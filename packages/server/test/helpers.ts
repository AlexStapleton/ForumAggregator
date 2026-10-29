import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { HostLimiter, type Fetcher, type JsonFetcher } from "../src/feeds/fetch.js";
import type { JsonPoster } from "../src/feeds/flaresolverr.js";
import { ConfigSchema } from "../src/config.js";
import { migrate, openDb, type Db } from "../src/db/index.js";
import { loadEnv } from "../src/env.js";

export const SECRET = "test-secret-key-that-is-long-enough-1234567890";
export const SETUP_CODE = "TESTCODE-1234";

/** Backends to run DB-backed suites against. Postgres only when TEST_DATABASE_URL is set. */
export const backends: Array<"sqlite" | "postgres"> = process.env.TEST_DATABASE_URL
  ? ["sqlite", "postgres"]
  : ["sqlite"];

async function resetPostgres(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("drop schema public cascade; create schema public;");
  await client.end();
}

export async function createTestApp(
  backend: "sqlite" | "postgres",
  envOverrides: Record<string, string> = {},
  clock: { now: number } = { now: Date.now() },
  deps: { fetcher?: Fetcher; fetchJson?: JsonFetcher; postJson?: JsonPoster } = {},
) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-test-"));
  let databaseUrl: string | undefined;
  if (backend === "postgres") {
    databaseUrl = process.env.TEST_DATABASE_URL!;
    await resetPostgres(databaseUrl);
  }
  const env = loadEnv({
    DATA_DIR: dataDir,
    FA_SECRET_KEY: SECRET,
    LOG_LEVEL: "silent",
    LOGIN_RATE_LIMIT: "false",
    WEB_DIST: path.join(dataDir, "no-web-ui"),
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    ...envOverrides,
  });
  const db: Db = openDb({ databaseUrl: env.DATABASE_URL, dataDir });
  await migrate(db);
  const app = await buildApp({
    env,
    secretKey: SECRET,
    config: ConfigSchema.parse({}),
    db,
    now: () => clock.now,
    fetcher: deps.fetcher,
    // Never reach the real YouTube API from tests.
    fetchJson: deps.fetchJson ?? (async () => ({ status: 503, body: null })),
    // Never reach a real FlareSolverr from tests.
    postJson: deps.postJson ?? (async () => ({ status: 503, body: null })),
    // Fake browser tests never open sockets; production's isolation gate remains the default.
    authorizeFlareTarget: deps.postJson ? async () => {} : undefined,
    // No waiting between requests in tests.
    limiter: new HostLimiter(0, 0, async () => {}),
  });
  await app.auth.initSetup(SETUP_CODE);
  return {
    ...app,
    db,
    clock,
    async close() {
      await app.fastify.close();
      await db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Pulls the fa_session cookie out of a response, as "name=value" for the next request. */
export function sessionCookie(res: { headers: Record<string, unknown> }): string | undefined {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const c = list.find((s: string) => s.startsWith("fa_session="));
  return c?.split(";")[0];
}

/** The known-device cookie (D-111), with its attributes, from a response. */
export function deviceCookieHeader(res: { headers: Record<string, unknown> }): string | undefined {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.find((s: string) => s.startsWith("fa_device="));
}

export const CSRF = { "x-fa-request": "1" };
