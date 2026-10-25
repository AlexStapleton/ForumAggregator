// The in-app reader: what to show when an item is opened.
//   1. YouTube item          → the video (embedded), plus its description
//   2. full text in the feed → that, sanitised (once, then cached)
//   3. otherwise             → fetch the article page once, extract it ("reader mode"), cache it
//   4. if that fails         → the feed summary, with a notice saying why
// A source with CSS selectors set (D-074) always reads the original page (step 3) with them.
// Fetching the page happens only when the user opens the item, like a browser would.
import crypto from "node:crypto";
import type { ItemAudio, ReaderComments, ReaderContent, ReaderPreview, ReaderPreviewRequest } from "@fa/shared";
import type { Db } from "../db/index.js";
import { FetchError, type Fetcher, type HostLimiter, type JsonFetcher } from "../feeds/fetch.js";
import { threadPagerFor, xenforoPager, type ThreadPager } from "../feeds/thread.js";
import type { FlareSolverr } from "../feeds/flaresolverr.js";
import { FeedParseError, parseFeed } from "../feeds/parse.js";
import { cleanRedditHtml, cleanRedditSummary, redditCommentsFeedUrl, redditPostLink } from "../feeds/reddit.js";
import { htmlToText } from "../feeds/text.js";
import { cleanFeedHtml, extractWithSelectors, pageNote, polishArticle, renderForumPosts, youtubeVideoId, type ReaderSelectors, type SelectorExtraction } from "./extract.js";
import { layoutRedditPost } from "./redditLayout.js";
import { sanitizeHtml } from "./sanitize.js";
import type { SettingsService } from "../settings.js";
import { topComments, YouTubeApiError } from "./youtubeApi.js";

/** Don't retry a page that failed for this long (avoids hammering a site that blocks us). */
const FAILED_RETRY_MS = 24 * 3_600_000;
const INTERACTIVE = { minDelayMs: 1000, jitterMs: 300 };
/** Feed text shorter than this is a teaser: try the article page instead (except Reddit). */
const FEED_FULL_TEXT_MIN = 500;
const COMMENTS_TTL_MS = 15 * 60_000;
/** A forum thread page read more than this long ago is read again, for new replies (D-081, D-088). */
const THREAD_REFRESH_MS = 30 * 60_000;
/** Thread pages kept in memory (each is at most 50 posts). */
const THREAD_PAGES_KEPT = 100;

/** Which page of a forum thread to show: a number, or the newest ("last"). */
export type ThreadPageRequest = number | "last";
/** Earlier posts shown dimmed above a followed thread's new replies (D-102). */
const THREAD_CARD_CONTEXT_POSTS = 3;
/** Replies shown on a followed thread's card (D-084). */
const THREAD_CARD_MAX_POSTS = 100;
/**
 * Finished reader HTML kept in memory (D-086): cleaning it again on every open costs a DOM parse.
 * Bounded by count and by size (~16 MB of text), so a Pi's memory isn't eaten by long articles.
 */
const HTML_CACHE_ENTRIES = 200;
const HTML_CACHE_CHARS = 8_000_000;
const MAX_COMMENTS = 30;

class SelectorMiss extends Error {
  constructor(
    message: string,
    readonly result: SelectorExtraction,
  ) {
    super(message);
  }
}

/** A page without article text; it may still have the story's audio (D-096). */
class NoArticle extends Error {
  constructor(
    message: string,
    readonly audio: ItemAudio | null,
  ) {
    super(message);
  }
}

function pageErrorMessage(err: unknown): string {
  return err instanceof FetchError && err.isChallenge
    ? /FlareSolverr/.test(err.message)
      ? `${err.message}.`
      : "The site answered with a bot check, so the article can't be shown here. If you run FlareSolverr, turn it on for this source (Edit source)."
    : err instanceof FetchError ? `The article couldn't be loaded (${err.message}).`
    : (err as Error).message;
}

export class ReaderService {
  private inFlight = new Map<string, Promise<ReaderContent | null>>();
  /** "itemId|page" → a thread page as shown, and when it was read (D-088). LRU by Map order. */
  private threadPages = new Map<string, { at: number; content: ReaderContent }>();
  private commentsCache = new Map<string, { at: number; value: ReaderComments }>();

  constructor(
    private readonly db: Db,
    private readonly fetcher: Fetcher,
    private readonly limiter: HostLimiter,
    private readonly now: () => number = Date.now,
    private readonly settings?: SettingsService,
    private readonly fetchJson?: JsonFetcher,
    private readonly flare?: FlareSolverr,
  ) {}

  private flareFetcher?: Fetcher;
  /** key → finished HTML; Map order doubles as least-recently-used order. */
  private htmlCache = new Map<string, string>();
  private htmlCacheChars = 0;

  /**
   * Finished HTML for stored content, built once. Keyed by a hash of exactly what goes in, so
   * anything re-fetched, re-stored or renamed misses the cache.
   */
  private finished(parts: string[], build: () => string): string {
    const key = crypto.createHash("sha1").update(parts.join("\u0000")).digest("base64");
    const hit = this.htmlCache.get(key);
    if (hit !== undefined) {
      this.htmlCache.delete(key);
      this.htmlCache.set(key, hit);
      return hit;
    }
    const html = build();
    this.htmlCache.set(key, html);
    this.htmlCacheChars += html.length;
    while (this.htmlCache.size > HTML_CACHE_ENTRIES || this.htmlCacheChars > HTML_CACHE_CHARS) {
      const [oldestKey, oldest] = this.htmlCache.entries().next().value!;
      this.htmlCache.delete(oldestKey);
      this.htmlCacheChars -= oldest.length;
    }
    return html;
  }

  /** Direct, or through FlareSolverr for sources set to use it (D-080). */
  private fetcherFor(viaFlareSolverr: boolean): Fetcher {
    if (!viaFlareSolverr || !this.flare) return this.fetcher;
    this.flareFetcher ??= this.flare.wrap(this.fetcher);
    return this.flareFetcher;
  }

  /** null if the item doesn't exist. Concurrent opens of the same item share the work. */
  get(itemId: string, page?: ThreadPageRequest): Promise<ReaderContent | null> {
    const key = `${itemId}|${page ?? ""}`;
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = this.load(itemId, page).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async load(itemId: string, page?: ThreadPageRequest): Promise<ReaderContent | null> {
    const item = await this.db.kysely
      .selectFrom("items")
      .innerJoin("sources", "sources.id", "items.source_id")
      .leftJoin("item_content", "item_content.item_id", "items.id")
      .select([
        "items.id",
        "items.url",
        "items.title",
        "items.author",
        "items.summary",
        "items.published_at",
        "items.audio_url",
        "items.audio_duration",
        "items.source_id",
        "sources.thread_batch_from",
        "sources.title as source_title",
        "sources.kind as source_kind",
        "sources.article_selector",
        "sources.remove_selector",
        "sources.via_flaresolverr",
        "sources.feed_url",
        "item_content.origin",
        "item_content.status",
        "item_content.html",
        "item_content.error",
        "item_content.fetched_at",
      ])
      .where("items.id", "=", itemId)
      .executeTakeFirst();
    if (!item) return null;

    const base: Omit<ReaderContent, "kind" | "html" | "notice" | "videoId"> = {
      itemId: item.id,
      title: item.title,
      url: item.url,
      sourceTitle: item.source_title,
      author: item.author,
      publishedAt: item.published_at,
      summary: item.source_kind === "reddit" ? cleanRedditSummary(item.summary) : item.summary,
      audio: item.audio_url ? { url: item.audio_url, durationSeconds: item.audio_duration } : null,
    };
    const isReddit = item.source_kind === "reddit";
    const via = item.via_flaresolverr === 1;
    // A followed thread's card shows its new replies; asked for a page, it shows the thread itself.
    if (item.source_kind === "thread") {
      if (page === undefined || !item.url) return this.threadCard(base, item.source_id, item.thread_batch_from);
      return this.forumThread(base, item, null, via, page, () => null, xenforoPager(item.url));
    }

    const videoId = youtubeVideoId(item.url);
    if (videoId) return { ...base, kind: "video", html: null, videoId, notice: null };

    // Per-source selectors mean "read the original page with these" (never for Reddit).
    const selectors: ReaderSelectors | null =
      !isReddit && (item.article_selector || item.remove_selector) ? { article: item.article_selector, remove: item.remove_selector } : null;

    // Forum threads are read from their pages (the posts), page by page (D-081, D-088): XenForo
    // thread links, and links from a vBulletin board's feed (D-099).
    const pager = isReddit ? null : threadPagerFor(item.url, item.feed_url);
    if (pager) {
      const row = item;
      const feedText = () =>
        row.status === "raw" && row.html ? sanitizeHtml(row.html, row.url ?? "https://invalid.invalid/") || null
        : row.status === "ok" && row.origin === "feed" ? row.html
        : null;
      return this.forumThread(base, item, selectors, via, page ?? 1, feedText, pager);
    }
    const preferPage = !!selectors;

    // Cached result (from the feed or a previous extraction).
    // A short feed text cached as the article by v1.5.0 and earlier, when the page failed without a
    // word (D-096): try the page again. Not Reddit (no pages), nor a story whose audio is known.
    const stuckTeaser =
      item.status === "ok" && item.origin === "feed" && !isReddit && !item.audio_url && !!item.html && htmlToText(item.html).length < FEED_FULL_TEXT_MIN;
    if (item.status === "ok" && item.html && !(preferPage && item.origin === "feed") && !stuckTeaser) {
      const stored = item.html;
      const html = this.finished(["ok", String(isReddit), item.title, stored], () =>
        // Reddit posts cached by v1.0.x: still unwrap the thumbnail table (D-076).
        polishArticle(isReddit ? layoutRedditPost(stored, null, item.title) : stored, item.title),
      );
      return { ...base, kind: item.origin === "feed" ? "feed" : "page", html, videoId: null, notice: null };
    }
    // The feed's own text, kept as a fallback if the page can't be read.
    let feedHtml: string | null = null;
    if (item.status === "raw" && item.html) {
      const rawHtml = item.html;
      // Reddit posts are often short but complete; elsewhere a short body is just a teaser.
      if (isReddit) {
        // Laid out from the raw body (once per process), so layout fixes reach old posts too.
        const html = this.finished(["reddit", item.title, item.url ?? "", rawHtml], () =>
          polishArticle(layoutRedditPost(sanitizeHtml(cleanRedditHtml(rawHtml), item.url ?? "https://invalid.invalid/"), redditPostLink(rawHtml), item.title), item.title),
        );
        return { ...base, kind: "feed", html, videoId: null, notice: null };
      }
      // Menus and "related" blocks some feeds include are dropped first (D-103).
      const html = sanitizeHtml(cleanFeedHtml(rawHtml), item.url ?? "https://invalid.invalid/");
      if (!preferPage && htmlToText(html).length >= FEED_FULL_TEXT_MIN) {
        await this.store(item.id, "feed", "ok", html, null);
        return { ...base, kind: "feed", html: polishArticle(html, item.title), videoId: null, notice: null };
      }
      feedHtml = html || null;
    } else if (item.origin === "feed" && item.html && (item.status === "failed" || (item.status === "ok" && (preferPage || stuckTeaser)))) {
      // Already cleaned when it was stored.
      feedHtml = item.html;
    }
    // Reddit pages need JavaScript and count against Reddit's request limit: never fetch them.
    if (isReddit) {
      return this.summaryOnly(base, "Open the original to see the full post on Reddit (images, video, polls).");
    }
    if (item.status === "failed" && item.fetched_at && this.now() - item.fetched_at < FAILED_RETRY_MS) {
      const notice = item.audio_url ? null : item.error;
      if (feedHtml) return { ...base, kind: "feed", html: polishArticle(feedHtml, item.title), videoId: null, notice: notice && `${notice} Showing the feed's text instead.` };
      return this.summaryOnly(base, notice);
    }
    if (!item.url) return this.summaryOnly(base, "This item has no link to an article.");

    try {
      const { article, audio } = await this.readStoryPage(item.url, selectors ?? {}, via);
      const withAudio = { ...base, audio: base.audio ?? (audio ? await this.rememberAudio(item.id, audio) : null) };
      if (article) {
        // A forum thread read without the in-app pager (e.g. a vBulletin link from another feed): say which page.
        const html = article.html + pageNote(article);
        await this.store(item.id, "page", "ok", html, null);
        return { ...withAudio, author: base.author ?? article.byline, kind: "page", html: polishArticle(html, item.title), videoId: null, notice: null };
      }
      // An audio story (D-096): the page has no more text than the feed, and the audio is the story.
      if (feedHtml) {
        await this.store(item.id, "feed", "ok", feedHtml, null);
        return { ...withAudio, kind: "feed", html: polishArticle(feedHtml, item.title), videoId: null, notice: null };
      }
      await this.store(item.id, "page", "failed", null, "The page has no article text; the story is its audio.");
      return this.summaryOnly(withAudio, null);
    } catch (err) {
      const message = pageErrorMessage(err);
      // The feed's own body still beats the one-line summary.
      if (feedHtml) {
        const html = polishArticle(feedHtml, item.title);
        // With selectors, keep retrying the page on later opens (the user may be fixing them).
        if (preferPage) {
          return { ...base, kind: "feed", html, videoId: null, notice: `${message} Showing the feed's text instead.` };
        }
        // Kept with the reason, and the page is tried again after a day (D-096). Not when the feed's
        // text is long enough to be the article itself (it's then shown before the page is tried).
        await this.store(item.id, "feed", "failed", feedHtml, message);
        const notice = base.audio ? null : `${message} Showing the feed's text instead.`;
        return { ...base, kind: "feed", html, videoId: null, notice };
      }
      await this.store(item.id, "page", "failed", null, message);
      // A podcast episode is its audio (played above the text, D-093); its page is a bonus.
      return this.summaryOnly(base, item.audio_url ? null : message);
    }
  }

  /**
   * One page of a forum thread (D-088): read on demand (through FlareSolverr when the source uses
   * it) and kept in memory for 30 minutes per page. "last" reads XenForo's newest page. If reading
   * fails: the copy read earlier, else the feed's own text, else the summary, each with the reason.
   */
  private async forumThread(
    base: Omit<ReaderContent, "kind" | "html" | "notice" | "videoId">,
    item: { id: string; url: string | null; title: string; status: string | null; origin: string | null; html: string | null },
    selectors: ReaderSelectors | null,
    via: boolean,
    want: ThreadPageRequest,
    feedText: () => string | null,
    pager: ThreadPager | null,
  ): Promise<ReaderContent> {
    if (!pager) return this.summaryOnly(base, "This link isn't a forum thread.");
    const key = `${item.id}|${want}`;
    const known = this.threadPages.get(key);
    if (known && this.now() - known.at < THREAD_REFRESH_MS) return known.content;

    // Without a "newest page" address (vBulletin), the last page is found from page 1's page count.
    if (want === "last" && !pager.latestUrl) {
      const first = await this.forumThread(base, item, selectors, via, 1, feedText, pager);
      const pages = first.pagination?.pages ?? 1;
      if (pages <= 1 || first.kind !== "page") return first;
      const last = await this.forumThread(base, item, selectors, via, pages, feedText, pager);
      this.rememberThreadPage(key, last);
      return last;
    }
    const url = want === "last" ? pager.latestUrl! : pager.pageUrl(want);
    try {
      const { article } = await this.readPage(url, selectors ?? {}, via);
      const content: ReaderContent = {
        ...base,
        author: base.author ?? article.byline,
        kind: "page",
        html: polishArticle(article.html, item.title),
        videoId: null,
        notice: null,
        pagination: article.pages ?? null,
      };
      this.rememberThreadPage(key, content);
      // "last" is also page N, and page 1 is what the item opens on.
      if (article.pages && article.pages.page !== want) this.rememberThreadPage(`${item.id}|${article.pages.page}`, content);
      if (article.pages?.page === 1) await this.store(item.id, "page", "ok", article.html, null);
      return content;
    } catch (err) {
      const message = pageErrorMessage(err);
      const earlier =
        known?.content ??
        (want === 1 && item.status === "ok" && item.origin === "page" && item.html
          ? { ...base, kind: "page" as const, html: polishArticle(item.html, item.title), videoId: null, notice: null, pagination: null }
          : null);
      if (earlier) return { ...earlier, notice: `Couldn't load new replies: ${message} Showing the copy read earlier.` };
      const feed = feedText();
      if (feed) return { ...base, kind: "feed", html: polishArticle(feed, item.title), videoId: null, notice: `${message} Showing the feed's text instead.`, pagination: null };
      return this.summaryOnly(base, message);
    }
  }

  private rememberThreadPage(key: string, content: ReaderContent) {
    this.threadPages.delete(key);
    this.threadPages.set(key, { at: this.now(), content });
    while (this.threadPages.size > THREAD_PAGES_KEPT) this.threadPages.delete(this.threadPages.keys().next().value!);
  }

  /**
   * A followed thread's card (D-084): the replies since it was last read, oldest first, from the
   * posts stored at each check (no page fetch). Before any batch, the newest stored posts.
   */
  private async threadCard(base: Omit<ReaderContent, "kind" | "html" | "notice" | "videoId">, sourceId: string, batchFrom: number | null): Promise<ReaderContent> {
    let q = this.db.kysely.selectFrom("thread_posts").select(["post_id", "author", "posted_at", "posted_label", "html"]).where("source_id", "=", sourceId);
    if (batchFrom !== null) q = q.where("fetched_at", ">=", batchFrom);
    const rows = (await q.execute()).sort((a, b) => Number(a.post_id) - Number(b.post_id));
    const shown = rows.slice(-THREAD_CARD_MAX_POSTS);
    if (!shown.length) return this.summaryOnly(base, "No replies stored yet. They appear here after the next check.");
    const asPost = (p: (typeof rows)[number]) => ({ author: p.author, datetime: p.posted_at ? new Date(p.posted_at).toISOString() : null, timeLabel: p.posted_label, html: p.html });
    // The posts just before the new ones, for context (D-102): what the new replies answer or quote.
    let context = "";
    if (batchFrom !== null && shown.length === rows.length) {
      const earlier = (await this.db.kysely.selectFrom("thread_posts").select(["post_id", "author", "posted_at", "posted_label", "html"]).where("source_id", "=", sourceId).where("fetched_at", "<", batchFrom).execute())
        .sort((a, b) => Number(a.post_id) - Number(b.post_id))
        .slice(-THREAD_CARD_CONTEXT_POSTS);
      if (earlier.length) context = `<div class="thread-context"><p class="thread-context-label">Earlier in the thread</p>${renderForumPosts(earlier.map(asPost))}</div><p class="thread-new-label">New replies</p>`;
    }
    const html = context + renderForumPosts(shown.map(asPost));
    const notice = rows.length > shown.length ? `Showing the newest ${shown.length} of ${rows.length} new replies. Open the original for the rest.` : null;
    return { ...base, kind: "page", html, videoId: null, notice };
  }

  /**
   * An article page for the reader: its article, and its audio (D-096). A page without article
   * text but with audio is an audio story, not an error.
   */
  private async readStoryPage(url: string, selectors: ReaderSelectors, via: boolean): Promise<{ article: SelectorExtraction["article"]; audio: ItemAudio | null }> {
    try {
      const result = await this.readPage(url, selectors, via);
      return { article: result.article, audio: result.audio };
    } catch (err) {
      if (err instanceof NoArticle && err.audio) return { article: null, audio: err.audio };
      throw err;
    }
  }

  /** Keeps audio found on a story's page, so its card shows it too. */
  private async rememberAudio(itemId: string, audio: ItemAudio): Promise<ItemAudio> {
    await this.db.kysely
      .updateTable("items")
      .set({ audio_url: audio.url, audio_duration: audio.durationSeconds })
      .where("id", "=", itemId)
      .where("audio_url", "is", null)
      .execute();
    return audio;
  }

  /** Fetches an article page and extracts it; throws with a user-facing reason. */
  private async readPage(
    url: string,
    selectors: ReaderSelectors,
    viaFlareSolverr = false,
  ): Promise<SelectorExtraction & { article: NonNullable<SelectorExtraction["article"]> }> {
    await this.limiter.wait(url, INTERACTIVE);
    const res = await this.fetcherFor(viaFlareSolverr)(url, { expect: "html", maxBytes: 3 * 1024 * 1024 });
    if (res.kind !== "ok") throw new Error("The site answered without content.");
    if (!/html/i.test(res.contentType)) throw new Error("The link isn't a web page (it may be a file or video).");
    const result = extractWithSelectors(res.body, res.url, selectors);
    if (!result.article) {
      if (selectors.article) {
        throw new SelectorMiss(
          result.matched ? `The article selector matched ${result.matched} element(s), but they had no text.` : "The article selector matched nothing on this page.",
          result,
        );
      }
      throw new NoArticle("Couldn't find the article text on that page. It may be behind a paywall or need JavaScript.", result.audio);
    }
    return result as SelectorExtraction & { article: NonNullable<SelectorExtraction["article"]> };
  }

  /**
   * What the reader would show for one of the source's items with these selectors.
   * Nothing is stored. null if the source doesn't exist.
   */
  async preview(sourceId: string, req: ReaderPreviewRequest): Promise<ReaderPreview | { error: string } | null> {
    const source = await this.db.kysely.selectFrom("sources").select(["id", "kind", "via_flaresolverr"]).where("id", "=", sourceId).executeTakeFirst();
    if (!source) return null;
    if (source.kind !== "feed") return { error: "Reader selectors are for feed sources; YouTube and Reddit items aren't read from their pages." };
    let q = this.db.kysely
      .selectFrom("items")
      .select(["id", "title", "url"])
      .where("source_id", "=", sourceId)
      .where("url", "is not", null);
    if (req.itemId) q = q.where("id", "=", req.itemId);
    const item = await q.orderBy("published_at", "desc").limit(1).executeTakeFirst();
    if (!item?.url) return { error: "This source has no items with a link to preview yet." };

    const out: ReaderPreview = { itemId: item.id, itemTitle: item.title, url: item.url, html: null, matched: null, removed: null, notice: null };
    try {
      const result = await this.readPage(item.url, { article: req.articleSelector, remove: req.removeSelector }, source.via_flaresolverr === 1);
      return { ...out, html: polishArticle(result.article.html, item.title), matched: result.matched, removed: result.removed };
    } catch (err) {
      const partial = err instanceof SelectorMiss ? err.result : null;
      return { ...out, matched: partial?.matched ?? null, removed: partial?.removed ?? null, notice: pageErrorMessage(err) };
    }
  }

  /**
   * Comments for an item, loaded on request (one call, cached 15 min). Reddit posts have a
   * public comments feed; YouTube videos need the user's API key (D-075); other sources have
   * none the app can read yet.
   */
  async comments(itemId: string): Promise<ReaderComments | null> {
    const item = await this.db.kysely
      .selectFrom("items")
      .innerJoin("sources", "sources.id", "items.source_id")
      .select(["items.id", "items.url", "sources.kind"])
      .where("items.id", "=", itemId)
      .executeTakeFirst();
    if (!item) return null;
    const videoId = youtubeVideoId(item.url);
    if (videoId) return this.youtubeComments(itemId, videoId, item.url);
    const feedUrl = item.kind === "reddit" ? redditCommentsFeedUrl(item.url) : null;
    if (!feedUrl) return { available: false, comments: [], notice: null, discussionUrl: item.url };

    const cached = this.commentsCache.get(itemId);
    if (cached && this.now() - cached.at < COMMENTS_TTL_MS) return cached.value;

    let value: ReaderComments;
    try {
      await this.limiter.wait(feedUrl, INTERACTIVE);
      const res = await this.fetcher(feedUrl, { expect: "feed" });
      if (res.kind !== "ok") throw new Error("Reddit answered without content.");
      const parsed = parseFeed(res.body, feedUrl);
      const comments = parsed.items
        // The first entry is the post itself (t3_…); comments are t1_….
        .filter((c) => !/^t3_/.test(c.guid))
        .slice(0, MAX_COMMENTS)
        .map((c) => ({
          author: c.author,
          html: sanitizeHtml(c.contentHtml ?? (c.summary ? `<p>${c.summary.replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[ch]!)}</p>` : ""), feedUrl),
          publishedAt: c.publishedAt,
          url: c.url,
        }))
        .filter((c) => c.html);
      value = { available: true, comments, notice: comments.length ? null : "No comments yet.", discussionUrl: item.url };
    } catch (err) {
      const notice =
        err instanceof FetchError && err.kind === "rate_limited" ? "Reddit is limiting requests right now. Try again in a few minutes."
        : err instanceof FetchError ? `Couldn't load the comments (${err.message}).`
        : err instanceof FeedParseError ? "Reddit's comments feed couldn't be read."
        : "Couldn't load the comments.";
      // Don't cache failures for long, but don't hammer either.
      value = { available: true, comments: [], notice, discussionUrl: item.url };
      this.commentsCache.set(itemId, { at: this.now() - COMMENTS_TTL_MS + 60_000, value });
      return value;
    }
    this.commentsCache.set(itemId, { at: this.now(), value });
    return value;
  }

  private async youtubeComments(itemId: string, videoId: string, url: string | null): Promise<ReaderComments> {
    const apiKey = this.settings && this.fetchJson ? await this.settings.youtubeApiKey() : null;
    if (!apiKey || !this.fetchJson) {
      // Says how to turn them on; no request is made.
      return { available: false, comments: [], notice: "Add a YouTube API key in Settings to see top comments here.", discussionUrl: url };
    }
    const cached = this.commentsCache.get(itemId);
    if (cached && this.now() - cached.at < COMMENTS_TTL_MS) return cached.value;
    let value: ReaderComments;
    try {
      const comments = await topComments(this.fetchJson, apiKey, videoId, MAX_COMMENTS);
      value = { available: true, comments, notice: comments.length ? null : "No comments yet.", discussionUrl: url };
      this.commentsCache.set(itemId, { at: this.now(), value });
    } catch (err) {
      const notice =
        err instanceof YouTubeApiError ? err.message
        : err instanceof FetchError ? `Couldn't load the comments (${err.message}).`
        : "Couldn't load the comments.";
      value = { available: true, comments: [], notice, discussionUrl: url };
      // Comments that are turned off stay off; other failures are retried after a minute.
      const keep = err instanceof YouTubeApiError && err.reason === "commentsDisabled";
      this.commentsCache.set(itemId, { at: keep ? this.now() : this.now() - COMMENTS_TTL_MS + 60_000, value });
    }
    return value;
  }

  private summaryOnly(base: Omit<ReaderContent, "kind" | "html" | "notice" | "videoId">, notice: string | null): ReaderContent {
    return { ...base, kind: "summary", html: null, videoId: null, notice };
  }

  private async store(itemId: string, origin: "feed" | "page", status: "ok" | "failed", html: string | null, error: string | null) {
    const row = { item_id: itemId, origin, status, html, error, fetched_at: this.now() };
    await this.db.kysely
      .insertInto("item_content")
      .values(row)
      .onConflict((oc) => oc.column("item_id").doUpdateSet({ origin, status, html, error, fetched_at: row.fetched_at }))
      .execute();
  }
}
