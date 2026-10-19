// Following one forum thread (D-084): its newest page is read on each check, posts the app hasn't
// seen are kept, and the thread has a single card that says how many new replies there are.
import { JSDOM } from "jsdom";
import { parseForumThread, type ForumThreadPage } from "../reader/extract.js";

const THREAD_PATH = /^(\/threads\/[^/]+\.\d+)(?:\/|$)/;

/** The thread's own address (first page, no page number or post anchor), or null. */
export function threadAddress(url: URL): string | null {
  const m = THREAD_PATH.exec(url.pathname);
  return m ? `${url.origin}${m[1]}/` : null;
}

/** XenForo sends ".../latest" to the newest post, i.e. the last page. */
export function latestPageUrl(thread: string): string {
  return `${thread}latest`;
}

export function threadPageUrl(thread: string, page: number): string {
  return page <= 1 ? thread : `${thread}page-${page}`;
}

/** A fetched thread page, parsed; null when the page has no posts we can read. */
export function parseThreadPage(html: string, pageUrl: string): ForumThreadPage | null {
  const dom = new JSDOM(html.slice(0, 3_000_000), { url: pageUrl });
  try {
    return parseForumThread(dom.window.document, pageUrl);
  } finally {
    dom.window.close();
  }
}

/** The card's one-line summary: "3 new replies · Reaper55: Looking great!". */
export function threadSummary(count: number, latest: { author: string | null; text: string } | null): string {
  const n = `${count} new ${count === 1 ? "reply" : "replies"}`;
  if (!latest) return n;
  const excerpt = latest.text.length > 160 ? `${latest.text.slice(0, 157).trimEnd()}…` : latest.text;
  return `${n} · ${latest.author ?? "someone"}: ${excerpt}`;
}

/** Numeric post IDs, so "newer than" works (XenForo post IDs only grow). */
export function postNumber(id: string): number {
  const n = Number(id);
  return Number.isFinite(n) ? n : 0;
}
