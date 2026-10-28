// "Reader mode": pulling the article out of a full web page.
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { ItemAudio } from "@fa/shared";
import { htmlToText, safeHttpUrl } from "../feeds/text.js";
import { sanitizeHtml } from "./sanitize.js";

/** Below this much text, what we got is probably a teaser, a paywall or an error page. */
export const MIN_ARTICLE_TEXT = 300;

export interface Extracted {
  html: string;
  title: string | null;
  byline: string | null;
  textLength: number;
  /** Forum thread pages: this page and the thread's page count (D-088). */
  pages?: { page: number; pages: number };
  /** The forum's own link to the next page, when it has one (vBulletin, D-098). */
  nextPageUrl?: string | null;
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
  /** The story's own audio, when the page has one (D-096). */
  audio: ItemAudio | null;
}

const AUDIO_FILE = /\.(mp3|m4a|aac|ogg|oga|opus|wav)(\?|$)/i;

/**
 * The story's audio on an article page (D-096): og:audio, an <audio> (or its <source>) with an
 * address, or NPR's headline player's Download link (NPR fills its <audio> by script, which never
 * runs here). Only http(s) addresses of audio files from the link; any from the tags.
 */
export function pageAudio(doc: Document, pageUrl: string): ItemAudio | null {
  const tagged = [
    doc.querySelector('meta[property="og:audio:secure_url"]')?.getAttribute("content"),
    doc.querySelector('meta[property="og:audio"]')?.getAttribute("content"),
    doc.querySelector("audio[src]")?.getAttribute("src"),
    doc.querySelector("audio source[src]")?.getAttribute("src"),
  ];
  for (const raw of tagged) {
    const url = safeHttpUrl(raw, pageUrl);
    if (url) return { url, durationSeconds: null };
  }
  const link = doc.querySelector(".headlineaudio .audio-tool-download a[href]") ?? doc.querySelector(".audio-tool-download a[href]");
  const url = safeHttpUrl(link?.getAttribute("href"), pageUrl);
  if (!url || !AUDIO_FILE.test(new URL(url).pathname)) return null;
  // NPR puts the length in seconds in the link (d=168).
  const d = Number(new URL(url).searchParams.get("d"));
  return { url, durationSeconds: /(^|\.)npr\.org$/.test(new URL(url).hostname) && Number.isInteger(d) && d > 0 ? d : null };
}

/**
 * A page without what extraction never uses (D-107): scripts, styles, inline SVG icons and
 * comments, often 20–40 % of a forum page, so it's quicker to build. <noscript> stays: reader mode
 * uses the images in it.
 */
export function leanPageHtml(html: string): string {
  return html.slice(0, 3_000_000).replace(/<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<svg\b[\s\S]*?<\/svg\s*>|<!--[\s\S]*?-->/gi, "");
}

export function extractWithSelectors(pageHtml: string, pageUrl: string, selectors: ReaderSelectors): SelectorExtraction {
  // Scripts never run (jsdom's default) and no subresources are loaded.
  const dom = new JSDOM(leanPageHtml(pageHtml), { url: pageUrl });
  try {
    const doc = dom.window.document;
    // Many sites lazy-load images with data-src; make them real before extraction.
    for (const img of Array.from(doc.querySelectorAll("img[data-src], img[data-lazy-src], img[data-original]"))) {
      const real = img.getAttribute("data-src") ?? img.getAttribute("data-lazy-src") ?? img.getAttribute("data-original");
      if (real) img.setAttribute("src", real);
    }
    // Before anything is removed: the player may sit outside the article.
    const audio = pageAudio(doc, pageUrl);
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
        audio,
      };
    }
    // A XenForo thread: the posts, not Readability's guess (D-081).
    const thread = xenforoThread(doc, pageUrl) ?? vbulletinThread(doc, pageUrl);
    if (thread) return { article: thread, matched: null, removed, audio };
    const article = new Readability(doc, { charThreshold: MIN_ARTICLE_TEXT }).parse();
    if (!article?.content) return { article: null, matched: null, removed, audio };
    const html = sanitizeHtml(article.content, pageUrl);
    const textLength = htmlToText(html).length;
    if (textLength < MIN_ARTICLE_TEXT) return { article: null, matched: null, removed, audio };
    return { article: { html, title: article.title ?? null, byline: article.byline ?? null, textLength }, matched: null, removed, audio };
  } finally {
    dom.window.close();
  }
}

/**
 * Posts shown from one thread page: all of them on any usual forum setting (XenForo shows 20 by
 * default; Bike Forums 75, whose newest were cut off at the old 50, D-123).
 */
const MAX_THREAD_POSTS = 100;

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
    // The post's own time is in its header; the member box can hold another <time> (Overclock.net's
    // "Joined" date, D-102), so that one is never used.
    const time =
      post.querySelector(".message-attribution time, time[qid='post-date-time']") ??
      Array.from(post.querySelectorAll("time.u-dt, time[datetime]")).find((t) => !t.closest(".message-user, .message-cell--user, .message-userDetails")) ??
      null;
    const body = post.querySelector(".message-body .bbWrapper, .bbWrapper")!;
    // "Click to expand…" toggles and other buttons mean nothing without the site's scripts.
    for (const junk of Array.from(body.querySelectorAll(".bbCodeBlock-expandLink, .bbCodeSpoiler-button, script, noscript"))) junk.remove();
    const idSource = post.getAttribute("data-content") ?? post.id ?? "";
    const unix = Number(time?.getAttribute("data-time") ?? time?.getAttribute("california-data-time"));
    const iso = Date.parse((time?.getAttribute("datetime") ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
    // A Unix time before 2000 isn't a post time (placeholders); the ISO attribute is used then.
    const postedAt = unix > 946_684_800 ? unix * 1000 : Number.isFinite(iso) ? iso : null;
    return {
      postedAt,
      id: /(\d+)$/.exec(idSource)?.[1] ?? null,
      author,
      // Standard ISO from the exact time, so browsers can show it in local time (XenForo writes "+0000").
      datetime: postedAt !== null ? new Date(postedAt).toISOString() : (time?.getAttribute("datetime") ?? null),
      timeLabel: time?.textContent?.trim() || null,
      html: sanitizeHtml(body.innerHTML, pageUrl),
    };
  });
  // Page count from the page navigation ("1 2 3 … 40"); Overclock.net's theme shows "22/23" on the
  // current page's button instead (D-102).
  let pages = Math.max(1, ...Array.from(doc.querySelectorAll(".pageNav-page")).map((li) => Number(li.textContent?.trim()) || 1));
  let page = Number(doc.querySelector(".pageNav-page--current")?.textContent?.trim()) || 1;
  const compact = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(doc.querySelector(".pageNav [aria-current='page']")?.textContent ?? "");
  if (compact && pages === 1) {
    page = Number(compact[1]);
    pages = Math.max(page, Number(compact[2]));
  }
  const title =
    doc.querySelector("h1.p-title-value")?.textContent?.trim() ||
    doc.querySelector(".p-title h1, .p-body-header h1")?.textContent?.trim() ||
    cleanPageTitle(doc.title) ||
    null;
  return { title, posts, page, pages };
}

/** A browser tab title without the unread count and page/site suffix: "(3) Title | Page 22 | Site" → "Title". */
export function cleanPageTitle(title: string | null | undefined): string {
  return (title ?? "")
    .replace(/^\(\d+\)\s*/, "")
    .replace(/\s*\|\s*Page \d+\s*(\|.*)?$/i, "")
    .replace(/\s*\|\s*[^|]+$/, (m) => (/\.(net|com|org)\b|forum/i.test(m) ? "" : m))
    .trim();
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

/** A thread page for the reader: its posts (up to 100), and which page of how many (D-081, D-088). */
function xenforoThread(doc: Document, pageUrl: string): Extracted | null {
  const thread = parseForumThread(doc, pageUrl);
  if (!thread) return null;
  const html = renderForumPosts(thread.posts.slice(0, MAX_THREAD_POSTS));
  const textLength = htmlToText(html).length;
  if (!thread.posts.some((p) => htmlToText(p.html).length)) return null;
  return { html, title: thread.title, byline: thread.posts[0]?.author ?? null, textLength, pages: { page: thread.page, pages: thread.pages } };
}

/**
 * vBulletin 3/4 thread page (e.g. Bike Forums) → its posts (D-098): author and date above each
 * post's own text (#post_message_<id>). The member sidebar (rank, badges, join date, post count),
 * signatures and buttons sit outside it and are left out. Quotes become block quotes.
 */
export function parseVbulletinThread(doc: Document, pageUrl: string): ForumThreadPage | null {
  const bodies = Array.from(doc.querySelectorAll('[id^="post_message_"]')).filter((el) => /^post_message_\d+$/.test(el.id));
  if (!bodies.length) return null;
  const offset = vbulletinTimeOffset(doc);
  const now = Date.now();
  const posts: ForumPost[] = bodies.map((body) => {
    const id = body.id.slice("post_message_".length);
    const post = doc.getElementById(`post${id}`) ?? doc.getElementById(`post_${id}`) ?? body.closest("table, li");
    const author = post?.querySelector(".bigusername, a.username, .username")?.textContent?.trim() || null;
    // vB4: .postdate; vB3: the post's header cell ("10-23-26 | 12:23 AM", "#1" in the next cell).
    const dateEl = post?.querySelector(".postdate .date, .postdate") ?? post?.querySelector(".thead .tcell, td.thead, .thead");
    const timeLabel = dateEl?.textContent?.replace(/\s+/g, " ").replace(/#\s*\d+\s*$/, "").trim().slice(0, 60) || null;
    vbulletinQuotes(body);
    for (const junk of Array.from(body.querySelectorAll("script, noscript, img[alt='View Post']"))) junk.remove();
    // A real time only when the page says which time zone its times are in (D-123).
    const postedAt = offset !== null && timeLabel ? vbulletinTime(timeLabel, offset, now) : null;
    const datetime = postedAt !== null ? new Date(postedAt).toISOString() : null;
    return { id, author, datetime, timeLabel, postedAt, html: sanitizeHtml(body.innerHTML, pageUrl) };
  });
  // Bike Forums' theme: "20 / 21" (#mb_page_current, #mb_page_total). Classic: "Page 20 of 21", an
  // innermost element of the page navigation (the page links sit beside it).
  const current = Number(doc.getElementById("mb_page_current")?.textContent);
  const total = Number(doc.getElementById("mb_page_total")?.textContent);
  const nav: [unknown, string, string] | null | undefined =
    current > 0 && total > 0
      ? [null, String(current), String(total)]
      : (Array.from(doc.querySelectorAll(".pagenav *, .pagination *, .threadpagenav *"))
          .filter((el) => !el.firstElementChild)
          .map((el) => /^\s*Page (\d+) of (\d+)\s*$/i.exec(el.textContent ?? ""))
          .find(Boolean) as [unknown, string, string] | undefined);
  const page = nav ? Number(nav[1]) : 1;
  const pages = nav ? Math.max(page, Number(nav[2])) : 1;
  const title = doc.querySelector("h1.threadtitle, .threadtitle, h1")?.textContent?.trim() || doc.title || null;
  return { title, posts, page, pages };
}

/**
 * The time zone of a vBulletin page's times, in minutes from UTC, from its footer ("All times are
 * GMT -6.", "GMT +5.5.", "GMT."); null when the page doesn't say (D-123).
 */
export function vbulletinTimeOffset(doc: Document): number | null {
  const m = /All times are GMT\s*(?:([+-])\s*(\d+(?:\.\d+)?))?\s*\./i.exec(doc.body?.textContent ?? "");
  if (!m) return null;
  return m[1] ? (m[1] === "-" ? -1 : 1) * Math.round(Number(m[2]) * 60) : 0;
}

/**
 * A vBulletin time as shown ("03-31-15 | 09:09 AM", "08-04-26 12:49 PM", "Today, 08:00 PM",
 * "Yesterday 21:15"), in the page's time zone → ms, or null. Dates are month-day-year, vBulletin's
 * default (as Bike Forums shows them).
 */
export function vbulletinTime(label: string, offsetMinutes: number, now: number): number | null {
  const time = /(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(label);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  if (time[3]) hour = (hour % 12) + (/pm/i.test(time[3]) ? 12 : 0);
  if (hour > 23 || minute > 59) return null;
  let year: number, month: number, day: number;
  const date = /(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})\b/.exec(label);
  if (date) {
    month = Number(date[1]);
    day = Number(date[2]);
    const y = Number(date[3]);
    year = date[3]!.length === 4 ? y : y < 70 ? 2000 + y : 1900 + y;
  } else if (/\b(today|yesterday)\b/i.test(label)) {
    // The forum's own calendar day, now.
    const local = new Date(now + offsetMinutes * 60_000 - (/yesterday/i.test(label) ? 86_400_000 : 0));
    year = local.getUTCFullYear();
    month = local.getUTCMonth() + 1;
    day = local.getUTCDate();
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
}

/** vBulletin's quote boxes (vB3 "Quote:" + table, vB4 .bbcode_container) → <blockquote>. */
function vbulletinQuotes(body: Element) {
  const doc = body.ownerDocument;
  const quote = (who: string | null, inner: Element | null) => {
    const bq = doc.createElement("blockquote");
    if (who) {
      const p = doc.createElement("p");
      const b = doc.createElement("strong");
      b.textContent = `${who} wrote:`;
      p.append(b);
      bq.append(p);
    }
    if (inner) bq.append(...Array.from(inner.childNodes));
    return bq;
  };
  // vB4
  for (const box of Array.from(body.querySelectorAll(".bbcode_container")).reverse()) {
    const who = box.querySelector(".bbcode_postedby strong")?.textContent?.trim() ?? null;
    box.querySelector(".bbcode_postedby")?.remove();
    box.replaceWith(quote(who, box.querySelector(".message, .bbcode_quote") ?? box));
  }
  // vB3: <div><div class="smallfont">Quote:</div><table>…<td class="alt2">[<div>Originally Posted by <strong>X</strong></div><div>text</div>]</td>…</table></div>
  // Bike Forums: <div><div><label>Quote:</label></div><div class="panel alt2">[same]</div></div>
  const labels = Array.from(body.querySelectorAll("div, label, span"))
    .filter((el) => /^\s*Quote:?\s*$/i.test(el.textContent ?? ""))
    // The outermost element that is just the label (a <div> around a <label>).
    .filter((el) => !(el.parentElement && el.parentElement !== body && /^\s*Quote:?\s*$/i.test(el.parentElement.textContent ?? "")));
  for (const label of labels.reverse()) {
    const next = label.nextElementSibling;
    const cell = next?.tagName === "TABLE" ? next.querySelector("td") : next;
    if (!next || !cell) continue;
    let who: string | null = null;
    const by = Array.from(cell.children).find((c) => /^\s*Originally Posted by/i.test(c.textContent ?? ""));
    if (by) {
      who = by.querySelector("strong, b")?.textContent?.trim() ?? null;
      by.remove();
    }
    const box = label.parentElement && label.parentElement !== body ? label.parentElement : null;
    const replacement = quote(who, cell);
    if (box && box.children.length === 2) box.replaceWith(replacement);
    else {
      next.replaceWith(replacement);
      label.remove();
    }
  }
}

/** A vBulletin thread page for the reader (D-098): its posts, which page of how many, and the next page's link. */
function vbulletinThread(doc: Document, pageUrl: string): Extracted | null {
  const thread = parseVbulletinThread(doc, pageUrl);
  if (!thread || !thread.posts.some((p) => htmlToText(p.html).length)) return null;
  const html = renderForumPosts(thread.posts.slice(0, MAX_THREAD_POSTS));
  const nextPageUrl = safeHttpUrl(doc.querySelector('link[rel="next"], a[rel="next"]')?.getAttribute("href"), pageUrl);
  return {
    html,
    title: thread.title,
    byline: thread.posts[0]?.author ?? null,
    textLength: htmlToText(html).length,
    pages: { page: thread.page, pages: thread.pages },
    nextPageUrl,
  };
}

/** For a thread page shown without the in-app pager: which page it is, and a link to the next. */
export function pageNote(article: Pick<Extracted, "pages" | "nextPageUrl">): string {
  if (!article.pages || article.pages.pages <= 1) return "";
  const next = article.nextPageUrl ? ` <a href="${escHtml(article.nextPageUrl)}">Next page on the forum</a>` : "";
  return `<p><em>Page ${article.pages.page} of ${article.pages.pages}.</em>${next}</p>`;
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

/**
 * Page furniture some feeds put around the article (D-103): NASA Science's feed carries the whole
 * rendered page (its menus, "You may also be interested in", "Keep Exploring"). Matched by
 * markup, so it runs on the feed's raw HTML, before sanitising removes classes.
 */
const FEED_FURNITURE = [
  "nav",
  '[role="navigation"]',
  '[class*="breadcrumb"]',
  '[class*="secondary-navigation"]',
  // WordPress: related posts, share buttons (Jetpack and others), NASA's content and topic cards.
  ".jp-relatedposts, .sharedaddy, .share-buttons, .social-share, .wp-block-social-links",
  '[class*="related-posts"], [class*="related-articles"], [class*="content-lists"], [class*="topic-cards"], [class*="credits-and-details"]',
].join(", ");
/** WordPress's feed footer: "The post X appeared first on Site." */
const FEED_FOOTER = /^\s*The post .+ appeared first on .+\.\s*$/;

/** Feed HTML without page furniture; unchanged (same string) when there is none. Untrusted in, untrusted out. */
export function cleanFeedHtml(html: string): string {
  if (!/<nav\b|navigation|breadcrumb|related|share|content-lists|topic-cards|credits-and-details|appeared first on/i.test(html)) return html;
  const dom = new JSDOM(`<!doctype html><body>${html.slice(0, 1_000_000)}</body>`);
  try {
    const doc = dom.window.document;
    let changed = false;
    for (const el of Array.from(doc.body.querySelectorAll(FEED_FURNITURE))) {
      if (!el.isConnected) continue;
      el.remove();
      changed = true;
    }
    const last = Array.from(doc.body.querySelectorAll("p")).at(-1);
    if (last && FEED_FOOTER.test(last.textContent ?? "")) {
      last.remove();
      changed = true;
    }
    return changed ? doc.body.innerHTML : html;
  } finally {
    dom.window.close();
  }
}

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
