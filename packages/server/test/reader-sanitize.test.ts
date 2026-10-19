import { describe, expect, it } from "vitest";
import { dropRepeatedTitle, extractArticle, youtubeVideoId } from "../src/reader/extract.js";
import { sanitizeHtml } from "../src/reader/sanitize.js";

const BASE = "https://news.example/2026/10/story";
const clean = (html: string) => sanitizeHtml(html, BASE);

describe("sanitizeHtml", () => {
  it("removes scripts, handlers, styles, iframes, forms and dangerous URLs", () => {
    const attacks = [
      "<script>alert(1)</script>",
      '<img src="https://x.example/a.png" onerror="alert(1)">',
      '<a href="javascript:alert(1)">x</a>',
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      '<iframe src="https://evil.example"></iframe>',
      '<form action="https://evil.example"><input name=a></form>',
      '<p style="background:url(javascript:alert(1))">s</p>',
      "<svg><script>alert(1)</script></svg>",
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<object data="x"></object><embed src="x">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      '<base href="https://evil.example/">',
      '<link rel="stylesheet" href="https://evil.example/x.css">',
      '<div onclick="alert(1)" class="x" id="y" data-x="1">t</div>',
    ].join("\n");
    const out = clean(attacks);
    for (const bad of [/<script/i, /onerror/i, /onclick/i, /javascript:/i, /data:text/i, /<iframe/i, /<form/i, /<input/i, /style=/i, /<svg/i, /<object/i, /<embed/i, /<meta/i, /<base/i, /<link/i, /class=/i, /id=/i, /data-x/i, /alert/i]) {
      expect(out).not.toMatch(bad);
    }
  });

  it("keeps formatting, resolves links, and forces safe link/image attributes", () => {
    const out = clean('<h2>Title</h2><p>Text <strong>bold</strong> <a href="/other">link</a></p><img src="/img/a.jpg" alt="A"><img src="http://insecure.example/b.jpg">');
    expect(out).toContain("<h2>Title</h2>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain('href="https://news.example/other"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toMatch(/<img[^>]+src="https:\/\/news\.example\/img\/a\.jpg"/);
    expect(out).toContain('referrerpolicy="no-referrer"');
    expect(out).not.toContain("insecure.example"); // http image dropped
  });
});

describe("extractArticle", () => {
  const page = (body: string) => `<!doctype html><html><head><title>Story</title></head><body>
    <nav><a href="/">Home</a> <a href="/about">About</a></nav>
    <article><h1>The Story</h1>${body}</article>
    <footer>© Example</footer><script>tracking()</script></body></html>`;

  it("pulls the article out of a page and cleans it", () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i} about tandem couplers and how they are maintained over many seasons of riding.</p>`).join("");
    const result = extractArticle(page(paragraphs + '<img data-src="/lazy.jpg" src="data:image/gif;base64,R0lGOD">'), BASE);
    expect(result).not.toBeNull();
    expect(result!.html).toContain("Paragraph 7");
    expect(result!.html).not.toMatch(/tracking|<nav|Home|©/);
    expect(result!.html).toContain('src="https://news.example/lazy.jpg"');
  });

  it("returns null for teasers and paywalls", () => {
    expect(extractArticle(page("<p>Subscribe to read more.</p>"), BASE)).toBeNull();
  });
});

describe("youtubeVideoId", () => {
  it("recognises watch, shorts and youtu.be links", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://www.youtube.com/shorts/abcDEF12345")).toBe("abcDEF12345");
    expect(youtubeVideoId("https://youtu.be/abcDEF12345?t=3")).toBe("abcDEF12345");
    expect(youtubeVideoId("https://www.youtube.com/watch?v=<script>")).toBeNull();
    expect(youtubeVideoId("https://evil.example/watch?v=abcDEF12345")).toBeNull();
    expect(youtubeVideoId(null)).toBeNull();
  });
});

describe("dropRepeatedTitle", () => {
  it("removes a leading heading that repeats the title, and nothing else", () => {
    expect(dropRepeatedTitle('<div id="x"><h2>Bridge reopens!</h2><p>Text</p></div>', "Bridge Reopens")).toBe('<div id="x"><p>Text</p></div>');
    expect(dropRepeatedTitle("<h2>Tools</h2><p>Text</p>", "Coupler maintenance")).toBe("<h2>Tools</h2><p>Text</p>");
    expect(dropRepeatedTitle("<p>Intro</p><h1>Bridge</h1>", "Bridge")).toBe("<p>Intro</p><h1>Bridge</h1>");
  });
});
