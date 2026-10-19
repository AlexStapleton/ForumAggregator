// The in-app reader: what to show when an item is opened.
//   1. YouTube item          → the video (embedded), plus its description
//   2. full text in the feed → that, sanitised (once, then cached)
//   3. otherwise             → fetch the article page once, extract it ("reader mode"), cache it
//   4. if that fails         → the feed summary, with a notice saying why
// Fetching the page happens only when the user opens the item, like a browser would.
import type { ReaderComments, ReaderContent } from "@fa/shared";
import type { Db } from "../db/index.js";
import { FetchError, type Fetcher, type HostLimiter } from "../feeds/fetch.js";
import { FeedParseError, parseFeed } from "../feeds/parse.js";
import { cleanRedditHtml, cleanRedditSummary, redditCommentsFeedUrl } from "../feeds/reddit.js";
import { htmlToText } from "../feeds/text.js";
import { extractArticle, polishArticle, youtubeVideoId } from "./extract.js";
import { sanitizeHtml } from "./sanitize.js";

/** Don't retry a page that failed for this long (avoids hammering a site that blocks us). */
const FAILED_RETRY_MS = 24 * 3_600_000;
const INTERACTIVE = { minDelayMs: 1000, jitterMs: 300 };
/** Feed text shorter than this is a teaser: try the article page instead (except Reddit). */
const FEED_FULL_TEXT_MIN = 500;
const COMMENTS_TTL_MS = 15 * 60_000;
const MAX_COMMENTS = 30;

export class ReaderService {
  private inFlight = new Map<string, Promise<ReaderContent | null>>();
  private commentsCache = new Map<string, { at: number; value: ReaderComments }>();

  constructor(
    private readonly db: Db,
    private readonly fetcher: Fetcher,
    private readonly limiter: HostLimiter,
    private readonly now: () => number = Date.now,
  ) {}

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
        "sources.title as source_title",
        "sources.kind as source_kind",
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

    const videoId = youtubeVideoId(item.url);
    if (videoId) return { ...base, kind: "video", html: null, videoId, notice: null };

    // Cached result (from the feed or a previous extraction).
    if (item.status === "ok" && item.html) {
      return { ...base, kind: item.origin === "feed" ? "feed" : "page", html: polishArticle(item.html, item.title), videoId: null, notice: null };
    }
    let shortFeedHtml: string | null = null;
    if (item.status === "raw" && item.html) {
      const raw = isReddit ? cleanRedditHtml(item.html) : item.html;
      const html = sanitizeHtml(raw, item.url ?? "https://invalid.invalid/");
      // Reddit posts are often short but complete; elsewhere a short body is just a teaser.
      if (isReddit || htmlToText(html).length >= FEED_FULL_TEXT_MIN) {
        await this.store(item.id, "feed", "ok", html, null);
        return { ...base, kind: "feed", html: polishArticle(html, item.title), videoId: null, notice: null };
      }
      shortFeedHtml = html || null;
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
      await this.limiter.wait(item.url, INTERACTIVE);
      const res = await this.fetcher(item.url, { expect: "html", maxBytes: 3 * 1024 * 1024 });
      if (res.kind !== "ok") throw new Error("The site answered without content.");
      if (!/html/i.test(res.contentType)) throw new Error("The link isn't a web page (it may be a file or video).");
      const article = extractArticle(res.body, res.url);
      if (!article) {
        throw new Error("Couldn't find the article text on that page. It may be behind a paywall or need JavaScript.");
      }
      await this.store(item.id, "page", "ok", article.html, null);
      return { ...base, author: base.author ?? article.byline, kind: "page", html: polishArticle(article.html, item.title), videoId: null, notice: null };
    } catch (err) {
      const message =
        err instanceof FetchError && err.isChallenge ? "The site answered with a bot check, so the article can't be shown here."
        : err instanceof FetchError ? `The article couldn't be loaded (${err.message}).`
        : (err as Error).message;
      // A short feed body still beats the one-line summary.
      if (shortFeedHtml) {
        await this.store(item.id, "feed", "ok", shortFeedHtml, null);
        return { ...base, kind: "feed", html: polishArticle(shortFeedHtml, item.title), videoId: null, notice: null };
      }
      await this.store(item.id, "page", "failed", null, message);
      return this.summaryOnly(base, message);
    }
  }

  /**
   * Comments for an item, loaded on request (one call, cached 15 min). Reddit posts have a
   * public comments feed; other sources have none the app can read yet.
   */
  async comments(itemId: string): Promise<ReaderComments | null> {
    const item = await this.db.kysely
      .selectFrom("items")
      .innerJoin("sources", "sources.id", "items.source_id")
      .select(["items.id", "items.url", "sources.kind"])
      .where("items.id", "=", itemId)
      .executeTakeFirst();
    if (!item) return null;
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
