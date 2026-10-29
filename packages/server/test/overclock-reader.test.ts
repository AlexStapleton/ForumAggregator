import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractArticle } from "../src/reader/extract.js";
import { parseThreadPage } from "../src/feeds/thread.js";
import { FakeWeb, rss } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const THREAD = "https://forum.example/threads/memory-review.42/";
const fixture = fs.readFileSync(path.join(import.meta.dirname, "fixtures/pages/overclock-nested-thread.html"), "utf8");
function page(n: number) {
  return fixture.replace('aria-current="page"', "").replace(`href="/threads/memory-review.42/${n === 1 ? "" : `page-${n}`}?nested_view=1#replies"`, `aria-current="page" href="/threads/memory-review.42/${n === 1 ? "" : `page-${n}`}?nested_view=1#replies"`);
}

describe("Overclock California nested thread layout", () => {
  it("extracts each parent/child once with its own author and post date", () => {
    const result = parseThreadPage(fixture, `${THREAD}page-3`)!;
    expect(result).toMatchObject({ title: "Memory review", page: 3, pages: 3 });
    expect(result.posts.map((p) => [p.id, p.author])).toEqual([["201", "ReplyAuthor"], ["202", "ChildAuthor"], ["203", "OtherAuthor"]]);
    expect(result.posts[0]!.datetime).toBe("2025-06-01T10:00:00.000Z");
    expect(result.posts[0]!.html).not.toContain("Nested reply body");
    expect(result.posts[1]!.html).toContain("Nested reply body");
  });

  it("excludes site widgets and repeated original post while retaining real lists and quotes", () => {
    const article = extractArticle(fixture, `${THREAD}page-3`)!;
    expect(article.pages).toEqual({ page: 3, pages: 3 });
    expect(article.html).toContain("Keep this real list");
    expect(article.html).toContain("<blockquote>Quoted text</blockquote>");
    for (const junk of ["Hidden structured-data copy", "Original review body", "Unrelated discussion", "Report Reply Like", "<li>?</li>"]) {
      expect(article.html).not.toContain(junk);
    }
  });

  it("includes the original post once on page one", () => {
    const result = parseThreadPage(page(1), THREAD)!;
    expect(result).toMatchObject({ page: 1, pages: 3 });
    expect(result.posts.map((p) => p.id)).toEqual(["100", "201", "202", "203"]);
    expect(result.posts[0]!.author).toBe("OriginalAuthor");
  });

  it("supports compact counters alongside standard page links", () => {
    const html = fixture.replace('>3</a>', '> 3/12 </a>');
    expect(parseThreadPage(html, `${THREAD}page-3`)).toMatchObject({ page: 3, pages: 12 });
  });

  it("uses the fetched page URL if the theme omits the current-page marker", () => {
    expect(parseThreadPage(fixture.replace('aria-current="page"', ""), `${THREAD}page-3?nested_view=1#replies`)).toMatchObject({ page: 3, pages: 3 });
  });
});

describe.each(backends)("Overclock reader page API (%s)", (backend) => {
  it("returns pagination for the first, requested and latest page through the real reader route", async () => {
    const web = new FakeWeb();
    web.set("https://forum.example/feed", { body: rss("Forum", [{ guid: "review", title: "Memory review", link: THREAD, date: "2026-10-29T10:00:00Z" }]) });
    web.set(THREAD, { body: page(1), contentType: "text/html" });
    web.set(`${THREAD}page-2`, { body: page(2), contentType: "text/html" });
    web.set(`${THREAD}page-3`, { body: page(3), contentType: "text/html" });
    web.set(`${THREAD}latest`, { body: page(3), contentType: "text/html", finalUrl: `${THREAD}page-3` });
    const app = await createTestApp(backend, {}, undefined, { fetcher: web.fetcher });
    try {
      const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", headers: CSRF, payload: { setupCode: SETUP_CODE, username: "reader", password: "reader test password" } });
      const headers = { ...CSRF, cookie: sessionCookie(setup)! };
      const source = await app.fastify.inject({ method: "POST", url: "/api/sources", headers, payload: { url: "https://forum.example/feed" } });
      expect(source.statusCode).toBe(201);
      const item = (await app.fastify.inject({ method: "GET", url: "/api/items?filter=all", headers })).json().items[0];
      for (const requested of [1, 2, 3, "last"] as const) {
        const response = await app.fastify.inject({ method: "GET", url: `/api/items/${item.id}/reader?page=${requested}`, headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ kind: "page", pagination: { page: requested === "last" ? 3 : requested, pages: 3 } });
        expect(response.json().html).not.toContain("Unrelated discussion");
      }
      expect(web.requests.some((r) => r.url === `${THREAD}page-2`)).toBe(true);
      expect(web.requests.some((r) => r.url === `${THREAD}latest`)).toBe(true);
    } finally { await app.close(); }
  });
});
