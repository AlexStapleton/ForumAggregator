// Per-source reader selectors and the preview (D-074).
import { afterEach, describe, expect, it } from "vitest";
import { extractWithSelectors, isValidSelector } from "../src/reader/extract.js";
import { FakeWeb, rss } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

// A forum-style page Readability tends to get wrong: the post is small next to the chrome.
const PAGE = `<!doctype html><html><head><title>Thread</title></head><body>
  <nav>Forums › Hardware</nav>
  <div class="post"><div class="message-body">First post about undervolting.<div class="share">Share · Report</div></div></div>
  <div class="post"><div class="message-body">Second post: <img src="https://img.example/chart.png"> works at 0.9 V.</div></div>
  <aside class="related">${"Related thread. ".repeat(60)}</aside>
</body></html>`;

describe("extractWithSelectors", () => {
  it("uses every match in page order, after removing unwanted elements", () => {
    const r = extractWithSelectors(PAGE, "https://forum.example/t/1", { article: ".message-body", remove: ".share, nav" });
    expect(r.matched).toBe(2);
    expect(r.removed).toBe(2);
    expect(r.article?.html).toContain("First post about undervolting.");
    expect(r.article?.html).toContain('src="https://img.example/chart.png"');
    expect(r.article?.html).not.toMatch(/Share · Report|Related thread|Forums/);
    expect(r.article!.html.indexOf("First")).toBeLessThan(r.article!.html.indexOf("Second"));
  });

  it("keeps only the outermost of nested matches, and reports no match", () => {
    const nested = extractWithSelectors(PAGE, "https://forum.example/t/1", { article: ".post, .message-body" });
    expect(nested.matched).toBe(2);
    expect(nested.article!.html.match(/First post/g)).toHaveLength(1);
    expect(extractWithSelectors(PAGE, "https://forum.example/t/1", { article: ".nothing-here" })).toMatchObject({ article: null, matched: 0 });
  });

  it("validates selectors", () => {
    expect(isValidSelector("article .body > p:not(.ad)")).toBe(true);
    expect(isValidSelector("div[")).toBe(false);
    expect(isValidSelector("<script>")).toBe(false);
  });
});

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const NOW = Date.UTC(2026, 9, 19, 12);

describe.each(backends)("reader selectors API (%s)", (backend) => {
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
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
    app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });
  const pageFetches = () => web.requests.filter((r) => r.url === "https://forum.example/t/1").length;

  /** A feed whose items carry a full-length body, linking to PAGE. */
  async function addForumFeed() {
    const body = `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Forum</title>
      <item><guid>1</guid><title>Undervolting thread</title><link>https://forum.example/t/1</link><pubDate>${new Date(NOW - 60_000).toUTCString()}</pubDate>
      <content:encoded><![CDATA[<p>${"Feed text. ".repeat(80)}</p>]]></content:encoded></item></channel></rss>`;
    web.set("https://forum.example/feed", { body });
    web.set("https://forum.example/t/1", { body: PAGE, contentType: "text/html" });
    const src = (await call("POST", "/api/sources", { url: "https://forum.example/feed" })).json();
    const item = (await call("GET", "/api/items")).json().items[0];
    return { src, item };
  }

  it("previews without saving, then reads the page with saved selectors and re-reads after a change", async () => {
    await start();
    const { src, item } = await addForumFeed();
    // Without selectors the feed's own text is used and the page isn't fetched.
    expect((await call("GET", `/api/items/${item.id}/reader`)).json()).toMatchObject({ kind: "feed" });
    expect(pageFetches()).toBe(0);

    const preview = (await call("POST", `/api/sources/${src.id}/reader-preview`, { articleSelector: ".message-body", removeSelector: ".share" })).json();
    expect(preview).toMatchObject({ itemId: item.id, itemTitle: "Undervolting thread", url: "https://forum.example/t/1", matched: 2, removed: 1, notice: null });
    expect(preview.html).toContain("Second post");
    expect(preview.html).not.toContain("Share · Report");
    // Still nothing saved.
    expect((await call("GET", "/api/sources")).json()[0]).toMatchObject({ articleSelector: null, removeSelector: null });
    expect((await call("GET", `/api/items/${item.id}/reader`)).json().kind).toBe("feed");

    const saved = (await call("PATCH", `/api/sources/${src.id}`, { articleSelector: " .message-body ", removeSelector: ".share" })).json();
    expect(saved).toMatchObject({ articleSelector: ".message-body", removeSelector: ".share" });
    const r = (await call("GET", `/api/items/${item.id}/reader`)).json();
    expect(r).toMatchObject({ kind: "page", notice: null });
    expect(r.html).toContain("First post about undervolting.");
    expect(r.html).not.toMatch(/Feed text|Share · Report/);
    const fetched = pageFetches();
    await call("GET", `/api/items/${item.id}/reader`);
    expect(pageFetches()).toBe(fetched); // cached

    // Changing a selector re-reads the page; an empty string clears it.
    await call("PATCH", `/api/sources/${src.id}`, { removeSelector: "" });
    expect((await call("GET", `/api/items/${item.id}/reader`)).json().html).toContain("Share · Report");
    expect(pageFetches()).toBe(fetched + 1);
    expect((await call("GET", "/api/sources")).json()[0].removeSelector).toBeNull();
  });

  it("falls back to the feed's text with a reason when the selector matches nothing", async () => {
    await start();
    const { src, item } = await addForumFeed();
    await call("PATCH", `/api/sources/${src.id}`, { articleSelector: ".does-not-exist" });
    const r = (await call("GET", `/api/items/${item.id}/reader`)).json();
    expect(r).toMatchObject({ kind: "feed" });
    expect(r.html).toContain("Feed text.");
    expect(r.notice).toMatch(/matched nothing.*feed's text/);
    // Fixing the selector takes effect on the next open.
    await call("PATCH", `/api/sources/${src.id}`, { articleSelector: ".message-body" });
    expect((await call("GET", `/api/items/${item.id}/reader`)).json()).toMatchObject({ kind: "page", notice: null });

    const miss = (await call("POST", `/api/sources/${src.id}/reader-preview`, { articleSelector: ".nope" })).json();
    expect(miss).toMatchObject({ html: null, matched: 0 });
    expect(miss.notice).toMatch(/matched nothing/);
  });

  it("rejects invalid selectors, and previews for non-feed or unknown sources", async () => {
    await start();
    const { src } = await addForumFeed();
    const bad = await call("PATCH", `/api/sources/${src.id}`, { articleSelector: "div[", removeSelector: ".ok" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields).toEqual({ articleSelector: "That isn't a valid CSS selector" });
    expect((await call("GET", "/api/sources")).json()[0]).toMatchObject({ articleSelector: null, removeSelector: null });
    const badPreview = await call("POST", `/api/sources/${src.id}/reader-preview`, { removeSelector: "<b>" });
    expect(badPreview.json().fields).toEqual({ removeSelector: "That isn't a valid CSS selector" });
    expect(web.requests.filter((r) => r.url === "https://forum.example/t/1")).toHaveLength(0);

    expect((await call("POST", "/api/sources/nope/reader-preview", {})).statusCode).toBe(404);
    web.set("https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv", {
      body: rss("Creator", [{ guid: "v", title: "Video", date: new Date(NOW).toISOString(), link: "https://www.youtube.com/watch?v=vid00000001" }]),
    });
    const yt = (await call("POST", "/api/sources", { url: "UCabcdefghijklmnopqrstuv" })).json();
    const ytPreview = await call("POST", `/api/sources/${yt.id}/reader-preview`, { articleSelector: "p" });
    expect(ytPreview.statusCode).toBe(400);
    expect(ytPreview.json().error).toBe("preview_unavailable");
  });
});
