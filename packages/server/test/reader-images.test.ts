import { describe, expect, it } from "vitest";
import { extractArticle, extractWithSelectors } from "../src/reader/extract.js";
import { parseThreadPage } from "../src/feeds/thread.js";
import { sanitizeHtml } from "../src/reader/sanitize.js";
import { srcsetImage } from "../src/reader/images.js";

const URL = "https://forum.example/threads/benchmarks.123/";
const xenforo = (body: string) => `<h1 class="p-title-value">Benchmarks</h1>
  <article class="message" data-content="post-1" data-author="Tester"><div class="bbWrapper">${body}</div></article>`;
const vbulletin = (body: string) => `<h1>Benchmarks</h1><div id="post1">
  <a class="username">Tester</a><div id="post_message_1">${body}</div></div>`;

describe("reader images", () => {
  const attachment = `<section class="message-attachments"><h4>Attachments</h4><ul class="attachmentList">
    <li class="file"><a class="file-preview js-lbImage" data-type="image" href="/attachments/watering-chart-png.151903/">
      <img src="/thumb.png" srcset="/thumb2.png 2x" alt="Watering chart" onerror="alert(1)"></a>
      <div class="file-content"><span class="file-name">Watering chart.png</span><div class="file-meta">Views: 12</div></div></li>
    <li class="file"><a class="file-preview" href="/attachments/notes-pdf.151904/">Icon</a><div class="file-content"><span class="file-name">Notes.pdf</span></div></li>
    </ul></section>`;

  it.each(["Post with an attached chart", ""])("keeps separate XenForo attachments in reader and polling (%s)", (text) => {
    const html = xenforo(text).replace("</article>", attachment + "</article>");
    for (const out of [extractArticle(html, URL)?.html, parseThreadPage(html, URL)?.posts[0]?.html]) {
      expect(out).toContain('src="https://forum.example/attachments/watering-chart-png.151903/"');
      expect(out).toContain('href="https://forum.example/attachments/watering-chart-png.151903/"');
      expect(out).toContain("Watering chart.png</figcaption>");
      expect(out).toContain('href="https://forum.example/attachments/notes-pdf.151904/"');
      expect(out).toContain("Notes.pdf</a>");
      expect(out).not.toMatch(/thumb|Views:|onerror|alert/);
    }
  });

  it("does not duplicate inline attachments or take attachments from nested/quoted posts", () => {
    const inline = '<a href="/attachments/watering-chart-png.151903/">Chart</a>';
    const nested = '<article class="message" data-content="post-2"><div class="bbWrapper">Second</div>' + attachment.replaceAll("151903", "251903") + '</article>';
    const html = xenforo(inline).replace("</article>", attachment + '<blockquote>' + attachment.replaceAll("151903", "351903") + '</blockquote>' + nested + '</article>');
    const posts = parseThreadPage(html, URL)!.posts;
    expect(posts).toHaveLength(2);
    expect(posts[0]!.html.match(/watering-chart-png\.151903/g)).toHaveLength(1);
    expect(posts[0]!.html).not.toMatch(/251903|351903/);
    expect(posts[1]!.html).toContain("251903");
  });

  it("resolves declared XenForo attachment images before sanitizing their metadata", () => {
    const html = '<a class="js-lbImage" data-type="image" href="/attachments/chart-png.123/"><img src="/thumb.png"></a>';
    expect(sanitizeHtml(html, URL)).toContain('src="https://forum.example/attachments/chart-png.123/"');
    expect(sanitizeHtml(html.replace('/attachments/chart-png.123/', 'javascript:alert(1)'), URL)).not.toContain('javascript:');
  });

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

  it("keeps captions and uses the full-size image behind a thumbnail link", () => {
    const html = '<main><figure><a href="/attachments/full.png"><img src="/thumbnail.png" data-src="javascript:bad()"></a><figcaption>Memory timings</figcaption></figure></main>';
    const result = extractWithSelectors(html, URL, { article: "main" });
    expect(result.article?.html).toContain('href="https://forum.example/attachments/full.png"');
    expect(result.article?.html).toContain('src="https://forum.example/attachments/full.png"');
    expect(result.article?.html).toContain("<figcaption>Memory timings</figcaption>");
  });

  it("does not accept an image-only thread when sanitization removes all its images", () => {
    expect(extractArticle(xenforo('<img data-src="javascript:bad()">'), URL)).toBeNull();
  });
});

describe("responsive images and attachments", () => {
  it("does not downgrade an ordinary image to a sub-1x candidate", () => {
    expect(sanitizeHtml('<img src="/normal.png" srcset="/half.png .5x">', URL)).toContain('src="https://forum.example/normal.png"');
  });
  it.each([
    ["/small.png 320w, /large.png 1600w, /medium.png 800w", "/large.png"],
    ["/normal.png 1x, /retina.png 2x", "/retina.png"],
    ["/normal.png, /retina.png 1.5x", "/retina.png"],
    ["/half.png .5x, /retina.png 2e0x", "/retina.png"],
    ["https://cdn.example/resize,w_1200/chart.png 1200w, /small.png 400w", "https://cdn.example/resize,w_1200/chart.png"],
    ["data:image/png;base64,AAAA 2x, /safe.png 1x", "/safe.png"],
    ["javascript:bad() 3x, http://insecure.example/a.png 2x, /safe.png 1x", "/safe.png"],
    ["/bad.png 0w, /negative.png -2w, /safe.png 400w", "/safe.png"],
    ["/bad.png 400w 2x, /safe.png 800w", "/safe.png"],
    ["/bad.png future(1,2), /safe.png 800w", "/safe.png"],
    ["\n /small.png\t400w,\r\n/large.png 800w, ", "/large.png"],
  ])("selects a usable image from %s", (set, expected) => {
    expect(srcsetImage(set!, URL)).toBe(new globalThis.URL(expected!, URL).href);
  });

  it.each(["/width.png 800w, /density.png 2x", "/bad.png NaNx", "/bad.png 1e999x", "/bad.png 0x"])("rejects unsupported sets (%s)", (set) => {
    expect(srcsetImage(set, URL)).toBeNull();
    expect(sanitizeHtml(`<img src="/fallback.png" srcset="${set}">`, URL)).toContain('src="https://forum.example/fallback.png"');
  });

  it.each(["srcset", "data-srcset", "data-lazy-srcset"])("restores %s across forum extraction paths", (attr) => {
    const page = xenforo(`<img src="/thumb.png" ${attr}="/small.png 400w, /chart.png 1600w" alt="Chart">`);
    expect(extractArticle(page, URL)?.html).toContain('src="https://forum.example/chart.png"');
    expect(parseThreadPage(page, URL)?.posts[0]?.html).toContain('src="https://forum.example/chart.png"');
  });

  it("resolves picture sources before sanitization removes them, without duplicating images", () => {
    const markup = `<picture>
      <source media="(max-width: 400px)" srcset="/crop.png 1x">
      <source type="image/unknown" srcset="/unsupported.png 1x">
      <source type="image/webp" data-srcset="/small.webp 400w, /large.webp 1600w">
      <img src="/fallback.png" data-src="/lazy.png" srcset="/fallback.png 1x" alt="Chart">
      <source srcset="/too-late.png 3x">
    </picture>`;
    const clean = sanitizeHtml(markup, URL);
    expect(clean).toContain('src="https://forum.example/large.webp"');
    expect(clean.match(/<img\b/g)).toHaveLength(1);
    expect(clean).not.toMatch(/<source|srcset|data-src|crop.png|unsupported.png|too-late/);
    expect(sanitizeHtml(clean, URL)).toBe(clean);
    expect(extractArticle(xenforo(markup), URL)?.html).toContain('src="https://forum.example/large.webp"');
    expect(parseThreadPage(vbulletin(markup), URL)?.posts[0]?.html).toContain('src="https://forum.example/large.webp"');
  });

  it("falls back to the img when picture sources require media evaluation or use unsafe URLs", () => {
    const markup = '<picture><source media="print" srcset="/print.png"><source srcset="javascript:bad() 2x"><img src="/fallback.png"><source srcset="/later.png"></picture>';
    expect(sanitizeHtml(markup, URL)).toContain('src="https://forum.example/fallback.png"');
  });

  it("keeps ordinary page and download links separate from the image address", () => {
    for (const href of ["/threads/other.456/", "/attachments/report.pdf", "/gallery/123", "javascript:bad()", "http://insecure.example/full.png"]) {
      const clean = sanitizeHtml(`<a href="${href}"><img src="/thumb.png"></a>`, URL);
      expect(clean).toContain('src="https://forum.example/thumb.png"');
    }
  });

  it("prefers a direct full-size attachment over responsive thumbnails and preserves its link", () => {
    const markup = '<a href="/attachments/chart.png.123/?download=1"><img src="/thumb.png" srcset="/thumb2.png 2x" data-src="/lazy-thumb.png" alt="Timings"></a>';
    const clean = sanitizeHtml(markup, URL);
    expect(clean).toContain('src="https://forum.example/attachments/chart.png.123/?download=1"');
    expect(clean).toContain('href="https://forum.example/attachments/chart.png.123/?download=1"');
    expect(clean).toContain('alt="Timings"');
    expect(clean).not.toContain("thumb");
  });

  it("restores responsive images during Readability extraction", () => {
    const text = '<p>Benchmark results explain memory timings, sustained throughput and stability across repeated runs.</p>'.repeat(8);
    const result = extractArticle(`<article><h1>Benchmarks</h1>${text}<img data-srcset="/small.png 400w, /chart.png 1600w" alt="Results"></article>`, URL);
    expect(result?.html).toContain('src="https://forum.example/chart.png"');
  });
});
