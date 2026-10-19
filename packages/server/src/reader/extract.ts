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
  // Scripts never run (jsdom's default) and no subresources are loaded.
  const dom = new JSDOM(pageHtml.slice(0, 3_000_000), { url: pageUrl });
  try {
    const doc = dom.window.document;
    // Many sites lazy-load images with data-src; make them real before extraction.
    for (const img of Array.from(doc.querySelectorAll("img[data-src], img[data-lazy-src], img[data-original]"))) {
      const real = img.getAttribute("data-src") ?? img.getAttribute("data-lazy-src") ?? img.getAttribute("data-original");
      if (real) img.setAttribute("src", real);
    }
    const article = new Readability(doc, { charThreshold: MIN_ARTICLE_TEXT }).parse();
    if (!article?.content) return null;
    const html = sanitizeHtml(article.content, pageUrl);
    const textLength = htmlToText(html).length;
    if (textLength < MIN_ARTICLE_TEXT) return null;
    return { html, title: article.title ?? null, byline: article.byline ?? null, textLength };
  } finally {
    dom.window.close();
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

/** Removes a leading <h1>/<h2> that just repeats the item's title (the reader shows the title already). */
export function dropRepeatedTitle(html: string, title: string): string {
  const m = /^((?:\s*<(?:div|section|article)[^>]*>)*)\s*<(h[12])[^>]*>([\s\S]*?)<\/\2>/i.exec(html);
  if (!m) return html;
  const norm = (t: string) => htmlToText(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (norm(m[3]!) !== norm(title)) return html;
  return m[1]! + html.slice(m[0].length);
}
