// Following one forum thread (D-084): its newest page is read on each check, posts the app hasn't
// seen are kept, and the thread has a single card that says how many new replies there are.
// XenForo threads, and vBulletin threads (D-120).
import { JSDOM } from "jsdom";
import { leanPageHtml, inspectForumDocument, type ForumThreadPage } from "../reader/extract.js";
import type { ThreadInspection } from "../reader/threadQuality.js";

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
  /** Which page an address made by `pageUrl` is, or null for any other address. */
  pageOf(url: string): number | null;
}

export function xenforoPager(url: string): ThreadPager | null {
  const address = threadAddress(new URL(url));
  if (!address) return null;
  return {
    pageUrl: (n) => threadPageUrl(address, n),
    latestUrl: latestPageUrl(address),
    pageOf: (u) => (u === address ? 1 : u.startsWith(`${address}page-`) ? wholeNumber(u.slice(`${address}page-`.length)) : null),
  };
}

/** "12" → 12; anything else (including "0", "12x") → null. */
function wholeNumber(text: string): number | null {
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
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
    return {
      pageUrl: (n) => (n <= 1 ? `${base}.html` : `${base}-${n}.html`),
      latestUrl: null,
      pageOf: (v) => (v === `${base}.html` ? 1 : v.startsWith(`${base}-`) && v.endsWith(".html") ? wholeNumber(v.slice(base.length + 1, -".html".length)) : null),
    };
  }
  const t = u.searchParams.get("t");
  if (/\/showthread\.php$/i.test(u.pathname) && t && /^\d+$/.test(t)) {
    const base = `${u.origin}${u.pathname}?t=${t}`;
    return {
      pageUrl: (n) => (n <= 1 ? base : `${base}&page=${n}`),
      latestUrl: null,
      pageOf: (v) => (v === base ? 1 : v.startsWith(`${base}&page=`) ? wholeNumber(v.slice(`${base}&page=`.length)) : null),
    };
  }
  return null;
}

/**
 * A followed thread's pages, from its own address (the source's feed_url): XenForo, else vBulletin
 * (D-120). Only for thread sources, whose address was confirmed to be a thread when it was added.
 */
export function followedThreadPager(address: string): ThreadPager | null {
  try {
    return xenforoPager(address) ?? vbulletinPager(address);
  } catch {
    return null;
  }
}

/**
 * A pasted vBulletin-style thread link, as the thread's first page; null for anything else. Such an
 * address can also be another kind of site's article (D-099), so it is followed as a thread only
 * if its page turns out to be one.
 */
export function vbulletinThreadAddress(url: URL): string | null {
  return vbulletinPager(url.href)?.pageUrl(1) ?? null;
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
  const result = inspectThreadPage(html, pageUrl);
  return result.status === "complete" ? result.value : null;
}

export function inspectThreadPage(html: string, pageUrl: string): ThreadInspection {
  const dom = new JSDOM(leanPageHtml(html), { url: pageUrl });
  try {
    return inspectForumDocument(dom.window.document, pageUrl, html.length > 3_000_000);
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
