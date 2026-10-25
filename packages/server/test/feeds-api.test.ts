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

  it("finds the feed one folder up when the pasted address is a 404 (D-090)", async () => {
    await start();
    // factorio.com/blog/post is a 404; factorio.com/blog/ advertises the Atom feed.
    web.set("https://game.example/blog/", {
      body: '<html><head><link href="/blog/rss" rel="alternate" title="Recent Blog Posts" type="application/atom+xml"></head></html>',
      contentType: "text/html",
    });
    web.set("https://game.example/blog/rss", { body: rss("Game Blog", [{ guid: "fff-1", title: "Friday Facts #1", date: iso(-3_600_000) }]) });
    const res = await addFeed("game.example/blog/post");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ feedUrl: "https://game.example/blog/rss", siteUrl: "https://game.example/blog/", title: "Game Blog" });

    // Nothing two levels up either: say what was tried. The front page is never tried.
    const miss = await addFeed("https://none.example/a/b/c");
    expect(miss.statusCode).toBe(422);
    expect(miss.json().message).toBe(
      "Nothing found at that address on none.example (404). Also tried https://none.example/a/b/ and https://none.example/a/. If the site has a feed, paste the feed's own address (often ending in /feed, /rss or .xml).",
    );
    expect(web.requests.map((r) => r.url)).not.toContain("https://none.example/");
    // Other failures stop at the pasted address.
    web.set("https://walled.example/x/y", { error: new FetchError("blocked", "forbidden [HTTP 403]", 403) });
    expect((await addFeed("https://walled.example/x/y")).json().message).toMatch(/refused the request \(403\)/);
    expect(web.requests.map((r) => r.url)).not.toContain("https://walled.example/x/");
  });

  it("lists podcast audio, adds it to episodes stored before, and allows it in the CSP (D-093)", async () => {
    await start();
    const feed = (audio: boolean) => `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Pod</title>
      <item><guid>ep1</guid><title>Episode 1</title><link>https://pod.example/ep1</link><pubDate>${new Date(iso(-3_600_000)).toUTCString()}</pubDate>
      ${audio ? '<enclosure url="https://cdn.pod.example/ep1.mp3" type="audio/mpeg"/><itunes:duration>24:30</itunes:duration>' : ""}</item></channel></rss>`;
    // As stored by 1.4.x, which ignored audio.
    web.set("https://pod.example/feed", { body: feed(false) });
    expect((await addFeed("https://pod.example/feed")).statusCode).toBe(201);
    expect((await items("?filter=all")).items[0].audio).toBeNull();
    web.set("https://pod.example/feed", { body: feed(true) });
    const source = (await app!.fastify.inject({ method: "GET", url: "/api/sources", headers: { cookie } })).json()[0];
    await app!.fastify.inject({ method: "POST", url: `/api/sources/${source.id}/check`, headers: { cookie, ...CSRF } });
    const listed = await items("?filter=all");
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].audio).toEqual({ url: "https://cdn.pod.example/ep1.mp3", durationSeconds: 1470 });
    // The episode page can't be read (404 here): the description, without a warning.
    const reader = (await call("GET", `/api/items/${listed.items[0].id}/reader`)).json();
    expect(reader).toMatchObject({ kind: "summary", notice: null });

    const page = await app!.fastify.inject({ method: "GET", url: "/" });
    expect(page.headers["content-security-policy"]).toMatch(/media-src 'self' https: http:/);
  });

  it("finds a WordPress section's own feed when the page advertises only the site's (D-103)", async () => {
    await start();
    // Shaped like science.nasa.gov/earth/: a WordPress page advertising only /feed/ (everything).
    const page = '<html><head><meta name="generator" content="WordPress 7.0.7"><link rel="alternate" type="application/rss+xml" title="Site &raquo; Feed" href="https://wp.example/feed/"></head><body><img src="/wp-content/x.jpg"></body></html>';
    web.set("https://wp.example/earth/", { body: page, contentType: "text/html" });
    web.set("https://wp.example/feed/", { body: rss("Everything", [{ guid: "s1", title: "Seminar", date: iso(-3_600_000) }]) });
    // …/earth/feed/ is the page's comments; /category/earth/feed/ the section's articles.
    web.set("https://wp.example/earth/feed/", { body: rss("Comments on: Earth", [{ guid: "c1", title: "By: someone", date: iso(-3_600_000) }]) });
    web.set("https://wp.example/category/earth/feed/", { body: rss("Earth", [{ guid: "e1", title: "El Niño Then and Now", date: iso(-3_600_000) }]) });
    const res = await addFeed("https://wp.example/earth/");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ feedUrl: "https://wp.example/category/earth/feed/", siteUrl: "https://wp.example/earth/", title: "Earth" });

    // No section feed: the advertised one, as before. Not WordPress: nothing extra is tried.
    web.set("https://wp.example/mars/", { body: page, contentType: "text/html" });
    expect((await addFeed("https://wp.example/mars/")).json()).toMatchObject({ feedUrl: "https://wp.example/feed/" });
    web.set("https://other.example/news/", { body: '<link rel="alternate" type="application/rss+xml" href="/feed/">', contentType: "text/html" });
    web.set("https://other.example/feed/", { body: rss("Other", [{ guid: "o1", title: "Story", date: iso(-3_600_000) }]) });
    const before = web.requests.length;
    expect((await addFeed("https://other.example/news/")).json()).toMatchObject({ feedUrl: "https://other.example/feed/" });
    expect(web.requests.slice(before).map((r) => r.url)).toEqual(["https://other.example/news/", "https://other.example/feed/"]);
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

  it("follows YouTube's redirect to the mobile page and uses the advertised feed", async () => {
    await start();
    // What YouTube actually served the app's User-Agent on 2026-10-19: a redirect to m.youtube.com,
    // with the feed advertised in a <link> and the ID in itemprop="identifier".
    web.set("https://www.youtube.com/@ImKibitz", {
      finalUrl: "https://m.youtube.com/@ImKibitz",
      contentType: "text/html",
      body: '<html><head><link rel="canonical" href="https://www.youtube.com/@ImKibitz"><link rel="alternate" type="application/rss+xml" title="RSS" href="https://www.youtube.com/feeds/videos.xml?channel_id=UCz9qw5nupdzCGwHwQiqs7qA"><meta itemprop="identifier" content="UCz9qw5nupdzCGwHwQiqs7qA"></head></html>',
    });
    web.set("https://www.youtube.com/feeds/videos.xml?channel_id=UCz9qw5nupdzCGwHwQiqs7qA", { body: youtubeFeed });
    const res = await addFeed("https://www.youtube.com/@ImKibitz");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: "youtube", siteUrl: "https://www.youtube.com/channel/UCz9qw5nupdzCGwHwQiqs7qA" });
  });

  it("says clearly when YouTube found the channel but not its feed, or showed a consent page", async () => {
    await start();
    web.set("https://www.youtube.com/@Broken", {
      contentType: "text/html",
      body: '<meta itemprop="identifier" content="UCabcdefghijklmnopqrstuv">',
    });
    web.set("https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv", { error: new FetchError("error", "unexpected response [HTTP 500]", 500) });
    const broken = await addFeed("@Broken");
    expect(broken.json()).toMatchObject({ error: "youtube_feed_failed" });
    expect(broken.json().message).toMatch(/Found the channel, but YouTube didn't return its video feed .*HTTP 500/);

    web.set("https://www.youtube.com/@EuViewer", { finalUrl: "https://consent.youtube.com/m?continue=x", contentType: "text/html", body: "<html>consent</html>" });
    expect((await addFeed("@EuViewer")).json()).toMatchObject({ error: "youtube_consent" });
  });

  it("turns old.reddit links into the www .rss feed, and explains Reddit blocks", async () => {
    await start();
    web.set("https://www.reddit.com/r/overclocking/.rss", {
      body: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>overclocking</title><entry><id>t3_1</id><title>New BIOS</title><link href="https://www.reddit.com/r/overclocking/comments/1/new_bios/"/><updated>2026-10-15T11:00:00Z</updated></entry></feed>',
    });
    const ok = await addFeed("https://old.reddit.com/r/overclocking/");
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ kind: "reddit", feedUrl: "https://www.reddit.com/r/overclocking/.rss", siteUrl: "https://www.reddit.com/r/overclocking/" });
    expect(web.requests.map((r) => r.url)).toEqual(["https://www.reddit.com/r/overclocking/.rss"]);

    // What Reddit served this build environment: a 403 "blocked due to a network policy" page.
    web.set("https://www.reddit.com/r/blocked/.rss", { error: new FetchError("blocked", "refused (401/403) [HTTP 403]", 403) });
    const blocked = await addFeed("https://www.reddit.com/r/blocked/");
    expect(blocked.json()).toMatchObject({ error: "reddit_blocked" });
    expect(blocked.json().message).toMatch(/Reddit blocks apps that aren't registered/);
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

    // Timeline order: oldest first, same guarantees.
    const oldest: string[] = [];
    cursor = "";
    while (cursor !== null) {
      const page: { items: Array<{ title: string }>; nextCursor: string | null } = await items(`?filter=all&order=oldest&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      oldest.push(...page.items.map((i) => i.title));
      cursor = page.nextCursor;
    }
    expect(oldest).toEqual(["A5", "A4", "A3", "A2", "B1", "A1"]);

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
    // Source checkboxes: unticked sources are left out (unknown IDs are ignored).
    expect((await items(`?filter=all&excludeSourceIds=${a.id}`)).items.map((i: { title: string }) => i.title)).toEqual(["B1"]);
    expect((await items(`?filter=all&excludeSourceIds=gone-source`)).items).toHaveLength(6);
    expect((await items(`?filter=all&excludeSourceIds=${a.id},${b.id}`)).items).toEqual([]);
    expect((await call("POST", "/api/items/mark-read", { excludeSourceIds: [a.id, b.id] })).json().updated).toBe(0);
    expect((await call("POST", "/api/items/mark-read", { excludeSourceIds: [a.id] })).json().updated).toBe(1);
    await call("PATCH", `/api/items/${(await items(`?filter=all&sourceId=${b.id}`)).items[0].id}`, { read: false });
    expect((await call("DELETE", `/api/sources/${b.id}`)).statusCode).toBe(200);
    expect((await items("?filter=all")).items.every((i: { sourceTitle: string }) => i.sourceTitle === "A")).toBe(true);
    expect((await call("DELETE", `/api/sources/${b.id}`)).statusCode).toBe(404);
  });
});
