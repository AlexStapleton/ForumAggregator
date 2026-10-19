// "Reader mode": pulling the article out of a full web page.
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { htmlToText } from "../feeds/text.js";
import { sanitizeHtml } from "./sanitize.js";

/** Below this much text, what we got is probably a teaser, a paywall or an error page. */
export const MIN_ARTICLE_TEXT = 300;

export interface Extracted {
  html: string;
  title: string | null;
  byline: string | null;
  textLength: number;
}

export function extractArticle(pageHtml: string, pageUrl: string): Extracted | null {
  return extractWithSelectors(pageHtml, pageUrl, {}).article;
}

/** Per-source overrides (D-074): CSS selectors applied to the original page. */
export interface ReaderSelectors {
  /** The article: every match, in page order. Replaces Readability when set. */
  article?: string | null;
  /** Elements removed from the page first (share bars, related links, ads…). */
  remove?: string | null;
}

export interface SelectorExtraction {
  article: Extracted | null;
  /** How many elements the article selector matched (null when not set). */
  matched: number | null;
  /** How many elements the remove selector took out (null when not set). */
  removed: number | null;
}

export function extractWithSelectors(pageHtml: string, pageUrl: string, selectors: ReaderSelectors): SelectorExtraction {
  // Scripts never run (jsdom's default) and no subresources are loaded.
  const dom = new JSDOM(pageHtml.slice(0, 3_000_000), { url: pageUrl });
  try {
    const doc = dom.window.document;
    // Many sites lazy-load images with data-src; make them real before extraction.
    for (const img of Array.from(doc.querySelectorAll("img[data-src], img[data-lazy-src], img[data-original]"))) {
      const real = img.getAttribute("data-src") ?? img.getAttribute("data-lazy-src") ?? img.getAttribute("data-original");
      if (real) img.setAttribute("src", real);
    }
    let removed: number | null = null;
    if (selectors.remove) {
      const victims = Array.from(doc.querySelectorAll(selectors.remove));
      for (const el of victims) el.remove();
      removed = victims.length;
    }
    if (selectors.article) {
      // Outermost matches only, so a selector matching nested elements doesn't repeat text.
      const matches = Array.from(doc.querySelectorAll(selectors.article)).filter(
        (el, _i, all) => !all.some((other) => other !== el && other.contains(el)),
      );
      const html = sanitizeHtml(matches.map((el) => el.outerHTML).join("\n"), pageUrl);
      const textLength = htmlToText(html).length;
      const hasImage = /<img\b/i.test(html);
      return {
        article: textLength > 0 || hasImage ? { html, title: doc.title || null, byline: null, textLength } : null,
        matched: matches.length,
        removed,
      };
    }
    // A XenForo thread: the posts, not Readability's guess (D-081).
    const thread = xenforoThread(doc, pageUrl);
    if (thread) return { article: thread, matched: null, removed };
    const article = new Readability(doc, { charThreshold: MIN_ARTICLE_TEXT }).parse();
    if (!article?.content) return { article: null, matched: null, removed };
    const html = sanitizeHtml(article.content, pageUrl);
    const textLength = htmlToText(html).length;
    if (textLength < MIN_ARTICLE_TEXT) return { article: null, matched: null, removed };
    return { article: { html, title: article.title ?? null, byline: article.byline ?? null, textLength }, matched: null, removed };
  } finally {
    dom.window.close();
  }
}

/** Posts shown from one thread page (XenForo shows 20 by default). */
const MAX_THREAD_POSTS = 50;

/** True for XenForo thread links (…/threads/title.123/, any page). */
export function isForumThreadUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    return /\/threads\/[^/]+\.\d+(\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface ForumPost {
  /** The forum's post ID, e.g. "123456". */
  id: string | null;
  author: string | null;
  /** ISO time from the page, and how the page shows it ("Today at 8:00 AM"). */
  datetime: string | null;
  timeLabel: string | null;
  /** When it was posted (ms), from XenForo's data-time or the ISO time. */
  postedAt: number | null;
  /** Sanitised post body. */
  html: string;
}

export interface ForumThreadPage {
  title: string | null;
  posts: ForumPost[];
  page: number;
  pages: number;
}

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** XenForo 2 thread page → its posts (author, time, body), or null if it isn't one. */
export function parseForumThread(doc: Document, pageUrl: string): ForumThreadPage | null {
  const articles = Array.from(doc.querySelectorAll("article.message")).filter((p) => p.querySelector(".bbWrapper"));
  if (!articles.length) return null;
  const posts: ForumPost[] = articles.map((post) => {
    const author = post.getAttribute("data-author") ?? post.querySelector(".message-name, .username")?.textContent?.trim() ?? null;
    const time = post.querySelector("time.u-dt, time[datetime]");
    const body = post.querySelector(".message-body .bbWrapper, .bbWrapper")!;
    // "Click to expand…" toggles and other buttons mean nothing without the site's scripts.
    for (const junk of Array.from(body.querySelectorAll(".bbCodeBlock-expandLink, .bbCodeSpoiler-button, script, noscript"))) junk.remove();
    const idSource = post.getAttribute("data-content") ?? post.id ?? "";
    const unix = Number(time?.getAttribute("data-time"));
    const iso = Date.parse((time?.getAttribute("datetime") ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
    return {
      postedAt: unix > 0 ? unix * 1000 : Number.isFinite(iso) ? iso : null,
      id: /(\d+)$/.exec(idSource)?.[1] ?? null,
      author,
      datetime: time?.getAttribute("datetime") ?? null,
      timeLabel: time?.textContent?.trim() || null,
      html: sanitizeHtml(body.innerHTML, pageUrl),
    };
  });
  // Page count from the page navigation ("1 2 3 … 40").
  const pages = Math.max(1, ...Array.from(doc.querySelectorAll(".pageNav-page")).map((li) => Number(li.textContent?.trim()) || 1));
  const page = Number(doc.querySelector(".pageNav-page--current")?.textContent?.trim()) || 1;
  const title = doc.querySelector("h1.p-title-value")?.textContent?.trim() || doc.title || null;
  return { title, posts, page, pages };
}

/** Posts as reader HTML: author and time above each body. Input bodies are already sanitised. */
export function renderForumPosts(posts: Array<Pick<ForumPost, "author" | "datetime" | "timeLabel" | "html">>): string {
  return posts
    .map((p) => {
      const head = [
        p.author ? `<strong>${escHtml(p.author)}</strong>` : "",
        p.timeLabel ? `<time datetime="${escHtml(p.datetime ?? "")}">${escHtml(p.timeLabel)}</time>` : "",
      ].filter(Boolean).join(" · ");
      return `<section><p>${head}</p>${p.html}</section><hr>`;
    })
    .join("\n");
}

/** A thread page for the reader: up to 50 posts, plus a note when there are more pages (D-081). */
function xenforoThread(doc: Document, pageUrl: string): Extracted | null {
  const thread = parseForumThread(doc, pageUrl);
  if (!thread) return null;
  let html = renderForumPosts(thread.posts.slice(0, MAX_THREAD_POSTS));
  if (thread.pages > 1) html += `\n<p><em>Page ${thread.page} of ${thread.pages}. Open the original for the rest of the thread.</em></p>`;
  const textLength = htmlToText(html).length;
  if (!thread.posts.some((p) => htmlToText(p.html).length)) return null;
  return { html, title: thread.title, byline: thread.posts[0]?.author ?? null, textLength };
}

const validator = new JSDOM("<!doctype html><p></p>").window.document;

/** Whether a CSS selector is valid (it's tried against an empty document). */
export function isValidSelector(selector: string): boolean {
  try {
    validator.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** The YouTube video ID of a watch / shorts / youtu.be link, or null. */
export function youtubeVideoId(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$/.test(u.hostname)) {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{6,20}$/.test(v)) return v;
      const m = /^\/(shorts|embed|live)\/([A-Za-z0-9_-]{6,20})/.exec(u.pathname);
      if (m) return m[2]!;
    }
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1);
      if (/^[A-Za-z0-9_-]{6,20}$/.test(id)) return id;
    }
  } catch {
    // not a URL
  }
  return null;
}

// ---- polishing extracted/feed HTML before it's shown ----------------------------------------

/** Typical media/share toolbar entries: "Download", "Transcript", "Embed", "Share on X", … */
const TOOLBAR_ITEM = /^(download|transcript|embed|share|listen|play|pause|email|e-mail|facebook|twitter|x|threads|bluesky|linkedin|reddit|whatsapp|print|copy link|save|subscribe)\b/i;
const EMBED_SNIPPET = /^\s*<(iframe|script|embed|object|video|audio)\b[\s\S]*>\s*$/i;

function normTitle(t: string): string {
  return htmlToText(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * Removes page furniture that extraction sometimes keeps: embed-code snippets ("Embed <iframe…>"),
 * media/share toolbars, and a heading that just repeats the item's title. Input must already be
 * sanitised; this only removes nodes. Runs when an article is shown, so improvements here also
 * apply to articles cached earlier.
 */
export function polishArticle(html: string, title: string): string {
  if (!html) return html;
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  try {
    const doc = dom.window.document;
    let changed = false;

    // 1. Embed snippets shown as text: a code block that is exactly one embed tag.
    for (const el of Array.from(doc.querySelectorAll("code, pre, textarea, kbd"))) {
      const text = el.textContent ?? "";
      if (text.length < 2000 && EMBED_SNIPPET.test(text)) {
        el.remove();
        changed = true;
      }
    }

    // 2. Toolbars: lists whose every item is short and starts like a toolbar entry.
    for (const list of Array.from(doc.querySelectorAll("ul, ol"))) {
      const items = Array.from(list.children).filter((c) => c.tagName === "LI");
      if (items.length >= 2 && items.every((li) => {
        const t = (li.textContent ?? "").replace(/\s+/g, " ").trim();
        return t.length <= 40 && TOOLBAR_ITEM.test(t);
      })) {
        list.remove();
        changed = true;
      }
    }

    // 3. A heading before the first paragraph that repeats the title.
    const first = doc.body.querySelector("h1, h2, h3, h4, p");
    if (first && first.tagName !== "P" && normTitle(first.textContent ?? "") === normTitle(title)) {
      first.remove();
      changed = true;
    }

    if (!changed) return html;
    // Drop wrappers the removals left empty.
    for (const el of Array.from(doc.body.querySelectorAll("li, ul, ol, div, span, p, b, strong"))) {
      if (!el.textContent?.trim() && !el.querySelector("img")) el.remove();
    }
    return doc.body.innerHTML.trim();
  } finally {
    dom.window.close();
  }
}
