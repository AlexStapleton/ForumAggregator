import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { FetchError, HostLimiter, httpFetch } from "../src/feeds/fetch.js";
import { nextCheck } from "../src/feeds/schedule.js";
import { USER_AGENT } from "../src/sites/userAgent.js";

let server: http.Server;
let base = "";
const seen: http.IncomingHttpHeaders[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.headers);
    switch (req.url) {
      case "/feed":
        if (req.headers["if-none-match"] === '"v1"') {
          res.writeHead(304).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/rss+xml", etag: '"v1"', "last-modified": "Sat, 10 Oct 2026 00:00:00 GMT" });
        res.end('<?xml version="1.0"?><rss><channel><title>T</title></channel></rss>');
        return;
      case "/latin1":
        res.writeHead(200, { "content-type": "text/xml; charset=iso-8859-1" });
        res.end(Buffer.from('<?xml version="1.0"?><rss><channel><title>Jalape\xf1o</title></channel></rss>', "latin1"));
        return;
      case "/challenge":
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<html><head><title>Just a moment...</title></head></html>");
        return;
      case "/slow-down":
        res.writeHead(429, { "retry-after": "120" }).end();
        return;
      case "/huge":
        res.writeHead(200, { "content-type": "text/xml" });
        res.end("x".repeat(2 * 1024 * 1024));
        return;
      case "/hang":
        return; // never answers
      case "/redirect":
        res.writeHead(301, { location: "/feed" }).end();
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("httpFetch", () => {
  it("identifies itself and supports conditional requests", async () => {
    const first = await httpFetch(`${base}/feed`, { expect: "feed" });
    expect(first).toMatchObject({ kind: "ok", status: 200, etag: '"v1"', lastModified: "Sat, 10 Oct 2026 00:00:00 GMT" });
    expect(seen.at(-1)!["user-agent"]).toBe(USER_AGENT);
    expect(seen.at(-1)!.accept).toMatch(/rss\+xml/);

    const second = await httpFetch(`${base}/feed`, { expect: "feed", etag: '"v1"' });
    expect(second).toEqual({ kind: "not_modified" });
    expect(seen.at(-1)!["if-none-match"]).toBe('"v1"');
  });

  it("follows redirects and reports the final URL", async () => {
    const res = await httpFetch(`${base}/redirect`, { expect: "feed" });
    expect(res).toMatchObject({ kind: "ok", url: `${base}/feed` });
  });

  it("decodes the declared character set", async () => {
    const res = await httpFetch(`${base}/latin1`, { expect: "feed" });
    expect(res.kind === "ok" && res.body).toContain("Jalapeño");
  });

  it("turns bot checks, rate limits, 404s, oversize and timeouts into typed errors", async () => {
    const err = async (path: string, opts = {}) => {
      try {
        await httpFetch(`${base}${path}`, { expect: "feed", ...opts });
      } catch (e) {
        return e as FetchError;
      }
      throw new Error("expected an error");
    };
    const challenge = await err("/challenge");
    expect(challenge).toBeInstanceOf(FetchError);
    expect(challenge.kind).toBe("cloudflare_challenge");
    expect(challenge.isChallenge).toBe(true);

    const limited = await err("/slow-down");
    expect(limited.kind).toBe("rate_limited");
    expect(limited.retryAfterMs).toBe(120_000);

    expect((await err("/nope")).kind).toBe("not_found");
    expect((await err("/huge", { maxBytes: 1024 * 1024 })).kind).toBe("too_large");
    expect((await err("/hang", { timeoutMs: 300 })).kind).toBe("timeout");
  });

  it("reports connection failures", async () => {
    await expect(httpFetch("http://127.0.0.1:1/", { expect: "feed" })).rejects.toMatchObject({ kind: "network" });
  });
});

describe("HostLimiter", () => {
  it("spaces requests to the same host but not across hosts", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new HostLimiter(5000, 0, async (ms) => {
      waits.push(ms);
      now += ms;
    }, () => now);
    await limiter.wait("https://a.example/1");
    await limiter.wait("https://a.example/2");
    await limiter.wait("https://b.example/1");
    await limiter.wait("https://a.example/3", { minDelayMs: 1000, jitterMs: 0 });
    // a: immediately, then +5 s; b: immediately; a again: its slot was reserved 5 s after the 2nd.
    expect(waits).toEqual([5000, 5000]);
  });
});

describe("nextCheck", () => {
  const polling = ConfigSchema.parse({}).polling; // 30 min, backoff cap 6 h, breaker after 5
  const at = (r: { at: number | null }) => (r.at === null ? null : r.at / 60_000);

  it("schedules the normal interval with ±10% jitter", () => {
    expect(at(nextCheck({ now: 0, intervalMinutes: 30, failures: 0, polling, random: () => 0 }))).toBe(27);
    expect(at(nextCheck({ now: 0, intervalMinutes: 30, failures: 0, polling, random: () => 1 }))).toBe(33);
  });

  it("doubles on each failure up to the cap, honours Retry-After, then pauses", () => {
    const fail = (failures: number, retryAfterMs?: number) => nextCheck({ now: 0, intervalMinutes: 120, failures, polling, retryAfterMs });
    expect(at(fail(1))).toBe(120);
    expect(at(fail(2))).toBe(240);
    expect(at(fail(3))).toBe(360); // capped at 6 h
    expect(at(fail(1, 5 * 3_600_000))).toBe(300); // server asked for 5 h
    expect(fail(5)).toEqual({ at: null, paused: true });
  });
});
