import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import proxyaddr from "proxy-addr";
import QRCode from "qrcode";
import {
  AcceptInviteRequest,
  ChangePasswordRequest,
  LoginRequest,
  ResetPasswordRequest,
  SetupRequest,
  TotpDisableRequest,
  TotpEnableRequest,
} from "@fa/shared/schemas";
import { z } from "zod";
import type { AuthStatus, ConnectionInfo, InviteLinkInfo, SessionView, TotpBeginResponse } from "@fa/shared";
import type { Env } from "../env.js";
import { splitList } from "../env.js";
import { parseBody, sendError } from "../http.js";
import { AccountError, type AuthService, type AuthUser, type CheckResult, type LoginResult } from "./service.js";

export const SESSION_COOKIE = "fa_session";
/** Marks a browser that has logged in before (D-111). Grants nothing by itself; only sent to /api/auth. */
export const DEVICE_COOKIE = "fa_device";
const DEVICE_COOKIE_DAYS = 365;

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
const PUBLIC_API = new Set(["/api/auth/status", "/api/auth/setup", "/api/auth/login", "/api/auth/link", "/api/auth/invite/accept", "/api/auth/reset"]);

const LOGIN_RATE_LIMIT = { max: 10, timeWindow: "15 minutes" };

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** The reply for a failed password/code check; 429 with Retry-After while the account is locked (D-110). */
function failed(reply: FastifyReply, result: Exclude<LoginResult | CheckResult, { ok: true }>) {
  if (result.reason === "locked" || result.reason === "totp_locked") {
    reply.header("retry-after", String(Math.ceil(result.retryAfterMs / 1000)));
    const wait = minutes(result.retryAfterMs);
    return sendError(
      reply,
      429,
      result.reason === "locked" ? "too_many_attempts" : "totp_locked",
      result.reason === "locked"
        ? `Too many wrong passwords. Try again in ${wait} minute${wait === 1 ? "" : "s"}.`
        : `Too many wrong codes. Two-factor login is locked for ${wait} minute${wait === 1 ? "" : "s"}.`,
    );
  }
  if (result.reason === "disabled") return sendError(reply, 403, "disabled", "This account is turned off. Ask the person who runs this app.");
  const messages = {
    invalid_credentials: "Wrong username or password",
    totp_required: "Enter the 6-digit code from your authenticator app",
    invalid_totp: "That code is wrong or was already used",
  };
  return sendError(reply, 401, result.reason, messages[result.reason]);
}

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

  /** Gives this browser its known-device cookie (D-111). */
  function rememberDevice(request: FastifyRequest, reply: FastifyReply, token: string) {
    reply.setCookie(DEVICE_COOKIE, token, { ...cookieOptions(request, Date.now() + DEVICE_COOKIE_DAYS * 86_400_000), path: "/api/auth" });
  }
  const deviceToken = (request: FastifyRequest) => request.cookies[DEVICE_COOKIE] || undefined;

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

  /** What the app sees of a connection: lets the user check their reverse proxy (D-110). */
  function connectionInfo(request: FastifyRequest): ConnectionInfo {
    const forwarded = typeof request.headers["x-forwarded-for"] === "string" || typeof request.headers["x-forwarded-proto"] === "string";
    // A trusted proxy's headers were used if Fastify took a client address from X-Forwarded-For
    // (request.ips has more than the socket's address) or its protocol from X-Forwarded-Proto.
    const socketProtocol = (request.socket as { encrypted?: boolean }).encrypted ? "https" : "http";
    const trusted = (request.ips?.length ?? 0) > 1 || request.protocol !== socketProtocol;
    const proxy: ConnectionInfo["proxy"] = !forwarded ? "direct" : trusted ? "through-trusted-proxy" : "untrusted-proxy";
    const https = request.protocol === "https";
    return { ip: request.ip, https, secureCookie: cookieOptions(request, 0).secure, proxy };
  }

  app.get("/api/auth/status", async (request): Promise<AuthStatus> => {
    const status: AuthStatus = {
      setupRequired: auth.isSetupRequired(),
      authenticated: !!request.auth,
      authMode: env.AUTH_MODE,
    };
    if (request.auth) {
      status.username = request.auth.user.username;
      status.role = request.auth.user.role;
      status.totpEnabled = request.auth.user.totpEnabled;
      status.via = request.auth.via;
      status.connection = connectionInfo(request);
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
    rememberDevice(request, reply, await auth.rememberDevice(user.id));
    if (localAllowed) await startSession(request, reply, user);
    return { ok: true };
  });

  app.post("/api/auth/login", { config: rateLimit }, async (request, reply) => {
    if (!localAllowed) return sendError(reply, 403, "local_login_disabled", "Log in through your SSO proxy");
    const body = parseBody(LoginRequest, request, reply);
    if (!body) return;
    const result = await auth.login(body.username, body.password, body.totpCode, deviceToken(request));
    if (!result.ok) {
      request.log.warn({ username: body.username, reason: result.reason, ip: request.ip, peer: request.socket.remoteAddress }, "login failed");
      return failed(reply, result);
    }
    if (result.deviceToken) rememberDevice(request, reply, result.deviceToken);
    await startSession(request, reply, result.user);
    return { ok: true };
  });

  // ---- invitation and password-reset links (D-114) ----
  // POST, not GET with the token in the address: it stays out of logs. The link itself carries the
  // token after "#", which browsers never send to a server.
  const accountError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof AccountError) return sendError(reply, err.status, err.code, err.message, err.fields);
    throw err;
  };

  app.post("/api/auth/link", { config: rateLimit }, async (request, reply): Promise<InviteLinkInfo | void> => {
    const body = parseBody(z.object({ token: z.string().max(200) }), request, reply);
    if (!body) return;
    const invite = await auth.inviteFor(body.token);
    if (!invite) return sendError(reply, 410, "invalid_link", "This link has expired or was already used. Ask for a new one.");
    return { kind: invite.kind, username: invite.username, expiresAt: invite.expiresAt };
  });

  app.post("/api/auth/invite/accept", { config: rateLimit }, async (request, reply) => {
    const body = parseBody(AcceptInviteRequest, request, reply);
    if (!body) return;
    try {
      const user = await auth.acceptInvite(body.token, body.username, body.password);
      request.log.info({ username: user.username }, "account created from an invitation");
      rememberDevice(request, reply, await auth.rememberDevice(user.id));
      // SSO only (AUTH_MODE=proxy): the proxy logs them in, by the same username.
      if (localAllowed) await startSession(request, reply, user);
      return { ok: true };
    } catch (err) {
      return accountError(reply, err);
    }
  });

  app.post("/api/auth/reset", { config: rateLimit }, async (request, reply) => {
    const body = parseBody(ResetPasswordRequest, request, reply);
    if (!body) return;
    try {
      const user = await auth.useResetLink(body.token, body.password);
      request.log.info({ username: user.username }, "password reset from a link; other devices signed out");
      return { ok: true, username: user.username };
    } catch (err) {
      return accountError(reply, err);
    }
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
    const result = await auth.changePassword(request.auth!.user.id, body.currentPassword, body.newPassword, request.auth!.sessionId, deviceToken(request));
    if (!result.ok) return result.reason === "invalid_credentials" ? sendError(reply, 403, "invalid_credentials", "Current password is wrong") : failed(reply, result);
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
    const result = await auth.enableTotp(request.auth!.user.id, body.code, request.auth!.sessionId, deviceToken(request));
    if (!result.ok) {
      return result.reason === "invalid_totp"
        ? sendError(reply, 400, "invalid_totp", "That code didn't match. Check the time on your phone and try again.")
        : failed(reply, result);
    }
    request.log.info({ username: request.auth!.user.username }, "two-factor login turned on; other devices signed out");
    return { ok: true };
  });

  app.post("/api/auth/totp/disable", { config: rateLimit }, async (request, reply) => {
    const body = parseBody(TotpDisableRequest, request, reply);
    if (!body) return;
    const result = await auth.disableTotp(request.auth!.user.id, body.password, body.code, request.auth!.sessionId, deviceToken(request));
    if (!result.ok) {
      return result.reason === "invalid_credentials" || result.reason === "invalid_totp"
        ? sendError(reply, 403, "invalid_credentials", "Password or code is wrong")
        : failed(reply, result);
    }
    request.log.info({ username: request.auth!.user.username }, "two-factor login turned off; other devices signed out");
    return { ok: true };
  });

  // ---- signed-in devices (D-110) ----
  app.get("/api/auth/sessions", async (request): Promise<SessionView[]> => {
    const current = request.auth!.sessionId;
    return (await auth.listSessions(request.auth!.user.id)).map((s) => ({ ...s, current: s.id === current }));
  });

  app.delete<{ Params: { id: string } }>("/api/auth/sessions/:id", async (request, reply) => {
    if (!/^[0-9a-f]{64}$/.test(request.params.id)) return sendError(reply, 404, "not_found", "No such session");
    if (!(await auth.endSession(request.auth!.user.id, request.params.id))) return sendError(reply, 404, "not_found", "No such session");
    if (request.params.id === request.auth!.sessionId) reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.post("/api/auth/sessions/sign-out-others", async (request) => {
    const signedOut = await auth.signOutOthers(request.auth!.user.id, request.auth!.sessionId);
    request.log.info({ signedOut }, "signed out other devices");
    return { ok: true, signedOut };
  });
}
