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

/** How to reach the pages of a forum thread in the reader (D-088, D-099). */
export interface ThreadPager {
  pageUrl(page: number): string;
  /** The newest page in one request, where the forum has such an address (XenForo); else null. */
  latestUrl: string | null;
}

export function xenforoPager(url: string): ThreadPager | null {
  const address = threadAddress(new URL(url));
  return address ? { pageUrl: (n) => threadPageUrl(address, n), latestUrl: latestPageUrl(address) } : null;
}

/** A vBulletin board's feed: …/external.php?type=RSS2… (e.g. Bike Forums). */
export function isVbulletinFeed(feedUrl: string | null): boolean {
  try {
    return !!feedUrl && /\/external\.php$/i.test(new URL(feedUrl).pathname);
  } catch {
    return false;
  }
}

/**
 * vBulletin thread pages (D-099), from the thread link a board feed gives (page 1):
 * friendly addresses ".../1000939-title.html" → ".../1000939-title-20.html", or
 * "showthread.php?t=1000939" → "&page=20". The link is taken as page 1 as it is: a title ending
 * in a number would be ambiguous otherwise.
 */
export function vbulletinPager(url: string): ThreadPager | null {
  const u = new URL(url);
  const seo = /^(.*\/\d+-[^/]+?)(?:-new-post)?\.html$/.exec(u.pathname);
  if (seo) {
    const base = `${u.origin}${seo[1]}`;
    return { pageUrl: (n) => (n <= 1 ? `${base}.html` : `${base}-${n}.html`), latestUrl: null };
  }
  const t = u.searchParams.get("t");
  if (/\/showthread\.php$/i.test(u.pathname) && t && /^\d+$/.test(t)) {
    const base = `${u.origin}${u.pathname}?t=${t}`;
    return { pageUrl: (n) => (n <= 1 ? base : `${base}&page=${n}`), latestUrl: null };
  }
  return null;
}

/** The pager for an item's link: a XenForo thread, or a thread from a vBulletin board's feed. */
export function threadPagerFor(url: string | null, feedUrl: string | null): ThreadPager | null {
  if (!url) return null;
  try {
    return xenforoPager(url) ?? (isVbulletinFeed(feedUrl) ? vbulletinPager(url) : null);
  } catch {
    return null;
  }
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
