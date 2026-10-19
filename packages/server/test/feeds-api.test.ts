import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FetchError } from "../src/feeds/fetch.js";
import { FakeWeb, rss } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

const NOW = Date.UTC(2026, 9, 15, 12);
const DAY = 24 * 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const youtubeFeed = fs.readFileSync(path.join(import.meta.dirname, "fixtures/feeds/youtube.xml"), "utf8");

describe.each(backends)("sources and feed (%s)", (backend) => {
  let app: TestApp | undefined;
  let cookie = "";
  let web: FakeWeb;
  const clock = { now: NOW };

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start() {
    clock.now = NOW;
    web = new FakeWeb();
    app = await createTestApp(backend, {}, clock, { fetcher: web.fetcher });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" },
      headers: CSRF,
    });
    cookie = sessionCookie(res)!;
  }

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) =>
    app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });
  const items = async (query = "") => (await call("GET", `/api/items${query}`)).json();
  const addFeed = async (url: string) => call("POST", "/api/sources", { url });

  it("requires login", async () => {
    await start();
    expect((await app!.fastify.inject({ method: "GET", url: "/api/items" })).statusCode).toBe(401);
    expect((await app!.fastify.inject({ method: "GET", url: "/api/sources" })).statusCode).toBe(401);
  });

  it("adds a feed URL, stores items, and starts old ones as read", async () => {
    await start();
    web.set(
      "https://site.example/feed.xml",
      {
        body: rss("Site News", [
          { guid: "a", title: "Fresh", date: iso(-1 * 3_600_000) },
          { guid: "b", title: "Yesterday", date: iso(-DAY) },
          { guid: "c", title: "Last month", date: iso(-30 * DAY) },
        ]),
      },
    );
    const res = await addFeed("site.example/feed.xml"); // scheme added automatically
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      kind: "feed",
      title: "Site News",
      feedUrl: "https://site.example/feed.xml",
      status: "ok",
      enabled: true,
      unreadCount: 2,
      itemCount: 3,
    });
    expect(res.json().nextCheckAt).toBeGreaterThan(NOW);

    const unread = await items();
    expect(unread.items.map((i: { title: string }) => i.title)).toEqual(["Fresh", "Yesterday"]);
    expect(unread.items[0]).toMatchObject({ sourceTitle: "Site News", url: "https://site.example/a", read: false, saved: false });
    expect((await items("?filter=all")).items).toHaveLength(3);
  });

  it("discovers the feed of a website", async () => {
    await start();
    web.set("https://blog.example/", {
      body: '<html><head><link rel="alternate" type="application/rss+xml" href="/rss"></head></html>',
      contentType: "text/html",
    });
    web.set("https://blog.example/rss", { body: rss("Blog", [{ guid: "p1", title: "Post", date: iso(-3_600_000) }]) });
    const res = await addFeed("https://blog.example/");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ feedUrl: "https://blog.example/rss", siteUrl: "https://blog.example/", title: "Blog" });
  });

  it("adds a YouTube channel from an @handle", async () => {
    await start();
    web.set("https://www.youtube.com/@ExampleCreator", {
      body: '<html><link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"></html>',
      contentType: "text/html",
    });
    web.set("https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv", { body: youtubeFeed });
    const res = await addFeed("@ExampleCreator");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      kind: "youtube",
      title: "Example Creator",
      siteUrl: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
    });
    const all = await items("?filter=all");
    expect(all.items[0]).toMatchObject({ sourceKind: "youtube", imageUrl: "https://i1.ytimg.com/vi/vid00000001/hqdefault.jpg" });
  });

  it("explains why a source can't be added", async () => {
    await start();
    web.set("https://nofeed.example/", { body: "<html><head></head><body>hi</body></html>", contentType: "text/html" });
    web.set("https://guarded.example/", { error: new FetchError("cloudflare_challenge", "challenge", 403) });
    web.set("https://ok.example/feed", { body: rss("OK", []) });

    const bad = await addFeed("javascript:alert(1)");
    expect(bad.statusCode).toBe(400);

    const none = await addFeed("https://nofeed.example/");
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe("no_feed");

    const guarded = await addFeed("https://guarded.example/");
    expect(guarded.statusCode).toBe(422);
    expect(guarded.json().message).toMatch(/bot check/);

    expect((await addFeed("https://missing.example/feed")).json().message).toMatch(/404/);

    expect((await addFeed("https://ok.example/feed")).statusCode).toBe(201);
    const dup = await addFeed("https://ok.example/feed");
    expect(dup.statusCode).toBe(409);
    expect(dup.json().message).toMatch(/already follow/);
  });

  it("checks on schedule, uses ETags, and only adds new items", async () => {
    await start();
    const url = "https://site.example/feed.xml";
    web.set(url, { body: rss("S", [{ guid: "1", title: "One", date: iso(-3_600_000) }]) });
    const src = (await addFeed(url)).json();

    expect(await app!.feeds.dueSourceIds()).toEqual([]);
    clock.now = src.nextCheckAt;
    web.set(url, {
      etag: '"v2"',
      body: rss("S", [
        { guid: "2", title: "Two", date: iso(0) },
        { guid: "1", title: "One", date: iso(-3_600_000) },
      ]),
    });
    await app!.poller.tick();
    app!.poller.stop();
    expect((await items()).items.map((i: { title: string }) => i.title)).toEqual(["Two", "One"]);

    // Unchanged feed → 304, nothing new, still healthy.
    const after = (await call("GET", "/api/sources")).json()[0];
    clock.now = after.nextCheckAt;
    const check = (await call("POST", `/api/sources/${src.id}/check`)).json();
    expect(check.result).toEqual({ ok: true, newItems: 0, notModified: true });
    expect(web.requests.at(-1)!.options.etag).toBe('"v2"');
    expect(check.source).toMatchObject({ status: "ok", itemCount: 2 });
  });

  it("backs off on errors, pauses after repeated failures, and resumes", async () => {
    await start();
    const url = "https://flaky.example/feed";
    web.set(url, { body: rss("Flaky", []) });
    const src = (await addFeed(url)).json();
    web.set(url, { error: new FetchError("error", "unexpected response [HTTP 502]", 502) });

    const gaps: number[] = [];
    let source = src;
    for (let i = 1; i <= 5; i++) {
      clock.now = source.nextCheckAt;
      source = (await call("POST", `/api/sources/${src.id}/check`)).json().source;
      if (source.nextCheckAt) gaps.push(source.nextCheckAt - clock.now);
    }
    // 30 min, 1 h, 2 h, 4 h, then the circuit breaker (5 failures) pauses it.
    expect(gaps).toEqual([30, 60, 120, 240].map((m) => m * 60_000));
    expect(source).toMatchObject({ status: "paused", nextCheckAt: null });
    expect(source.lastError).toMatch(/Paused after 5 failed checks/);

    web.set(url, { body: rss("Flaky", [{ guid: "x", title: "Back", date: iso(0) }]) });
    const resumed = (await call("PATCH", `/api/sources/${src.id}`, { enabled: true })).json();
    expect(resumed).toMatchObject({ status: "pending", nextCheckAt: clock.now });
    await app!.poller.tick();
    app!.poller.stop();
    expect((await call("GET", "/api/sources")).json()[0]).toMatchObject({ status: "ok", unreadCount: 1 });
  });

  it("marks a source that starts serving bot checks as challenged", async () => {
    await start();
    const url = "https://turns.example/feed";
    web.set(url, { body: rss("T", []) });
    const src = (await addFeed(url)).json();
    web.set(url, { error: new FetchError("pow_challenge", "challenge", 200) });
    const res = (await call("POST", `/api/sources/${src.id}/check`)).json();
    expect(res.source.status).toBe("challenged");
    expect(res.source.lastError).toMatch(/bot check/);
  });

  it("pausing stops checks; renaming and intervals stick", async () => {
    await start();
    web.set("https://p.example/feed", { body: rss("P", []) });
    const src = (await addFeed("https://p.example/feed")).json();
    const paused = (await call("PATCH", `/api/sources/${src.id}`, { enabled: false, title: "Renamed", pollIntervalMinutes: 120 })).json();
    expect(paused).toMatchObject({ enabled: false, status: "paused", title: "Renamed", pollIntervalMinutes: 120, nextCheckAt: null });
    clock.now += 10 * DAY;
    expect(await app!.feeds.dueSourceIds()).toEqual([]);
    expect((await call("PATCH", `/api/sources/${src.id}`, { pollIntervalMinutes: 1 })).statusCode).toBe(400);
  });

  it("read, saved, mark all read, paging and deleting", async () => {
    await start();
    web.set("https://a.example/feed", {
      body: rss("A", [1, 2, 3, 4, 5].map((n) => ({ guid: `a${n}`, title: `A${n}`, date: iso(-n * 60_000) }))),
    });
    web.set("https://b.example/feed", { body: rss("B", [{ guid: "b1", title: "B1", date: iso(-90_000) }]) });
    const a = (await addFeed("https://a.example/feed")).json();
    const b = (await addFeed("https://b.example/feed")).json();

    // Paging: 2 per page, newest first, no duplicates or gaps.
    const seen: string[] = [];
    let cursor: string | null = "";
    while (cursor !== null) {
      const page: { items: Array<{ title: string }>; nextCursor: string | null } = await items(`?filter=all&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.items.map((i) => i.title));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["A1", "B1", "A2", "A3", "A4", "A5"]);

    const first = (await items()).items[0];
    expect((await call("PATCH", `/api/items/${first.id}`, { read: true, saved: true })).statusCode).toBe(200);
    expect((await items()).items).toHaveLength(5);
    expect((await items("?filter=saved")).items.map((i: { title: string }) => i.title)).toEqual(["A1"]);
    expect((await call("PATCH", "/api/items/nope", { read: true })).statusCode).toBe(404);

    // "Mark read" only what was on screen: source A, published at or before B1 (90 s ago).
    // A1 (1 min ago) is newer and already read; A2..A5 are older → 4 updated.
    const marked = (await call("POST", "/api/items/mark-read", { sourceId: a.id, upTo: NOW - 90_000 })).json();
    expect(marked.updated).toBe(4);
    expect((await items()).items.map((i: { title: string }) => i.title)).toEqual(["B1"]);
    expect((await call("GET", "/api/sources")).json().map((s: { title: string; unreadCount: number }) => [s.title, s.unreadCount])).toEqual([
      ["A", 0],
      ["B", 1],
    ]);

    // Per-source filter, then delete a source with its items.
    expect((await items(`?filter=all&sourceId=${b.id}`)).items).toHaveLength(1);
    expect((await call("DELETE", `/api/sources/${b.id}`)).statusCode).toBe(200);
    expect((await items("?filter=all")).items.every((i: { sourceTitle: string }) => i.sourceTitle === "A")).toBe(true);
    expect((await call("DELETE", `/api/sources/${b.id}`)).statusCode).toBe(404);
  });
});
