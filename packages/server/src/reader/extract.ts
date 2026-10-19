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
