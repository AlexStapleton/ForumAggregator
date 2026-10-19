import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FetchError, HostLimiter } from "../src/feeds/fetch.js";
import { cleanRedditHtml, cleanRedditSummary, redditCommentsFeedUrl } from "../src/feeds/reddit.js";
import { FakeWeb, rss } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures/feeds", name), "utf8");
const NOW = Date.UTC(2026, 9, 19, 12);

describe("Reddit helpers", () => {
  it("removes the 'submitted by' footer from summaries", () => {
    expect(cleanRedditSummary("Is it worth it? submitted by /u/4yper9ktiv [link] [comments]")).toBe("Is it worth it?");
    expect(cleanRedditSummary("submitted by /u/x [link] [comments]")).toBeNull();
    expect(cleanRedditSummary("Nothing to remove")).toBe("Nothing to remove");
    expect(cleanRedditSummary(null)).toBeNull();
  });

  it("drops the footer from HTML but keeps the external link of link posts", () => {
    const selfPost = '<div class="md"><p>Body</p></div> &#32; submitted by &#32; <a href="https://www.reddit.com/user/a"> /u/a </a> <br/> <span><a href="https://www.reddit.com/r/x/comments/1/t/">[link]</a></span>';
    expect(cleanRedditHtml(selfPost)).toBe('<div class="md"><p>Body</p></div>');
    const linkPost = '<table><tr><td> &#32; submitted by &#32; <a href="https://www.reddit.com/user/b"> /u/b </a> <br/> <span><a href="https://news.example/gpu-review?a=1&amp;b=2">[link]</a></span>';
    expect(cleanRedditHtml(linkPost)).toContain('Linked: <a href="https://news.example/gpu-review?a=1&b=2"');
  });

  it("builds the comments feed of a post", () => {
    expect(redditCommentsFeedUrl("https://www.reddit.com/r/overclocking/comments/1abc/slow_readcopy/")).toBe(
      "https://www.reddit.com/r/overclocking/comments/1abc/slow_readcopy/.rss",
    );
    expect(redditCommentsFeedUrl("https://old.reddit.com/r/x/comments/abc")).toBe("https://www.reddit.com/r/x/comments/abc/.rss");
    expect(redditCommentsFeedUrl("https://www.reddit.com/r/x/")).toBeNull();
    expect(redditCommentsFeedUrl("https://evil.example/r/x/comments/abc/")).toBeNull();
  });

  it("spaces Reddit requests at least 10 s apart, even interactive ones", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new HostLimiter(5000, 0, async (ms) => {
      waits.push(ms);
      now += ms;
    }, () => now);
    await limiter.wait("https://www.reddit.com/r/a/.rss");
    await limiter.wait("https://www.reddit.com/r/b/.rss", { minDelayMs: 1000, jitterMs: 0 });
    await limiter.wait("https://www.reddit.com/r/c/.rss");
    expect(waits).toEqual([10_000, 10_000]);
  });
});

describe.each(backends)("Reddit and forum links in the app (%s)", (backend) => {
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
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
    const res = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" }, headers: CSRF });
    cookie = sessionCookie(res)!;
  }
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });

  it("shows Reddit posts from the feed, never fetching Reddit's pages, with clean summaries", async () => {
    await start();
    web.set("https://www.reddit.com/r/overclocking/.rss", { body: fixture("reddit.xml") });
    expect((await call("POST", "/api/sources", { url: "https://old.reddit.com/r/overclocking/" })).statusCode).toBe(201);
    const [selfPost, linkPost] = (await call("GET", "/api/items")).json().items;
    expect(selfPost.summary).toBe("Some people can get 70/95+/70 and some say 65/95/65 is normal. Is it worth trying to fix?");

    const r1 = (await call("GET", `/api/items/${selfPost.id}/reader`)).json();
    expect(r1).toMatchObject({ kind: "feed", notice: null });
    expect(r1.html).toContain("Is it worth trying to fix?");
    expect(r1.html).not.toMatch(/submitted by|\[comments\]/);

    const r2 = (await call("GET", `/api/items/${linkPost.id}/reader`)).json();
    expect(r2.html).toContain('href="https://news.example/gpu-review"');

    expect(web.requests.some((q) => q.url.includes("/comments/"))).toBe(false);
  });

  it("loads Reddit comments on request, skips the post itself, sanitises and caches", async () => {
    await start();
    web.set("https://www.reddit.com/r/overclocking/.rss", { body: fixture("reddit.xml") });
    web.set("https://www.reddit.com/r/overclocking/comments/1abc/slow_readcopy/.rss", { body: fixture("reddit-comments.xml") });
    await call("POST", "/api/sources", { url: "https://www.reddit.com/r/overclocking/" });
    const post = (await call("GET", "/api/items")).json().items[0];

    const c = (await call("GET", `/api/items/${post.id}/comments`)).json();
    expect(c).toMatchObject({ available: true, notice: null, discussionUrl: post.url });
    expect(c.comments.map((x: { author: string }) => x.author)).toEqual(["/u/timings_guy", "/u/second"]);
    expect(c.comments[0].html).toContain("<strong>tRFC</strong>");
    expect(c.comments[0].html).not.toMatch(/script|alert/);

    const before = web.requests.length;
    await call("GET", `/api/items/${post.id}/comments`);
    expect(web.requests.length).toBe(before); // cached
  });

  it("explains Reddit's rate limit on comments", async () => {
    await start();
    web.set("https://www.reddit.com/r/overclocking/.rss", { body: fixture("reddit.xml") });
    web.set("https://www.reddit.com/r/overclocking/comments/1abc/slow_readcopy/.rss", { error: new FetchError("rate_limited", "rate limited (429)", 429) });
    await call("POST", "/api/sources", { url: "https://www.reddit.com/r/overclocking/" });
    const post = (await call("GET", "/api/items")).json().items[0];
    expect((await call("GET", `/api/items/${post.id}/comments`)).json()).toMatchObject({ comments: [], notice: expect.stringMatching(/limiting requests/) });
  });

  it("says non-Reddit items have no comments, and uses a short feed body only if the page fails", async () => {
    await start();
    const body = `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>B</title>
      <item><guid>1</guid><title>Short</title><link>https://b.example/1</link><content:encoded><![CDATA[<p>A short but real body.</p>]]></content:encoded></item></channel></rss>`;
    web.set("https://b.example/feed", { body });
    web.set("https://b.example/1", { error: new FetchError("blocked", "refused [HTTP 403]", 403) });
    await call("POST", "/api/sources", { url: "https://b.example/feed" });
    const item = (await call("GET", "/api/items")).json().items[0];
    expect((await call("GET", `/api/items/${item.id}/comments`)).json()).toMatchObject({ available: false });
    const r = (await call("GET", `/api/items/${item.id}/reader`)).json();
    expect(web.requests.some((q) => q.url === "https://b.example/1")).toBe(true); // tried the page first
    expect(r).toMatchObject({ kind: "feed" });
    expect(r.html).toContain("A short but real body.");
  });

  // Thread links are followed since D-084 (thread-follow.test.ts).
  it("reads board RSS directly", async () => {
    await start();
    // The board page itself would show a bot check; its RSS is fetched directly instead.
    web.set("https://forum.example/forums/nvidia.12/", { error: new FetchError("pow_challenge", "challenge", 200) });
    web.set("https://forum.example/forums/nvidia.12/index.rss", { body: rss("NVIDIA", [{ guid: "t1", title: "New thread", date: new Date(NOW - 60_000).toISOString() }]) });
    const board = await call("POST", "/api/sources", { url: "https://forum.example/forums/nvidia.12/" });
    expect(board.statusCode).toBe(201);
    expect(board.json()).toMatchObject({ feedUrl: "https://forum.example/forums/nvidia.12/index.rss", siteUrl: "https://forum.example/forums/nvidia.12/" });
    expect(web.requests.map((q) => q.url)).toEqual(["https://forum.example/forums/nvidia.12/index.rss"]);
  });
});
