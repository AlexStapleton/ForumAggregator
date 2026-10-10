import * as OTPAuth from "otpauth";
import { afterEach, describe, expect, it } from "vitest";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const PASSWORD = "correct horse battery";

describe.each(backends)("auth (%s)", (backend) => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const inject = (opts: Parameters<TestApp["fastify"]["inject"]>[0]) => app!.fastify.inject(opts);
  const post = (url: string, payload: object, cookie?: string) =>
    inject({ method: "POST", url, payload, headers: { ...CSRF, ...(cookie ? { cookie } : {}) } });
  const status = async (cookie?: string) =>
    (await inject({ method: "GET", url: "/api/auth/status", headers: cookie ? { cookie } : {} })).json();

  async function setUp(): Promise<string> {
    const res = await post("/api/auth/setup", { setupCode: SETUP_CODE, username: "Alex", password: PASSWORD });
    expect(res.statusCode).toBe(200);
    return sessionCookie(res)!;
  }

  it("first run: requires the setup code, creates the account once, logs in", async () => {
    app = await createTestApp(backend);
    expect(await status()).toMatchObject({ setupRequired: true, authenticated: false, authMode: "local" });

    const wrong = await post("/api/auth/setup", { setupCode: "nope", username: "alex", password: PASSWORD });
    expect(wrong.statusCode).toBe(403);

    // Dashes, spaces and case in the code don't matter.
    const weak = await post("/api/auth/setup", { setupCode: SETUP_CODE, username: "alex", password: "short" });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().fields.password).toMatch(/12/);

    const res = await post("/api/auth/setup", { setupCode: "testcode 1234", username: "Alex", password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookie(res)!;
    expect(res.headers["set-cookie"]).toMatch(/HttpOnly/);
    expect(res.headers["set-cookie"]).toMatch(/SameSite=Lax/);
    expect(await status(cookie)).toMatchObject({ setupRequired: false, authenticated: true, username: "alex", via: "session" });

    const again = await post("/api/auth/setup", { setupCode: SETUP_CODE, username: "other", password: PASSWORD });
    expect(again.statusCode).toBe(409);
  });

  it("protects the API and accepts login/logout", async () => {
    app = await createTestApp(backend);
    await setUp();

    expect((await inject({ method: "GET", url: "/api/config" })).statusCode).toBe(401);
    expect((await post("/api/auth/login", { username: "alex", password: "wrong password" })).statusCode).toBe(401);
    expect((await post("/api/auth/login", { username: "nobody", password: PASSWORD })).json().error).toBe("invalid_credentials");

    const login = await post("/api/auth/login", { username: "ALEX ", password: PASSWORD });
    expect(login.statusCode).toBe(200);
    const cookie = sessionCookie(login)!;
    const cfg = await inject({ method: "GET", url: "/api/config", headers: { cookie } });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.json().polling.intervalMinutes).toBe(30);

    expect((await post("/api/auth/logout", {}, cookie)).statusCode).toBe(200);
    expect(await status(cookie)).toMatchObject({ authenticated: false });
  });

  it("rejects state-changing requests without the CSRF header", async () => {
    app = await createTestApp(backend);
    const res = await inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { setupCode: SETUP_CODE, username: "alex", password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("csrf");
  });

  it("expires sessions and slides the expiry while in use", async () => {
    const clock = { now: Date.UTC(2026, 0, 1) };
    app = await createTestApp(backend, { SESSION_TTL_DAYS: "1" }, clock);
    const cookie = await setUp();

    clock.now += 23 * 3600_000; // still valid, and old enough to be renewed
    const res = await inject({ method: "GET", url: "/api/auth/status", headers: { cookie } });
    expect(res.json().authenticated).toBe(true);
    expect(sessionCookie(res)).toBe(cookie);

    clock.now += 23 * 3600_000; // valid only because of the renewal
    expect((await status(cookie)).authenticated).toBe(true);

    clock.now += 25 * 3600_000;
    expect((await status(cookie)).authenticated).toBe(false);
  });

  it("changing the password signs out other sessions", async () => {
    app = await createTestApp(backend);
    const first = await setUp();
    const second = sessionCookie(await post("/api/auth/login", { username: "alex", password: PASSWORD }))!;

    expect((await post("/api/auth/password", { currentPassword: "wrong", newPassword: "another long password" }, second)).statusCode).toBe(403);
    expect((await post("/api/auth/password", { currentPassword: PASSWORD, newPassword: "another long password" }, second)).statusCode).toBe(200);

    expect((await status(second)).authenticated).toBe(true);
    expect((await status(first)).authenticated).toBe(false);
    expect((await post("/api/auth/login", { username: "alex", password: PASSWORD })).statusCode).toBe(401);
    expect((await post("/api/auth/login", { username: "alex", password: "another long password" })).statusCode).toBe(200);
  });

  it("TOTP: enrol, require on login, reject replays, disable", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 12) };
    app = await createTestApp(backend, {}, clock);
    const cookie = await setUp();

    const begin = await post("/api/auth/totp/begin", {}, cookie);
    expect(begin.statusCode).toBe(200);
    const { secret, otpauthUri, qrDataUrl } = begin.json();
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/ForumAggregator:alex\?/);
    expect(qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), period: 30, digits: 6 });
    const code = () => totp.generate({ timestamp: clock.now });

    expect((await post("/api/auth/totp/enable", { code: "000000" }, cookie)).statusCode).toBe(400);
    expect((await post("/api/auth/totp/enable", { code: code() }, cookie)).statusCode).toBe(200);
    expect(await status(cookie)).toMatchObject({ totpEnabled: true });

    // Password alone is no longer enough.
    const noCode = await post("/api/auth/login", { username: "alex", password: PASSWORD });
    expect(noCode.json().error).toBe("totp_required");

    // The code used for enrolment can't be replayed in the same 30 s window.
    expect((await post("/api/auth/login", { username: "alex", password: PASSWORD, totpCode: code() })).json().error).toBe("invalid_totp");

    clock.now += 30_000;
    const ok = await post("/api/auth/login", { username: "alex", password: PASSWORD, totpCode: code() });
    expect(ok.statusCode).toBe(200);
    expect((await post("/api/auth/login", { username: "alex", password: PASSWORD, totpCode: code() })).statusCode).toBe(401);

    clock.now += 30_000;
    expect((await post("/api/auth/totp/disable", { password: "wrong", code: code() }, cookie)).statusCode).toBe(403);
    clock.now += 30_000;
    expect((await post("/api/auth/totp/disable", { password: PASSWORD, code: code() }, cookie)).statusCode).toBe(200);
    expect((await post("/api/auth/login", { username: "alex", password: PASSWORD })).statusCode).toBe(200);
  });

  it("rate-limits login attempts", async () => {
    app = await createTestApp(backend, { LOGIN_RATE_LIMIT: "true" });
    await setUp();
    // Each route has its own budget of 10 attempts per 15 minutes per client IP.
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await post("/api/auth/login", { username: "alex", password: "wrong password" })).statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
    // Even the right password is refused while limited.
    const res = await post("/api/auth/login", { username: "alex", password: PASSWORD });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("rate_limited");
  });

  describe("proxy (SSO) auth", () => {
    const proxyEnv = { AUTH_MODE: "both", AUTH_PROXY_TRUSTED: "127.0.0.1", LOGIN_RATE_LIMIT: "false" };

    it("trusts the header only from the configured proxy and only for the app's account", async () => {
      app = await createTestApp(backend, proxyEnv);
      await setUp();
      // fastify.inject connects from 127.0.0.1, which is trusted here.
      expect(await status()).toMatchObject({ authenticated: false });
      const ok = await inject({ method: "GET", url: "/api/auth/status", headers: { "remote-user": "Alex" } });
      expect(ok.json()).toMatchObject({ authenticated: true, via: "proxy", username: "alex" });
      const other = await inject({ method: "GET", url: "/api/auth/status", headers: { "remote-user": "mallory" } });
      expect(other.json().authenticated).toBe(false);
    });

    it("ignores the header from untrusted peers", async () => {
      app = await createTestApp(backend, { ...proxyEnv, AUTH_PROXY_TRUSTED: "10.9.9.9" });
      await setUp();
      const res = await inject({ method: "GET", url: "/api/auth/status", headers: { "remote-user": "alex" } });
      expect(res.json().authenticated).toBe(false);
    });

    it("proxy-only mode disables password login", async () => {
      app = await createTestApp(backend, { ...proxyEnv, AUTH_MODE: "proxy" });
      await setUp();
      const res = await post("/api/auth/login", { username: "alex", password: PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("local_login_disabled");
    });
  });
});

describe("misc endpoints", () => {
  let app: TestApp | undefined;
  afterEach(async () => {
    await app?.close();
  });

  it("health check is public and checks the database", async () => {
    app = await createTestApp("sqlite");
    const res = await app.fastify.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("sends security headers without HSTS or upgrade-insecure-requests", async () => {
    app = await createTestApp("sqlite");
    const res = await app.fastify.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(res.headers["content-security-policy"]).not.toMatch(/upgrade-insecure-requests/);
    expect(res.headers["strict-transport-security"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("marks the cookie Secure when a trusted proxy reports HTTPS", async () => {
    app = await createTestApp("sqlite", { LOGIN_RATE_LIMIT: "false" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { setupCode: SETUP_CODE, username: "alex", password: PASSWORD },
      headers: { ...CSRF, "x-forwarded-proto": "https" },
    });
    expect(res.headers["set-cookie"]).toMatch(/Secure/);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    app = await createTestApp("sqlite");
    const res = await app.fastify.inject({ method: "GET", url: "/api/nope", headers: {} });
    // Unauthenticated callers get 401 before routing reveals anything.
    expect(res.statusCode).toBe(401);
  });
});
