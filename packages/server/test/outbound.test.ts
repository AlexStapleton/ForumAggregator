import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutboundBlocked, OutboundPolicy, publicAddress } from "../src/feeds/outbound.js";
import { createHttpFetch, httpFetch, httpJson, httpServiceJson } from "../src/feeds/fetch.js";
import { FlareSolverr, httpPostJson } from "../src/feeds/flaresolverr.js";
import { createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

describe("outbound destination policy", () => {
  it.each([
    "0.0.0.0", "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "100.100.100.200", "192.0.2.1", "198.18.0.1", "224.0.0.1", "240.0.0.1",
    "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
    "64:ff9b::a00:1", "2002:7f00:1::", "2001::1", "4000::1", "3fff::1",
  ])("blocks special address %s", (address) => expect(publicAddress(address)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows public address %s", (address) => expect(publicAddress(address)).toBe(true));

  it.each(["http://2130706433/", "http://0x7f000001/", "http://127.1/", "http://[::ffff:7f00:1]/", "http://u:p@example.com", "file:///etc/passwd"])("rejects alternate literals or unsafe URLs: %s", async (url) => {
    await expect(new OutboundPolicy().fetch(url)).rejects.toBeInstanceOf(OutboundBlocked);
  });

  it("rejects mixed public/private DNS answers", async () => {
    const policy = new OutboundPolicy([], async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(policy.check("https://mixed.example")).rejects.toBeInstanceOf(OutboundBlocked);
  });

  it("returns the validated address to the socket with exactly one DNS lookup", async () => {
    const resolve = vi.fn().mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const policy = new OutboundPolicy([], resolve);
    const lookup = policy.connectionLookup("https://changing.example");
    const result = await new Promise<unknown>((done, fail) => lookup("changing.example", {}, (error, address) => error ? fail(error) : done(address)));
    expect(result).toBe("8.8.8.8");
    expect(resolve).toHaveBeenCalledTimes(1);
    // A subsequent connection revalidates rather than trusting a cached hostname approval.
    await expect(new Promise((done, fail) => lookup("changing.example", {}, (error, address) => error ? fail(error) : done(address)))).rejects.toBeInstanceOf(OutboundBlocked);
  });

  it("validates all-address socket lookups too", async () => {
    const policy = new OutboundPolicy([], async () => [{ address: "8.8.8.8", family: 4 }]);
    const result = await new Promise((done, fail) => policy.connectionLookup("https://public.example")("public.example", { all: true }, (error, addresses) => error ? fail(error) : done(addresses)));
    expect(result).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("rejects broad or malformed administrator exceptions", () => {
    for (const origin of ["http://internal/path", "http://internal?x=1", "http://u:p@internal", "http://*.example", "*.example", "10.0.0.0/8"]) {
      expect(() => new OutboundPolicy([origin])).toThrow();
    }
  });
});

describe("real HTTP boundaries (only local dummy servers)", () => {
  let server: http.Server;
  let base: string;
  let other: string;
  let seen: Array<{ path: string; cookie?: string; host?: string }>;
  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push({ path: req.url!, cookie: req.headers.cookie, host: req.headers.host });
      if (req.url === "/redirect") res.writeHead(302, { location: `${other}/target` }).end();
      else if (req.url === "/loop") res.writeHead(302, { location: "/loop" }).end();
      else if (req.url === "/feed") res.writeHead(200, { "content-type": "application/rss+xml" }).end(`<rss version="2.0"><channel><title>Allowed feed</title><link>${base}</link><description>Test</description><item><guid>probe</guid><title>Internal article</title><link>${other}/article</link><description>Short teaser</description></item></channel></rss>`);
      else res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    other = `http://localhost:${port}`;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("blocks both feed and JSON fetches before any request reaches loopback", async () => {
    await expect(httpFetch(base, { expect: "feed" })).rejects.toMatchObject({ kind: "blocked_destination" });
    await expect(httpJson(base)).rejects.toMatchObject({ kind: "blocked_destination" });
    expect(seen).toEqual([]);
  });

  it("blocks private DNS answers in the actual connection lookup", async () => {
    const policy = new OutboundPolicy([], async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(createHttpFetch(policy)(other, { expect: "html" })).rejects.toMatchObject({ kind: "blocked_destination" });
    expect(seen).toEqual([]);
  });

  it("allows only the administrator's exact origin, retaining the original Host header", async () => {
    const policy = new OutboundPolicy([other], async () => [{ address: "127.0.0.1", family: 4 }]);
    const result = await policy.fetch(other);
    expect(await result.json()).toEqual({ ok: true });
    expect(seen[0]!.host).toBe(new URL(other).host);
    await expect(policy.fetch(base)).rejects.toBeInstanceOf(OutboundBlocked);
  });

  it("does not extend an exception to a redirected origin", async () => {
    const policy = new OutboundPolicy([base], async () => [{ address: "127.0.0.1", family: 4 }]);
    await expect(policy.fetch(`${base}/redirect`)).rejects.toBeInstanceOf(OutboundBlocked);
    expect(seen.map((r) => r.path)).toEqual(["/redirect"]);
  });

  it("strips clearance cookies across origins and bounds redirect loops", async () => {
    const policy = new OutboundPolicy([base, other], async () => [{ address: "127.0.0.1", family: 4 }]);
    const result = await policy.fetch(`${base}/redirect`, { headers: { cookie: "cf_clearance=test" } });
    await result.text();
    expect(seen.map((r) => r.cookie)).toEqual(["cf_clearance=test", undefined]);
    seen.length = 0;
    await expect(policy.fetch(`${base}/loop`)).rejects.toThrow("Too many redirects");
    expect(seen).toHaveLength(6);
  });

  it("rejects a public-to-private redirect before issuing the private request", async () => {
    // The public response is simulated; no external service is contacted.
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: base } }));
    await expect(new OutboundPolicy().fetch("https://public.example/feed")).rejects.toBeInstanceOf(OutboundBlocked);
    expect(network).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it("allows admin service calls but never follows their redirects", async () => {
    expect(await httpServiceJson(base)).toEqual({ status: 200, body: { ok: true } });
    expect(await httpPostJson(base, {}, 1000)).toEqual({ status: 200, body: { ok: true } });
    seen.length = 0;
    await expect(httpServiceJson(`${base}/redirect`)).rejects.toThrow();
    await expect(httpPostJson(`${base}/redirect`, {}, 1000)).rejects.toThrow();
    expect(seen.map((r) => r.path)).toEqual(["/redirect", "/redirect"]);
  });

  it("keeps the real source API from fetching an invited user's loopback URL", async () => {
    const app = await createTestApp("sqlite");
    try {
      const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", headers: CSRF, payload: { setupCode: SETUP_CODE, username: "admin", password: "isolated test password" } });
      const invite = await app.fastify.inject({ method: "POST", url: "/api/admin/invites", headers: { ...CSRF, cookie: sessionCookie(setup)! }, payload: {} });
      const accepted = await app.fastify.inject({ method: "POST", url: "/api/auth/invite/accept", headers: CSRF, payload: { token: invite.json().token, username: "reader", password: "isolated user password" } });
      expect(accepted.statusCode).toBe(200);
      const cookie = sessionCookie(accepted)!;
      for (const url of [base, `${base}/redirect`]) {
        const response = await app.fastify.inject({ method: "POST", url: "/api/sources", headers: { ...CSRF, cookie }, payload: { url } });
        expect(response.statusCode).toBe(422);
        expect(response.json().error).toBe("blocked_destination");
      }
      expect(seen).toEqual([]);
    } finally { await app.close(); }
  });

  it("disables remote browser fetching by default, without calling its service", async () => {
    const post = vi.fn();
    const direct = vi.fn();
    const flare = new FlareSolverr(async () => base, post, vi.fn());
    await expect(flare.wrap(direct)("https://public.example", { expect: "html" })).rejects.toMatchObject({ kind: "blocked_destination" });
    expect(post).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it("does not let an allowed feed fetch a private article on another origin", async () => {
    const app = await createTestApp("sqlite", { FA_ALLOWED_INTERNAL_ORIGINS: base });
    try {
      const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", headers: CSRF, payload: { setupCode: SETUP_CODE, username: "admin", password: "isolated test password" } });
      const headers = { ...CSRF, cookie: sessionCookie(setup)! };
      const source = await app.fastify.inject({ method: "POST", url: "/api/sources", headers, payload: { url: `${base}/feed` } });
      expect(source.statusCode).toBe(201);
      const items = (await app.fastify.inject({ method: "GET", url: "/api/items?filter=all", headers })).json().items;
      expect(items).toHaveLength(1);
      seen.length = 0;
      const reader = await app.fastify.inject({ method: "GET", url: `/api/items/${items[0].id}/reader`, headers });
      expect(reader.statusCode).toBe(200);
      expect(reader.json().notice).toContain("not public");
      expect(seen).toEqual([]);
    } finally { await app.close(); }
  });

  it("checks remote-browser destinations before calling the service", async () => {
    const post = vi.fn();
    const policy = new OutboundPolicy();
    const flare = new FlareSolverr(async () => base, post, vi.fn(), Date.now, (url) => policy.check(url));
    await expect(flare.wrap(vi.fn())(base, { expect: "html" })).rejects.toBeInstanceOf(OutboundBlocked);
    expect(post).not.toHaveBeenCalled();
  });
});
