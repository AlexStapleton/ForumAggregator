// The in-app reader: what to show when an item is opened.
//   1. YouTube item          → the video (embedded), plus its description
//   2. full text in the feed → that, sanitised (once, then cached)
//   3. otherwise             → fetch the article page once, extract it ("reader mode"), cache it
//   4. if that fails         → the feed summary, with a notice saying why
// Fetching the page happens only when the user opens the item, like a browser would.
import type { ReaderContent } from "@fa/shared";
import type { Db } from "../db/index.js";
import { FetchError, type Fetcher, type HostLimiter } from "../feeds/fetch.js";
import { dropRepeatedTitle, extractArticle, youtubeVideoId } from "./extract.js";
import { sanitizeHtml } from "./sanitize.js";

/** Don't retry a page that failed for this long (avoids hammering a site that blocks us). */
const FAILED_RETRY_MS = 24 * 3_600_000;
const INTERACTIVE = { minDelayMs: 1000, jitterMs: 300 };

export class ReaderService {
  private inFlight = new Map<string, Promise<ReaderContent | null>>();

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
      summary: item.summary,
    };

    const videoId = youtubeVideoId(item.url);
    if (videoId) return { ...base, kind: "video", html: null, videoId, notice: null };

    // Cached result (from the feed or a previous extraction).
    if (item.status === "ok" && item.html) {
      return { ...base, kind: item.origin === "feed" ? "feed" : "page", html: item.html, videoId: null, notice: null };
    }
    if (item.status === "raw" && item.html) {
      const html = dropRepeatedTitle(sanitizeHtml(item.html, item.url ?? "https://invalid.invalid/"), item.title);
      await this.store(item.id, "feed", "ok", html, null);
      return { ...base, kind: "feed", html, videoId: null, notice: null };
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
      const html = dropRepeatedTitle(article.html, item.title);
      await this.store(item.id, "page", "ok", html, null);
      return { ...base, author: base.author ?? article.byline, kind: "page", html, videoId: null, notice: null };
    } catch (err) {
      const message =
        err instanceof FetchError && err.isChallenge ? "The site answered with a bot check, so the article can't be shown here."
        : err instanceof FetchError ? `The article couldn't be loaded (${err.message}).`
        : (err as Error).message;
      await this.store(item.id, "page", "failed", null, message);
      return this.summaryOnly(base, message);
    }
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
