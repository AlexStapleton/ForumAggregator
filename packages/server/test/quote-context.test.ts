import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseForumThread, parseVbulletinThread } from "../src/reader/extract.js";
import { sanitizeHtml } from "../src/reader/sanitize.js";
import { enhanceQuotes, quotedPostId } from "../../web/src/quoteContext.js";
import { trackThreadPosition } from "../../web/src/threadPosition.js";

const URL = "https://forum.example/threads/test.42/";
describe("forum quote normalization", () => {
  it("retains nested XenForo authors, references and rich content without source controls", () => {
    const dom = new JSDOM(`<article class="message" data-content="post-9"><div class="bbWrapper">
      <blockquote class="bbCodeBlock--quote" data-quote="Alice" data-source="post: 1">
      <div class="bbCodeBlock-title"><a href="${URL}#post-1">Alice said:</a></div>
      <table><tr><td>memory result</td></tr></table><pre>  code\n next</pre>
      <blockquote class="bbCodeBlock--quote" data-quote="Bob" data-source="post: 2"><div class="bbCodeBlock-title">Bob said:</div><img src="https://images.example/test.png"></blockquote>
      <div class="bbCodeBlock-expandLink">Click to expand</div></blockquote></div></article>`);
    const html = parseForumThread(dom.window.document, URL)!.posts[0]!.html;
    const clean = new JSDOM(html).window.document;
    expect(clean.querySelectorAll("blockquote")).toHaveLength(2);
    expect(clean.querySelector("blockquote > p > cite")?.textContent).toBe("Alice wrote:");
    expect(clean.querySelector("blockquote blockquote cite")?.textContent).toBe("Bob wrote:");
    expect(clean.querySelector("blockquote")?.getAttribute("cite")).toBe(`${URL}#post-1`);
    expect(html).toContain('https://forum.example/posts/2/');
    expect(html).toContain("memory result");
    expect(html).toContain("  code\n next");
    expect(html).toContain("https://images.example/test.png");
    expect(html).not.toContain("Click to expand");
  });

  it("preserves vBulletin attribution links and nested bodies", () => {
    const dom = new JSDOM(`<div id="post_message_9"><div class="bbcode_container"><div class="bbcode_postedby">Originally Posted by <strong>Alice</strong><a href="showthread.php?t=42&amp;p=1#post1">View Post</a></div><div class="message">Outer<div class="bbcode_container"><div class="bbcode_postedby"><strong>Bob</strong></div><div class="message">Inner</div></div></div></div></div>`);
    const html = parseVbulletinThread(dom.window.document, "https://forum.example/showthread.php?t=42")!.posts[0]!.html;
    expect(html).toContain("Alice wrote:");
    expect(html).toContain("Bob wrote:");
    expect(html).toContain("Inner");
    expect(new JSDOM(html).window.document.querySelector("blockquote")?.getAttribute("cite")).toBe("https://forum.example/showthread.php?t=42&p=1#post1");
  });

  it("resolves a XenForo redirect locally only when its target is verified on the page", () => {
    const dom = new JSDOM(`<article class="message" data-content="post-1"><div class="bbWrapper">Original</div></article>
      <article class="message" data-content="post-9"><div class="bbWrapper">
      <blockquote class="bbCodeBlock--quote" data-quote="Alice" data-source="post: 1"><div class="bbCodeBlock-title"><a href="/goto/post?id=1">Alice said:</a></div>Text</blockquote>
      <blockquote class="bbCodeBlock--quote" data-source="post: 2">Other thread</blockquote></div></article>`);
    const html = parseForumThread(dom.window.document, URL)!.posts[1]!.html;
    const doc = new JSDOM(html).window.document;
    expect(doc.querySelector("blockquote")?.getAttribute("cite")).toBe(`${URL}#post-1`);
    expect(doc.querySelector("blockquote a")?.getAttribute("href")).toBe("https://forum.example/goto/post?id=1");
    expect(doc.querySelectorAll("blockquote")[1]?.getAttribute("cite")).toBe("https://forum.example/posts/2/");
  });

  it("keeps unattributed content and strips spoofed IDs, handlers and unsafe references", () => {
    const html = sanitizeHtml('<blockquote cite="javascript:alert(1)" id="fa-post-1" data-quote-post="1" onclick="bad()">Keep me</blockquote>', URL);
    expect(html).toBe("<blockquote>Keep me</blockquote>");
  });
});

describe("quote controls and reading position", () => {
  afterEach(() => vi.useRealTimers());
  it("only resolves explicit same-thread permalinks", () => {
    expect(quotedPostId(`${URL}page-3#post-17`, URL)).toBe("17");
    expect(quotedPostId("https://forum.example/showthread.php?t=42&p=17#post17", "https://forum.example/showthread.php?t=42&page=2")).toBe("17");
    for (const ref of ["javascript:bad()", "https://other.example/threads/test.42/#post-17", "https://forum.example/threads/other.43/#post-17", "https://forum.example/posts/17/", `${URL}#post-NaN`]) expect(quotedPostId(ref, URL)).toBeNull();
  });

  function view() {
    const dom = new JSDOM(`<div id="root"><div class="reader-content"><section id="fa-post-1">Original</section><section id="fa-post-9"><blockquote cite="${URL}#post-1"><p><cite>Alice wrote:</cite> <a href="${URL}#post-1">View original post</a></p><p>Quote body</p></blockquote>Reply</section></div></div>`, { pretendToBeVisual: true });
    const root = dom.window.document.getElementById("root")!;
    root.getBoundingClientRect = () => ({ top: 0, bottom: 500 } as DOMRect);
    const first = root.querySelector<HTMLElement>("#fa-post-1")!;
    first.getBoundingClientRect = () => ({ top: 0, bottom: 200 } as DOMRect);
    const reply = root.querySelector<HTMLElement>("#fa-post-9")!;
    reply.getBoundingClientRect = () => ({ top: 600, bottom: 1200 } as DOMRect);
    return { dom, root, first, reply };
  }

  it("jumps, highlights and returns without saving intervening posts, including after tracker recreation", async () => {
    vi.useFakeTimers();
    const { dom, root, first, reply } = view();
    const cleanup = enhanceQuotes(root, URL);
    const send = vi.fn(async (_id: number) => ({ saved: true }));
    let stop = trackThreadPosition(root, 1, send, () => {});
    root.querySelector<HTMLButtonElement>(".quote-jump")!.click();
    expect(first.classList.contains("quote-target")).toBe(true);
    reply.getBoundingClientRect = () => ({ top: 100, bottom: 400 } as DOMRect);
    root.dispatchEvent(new dom.window.Event("scroll"));
    await stop();
    stop = trackThreadPosition(root, 1, send, () => {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>(".quote-return button")!.click();
    expect(first.classList.contains("quote-target")).toBe(false);
    root.dispatchEvent(new dom.window.Event("scroll"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).not.toHaveBeenCalled();
    root.dispatchEvent(new dom.window.Event("wheel"));
    root.dispatchEvent(new dom.window.Event("scroll"));
    await vi.advanceTimersByTimeAsync(750);
    expect(send).toHaveBeenCalledWith(9);
    await stop(); cleanup(); dom.window.close();
  });

  it("collapses tall quotes, retains attribution and expansion when pages append, without duplicate controls", async () => {
    const { dom, root } = view();
    const quote = root.querySelector<HTMLElement>("blockquote")!;
    quote.getBoundingClientRect = () => ({ height: 600 } as DOMRect);
    const cleanup = enhanceQuotes(root, URL);
    const details = quote.querySelector("details")!;
    expect(details).not.toBeNull();
    expect(quote.querySelector(":scope > p > cite")?.textContent).toBe("Alice wrote:");
    expect(details.open).toBe(false);
    details.open = true;
    root.querySelector(".reader-content")!.insertAdjacentHTML("beforeend", '<section id="fa-post-20">Next page</section>');
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(details.open).toBe(true);
    expect(quote.querySelectorAll(".quote-jump")).toHaveLength(1);
    expect(root.dataset.quotePause).toBe("layout");
    cleanup(); dom.window.close();
  });

  it("keeps original links for missing targets and enables a jump once the post arrives", async () => {
    const { dom, root, first } = view(); first.remove();
    const cleanup = enhanceQuotes(root, URL);
    const button = root.querySelector<HTMLButtonElement>(".quote-jump")!;
    expect(button.hidden).toBe(true);
    expect(root.querySelector("blockquote a")?.getAttribute("href")).toBe(`${URL}#post-1`);
    root.querySelector(".reader-content")!.append(first);
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(button.hidden).toBe(false);
    cleanup(); dom.window.close();
  });

  it("does not save newly exposed post ends after automatic collapse or on close", async () => {
    vi.useFakeTimers();
    const { dom, root, reply } = view();
    const quote = root.querySelector<HTMLElement>("blockquote")!;
    quote.getBoundingClientRect = () => ({ height: 600 } as DOMRect);
    const send = vi.fn(async (_id: number) => ({ saved: true }));
    const stop = trackThreadPosition(root, 1, send, () => {});
    const cleanup = enhanceQuotes(root, URL);
    reply.getBoundingClientRect = () => ({ top: 100, bottom: 400 } as DOMRect);
    root.dispatchEvent(new dom.window.Event("scroll"));
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    await vi.advanceTimersByTimeAsync(1000);
    await stop();
    expect(send).not.toHaveBeenCalled();
    cleanup(); dom.window.close();
  });
});
