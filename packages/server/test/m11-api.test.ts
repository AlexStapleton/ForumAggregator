// Tags, editing sources, retention and the reader (M1.1).
import { afterEach, describe, expect, it } from "vitest";
import { FetchError } from "../src/feeds/fetch.js";
import { FakeWeb, rss } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const NOW = Date.UTC(2026, 9, 19, 12);
const DAY = 24 * 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe.each(backends)("M1.1 (%s)", (backend) => {
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
  const titles = async (query: string) => (await call("GET", `/api/items${query}`)).json().items.map((i: { title: string }) => i.title);

  describe("tags", () => {
    it("normalises tags, shows them on items, filters by them, and applies edits retroactively", async () => {
      await start();
      web.set("https://npr.example/rss", { body: rss("NPR", [{ guid: "n1", title: "News 1", date: iso(-60_000) }]) });
      web.set("https://gpu.example/rss", { body: rss("GPU", [{ guid: "g1", title: "GPU 1", date: iso(-120_000) }]) });
      const npr = (await call("POST", "/api/sources", { url: "https://npr.example/rss", tags: [" News ", "Politics", "news", ""] })).json();
      expect(npr.tags).toEqual(["news", "politics"]);
      const gpu = (await call("POST", "/api/sources", { url: "https://gpu.example/rss", tags: ["GPU Tuning"] })).json();
      expect(gpu.tags).toEqual(["gpu-tuning"]);

      const items = (await call("GET", "/api/items")).json().items;
      expect(items.map((i: { title: string; tags: string[] }) => [i.title, i.tags])).toEqual([
        ["News 1", ["news", "politics"]],
        ["GPU 1", ["gpu-tuning"]],
      ]);
      expect(await titles("?tag=news")).toEqual(["News 1"]);
      expect(await titles("?tag=nope")).toEqual([]);

      expect((await call("GET", "/api/tags")).json()).toEqual([
        { tag: "gpu-tuning", sources: 1, unread: 1 },
        { tag: "news", sources: 1, unread: 1 },
        { tag: "politics", sources: 1, unread: 1 },
      ]);

      // Editing tags changes what existing items show.
      await call("PATCH", `/api/sources/${gpu.id}`, { tags: ["pc", "news"] });
      expect(await titles("?tag=news")).toEqual(["News 1", "GPU 1"]);
      expect((await call("GET", "/api/items")).json().items[1].tags).toEqual(["news", "pc"]);
    });
  });

  describe("editing a source", () => {
    it("renames, changes interval, and moves to a new address keeping existing items", async () => {
      await start();
      web.set("https://old.example/feed", { body: rss("Old", [{ guid: "a", title: "From old", date: iso(-60_000) }]) });
      web.set("https://new.example/feed", { body: rss("New", [{ guid: "b", title: "From new", date: iso(-30_000) }]) });
      const src = (await call("POST", "/api/sources", { url: "https://old.example/feed" })).json();

      const edited = (await call("PATCH", `/api/sources/${src.id}`, { title: "My blog", pollIntervalMinutes: 60, url: "https://new.example/feed" })).json();
      expect(edited).toMatchObject({ title: "My blog", pollIntervalMinutes: 60, feedUrl: "https://new.example/feed", status: "ok", itemCount: 2 });
      expect(await titles("?filter=all")).toEqual(["From new", "From old"]);
    });

    it("checks the new address before saving and refuses duplicates", async () => {
      await start();
      web.set("https://a.example/feed", { body: rss("A", []) });
      web.set("https://b.example/feed", { body: rss("B", []) });
      const a = (await call("POST", "/api/sources", { url: "https://a.example/feed" })).json();
      await call("POST", "/api/sources", { url: "https://b.example/feed" });

      const broken = await call("PATCH", `/api/sources/${a.id}`, { url: "https://missing.example/feed" });
      expect(broken.statusCode).toBe(422);
      expect((await call("GET", "/api/sources")).json().find((s: { id: string }) => s.id === a.id).feedUrl).toBe("https://a.example/feed");

      const dup = await call("PATCH", `/api/sources/${a.id}`, { url: "https://b.example/feed" });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().message).toMatch(/already followed as “B”/);
    });
  });

  describe("retention", () => {
    it("deletes unsaved items older than the source keeps, and doesn't re-add them", async () => {
      await start();
      const url = "https://r.example/feed";
      const feed = rss("R", [
        { guid: "new", title: "Recent", date: iso(-2 * DAY) },
        { guid: "mid", title: "Mid", date: iso(-10 * DAY) },
        { guid: "old", title: "Ancient", date: iso(-40 * DAY) },
      ]);
      web.set(url, { body: feed });
      const src = (await call("POST", "/api/sources", { url })).json();
      expect(src.retentionDays).toBeNull(); // global default: keep forever
      const all = (await call("GET", "/api/items?filter=all")).json().items;
      const mid = all.find((i: { title: string }) => i.title === "Mid");
      await call("PATCH", `/api/items/${mid.id}`, { saved: true });

      // Keep 7 days: "Ancient" goes, "Mid" stays because it's saved.
      const updated = (await call("PATCH", `/api/sources/${src.id}`, { retentionDays: 7 })).json();
      expect(updated).toMatchObject({ retentionDays: 7, itemCount: 2 });
      expect(await titles("?filter=all")).toEqual(["Recent", "Mid"]);

      // The feed still lists "Ancient", but it isn't added back.
      clock.now = updated.nextCheckAt;
      await call("POST", `/api/sources/${src.id}/check`);
      expect(await titles("?filter=all")).toEqual(["Recent", "Mid"]);

      // Time passes: "Recent" ages out too (on the next retention run).
      clock.now = NOW + 6 * DAY;
      expect(await app!.feeds.applyRetention()).toBe(1);
      expect(await titles("?filter=all")).toEqual(["Mid"]);

      // Back to "forever" stops deleting.
      await call("PATCH", `/api/sources/${src.id}`, { retentionDays: 0 });
      clock.now = NOW + 400 * DAY;
      expect(await app!.feeds.applyRetention()).toBe(0);
    });
  });

  describe("reader", () => {
    const article = (n: number) =>
      `<!doctype html><html><head><title>A</title></head><body><nav>Menu</nav><article><h1>Story</h1>${Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} with enough words to be considered a real part of an article about bikes.</p>`).join("")}<script>track()</script></article></body></html>`;

    it("shows full text from the feed, sanitised, without fetching the page", async () => {
      await start();
      const body = `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Blog</title>
        <item><guid>1</guid><title>Full</title><link>https://blog.example/1</link><pubDate>${new Date(NOW - 60_000).toUTCString()}</pubDate>
        <content:encoded><![CDATA[<p>${"Long text. ".repeat(80)}</p><script>alert(1)</script><img src="/i.jpg" onerror="x()">]]></content:encoded></item></channel></rss>`;
      web.set("https://blog.example/feed", { body });
      await call("POST", "/api/sources", { url: "https://blog.example/feed" });
      const item = (await call("GET", "/api/items")).json().items[0];
      const before = web.requests.length;

      const r = (await call("GET", `/api/items/${item.id}/reader`)).json();
      expect(r).toMatchObject({ kind: "feed", title: "Full", url: "https://blog.example/1", sourceTitle: "Blog", notice: null });
      expect(r.html).toContain("Long text.");
      expect(r.html).not.toMatch(/script|onerror|alert/);
      expect(r.html).toContain('src="https://blog.example/i.jpg"');
      expect(web.requests.length).toBe(before); // no page fetch
    });

    it("extracts the article from the page once and caches it", async () => {
      await start();
      web.set("https://news.example/feed", { body: rss("News", [{ guid: "s1", title: "Story", date: iso(-60_000), link: "https://news.example/story" }]) });
      web.set("https://news.example/story", { body: article(8), contentType: "text/html; charset=utf-8" });
      await call("POST", "/api/sources", { url: "https://news.example/feed" });
      const item = (await call("GET", "/api/items")).json().items[0];

      const r = (await call("GET", `/api/items/${item.id}/reader`)).json();
      expect(r.kind).toBe("page");
      expect(r.html).toContain("Paragraph 7");
      expect(r.html).not.toMatch(/Menu|track\(/);
      const fetches = web.requests.filter((q) => q.url === "https://news.example/story").length;
      await call("GET", `/api/items/${item.id}/reader`);
      expect(web.requests.filter((q) => q.url === "https://news.example/story").length).toBe(fetches); // cached
    });

    it("falls back to the summary with a reason, and doesn't retry a blocked page right away", async () => {
      await start();
      web.set("https://guarded.example/feed", {
        body: rss("Guarded", [
          { guid: "p", title: "Paywalled", date: iso(-60_000), link: "https://guarded.example/paywall" },
          { guid: "b", title: "Blocked", date: iso(-90_000), link: "https://guarded.example/blocked" },
        ]),
      });
      web.set("https://guarded.example/paywall", { body: article(1).replace(/Paragraph 0[^<]*/, "Subscribe to read."), contentType: "text/html" });
      web.set("https://guarded.example/blocked", { error: new FetchError("cloudflare_challenge", "challenge", 403) });
      await call("POST", "/api/sources", { url: "https://guarded.example/feed" });
      const [paywalled, blocked] = (await call("GET", "/api/items")).json().items;

      const p = (await call("GET", `/api/items/${paywalled.id}/reader`)).json();
      expect(p).toMatchObject({ kind: "summary", html: null });
      expect(p.notice).toMatch(/paywall/);

      const b = (await call("GET", `/api/items/${blocked.id}/reader`)).json();
      expect(b.notice).toMatch(/bot check/);
      const tries = web.requests.filter((q) => q.url === "https://guarded.example/blocked").length;
      await call("GET", `/api/items/${blocked.id}/reader`);
      expect(web.requests.filter((q) => q.url === "https://guarded.example/blocked").length).toBe(tries);
      // After a day it's tried again.
      clock.now += 25 * 3_600_000;
      await call("GET", `/api/items/${blocked.id}/reader`);
      expect(web.requests.filter((q) => q.url === "https://guarded.example/blocked").length).toBe(tries + 1);
    });

    it("returns the video for YouTube items and 404 for unknown items", async () => {
      await start();
      web.set("https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv", {
        body: rss("Creator", [{ guid: "v", title: "Video", date: iso(-60_000), link: "https://www.youtube.com/watch?v=vid00000001" }]),
      });
      await call("POST", "/api/sources", { url: "UCabcdefghijklmnopqrstuv" });
      const item = (await call("GET", "/api/items")).json().items[0];
      expect((await call("GET", `/api/items/${item.id}/reader`)).json()).toMatchObject({ kind: "video", videoId: "vid00000001" });
      expect((await call("GET", "/api/items/nope/reader")).statusCode).toBe(404);
    });
  });
});
