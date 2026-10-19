import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { CSRF_HEADER, type VersionInfo } from "@fa/shared";
import { registerAuth } from "./auth/routes.js";
import { AuthService } from "./auth/service.js";
import type { AppConfig } from "./config.js";
import { createSecretBox } from "./crypto.js";
import type { Db } from "./db/index.js";
import { splitList, type Env } from "./env.js";
import { sendError } from "./http.js";
import { VERSION } from "./version.js";
import { HostLimiter, httpFetch, type Fetcher } from "./feeds/fetch.js";
import { ItemService } from "./feeds/items.js";
import { Poller } from "./feeds/poller.js";
import { registerFeedRoutes } from "./feeds/routes.js";
import { FeedService } from "./feeds/service.js";

export interface AppDeps {
  env: Env;
  /** Resolved by resolveSecretKey(): FA_SECRET_KEY or the key file in DATA_DIR. */
  secretKey: string;
  config: AppConfig;
  db: Db;
  now?: () => number;
  /** HTTP client for sources; tests pass a fake. */
  fetcher?: Fetcher;
  /** Host spacing; tests pass a no-wait limiter. */
  limiter?: HostLimiter;
}

export interface App {
  fastify: FastifyInstance;
  auth: AuthService;
  feeds: FeedService;
  items: ItemService;
  /** Not started by buildApp; index.ts starts it after the server is listening. */
  poller: Poller;
}

function trustProxySetting(value: string): boolean | string[] {
  if (value === "false") return false;
  if (value === "true") return true;
  return splitList(value);
}

export async function buildApp({ env, secretKey, config, db, now, fetcher, limiter }: AppDeps): Promise<App> {
  const fastify = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'],
    },
    trustProxy: trustProxySetting(env.TRUST_PROXY),
    bodyLimit: 256 * 1024,
  });

  const box = createSecretBox(secretKey);
  const auth = new AuthService(db, box, env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000, now);

  await fastify.register(helmet, {
    // HSTS is the reverse proxy's job (Nginx Proxy Manager has a switch for it), and sending
    // it from here would break plain-HTTP access on the LAN.
    hsts: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        // Feed images (e.g. YouTube thumbnails). Only http(s) URLs are ever stored (feeds/text.ts).
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
  });
  await fastify.register(cookie);
  await fastify.register(rateLimit, { global: false });

  // CSRF: every state-changing API call must send a custom header. Browsers won't add a
  // custom header to a cross-site request without a CORS preflight, which we never allow.
  fastify.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (request.headers[CSRF_HEADER] !== "1") {
      return sendError(reply, 403, "csrf", `Missing ${CSRF_HEADER} header`);
    }
  });

  registerAuth(fastify, env, auth);

  const feeds = new FeedService(
    db,
    config,
    fetcher ?? httpFetch,
    limiter ?? new HostLimiter(config.polling.minDelaySeconds * 1000, config.polling.jitterSeconds * 1000),
    now,
    fastify.log,
  );
  const items = new ItemService(db, now);
  const poller = new Poller(feeds, fastify.log);
  registerFeedRoutes(fastify, feeds, items);

  fastify.get("/healthz", async (_request, reply) => {
    try {
      await db.ping();
      return { status: "ok" };
    } catch (err) {
      fastify.log.error({ err }, "health check failed");
      return reply.code(503).send({ status: "error" });
    }
  });

  fastify.get("/api/version", async (): Promise<VersionInfo> => ({
    name: "ForumAggregator",
    version: VERSION,
    database: db.kind,
  }));

  // Read-only view of the effective config, for the (future) settings screen.
  fastify.get("/api/config", async () => config);

  await registerWebUi(fastify, env);

  fastify.setErrorHandler((err: Error & { statusCode?: number }, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) request.log.error({ err }, "request failed");
    if (status === 429) return sendError(reply, 429, "rate_limited", "Too many attempts. Try again later.");
    return sendError(reply, status, status >= 500 ? "internal" : "bad_request", status >= 500 ? "Something went wrong" : err.message);
  });

  return { fastify, auth, feeds, items, poller };
}

async function registerWebUi(fastify: FastifyInstance, env: Env): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(env.WEB_DIST ?? path.join(here, "../../web/dist"));
  const hasUi = fs.existsSync(path.join(root, "index.html"));
  if (!hasUi) {
    fastify.log.warn({ root }, "web UI not found; serving the API only (run `npm run build -w @fa/web`)");
  } else {
    await fastify.register(fastifyStatic, {
      root,
      wildcard: false,
      setHeaders(reply, filePath) {
        // Vite fingerprints everything under assets/, so it can be cached forever.
        reply.header(
          "cache-control",
          filePath.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
        );
      },
    });
  }

  // Single-page app: unknown non-API GETs get index.html so client-side routes work on reload.
  fastify.setNotFoundHandler((request, reply) => {
    const wantsHtml = request.headers.accept?.includes("text/html");
    if (hasUi && request.method === "GET" && !request.url.startsWith("/api/") && wantsHtml) {
      return reply.header("cache-control", "no-cache").sendFile("index.html");
    }
    return sendError(reply, 404, "not_found", "Not found");
  });
}
