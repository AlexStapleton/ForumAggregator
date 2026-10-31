import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectThreadPage, parseThreadPage } from "../src/feeds/thread.js";
import { extractWithSelectors } from "../src/reader/extract.js";
import { pageParser, PageParser, runPageJob } from "../src/reader/pageParser.js";
import { validateThreadResponse } from "../src/reader/threadQuality.js";
import { FakeWeb } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const URL = "https://forum.example/threads/memory.42/";
const post = (id: number, body = "A reply", wrapper = "bbWrapper") => `<article class="message" data-content="post-${id}"><div class="${wrapper}">${body}</div></article>`;
const page = (posts: string, n = 1, total = 1) => `<html><head><title>Memory | Forum</title></head><body><h1 class="p-title-value">Memory</h1><nav class="pageNav"><a aria-current="page">${n}/${total}</a></nav>${posts}</body></html>`;

describe("thread extraction evidence", () => {
  it.each(["x", "🙂", '<img src="https://images.example/result.png">'])("accepts short and media-only replies: %s", (body) => {
    const result = inspectThreadPage(page(post(1, body)), URL);
    expect(result.status).toBe("complete");
    expect(result.counts).toMatchObject({ candidates: 1, bodies: 1, usable: 1, stableIds: 1 });
  });

  it("detects a missing body among ten posts, with optional author/time omitted", () => {
    const html = page(Array.from({ length: 10 }, (_, i) => post(i + 1, "Reply", i === 4 ? "changed-layout" : "bbWrapper")).join(""));
    const result = inspectThreadPage(html, URL);
    expect(result).toMatchObject({ status: "partial", codes: ["missing-body"], counts: { candidates: 10, bodies: 9, usable: 9 } });
    expect(result.value?.posts).toHaveLength(9);
    expect(parseThreadPage(html, URL)).toBeNull();
  });

  it("detects empty sanitized bodies and missing stable IDs without treating ID gaps as failure", () => {
    expect(inspectThreadPage(page(post(1, '<script>bad()</script>')), URL)).toMatchObject({ status: "partial", codes: ["empty-body"] });
    expect(inspectThreadPage(page(post(1).replace('data-content="post-1"', "")), URL)).toMatchObject({ status: "partial", codes: ["missing-id"] });
    expect(inspectThreadPage(page(post(1) + post(100)), URL).status).toBe("complete");
    expect(inspectThreadPage(page(post(1) + '<article class="message">A site notification</article>'), URL).status).toBe("complete");
  });

  it("ignores hidden duplicates and handles nested Overclock posts once", () => {
    const fixture = fs.readFileSync(new globalThis.URL("./fixtures/pages/overclock-nested-thread.html", import.meta.url), "utf8");
    expect(inspectThreadPage(fixture, `${URL}page-3`)).toMatchObject({ status: "complete", counts: { candidates: 3, bodies: 3, usable: 3 } });
    expect(inspectThreadPage(page(`<div hidden>${post(1, "Hidden")}</div>${post(1)}${post(1)}`), URL))
      .toMatchObject({ status: "complete", counts: { candidates: 1, usable: 1, duplicates: 1 } });
  });

  it("detects missing vBulletin bodies using post wrappers and deduplicates copies", () => {
    const html = '<meta name="generator" content="vBulletin"><div id="post1"><div id="post_message_1">Good</div></div><div id="post2"><a class="bigusername">Member</a></div>';
    expect(inspectThreadPage(html, "https://forum.example/showthread.php?t=42"))
      .toMatchObject({ status: "partial", codes: ["missing-body"], counts: { candidates: 2, bodies: 1, usable: 1 } });
    const good = '<div id="post1"><div id="post_message_1">Good</div></div>';
    expect(inspectThreadPage(good + good, URL)).toMatchObject({ status: "complete", counts: { candidates: 1, usable: 1, duplicates: 1 } });
  });

  it("distinguishes login, challenges, deleted pages and unknown layouts", () => {
    expect(inspectThreadPage('<title>Log in</title><form><input type="password"></form>', URL)).toMatchObject({ status: "access-blocked", codes: ["login"] });
    expect(inspectThreadPage('<div id="challenge-running">Please wait</div>', URL)).toMatchObject({ status: "access-blocked", codes: ["challenge"] });
    expect(inspectThreadPage('<div class="blockMessage">This thread has been deleted.</div>', URL)).toMatchObject({ status: "empty", codes: ["deleted"] });
    expect(inspectThreadPage('<article class="message message--deleted" data-content="post-1">Deleted</article>', URL).status).toBe("empty");
    expect(inspectThreadPage("<p>Unexpected layout</p>", URL).status).toBe("unrecognized");
    expect(inspectThreadPage(page(post(1, '<blockquote><div id="challenge-running">Quoted warning</div></blockquote>Reply') + '<form><input type="password"></form>'), URL).status).toBe("complete");
  });

  it("rejects wrong threads/pages but accepts renamed slugs and clamped last pages", () => {
    const result = inspectThreadPage(page(post(1), 2, 3), `${URL}page-2`);
    expect(validateThreadResponse(result, `${URL}page-3`, `${URL}page-2`, 3)).toMatchObject({ status: "wrong-page", codes: ["wrong-page"], value: null });
    expect(validateThreadResponse(result, URL, "https://forum.example/threads/other.99/", 2).codes).toEqual(["wrong-thread"]);
    expect(validateThreadResponse(result, URL, "https://forum.example/threads/renamed.42/page-2", 2).status).toBe("complete");
    expect(validateThreadResponse(inspectThreadPage(page(post(1), 2, 2), `${URL}page-2`), `${URL}page-3`, `${URL}page-2`, 3).status).toBe("complete");
    const canonical = `<link rel="canonical" href="https://forum.example/threads/other.99/">${page(post(1))}`;
    expect(inspectThreadPage(canonical, URL)).toMatchObject({ status: "wrong-page", codes: ["wrong-thread"] });
  });

  it("reports truncation instead of certifying a capped response", () => {
    expect(inspectThreadPage(page(post(1, "x".repeat(400_001))), URL)).toMatchObject({ status: "partial", codes: ["truncated"] });
    expect(inspectThreadPage(page(post(1)) + " ".repeat(3_000_001), URL).codes).toContain("truncated");
  });

  it("keeps explicit selector counts and prevents generic article fallback for recognized broken threads", () => {
    const html = page(post(1) + post(2, "Lost", "changed-layout"));
    expect(extractWithSelectors(html, URL, { article: ".bbWrapper", remove: "nav" }))
      .toMatchObject({ matched: 1, removed: 1, thread: { status: "partial" } });
    expect(extractWithSelectors('<div id="challenge-running">' + "Please wait ".repeat(100) + "</div>", URL, {}))
      .toMatchObject({ article: null, thread: { status: "access-blocked" } });
  });

  it("transports the same evidence through direct jobs and a real compiled worker", async () => {
    // Root npm test builds server output first so this exercises production worker transport.
    const moduleUrl = new globalThis.URL("../dist/reader/pageParser.js", import.meta.url).href;
    const compiled = await import(/* @vite-ignore */ moduleUrl);
    const worker: PageParser = new compiled.PageParser(true);
    const direct = new PageParser(false);
    try {
      for (const html of [page(post(1)), page(post(1) + post(2, "Lost", "changed-layout")), '<title>Log in</title><form><input type="password"></form>']) {
        const expected = runPageJob({ kind: "thread-inspection", html, url: URL });
        expect(await direct.inspectThread(html, URL)).toEqual(expected);
        expect(await worker.inspectThread(html, URL)).toEqual(expected);
      }
    } finally { await worker.close(); await direct.close(); }
  });
});

describe.each(backends)("incomplete thread reader (%s)", (backend) => {
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  afterEach(async () => { vi.restoreAllMocks(); await app?.close(); app = undefined; });
  async function start() {
    const clock = { now: Date.UTC(2026, 9, 30, 12) };
    const web = new FakeWeb();
    const good = page(post(1, "Original good copy") + post(2));
    web.set(`${URL}latest`, { body: good, contentType: "text/html", finalUrl: URL });
    web.set(URL, { body: good, contentType: "text/html" });
    app = await createTestApp(backend, {}, clock, { fetcher: web.fetcher });
    const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "reader", password: "correct horse battery" }, headers: CSRF });
    const headers = { ...CSRF, cookie: sessionCookie(setup)! };
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app!.fastify.inject({ method, url, payload, headers });
    const source = (await call("POST", "/api/sources", { url: URL })).json();
    expect(source.id).toBeTruthy();
    const item = (await call("GET", "/api/items?filter=all")).json().items[0];
    return { clock, web, call, source, item, good };
  }

  it("keeps a good cached copy, disables progress and leaves stored HTML unchanged after partial parsing", async () => {
    const { clock, web, call, item } = await start();
    const good = (await call("GET", `/api/items/${item.id}/reader?page=1`)).json();
    expect(good.extraction.status).toBe("complete");
    const stored = await app!.db.kysely.selectFrom("item_content").selectAll().where("item_id", "=", item.id).executeTakeFirst();
    clock.now += 31 * 60_000;
    web.set(URL, { body: page(post(1, "Incomplete replacement") + post(2, "Missing", "changed-layout")), contentType: "text/html" });
    const bad = (await call("GET", `/api/items/${item.id}/reader?page=1`)).json();
    expect(bad).toMatchObject({ html: good.html, extraction: { status: "partial", stale: true }, threadProgress: { tracking: false } });
    expect(bad.notice).toContain("copy read earlier");
    expect(await app!.db.kysely.selectFrom("item_content").selectAll().where("item_id", "=", item.id).executeTakeFirst()).toEqual(stored);
  });

  it("labels uncached partial previews, does not cache them, and recovers on retry", async () => {
    const { web, call, item } = await start();
    web.set(`${URL}page-2`, { body: page(post(3, "Preview text") + post(4, "Missing", "changed-layout"), 2, 2), contentType: "text/html" });
    const bad = (await call("GET", `/api/items/${item.id}/reader?page=2`)).json();
    expect(bad).toMatchObject({ extraction: { status: "partial", stale: false }, threadProgress: { tracking: false } });
    expect(bad.html).toContain("Preview text");
    expect(bad.notice).toContain("incomplete preview");
    web.set(`${URL}page-2`, { body: page(post(3, "Recovered") + post(4), 2, 2), contentType: "text/html" });
    const recovered = (await call("GET", `/api/items/${item.id}/reader?page=2`)).json();
    expect(recovered).toMatchObject({ extraction: { status: "complete", stale: false }, threadProgress: { tracking: true } });
    expect(recovered.html).toContain("Recovered");
  });

  it("does not display another page as a successful read and handles worker failure without leaking details", async () => {
    const { web, call, item } = await start();
    web.set(`${URL}page-2`, { body: page(post(1), 1, 3), contentType: "text/html" });
    const wrong = (await call("GET", `/api/items/${item.id}/reader?page=2`)).json();
    expect(wrong).toMatchObject({ html: null, extraction: { status: "wrong-page" }, threadProgress: { tracking: false } });
    vi.spyOn(pageParser, "extract").mockRejectedValueOnce(new Error("private page token: secret"));
    const failed = (await call("GET", `/api/items/${item.id}/reader?page=2`)).json();
    expect(failed).toMatchObject({ extraction: { status: "failed" }, threadProgress: { tracking: false } });
    expect(failed.notice).toContain("Reading the forum page failed");
    expect(failed.notice).not.toContain("secret");
  });

  it("preserves replies and saved position after polling failure and resumes only after a good source check", async () => {
    const { web, call, source, item, good } = await start();
    expect((await call("PUT", `/api/items/${item.id}/thread-position`, { postId: 1 })).json()).toEqual({ saved: true });
    const before = await app!.db.kysely.selectFrom("thread_posts").selectAll().where("source_id", "=", source.id).orderBy("post_id").execute();
    web.set(`${URL}latest`, { body: page(post(1, "Bad repair") + post(2, "Missing", "changed-layout")), contentType: "text/html", finalUrl: URL });
    expect(await app!.feeds.checkSource(source.id)).toMatchObject({ ok: false, newItems: 0 });
    expect(await app!.db.kysely.selectFrom("thread_posts").selectAll().where("source_id", "=", source.id).orderBy("post_id").execute()).toEqual(before);
    expect((await call("PUT", `/api/items/${item.id}/thread-position`, { postId: 2 })).json()).toEqual({ saved: false });
    expect((await call("GET", `/api/items/${item.id}/reader`)).json()).toMatchObject({ extraction: { stale: true }, threadProgress: { tracking: false, readPostId: 1 } });
    web.set(`${URL}latest`, { body: good, contentType: "text/html", finalUrl: URL });
    expect(await app!.feeds.checkSource(source.id)).toMatchObject({ ok: true, newItems: 0 });
    expect((await call("GET", `/api/items/${item.id}/reader`)).json()).toMatchObject({ threadProgress: { tracking: true, readPostId: 1 } });
  });
});
