import { describe, expect, it } from "vitest";
import { extractArticle, extractWithSelectors } from "../src/reader/extract.js";
import { parseThreadPage } from "../src/feeds/thread.js";
import { sanitizeHtml } from "../src/reader/sanitize.js";

const URL = "https://forum.example/threads/benchmarks.123/";
const xenforo = (body: string) => `<h1 class="p-title-value">Benchmarks</h1>
  <article class="message" data-content="post-1" data-author="Tester"><div class="bbWrapper">${body}</div></article>`;
const vbulletin = (body: string) => `<h1>Benchmarks</h1><div id="post1">
  <a class="username">Tester</a><div id="post_message_1">${body}</div></div>`;

describe("reader images", () => {
  it.each(["data-src", "data-lazy-src", "data-original"])("restores %s in sanitized feed content", (attr) => {
    const out = sanitizeHtml(`<img src="data:image/gif;base64,placeholder" ${attr}="/results.png" alt="Benchmark" onerror="alert(1)">`, URL);
    expect(out).toContain('src="https://forum.example/results.png"');
    expect(out).toContain('alt="Benchmark"');
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(out).not.toMatch(/onerror|data-src|data-lazy-src|data-original|placeholder/);
  });

  it.each(["", "javascript:alert(1)", "data:image/svg+xml,bad", "http://insecure.example/a.png"])("skips invalid lazy addresses (%s) without discarding valid fallback images", (bad) => {
    const out = sanitizeHtml(`<img data-src="${bad}" data-original="/real.png"><img data-src="${bad}" src="/fallback.png">`, URL);
    expect(out).toContain('src="https://forum.example/real.png"');
    expect(out).toContain('src="https://forum.example/fallback.png"');
    expect(out).not.toMatch(/javascript:|data:image|http:\/\//);
  });

  it.each([["XenForo", xenforo], ["vBulletin", vbulletin]] as const)("keeps image-only %s posts in both reader and followed-thread extraction", (_name, wrap) => {
    const html = wrap('<figure><img data-lazy-src="/chart.png" alt="Results"></figure>');
    const article = extractArticle(html, URL);
    const followed = parseThreadPage(html, URL);
    expect(article?.html).toContain('src="https://forum.example/chart.png"');
    expect(article?.pages).toEqual({ page: 1, pages: 1 });
    expect(followed?.posts).toHaveLength(1);
    expect(followed?.posts[0]?.html).toContain('src="https://forum.example/chart.png"');
  });

  it("keeps captions, attachment links and the existing safe src with an invalid lazy attribute", () => {
    const html = '<main><figure><a href="/attachments/full.png"><img src="/thumbnail.png" data-src="javascript:bad()"></a><figcaption>Memory timings</figcaption></figure></main>';
    const result = extractWithSelectors(html, URL, { article: "main" });
    expect(result.article?.html).toContain('href="https://forum.example/attachments/full.png"');
    expect(result.article?.html).toContain('src="https://forum.example/thumbnail.png"');
    expect(result.article?.html).toContain("<figcaption>Memory timings</figcaption>");
  });

  it("does not accept an image-only thread when sanitization removes all its images", () => {
    expect(extractArticle(xenforo('<img data-src="javascript:bad()">'), URL)).toBeNull();
  });
});
