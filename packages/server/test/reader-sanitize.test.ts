import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { extractArticle, extractWithSelectors, pageAudio, pageNote, parseVbulletinThread, polishArticle, youtubeVideoId } from "../src/reader/extract.js";
import { threadPagerFor, vbulletinPager } from "../src/feeds/thread.js";
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

describe("pageAudio (D-096)", () => {
  const audioOf = (html: string, url = "https://news.example/story") => pageAudio(new JSDOM(html).window.document, url);

  it("finds NPR's headline audio from its Download link, with the length", () => {
    const html = fs.readFileSync(path.join(import.meta.dirname, "fixtures/pages/npr-audio-story.html"), "utf8");
    expect(audioOf(html, "https://www.npr.org/2026/10/23/x/two-strangers")).toEqual({
      url: "https://ondemand.npr.org/anon.npr-mp3/npr/me/2026/10/20261023_me_two_strangers.mp3?t=progseg&e=1&d=168&size=2701733&sc=siteplayer",
      durationSeconds: 168,
    });
  });

  it("uses og:audio and <audio> addresses, and ignores pages without audio", () => {
    expect(audioOf('<meta property="og:audio" content="/ep.mp3">')).toEqual({ url: "https://news.example/ep.mp3", durationSeconds: null });
    expect(audioOf('<audio controls><source src="https://cdn.example/a.ogg"></audio>')).toEqual({ url: "https://cdn.example/a.ogg", durationSeconds: null });
    expect(audioOf('<audio id="x"></audio><p>Text</p>')).toBeNull();
    // A download link that isn't an audio file, or isn't http(s).
    expect(audioOf('<li class="audio-tool-download"><a href="/story.pdf">Download</a></li>')).toBeNull();
    expect(audioOf('<li class="audio-tool-download"><a href="javascript:alert(1)//.mp3">Download</a></li>')).toBeNull();
  });
});

describe("vBulletin threads (D-098)", () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, "fixtures/pages/vbulletin-thread.html"), "utf8");
  const url = "https://forum.example/classic-vintage/100-steel-frames.html";

  it("keeps each post's author, date and text, and none of the member sidebar or signature", () => {
    const thread = parseVbulletinThread(new JSDOM(html, { url }).window.document, url)!;
    expect(thread.posts.map((p) => [p.id, p.author, p.timeLabel])).toEqual([
      ["501", "Rider One", "10-23-26 | 12:23 AM"],
      ["502", "Rider Two", "10-23-26 | 01:34 AM"],
    ]);
    expect([thread.page, thread.pages]).toEqual([1, 3]);
    const all = thread.posts.map((p) => p.html).join("");
    expect(all).not.toMatch(/Joined|Posts:|Likes|Senior Member|Titanium|Thread Starter|Signature|View Post|alert/);
    expect(thread.posts[0]!.html).toContain('<img src="https://img.example/frame.jpg"');
  });

  it("turns vB3 and vB4 quotes into block quotes with who wrote them", () => {
    const thread = parseVbulletinThread(new JSDOM(html, { url }).window.document, url)!;
    const reply = thread.posts[1]!.html;
    expect(reply).toMatch(/<blockquote><p><strong>Rider One wrote:<\/strong><\/p>[\s\S]*Is steel still worth it\?[\s\S]*<\/blockquote>/);
    expect(reply).toMatch(/<blockquote><p><strong>Someone wrote:<\/strong><\/p>[\s\S]*Steel is real\.[\s\S]*<\/blockquote>/);
    expect(reply).not.toMatch(/Quote:|Originally Posted by|<table/);
    expect(reply).toContain("Yes, for comfort.");
  });

  it("is used by the reader, with the page count and the next page's link", () => {
    const article = extractWithSelectors(html, url, {}).article!;
    expect(article.html).toMatch(/^<section><p><strong>Rider One<\/strong> · <time datetime="">10-23-26 \| 12:23 AM<\/time><\/p>/);
    expect(article.pages).toEqual({ page: 1, pages: 3 });
    expect(article.nextPageUrl).toBe("https://forum.example/classic-vintage/100-steel-frames-2.html");
    expect(article.byline).toBe("Rider One");
    expect(pageNote(article)).toBe('<p><em>Page 1 of 3.</em> <a href="https://forum.example/classic-vintage/100-steel-frames-2.html">Next page on the forum</a></p>');
  });

  it("reads Bike Forums' page counter (20 / 21)", () => {
    const themed = html.replace(/<div class="pagenav">[\s\S]*?<\/div>/, '<span id="mb_page"><span id="mb_page_current">20</span> / <span id="mb_page_total">21</span></span>');
    expect(extractWithSelectors(themed, url, {}).article!.pages).toEqual({ page: 20, pages: 21 });
  });
});

describe("thread pagers (D-099)", () => {
  it("builds vBulletin page addresses from the thread link the feed gives", () => {
    const seo = vbulletinPager("https://www.bikeforums.net/tandem-cycling/1000939-anyone-looking-one-these-tandems-found-sale.html")!;
    expect([seo.pageUrl(1), seo.pageUrl(20), seo.latestUrl]).toEqual([
      "https://www.bikeforums.net/tandem-cycling/1000939-anyone-looking-one-these-tandems-found-sale.html",
      "https://www.bikeforums.net/tandem-cycling/1000939-anyone-looking-one-these-tandems-found-sale-20.html",
      null,
    ]);
    // A title ending in a number stays whole.
    expect(vbulletinPager("https://f.example/x/1324707-top-10.html")!.pageUrl(2)).toBe("https://f.example/x/1324707-top-10-2.html");
    expect(vbulletinPager("https://f.example/x/1324707-top-10-new-post.html")!.pageUrl(1)).toBe("https://f.example/x/1324707-top-10.html");
    const classic = vbulletinPager("https://f.example/forum/showthread.php?t=123&goto=newpost")!;
    expect([classic.pageUrl(1), classic.pageUrl(3)]).toEqual(["https://f.example/forum/showthread.php?t=123", "https://f.example/forum/showthread.php?t=123&page=3"]);
    expect(vbulletinPager("https://news.example/story")).toBeNull();
  });

  it("pages vBulletin links only when they come from a vBulletin board's feed", () => {
    const link = "https://www.bikeforums.net/classic-vintage/1324707-cannondale-moves-out-us.html";
    expect(threadPagerFor(link, "https://www.bikeforums.net/external.php?type=RSS2&forumids=181")).not.toBeNull();
    // e.g. a news site with ".../12345-title.html" links
    expect(threadPagerFor("https://news.example/news/12345-title.html", "https://news.example/feed")).toBeNull();
    expect(threadPagerFor("https://forum.example/threads/gpu.12/", "https://forum.example/forums/x.1/index.rss")!.latestUrl).toBe("https://forum.example/threads/gpu.12/latest");
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

describe("polishArticle", () => {
  const title = "NASA's Mars rover Perseverance has broken a landmark distance record";

  it("cleans an NPR-style audio story: repeated headline, toolbar, embed snippet", () => {
    // Shape of what the reader showed for an NPR story (2026-10-19 screenshot), after sanitising.
    const html = `<div><div><h3>NASA’s Mars rover Perseverance has broken a landmark distance record</h3>
      <p><a href="https://www.npr.org/transcripts/1">Transcript</a></p>
      <ul><li><a href="https://ondemand.npr.org/a.mp3">Download</a></li>
      <li><b>Embed</b> <b><code>&lt;iframe src="https://www.npr.org/player/embed/nx-s1-1/nx-s1-2" width="100%" height="290" frameborder="0" scrolling="no" title="NPR embedded audio player"&gt;</code></b></li>
      <li><a href="https://www.npr.org/transcripts/1">Transcript</a></li></ul>
      <p>The rover has now driven farther than any other on Mars.</p></div></div>`;
    const out = polishArticle(html, title);
    expect(out).not.toMatch(/iframe|Embed|Download|<h3>/);
    expect(out).toContain("The rover has now driven farther");
    expect(out).toContain(">Transcript</a>"); // the standalone transcript link is useful, kept
  });

  it("leaves real content alone", () => {
    const article = "<h2>Tools</h2><ul><li>Torque wrench</li><li>Grease</li></ul><pre><code>&lt;iframe src=x&gt;&lt;/iframe&gt;\nconst a = 1;</code></pre><p>Text</p>";
    expect(polishArticle(article, "Coupler maintenance")).toBe(article);
    expect(polishArticle("<p>Intro</p><h1>Bridge</h1>", "Bridge")).toBe("<p>Intro</p><h1>Bridge</h1>");
  });

  it("removes share bars", () => {
    const out = polishArticle('<p>Body</p><ul><li><a href="https://x.example">Share on Facebook</a></li><li><a href="https://y.example">Email</a></li></ul>', "T");
    expect(out).toBe("<p>Body</p>");
  });
});
