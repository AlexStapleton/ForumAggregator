import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import proxyaddr from "proxy-addr";
import QRCode from "qrcode";
import {
  ChangePasswordRequest,
  LoginRequest,
  SetupRequest,
  TotpDisableRequest,
  TotpEnableRequest,
} from "@fa/shared/schemas";
import type { AuthStatus, TotpBeginResponse } from "@fa/shared";
import type { Env } from "../env.js";
import { splitList } from "../env.js";
import { parseBody, sendError } from "../http.js";
import type { AuthService, AuthUser } from "./service.js";

export const SESSION_COOKIE = "fa_session";

export interface RequestAuth {
  user: AuthUser;
  via: "session" | "proxy";
  sessionId?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
}

/** Routes reachable without being logged in. */
const PUBLIC_API = new Set(["/api/auth/status", "/api/auth/setup", "/api/auth/login"]);

const LOGIN_RATE_LIMIT = { max: 10, timeWindow: "15 minutes" };

export function registerAuth(app: FastifyInstance, env: Env, auth: AuthService): void {
  const localAllowed = env.AUTH_MODE !== "proxy";
  const proxyAllowed = env.AUTH_MODE !== "local";
  const proxyTrusted = proxyAllowed ? proxyaddr.compile(splitList(env.AUTH_PROXY_TRUSTED ?? "")) : undefined;
  const proxyHeader = env.AUTH_PROXY_HEADER.toLowerCase();
  const rateLimit = { rateLimit: env.LOGIN_RATE_LIMIT ? LOGIN_RATE_LIMIT : (false as const) };

  const cookieOptions = (request: FastifyRequest, expiresAt: number) => ({
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: env.COOKIE_SECURE === "auto" ? request.protocol === "https" : env.COOKIE_SECURE === "true",
    expires: new Date(expiresAt),
  });

  async function startSession(request: FastifyRequest, reply: FastifyReply, user: AuthUser) {
    const { token, expiresAt } = await auth.createSession(user.id, {
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });
    reply.setCookie(SESSION_COOKIE, token, cookieOptions(request, expiresAt));
  }

  app.decorateRequest("auth", null);

  // Resolve who is calling, then enforce login on everything under /api except PUBLIC_API.
  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/")) return;

    if (proxyTrusted) {
      const headerUser = request.headers[proxyHeader];
      // Only the directly connected peer counts: X-Forwarded-For could be forged by anyone.
      const peer = request.socket.remoteAddress;
      if (typeof headerUser === "string" && headerUser && peer && proxyTrusted(peer, 0)) {
        const user = await auth.getUserByUsername(headerUser.trim().toLowerCase());
        if (user) request.auth = { user, via: "proxy" };
        else request.log.warn({ headerUser }, "proxy auth header does not match the app's account");
      }
    }

    const token = request.cookies[SESSION_COOKIE];
    if (!request.auth && token && localAllowed) {
      const session = await auth.resolveSession(token);
      if (session) {
        request.auth = { user: session.user, via: "session", sessionId: session.sessionId };
        if (session.renewedExpiresAt) {
          reply.setCookie(SESSION_COOKIE, token, cookieOptions(request, session.renewedExpiresAt));
        }
      }
    }

    if (!request.auth && !PUBLIC_API.has(url)) {
      return sendError(reply, 401, "unauthorized", "Please log in");
    }
  });

  app.get("/api/auth/status", async (request): Promise<AuthStatus> => {
    const status: AuthStatus = {
      setupRequired: auth.isSetupRequired(),
      authenticated: !!request.auth,
      authMode: env.AUTH_MODE,
    };
    if (request.auth) {
      status.username = request.auth.user.username;
      status.totpEnabled = request.auth.user.totpEnabled;
      status.via = request.auth.via;
    }
    return status;
  });

  app.post("/api/auth/setup", { config: rateLimit }, async (request, reply) => {
    const body = parseBody(SetupRequest, request, reply);
    if (!body) return;
    if (!auth.isSetupRequired()) return sendError(reply, 409, "already_set_up", "The account already exists");
    if (!auth.checkSetupCode(body.setupCode)) {
      return sendError(reply, 403, "invalid_setup_code", "Wrong setup code. It is printed in the container log.");
    }
    const user = await auth.createInitialUser(body.username, body.password);
    request.log.info({ username: user.username }, "account created");
    if (localAllowed) await startSession(request, reply, user);
    return { ok: true };
  });

  app.post("/api/auth/login", { config: rateLimit }, async (request, reply) => {
    if (!localAllowed) return sendError(reply, 403, "local_login_disabled", "Log in through your SSO proxy");
    const body = parseBody(LoginRequest, request, reply);
    if (!body) return;
    const result = await auth.login(body.username, body.password, body.totpCode);
    if (!result.ok) {
      const messages = {
        invalid_credentials: "Wrong username or password",
        totp_required: "Enter the 6-digit code from your authenticator app",
        invalid_totp: "That code is wrong or was already used",
      };
      request.log.warn({ username: body.username, reason: result.reason, ip: request.ip }, "login failed");
      return sendError(reply, 401, result.reason, messages[result.reason]);
    }
    await startSession(request, reply, result.user);
    return { ok: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await auth.deleteSessionByToken(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/password", { config: rateLimit }, async (request, reply) => {
    const body = parseBody(ChangePasswordRequest, request, reply);
    if (!body) return;
    const ok = await auth.changePassword(request.auth!.user.id, body.currentPassword, body.newPassword, request.auth!.sessionId);
    if (!ok) return sendError(reply, 403, "invalid_credentials", "Current password is wrong");
    return { ok: true };
  });

  app.post("/api/auth/totp/begin", async (request, reply): Promise<TotpBeginResponse | void> => {
    if (request.auth!.user.totpEnabled) {
      return sendError(reply, 409, "totp_already_enabled", "Two-factor login is already on");
    }
    const { secret, uri } = await auth.beginTotp(request.auth!.user.id);
    return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) };
  });

  app.post("/api/auth/totp/enable", { config: rateLimit }, async (request, reply) => {
    const body = parseBody(TotpEnableRequest, request, reply);
    if (!body) return;
    if (!(await auth.enableTotp(request.auth!.user.id, body.code))) {
      return sendError(reply, 400, "invalid_totp", "That code didn't match. Check the time on your phone and try again.");
    }
    return { ok: true };
  });

  app.post("/api/auth/totp/disable", { config: rateLimit }, async (request, reply) => {
    const body = parseBody(TotpDisableRequest, request, reply);
    if (!body) return;
    if (!(await auth.disableTotp(request.auth!.user.id, body.password, body.code))) {
      return sendError(reply, 403, "invalid_credentials", "Password or code is wrong");
    }
    return { ok: true };
  });
}
