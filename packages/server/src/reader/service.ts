// The in-app reader: what to show when an item is opened.
//   1. YouTube item          → the video (embedded), plus its description
//   2. full text in the feed → that, sanitised (once, then cached)
//   3. otherwise             → fetch the article page once, extract it ("reader mode"), cache it
//   4. if that fails         → the feed summary, with a notice saying why
// A source with CSS selectors set (D-074) always reads the original page (step 3) with them.
// Fetching the page happens only when the user opens the item, like a browser would.
import type { ReaderComments, ReaderContent, ReaderPreview, ReaderPreviewRequest } from "@fa/shared";
import type { Db } from "../db/index.js";
import { FetchError, type Fetcher, type HostLimiter, type JsonFetcher } from "../feeds/fetch.js";
import type { FlareSolverr } from "../feeds/flaresolverr.js";
import { FeedParseError, parseFeed } from "../feeds/parse.js";
import { cleanRedditHtml, cleanRedditSummary, redditCommentsFeedUrl, redditPostLink } from "../feeds/reddit.js";
import { htmlToText } from "../feeds/text.js";
import { extractWithSelectors, isForumThreadUrl, polishArticle, renderForumPosts, youtubeVideoId, type ReaderSelectors, type SelectorExtraction } from "./extract.js";
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
/** A forum thread read more than this long ago is read again, for new replies (D-081). */
const THREAD_REFRESH_MS = 30 * 60_000;
/** Replies shown on a followed thread's card (D-084). */
const THREAD_CARD_MAX_POSTS = 100;
const MAX_COMMENTS = 30;

class SelectorMiss extends Error {
  constructor(
    message: string,
    readonly result: SelectorExtraction,
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

  /** Direct, or through FlareSolverr for sources set to use it (D-080). */
  private fetcherFor(viaFlareSolverr: boolean): Fetcher {
    if (!viaFlareSolverr || !this.flare) return this.fetcher;
    this.flareFetcher ??= this.flare.wrap(this.fetcher);
    return this.flareFetcher;
  }

  /** null if the item doesn't exist. Concurrent opens of the same item share the work. */
  get(itemId: string): Promise<ReaderContent | null> {
    const running = this.inFlight.get(itemId);
    if (running) return running;
    const p = this.load(itemId).finally(() => this.inFlight.delete(itemId));
    this.inFlight.set(itemId, p);
    return p;
  }

  private async load(itemId: string): Promise<ReaderContent | null> {
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
        "items.source_id",
        "sources.thread_batch_from",
        "sources.title as source_title",
        "sources.kind as source_kind",
        "sources.article_selector",
        "sources.remove_selector",
        "sources.via_flaresolverr",
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
    };
    const isReddit = item.source_kind === "reddit";
    if (item.source_kind === "thread") return this.threadCard(base, item.source_id, item.thread_batch_from);

    const videoId = youtubeVideoId(item.url);
    if (videoId) return { ...base, kind: "video", html: null, videoId, notice: null };

    // Per-source selectors mean "read the original page with these" (never for Reddit).
    const selectors: ReaderSelectors | null =
      !isReddit && (item.article_selector || item.remove_selector) ? { article: item.article_selector, remove: item.remove_selector } : null;

    // Forum threads are read from the page (the posts), like sources with selectors (D-081).
    const isThread = !isReddit && isForumThreadUrl(item.url);
    const preferPage = !!selectors || isThread;
    const via = item.via_flaresolverr === 1;
    // A thread read a while ago may have new replies: read it again, keeping the old copy in case.
    const stalePage =
      isThread && item.status === "ok" && item.origin === "page" && item.html && item.fetched_at !== null && this.now() - item.fetched_at > THREAD_REFRESH_MS
        ? item.html
        : null;

    // Cached result (from the feed or a previous extraction).
    if (item.status === "ok" && item.html && !(preferPage && item.origin === "feed") && !stalePage) {
      // Reddit posts cached by v1.0.x: still unwrap the thumbnail table (D-076).
      const html = isReddit ? layoutRedditPost(item.html, null, item.title) : item.html;
      return { ...base, kind: item.origin === "feed" ? "feed" : "page", html: polishArticle(html, item.title), videoId: null, notice: null };
    }
    // The feed's own text, kept as a fallback if the page can't be read.
    let feedHtml: string | null = null;
    if (item.status === "raw" && item.html) {
      const raw = isReddit ? cleanRedditHtml(item.html) : item.html;
      let html = sanitizeHtml(raw, item.url ?? "https://invalid.invalid/");
      // Reddit posts are often short but complete; elsewhere a short body is just a teaser.
      if (isReddit) {
        // Laid out from the raw body on every open (cheap), so layout fixes reach old posts too.
        html = layoutRedditPost(html, redditPostLink(item.html), item.title);
        return { ...base, kind: "feed", html: polishArticle(html, item.title), videoId: null, notice: null };
      }
      if (!preferPage && htmlToText(html).length >= FEED_FULL_TEXT_MIN) {
        await this.store(item.id, "feed", "ok", html, null);
        return { ...base, kind: "feed", html: polishArticle(html, item.title), videoId: null, notice: null };
      }
      feedHtml = html || null;
    } else if (preferPage && item.status === "ok" && item.origin === "feed") {
      feedHtml = item.html;
    }
    // Reddit pages need JavaScript and count against Reddit's request limit: never fetch them.
    if (isReddit) {
      return this.summaryOnly(base, "Open the original to see the full post on Reddit (images, video, polls).");
    }
    if (item.status === "failed" && item.fetched_at && this.now() - item.fetched_at < FAILED_RETRY_MS) {
      return this.summaryOnly(base, item.error);
    }
    if (!item.url) return this.summaryOnly(base, "This item has no link to an article.");

    try {
      const { article } = await this.readPage(item.url, selectors ?? {}, via);
      await this.store(item.id, "page", "ok", article.html, null);
      return { ...base, author: base.author ?? article.byline, kind: "page", html: polishArticle(article.html, item.title), videoId: null, notice: null };
    } catch (err) {
      const message = pageErrorMessage(err);
      if (stalePage) {
        return { ...base, kind: "page", html: polishArticle(stalePage, item.title), videoId: null, notice: `Couldn't load new replies: ${message} Showing the copy read earlier.` };
      }
      // The feed's own body still beats the one-line summary.
      if (feedHtml) {
        // With selectors or a thread, keep retrying the page on later opens.
        if (preferPage) {
          return { ...base, kind: "feed", html: polishArticle(feedHtml, item.title), videoId: null, notice: `${message} Showing the feed's text instead.` };
        }
        await this.store(item.id, "feed", "ok", feedHtml, null);
        return { ...base, kind: "feed", html: polishArticle(feedHtml, item.title), videoId: null, notice: null };
      }
      await this.store(item.id, "page", "failed", null, message);
      return this.summaryOnly(base, message);
    }
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
    const html = renderForumPosts(
      shown.map((p) => ({ author: p.author, datetime: p.posted_at ? new Date(p.posted_at).toISOString() : null, timeLabel: p.posted_label, html: p.html })),
    );
    const notice = rows.length > shown.length ? `Showing the newest ${shown.length} of ${rows.length} new replies. Open the original for the rest.` : null;
    return { ...base, kind: "page", html, videoId: null, notice };
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
      throw new Error("Couldn't find the article text on that page. It may be behind a paywall or need JavaScript.");
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
