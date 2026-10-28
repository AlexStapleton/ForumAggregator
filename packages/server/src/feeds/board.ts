// Following a vBulletin board's activity (D-123): each check reads the board's first page (and its
// sub-forums' first pages), and every thread there has one card that comes back with new replies.
import { JSDOM } from "jsdom";
import { leanPageHtml, vbulletinTime, vbulletinTimeOffset } from "../reader/extract.js";
import { safeHttpUrl } from "./text.js";

/** One thread as a board page lists it. */
export interface BoardThread {
  /** The forum's thread ID, e.g. "1000939". */
  id: string;
  title: string;
  /** The thread's first page. */
  url: string;
  starter: string | null;
  sticky: boolean;
  replies: number | null;
  /** The newest post's ID ("23823292"), from the "Go to last post" link; it only grows. */
  lastPostId: string | null;
  /** The page holding the newest post, without its #post anchor. */
  lastPageUrl: string | null;
  lastPoster: string | null;
  /** When the newest post was written (ms), when the page says which time zone it shows. */
  lastPostAt: number | null;
}

export interface BoardPage {
  title: string | null;
  threads: BoardThread[];
  /** The first pages of the board's sub-forums, as its "Sub-Forums" list links them. */
  subforums: string[];
}

/** Cheap check before building the page: vBulletin's thread list (threadbits_forum_<id>). */
export function looksLikeVbulletinBoard(html: string): boolean {
  return /id=["']threadbits_forum_\d+["']/.test(html);
}

/** A vBulletin 3/4 board page → its threads, or null when it has no thread list. */
export function parseBoardPage(html: string, pageUrl: string, now = Date.now()): BoardPage | null {
  const dom = new JSDOM(leanPageHtml(html), { url: pageUrl });
  try {
    const doc = dom.window.document;
    const list = doc.querySelector('[id^="threadbits_forum_"]');
    if (!list) return null;
    const offset = vbulletinTimeOffset(doc);
    const threads: BoardThread[] = [];
    const seen = new Set<string>();
    for (const link of Array.from(list.querySelectorAll('a[id^="thread_title_"]'))) {
      const id = /^thread_title_(\d+)$/.exec(link.id)?.[1];
      const url = safeHttpUrl(link.getAttribute("href"), pageUrl);
      const title = link.textContent?.replace(/\s+/g, " ").trim();
      if (!id || !url || !title || seen.has(id)) continue;
      seen.add(id);
      const row = link.closest(".trow, tr");
      const titleCell = link.closest('[id^="td_threadtitle_"]') ?? row;
      // "Sticky" before the title (stock vBulletin: "Sticky:"), or Bike Forums' sticky icon.
      const before = (titleCell?.textContent ?? "").split(link.textContent ?? "")[0] ?? "";
      const sticky = !!row?.querySelector('img[alt="Sticky Thread" i]') || /\bSticky\b/i.test(before);
      const starter = titleCell?.querySelector('.smallfont span[onclick], .smallfont a[href*="member"]')?.textContent?.trim() || null;
      // The last post cell carries "Replies: 519, Views: …" as its title (stock vBulletin 3 too).
      const last = row?.querySelector('[title^="Replies:"]') ?? null;
      const replies = /Replies:\s*([\d,]+)/.exec(last?.getAttribute("title") ?? "")?.[1];
      const lastLink = last?.querySelector('a[href*="#post"]') ?? null;
      const lastHref = safeHttpUrl(lastLink?.getAttribute("href"), pageUrl);
      const lastText = (last?.textContent ?? "").replace(/\s+/g, " ");
      const when = lastText.split(/\bby\b/)[0] ?? "";
      threads.push({
        id,
        title,
        url,
        starter,
        sticky,
        replies: replies ? Number(replies.replace(/,/g, "")) : null,
        lastPostId: /#post(\d+)$/.exec(lastHref ?? "")?.[1] ?? null,
        lastPageUrl: lastHref ? lastHref.replace(/#.*$/, "") : null,
        lastPoster: last?.querySelector('a:not([href*="#post"])')?.textContent?.trim() || null,
        lastPostAt: offset !== null ? vbulletinTime(when, offset, now) : null,
      });
    }
    // Sub-forums are listed as forum rows with id="f<forumid>".
    const subforums = Array.from(doc.querySelectorAll('[id^="f"]'))
      .filter((el) => /^f\d+$/.test(el.id))
      .map((el) => safeHttpUrl(el.querySelector("a[href]")?.getAttribute("href"), pageUrl))
      .filter((u): u is string => !!u && u !== pageUrl);
    return { title: doc.title.trim() || null, threads, subforums: [...new Set(subforums)] };
  } finally {
    dom.window.close();
  }
}

/** The card's one-line summary (D-123): "3 new replies · last by SoCaled", or the thread when new. */
export function boardThreadSummary(t: BoardThread, newReplies: number | null): string {
  const by = t.lastPoster ? ` · last by ${t.lastPoster}` : "";
  if (newReplies !== null && newReplies > 0) return `${newReplies} new ${newReplies === 1 ? "reply" : "replies"}${by}`;
  if (!t.replies) return t.starter ? `New thread by ${t.starter}` : "New thread";
  return `${t.replies} ${t.replies === 1 ? "reply" : "replies"}${by}`;
}
