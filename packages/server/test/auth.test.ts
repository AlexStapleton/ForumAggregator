import * as OTPAuth from "otpauth";
import { afterEach, describe, expect, it } from "vitest";
import { backends, createTestApp, CSRF, deviceCookieHeader, SETUP_CODE, sessionCookie } from "./helpers.js";

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
    // Both cookies (session, and known device since D-111) carry the flags.
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] as string | string[]);
    expect(cookies.map((c) => c.split("=")[0])).toEqual(["fa_device", "fa_session"]);
    for (const c of cookies) {
      expect(c).toMatch(/HttpOnly/);
      expect(c).toMatch(/SameSite=Lax/);
    }
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

  /** Two-factor on, with the test clock: returns a code generator. */
  async function withTwoFactor(clock: { now: number }, cookie: string) {
    const { secret } = (await post("/api/auth/totp/begin", {}, cookie)).json();
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), period: 30, digits: 6 });
    const code = () => totp.generate({ timestamp: clock.now });
    expect((await post("/api/auth/totp/enable", { code: code() }, cookie)).statusCode).toBe(200);
    clock.now += 30_000;
    return { code, wrong: (n = 0) => String((Number(code()) + 500_000 + n) % 1_000_000).padStart(6, "0") };
  }

  it("locks two-factor codes after 5 wrong ones, whatever IP they claim, until the wait is over (D-110)", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 12) };
    app = await createTestApp(backend, {}, clock);
    const cookie = await setUp();
    const { code, wrong } = await withTwoFactor(clock, cookie);
    const login = (totpCode: string, n = 0) =>
      inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: PASSWORD, totpCode }, headers: { ...CSRF, "x-forwarded-for": `198.51.100.${n}` } });
    const results: Array<[number, string]> = [];
    for (let i = 0; i < 5; i++) {
      const r = await login(wrong(i), i);
      results.push([r.statusCode, r.json().error]);
    }
    expect(results.slice(0, 4)).toEqual(Array(4).fill([401, "invalid_totp"]));
    expect(results[4]).toEqual([429, "totp_locked"]);
    // Even the right code is refused while locked; the reply says how long.
    const locked = await login(code(), 9);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers["retry-after"]).toBe("900");
    expect(locked.json().message).toMatch(/locked for 15 minutes/);
    // After the wait, the right code works and the count starts over.
    clock.now += 15 * 60_000 + 1000;
    expect((await login(code())).statusCode).toBe(200);
    const row = await app!.db.kysely.selectFrom("users").select(["totp_failures", "totp_locked_until"]).executeTakeFirstOrThrow();
    expect(row).toEqual({ totp_failures: 0, totp_locked_until: null });
  });

  it("checks codes one at a time, so a burst of parallel guesses can't outrun the lock", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 12) };
    app = await createTestApp(backend, {}, clock);
    const cookie = await setUp();
    const { wrong } = await withTwoFactor(clock, cookie);
    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, i) => post("/api/auth/login", { username: "alex", password: PASSWORD, totpCode: wrong(i) })),
    );
    expect(replies.filter((r) => r.statusCode === 401)).toHaveLength(4);
    expect(replies.filter((r) => r.statusCode === 429)).toHaveLength(8);
    const row = await app!.db.kysely.selectFrom("users").select("totp_failures").executeTakeFirstOrThrow();
    expect(row.totp_failures).toBe(5); // no code was checked after the lock
  });

  it("makes wrong passwords wait after 10 in a row, per account (D-110)", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 12) };
    app = await createTestApp(backend, {}, clock);
    await setUp();
    const login = (password: string, n: number) =>
      inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password }, headers: { ...CSRF, "x-forwarded-for": `203.0.113.${n}` } });
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await login("wrong password", i)).statusCode);
    expect(codes).toEqual(Array(10).fill(401));
    const waiting = await login(PASSWORD, 50);
    expect(waiting.statusCode).toBe(429);
    expect(waiting.json()).toMatchObject({ error: "too_many_attempts", message: expect.stringMatching(/Try again in 1 minute/) });
    clock.now += 61_000;
    expect((await login("wrong again", 51)).statusCode).toBe(401); // 11th: now 2 minutes
    clock.now += 61_000;
    expect((await login(PASSWORD, 52)).statusCode).toBe(429);
    clock.now += 61_000;
    expect((await login(PASSWORD, 53)).statusCode).toBe(200);
    const row = await app!.db.kysely.selectFrom("users").select(["failed_logins", "login_locked_until"]).executeTakeFirstOrThrow();
    expect(row).toEqual({ failed_logins: 0, login_locked_until: null });
  });

  describe("known devices (D-111)", () => {
    const loginFrom = (device: string | undefined, password: string, totpCode?: string, ip = "198.51.100.9") =>
      inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alex", password, ...(totpCode ? { totpCode } : {}) },
        headers: { ...CSRF, "x-forwarded-for": ip, ...(device ? { cookie: device } : {}) },
      });

    it("a browser gets a device cookie on setup and on its first login, sent only to /api/auth", async () => {
      app = await createTestApp(backend);
      const setup = await post("/api/auth/setup", { setupCode: SETUP_CODE, username: "Alex", password: PASSWORD });
      expect(deviceCookieHeader(setup)).toMatch(/^fa_device=[\w-]{43}; Path=\/api\/auth; Expires=.*; HttpOnly; SameSite=Lax/);
      const fresh = await loginFrom(undefined, PASSWORD);
      expect(deviceCookieHeader(fresh)).toBeDefined();
      // A known device doesn't get a new one; a made-up cookie is just an unknown browser.
      const known = deviceCookieHeader(fresh)!.split(";")[0]!;
      expect(deviceCookieHeader(await loginFrom(known, PASSWORD))).toBeUndefined();
      expect(deviceCookieHeader(await loginFrom("fa_device=made-up-value", PASSWORD))).toBeDefined();
    });

    it("a stranger spamming wrong passwords locks unknown browsers, not your known devices", async () => {
      const clock = { now: Date.UTC(2026, 0, 1, 12) };
      app = await createTestApp(backend, {}, clock);
      const mine = deviceCookieHeader(await post("/api/auth/setup", { setupCode: SETUP_CODE, username: "Alex", password: PASSWORD }))!.split(";")[0]!;
      for (let i = 0; i < 15; i++) await loginFrom(undefined, "guess " + i, undefined, `203.0.113.${i}`);
      expect((await loginFrom(undefined, PASSWORD, undefined, "203.0.113.99")).statusCode).toBe(429); // unknown browsers wait
      expect((await loginFrom(mine, PASSWORD)).statusCode).toBe(200); // you don't
    });

    it("a stranger who has your password can lock codes for unknown browsers, not your known devices", async () => {
      const clock = { now: Date.UTC(2026, 0, 1, 12) };
      app = await createTestApp(backend, {}, clock);
      const setup = await post("/api/auth/setup", { setupCode: SETUP_CODE, username: "Alex", password: PASSWORD });
      const mine = deviceCookieHeader(setup)!.split(";")[0]!;
      const { code, wrong } = await withTwoFactor(clock, sessionCookie(setup)!);
      for (let i = 0; i < 5; i++) await loginFrom(undefined, PASSWORD, wrong(i), `203.0.113.${i}`);
      expect((await loginFrom(undefined, PASSWORD, code(), "203.0.113.99")).json().error).toBe("totp_locked");
      expect((await loginFrom(mine, PASSWORD, code())).statusCode).toBe(200);
    });

    it("a known device's own wrong tries lock only that device", async () => {
      const clock = { now: Date.UTC(2026, 0, 1, 12) };
      app = await createTestApp(backend, {}, clock);
      const mine = deviceCookieHeader(await post("/api/auth/setup", { setupCode: SETUP_CODE, username: "Alex", password: PASSWORD }))!.split(";")[0]!;
      for (let i = 0; i < 10; i++) await loginFrom(mine, "typo " + i);
      expect((await loginFrom(mine, PASSWORD)).statusCode).toBe(429);
      expect((await loginFrom(undefined, PASSWORD)).statusCode).toBe(200);
      const account = await app!.db.kysely.selectFrom("users").select("failed_logins").executeTakeFirstOrThrow();
      expect(account.failed_logins).toBe(0);
    });

    it("changing the password forgets your other known devices", async () => {
      const clock = { now: Date.UTC(2026, 0, 1, 12) };
      app = await createTestApp(backend, {}, clock);
      const setup = await post("/api/auth/setup", { setupCode: SETUP_CODE, username: "Alex", password: PASSWORD });
      const here = deviceCookieHeader(setup)!.split(";")[0]!;
      const other = deviceCookieHeader(await loginFrom(undefined, PASSWORD))!.split(";")[0]!;
      expect(await app!.db.kysely.selectFrom("known_devices").select("id").execute()).toHaveLength(2);
      const changed = await inject({
        method: "POST",
        url: "/api/auth/password",
        payload: { currentPassword: PASSWORD, newPassword: "an even longer passphrase" },
        headers: { ...CSRF, cookie: `${sessionCookie(setup)}; ${here}` },
      });
      expect(changed.statusCode).toBe(200);
      expect(await app!.db.kysely.selectFrom("known_devices").select("id").execute()).toHaveLength(1);
      // The other browser is unknown again: it gets a new device cookie at its next login.
      expect(deviceCookieHeader(await loginFrom(other, "an even longer passphrase"))).toBeDefined();
    });
  });

  it("signs out other devices when two-factor is turned on or off, and lists and ends sessions (D-110)", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 12) };
    app = await createTestApp(backend, {}, clock);
    const here = await setUp();
    const phone = sessionCookie(await inject({ method: "POST", url: "/api/auth/login", payload: { username: "alex", password: PASSWORD }, headers: { ...CSRF, "user-agent": "Mozilla/5.0 (Linux; Android 15) Chrome/141.0" } }))!;
    const list = async (cookie: string) => (await inject({ method: "GET", url: "/api/auth/sessions", headers: { cookie } })).json();
    let sessions = await list(here);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const { code } = await withTwoFactor(clock, here);
    expect((await status(phone)).authenticated).toBe(false); // signed out when two-factor went on
    expect((await status(here)).authenticated).toBe(true);

    // A second device logs in with a code; "sign out everywhere else" ends it.
    const laptop = sessionCookie(await post("/api/auth/login", { username: "alex", password: PASSWORD, totpCode: code() }))!;
    expect((await list(here))).toHaveLength(2);
    const others = await inject({ method: "POST", url: "/api/auth/sessions/sign-out-others", headers: { ...CSRF, cookie: here } });
    expect(others.json()).toEqual({ ok: true, signedOut: 1 });
    expect((await status(laptop)).authenticated).toBe(false);

    // Ending one session by its id; an unknown id is a 404.
    clock.now += 30_000;
    const tablet = sessionCookie(await post("/api/auth/login", { username: "alex", password: PASSWORD, totpCode: code() }))!;
    sessions = await list(here);
    const tabletId = sessions.find((s: { current: boolean }) => !s.current).id;
    expect((await inject({ method: "DELETE", url: `/api/auth/sessions/${tabletId}`, headers: { ...CSRF, cookie: here } })).statusCode).toBe(200);
    expect((await status(tablet)).authenticated).toBe(false);
    expect((await inject({ method: "DELETE", url: `/api/auth/sessions/${"0".repeat(64)}`, headers: { ...CSRF, cookie: here } })).statusCode).toBe(404);
    // Ending a session needs the CSRF header like any change.
    expect((await inject({ method: "DELETE", url: `/api/auth/sessions/${tabletId}`, headers: { cookie: here } })).statusCode).toBe(403);
  });

  it("ends a session after SESSION_MAX_DAYS even if it's used every day (D-110)", async () => {
    const clock = { now: Date.UTC(2026, 0, 1, 12) };
    app = await createTestApp(backend, { SESSION_TTL_DAYS: "30", SESSION_MAX_DAYS: "90" }, clock);
    const cookie = await setUp();
    for (let day = 1; day < 90; day++) {
      clock.now += 24 * 3_600_000;
      if (day % 10 === 0) expect((await status(cookie)).authenticated).toBe(true);
    }
    clock.now += 24 * 3_600_000;
    expect((await status(cookie)).authenticated).toBe(false);
  });

  it("reports what it sees of the connection, to check the reverse proxy (D-110)", async () => {
    app = await createTestApp(backend);
    const cookie = await setUp();
    const direct = await status(cookie);
    expect(direct.connection).toEqual({ ip: "127.0.0.1", https: false, secureCookie: false, proxy: "direct" });
    const viaProxy = (await inject({ method: "GET", url: "/api/auth/status", headers: { cookie, "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" } })).json();
    expect(viaProxy.connection).toEqual({ ip: "203.0.113.7", https: true, secureCookie: true, proxy: "through-trusted-proxy" });
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

  it("says when a proxy's headers come from an address TRUST_PROXY doesn't trust (D-110)", async () => {
    app = await createTestApp("sqlite", { LOGIN_RATE_LIMIT: "false", TRUST_PROXY: "10.9.9.9" });
    const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "alex", password: PASSWORD }, headers: CSRF });
    const res = await app.fastify.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: sessionCookie(setup)!, "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" } });
    expect(res.json().connection).toEqual({ ip: "127.0.0.1", https: false, secureCookie: false, proxy: "untrusted-proxy" });
  });

  it("marks the cookie Secure when a trusted proxy reports HTTPS", async () => {
    app = await createTestApp("sqlite", { LOGIN_RATE_LIMIT: "false" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { setupCode: SETUP_CODE, username: "alex", password: PASSWORD },
      headers: { ...CSRF, "x-forwarded-proto": "https" },
    });
    const cookies = ([] as string[]).concat(res.headers["set-cookie"] as string | string[]);
    expect(cookies).toHaveLength(2);
    for (const c of cookies) expect(c).toMatch(/; Secure/);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    app = await createTestApp("sqlite");
    const res = await app.fastify.inject({ method: "GET", url: "/api/nope", headers: {} });
    // Unauthenticated callers get 401 before routing reveals anything.
    expect(res.statusCode).toBe(401);
  });
});
