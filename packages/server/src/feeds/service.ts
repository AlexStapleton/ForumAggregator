// Sources: adding (with feed discovery and YouTube lookup), checking, and storing new items.
import crypto from "node:crypto";
import type { Selectable } from "kysely";
import type { AddSourceRequest, Source, SourceKind, UpdateSourceRequest } from "@fa/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SourcesTable } from "../db/schema.js";
import { discoverFeeds } from "./discover.js";
import { FetchError, type Fetcher, type HostLimiter } from "./fetch.js";
import { FeedParseError, looksLikeFeed, parseFeed, type ParsedFeed } from "./parse.js";
import { nextCheck } from "./schedule.js";
import { planReddit } from "./reddit.js";
import { channelFeedUrl, channelIdFromPage, isConsentPage, normaliseYouTubeInput, planYouTube } from "./youtube.js";

type SourceRow = Selectable<SourcesTable>;

/** A user-facing failure with a message that says what to do about it. */
export class SourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

/** Interactive actions (adding a source) still space requests out, just less. */
const INTERACTIVE = { minDelayMs: 1000, jitterMs: 500 };
/** On a source's first fetch, items older than this start out as read. */
const FIRST_FETCH_UNREAD_WINDOW_MS = 7 * 24 * 3_600_000;
const INSERT_CHUNK = 50;

export interface CheckResult {
  ok: boolean;
  newItems: number;
  notModified?: boolean;
  error?: string;
}

function friendlyFetchError(err: FetchError, url: string): string {
  const host = new URL(url).host;
  if (err.isChallenge) {
    return `${host} answered with a bot check, so it can't be read automatically from this server. ForumAggregator doesn't try to get around these.`;
  }
  switch (err.kind) {
    case "blocked":
      return `${host} refused the request (${err.status}).`;
    case "not_found":
      return `Nothing found at that address on ${host} (404).`;
    case "rate_limited":
      return `${host} asked us to slow down (429). It will be retried later.`;
    case "timeout":
      return `${host} took too long to answer.`;
    case "too_large":
      return `${host} sent a response that's too large to be a feed.`;
    case "network":
      return `Couldn't reach ${host}. ${err.message}`;
    default:
      return `${host}: ${err.message}`;
  }
}

export class FeedService {
  private inFlight = new Map<string, Promise<CheckResult>>();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly fetcher: Fetcher,
    private readonly limiter: HostLimiter,
    private readonly now: () => number = Date.now,
    private readonly log?: Logger,
  ) {}

  // ---- adding ------------------------------------------------------------------------

  async addSource(input: AddSourceRequest): Promise<Source> {
    let resolved: Awaited<ReturnType<FeedService["resolve"]>>;
    try {
      resolved = await this.resolve(input.url);
    } catch (err) {
      // Shows up in `docker logs`, so failures can be diagnosed without the UI.
      if (err instanceof SourceError) this.log?.warn({ input: input.url, code: err.code, reason: err.message }, "could not add source");
      throw err;
    }
    const existing = await this.db.kysely.selectFrom("sources").select("id").where("feed_url", "=", resolved.feedUrl).executeTakeFirst();
    if (existing) throw new SourceError("duplicate", "You already follow this feed.", 409);

    const now = this.now();
    const id = crypto.randomUUID();
    const title = input.title || resolved.parsed.title || new URL(resolved.siteUrl ?? resolved.feedUrl).hostname;
    await this.db.kysely
      .insertInto("sources")
      .values({
        id,
        kind: resolved.kind,
        title,
        site_url: resolved.siteUrl,
        feed_url: resolved.feedUrl,
        status: "pending",
        last_error: null,
        last_checked_at: null,
        last_success_at: null,
        next_check_at: null,
        poll_interval_minutes: null,
        etag: null,
        last_modified: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    // We already have the feed from resolving it, so store its items straight away.
    const added = await this.ingest(id, resolved.parsed, true);
    await this.recordSuccess(id, now, null, null);
    this.log?.info({ sourceId: id, feedUrl: resolved.feedUrl, items: added }, "source added");
    return (await this.getSource(id))!;
  }

  /** Works out the feed URL for whatever the user pasted, fetching as little as possible. */
  private async resolve(raw: string): Promise<{ kind: SourceKind; feedUrl: string; siteUrl: string | null; parsed: ParsedFeed }> {
    let input = normaliseYouTubeInput(raw);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `https://${input}`;
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new SourceError("invalid_url", "That doesn't look like a web address.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SourceError("invalid_url", "Only http:// and https:// addresses are supported.");
    }

    const yt = planYouTube(url);
    if (yt) {
      let feedUrl: string;
      let siteUrl: string;
      if (yt.kind === "lookup") {
        const page = await this.fetchInteractive(yt.pageUrl, "html");
        if (isConsentPage(page.url)) {
          throw new SourceError(
            "youtube_consent",
            "YouTube showed a cookie-consent page instead of the channel. Paste the channel ID instead: on the channel's page, About → Share channel → Copy channel ID (it starts with UC).",
          );
        }
        // Prefer the feed the page advertises; fall back to finding the channel ID.
        const advertised = discoverFeeds(page.body, page.url).find((f) => f.url.includes("/feeds/videos.xml"));
        const channelId = channelIdFromPage(page.body);
        if (!advertised && !channelId) {
          throw new SourceError(
            "youtube_not_found",
            "Couldn't find the channel on that YouTube page. Paste the channel ID instead: on the channel's page, About → Share channel → Copy channel ID (it starts with UC).",
          );
        }
        feedUrl = advertised?.url ?? channelFeedUrl(channelId!);
        const id = new URL(feedUrl).searchParams.get("channel_id") ?? channelId;
        siteUrl = id ? `https://www.youtube.com/channel/${id}` : yt.pageUrl;
      } else {
        ({ feedUrl, siteUrl } = yt);
      }
      let res;
      try {
        res = await this.fetchInteractive(feedUrl, "feed");
      } catch (err) {
        if (err instanceof SourceError) {
          throw new SourceError(
            "youtube_feed_failed",
            `Found the channel, but YouTube didn't return its video feed (${err.message}). YouTube's feeds are sometimes briefly unavailable, so try again in a few minutes. Feed address: ${feedUrl}`,
            err.status,
          );
        }
        throw err;
      }
      return { kind: "youtube", feedUrl, siteUrl, parsed: this.parse(res.body, feedUrl) };
    }

    const reddit = planReddit(url);
    if (reddit) {
      let res;
      try {
        res = await this.fetchInteractive(reddit.feedUrl, "feed");
      } catch (err) {
        if (err instanceof SourceError && ["blocked", "rate_limited", "cloudflare_challenge", "pow_challenge"].includes(err.code)) {
          throw new SourceError(
            "reddit_blocked",
            "Reddit refused the request. Reddit blocks apps that aren't registered with it, so subreddit feeds may not work from your server. Reddit support through your own Reddit account is planned (roadmap M5).",
            err.status,
          );
        }
        throw err;
      }
      return { kind: "reddit", feedUrl: reddit.feedUrl, siteUrl: reddit.siteUrl, parsed: this.parse(res.body, reddit.feedUrl) };
    }

    const res = await this.fetchInteractive(url.href, "feed");
    if (looksLikeFeed(res.body)) {
      const parsed = this.parse(res.body, url.href);
      return { kind: "feed", feedUrl: url.href, siteUrl: parsed.siteUrl ?? url.origin + "/", parsed };
    }
    const feeds = discoverFeeds(res.body, res.url);
    const first = feeds[0];
    if (!first) {
      throw new SourceError(
        "no_feed",
        "No RSS or Atom feed found at this address. If the site has one, paste the feed's own address (often ending in /feed, /rss or .xml).",
      );
    }
    const feedRes = await this.fetchInteractive(first.url, "feed");
    return { kind: "feed", feedUrl: first.url, siteUrl: url.href, parsed: this.parse(feedRes.body, first.url) };
  }

  private async fetchInteractive(url: string, expect: "feed" | "html") {
    await this.limiter.wait(url, INTERACTIVE);
    try {
      const res = await this.fetcher(url, { expect });
      if (res.kind !== "ok") throw new SourceError("unexpected", "The site answered without content.");
      return res;
    } catch (err) {
      if (err instanceof FetchError) throw new SourceError(err.kind, friendlyFetchError(err, url), 422);
      throw err;
    }
  }

  private parse(body: string, url: string): ParsedFeed {
    try {
      return parseFeed(body, url);
    } catch (err) {
      if (err instanceof FeedParseError) throw new SourceError("not_a_feed", `That address isn't a readable feed: ${err.message}`, 422);
      throw err;
    }
  }

  // ---- checking ----------------------------------------------------------------------

  /** Checks one source now. Concurrent calls for the same source share one request. */
  checkSource(id: string): Promise<CheckResult> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const p = this.doCheck(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
    return p;
  }

  private async doCheck(id: string): Promise<CheckResult> {
    const row = await this.db.kysely.selectFrom("sources").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return { ok: false, newItems: 0, error: "Source no longer exists" };

    await this.limiter.wait(row.feed_url);
    const startedAt = this.now();
    try {
      const res = await this.fetcher(row.feed_url, { expect: "feed", etag: row.etag, lastModified: row.last_modified });
      if (res.kind === "not_modified") {
        await this.recordSuccess(id, startedAt, row.etag, row.last_modified, row);
        return { ok: true, newItems: 0, notModified: true };
      }
      const parsed = parseFeed(res.body, row.feed_url);
      const newItems = await this.ingest(id, parsed, row.last_success_at === null);
      await this.recordSuccess(id, startedAt, res.etag, res.lastModified, row);
      if (newItems) this.log?.info({ sourceId: id, newItems }, "new items");
      return { ok: true, newItems };
    } catch (err) {
      const message =
        err instanceof FetchError ? friendlyFetchError(err, row.feed_url)
        : err instanceof FeedParseError ? `The feed couldn't be read: ${err.message}`
        : "Unexpected error while checking this source";
      if (!(err instanceof FetchError || err instanceof FeedParseError)) this.log?.warn({ err, sourceId: id }, "check failed");
      await this.recordFailure(row, startedAt, message, err instanceof FetchError ? err : undefined);
      return { ok: false, newItems: 0, error: message };
    }
  }

  private intervalMinutes(row: Pick<SourceRow, "poll_interval_minutes">): number {
    return row.poll_interval_minutes ?? this.config.polling.intervalMinutes;
  }

  private async recordSuccess(id: string, at: number, etag: string | null, lastModified: string | null, row?: SourceRow) {
    const next = nextCheck({ now: at, intervalMinutes: this.intervalMinutes(row ?? { poll_interval_minutes: null }), failures: 0, polling: this.config.polling });
    await this.db.kysely
      .updateTable("sources")
      .set({
        status: "ok",
        last_error: null,
        consecutive_failures: 0,
        last_checked_at: at,
        last_success_at: at,
        next_check_at: next.at,
        etag,
        last_modified: lastModified,
        updated_at: this.now(),
      })
      .where("id", "=", id)
      .execute();
  }

  private async recordFailure(row: SourceRow, at: number, message: string, err?: FetchError) {
    const failures = row.consecutive_failures + 1;
    const next = nextCheck({
      now: at,
      intervalMinutes: this.intervalMinutes(row),
      failures,
      polling: this.config.polling,
      retryAfterMs: err?.retryAfterMs,
    });
    const status = next.paused ? "paused" : err?.isChallenge ? "challenged" : "error";
    await this.db.kysely
      .updateTable("sources")
      .set({
        status,
        last_error: next.paused ? `Paused after ${failures} failed checks in a row. Last error: ${message}` : message,
        consecutive_failures: failures,
        last_checked_at: at,
        next_check_at: next.at,
        updated_at: this.now(),
      })
      .where("id", "=", row.id)
      .execute();
  }

  /** Stores items not seen before. Returns how many were new. */
  private async ingest(sourceId: string, parsed: ParsedFeed, firstFetch: boolean): Promise<number> {
    const now = this.now();
    const rows = parsed.items.map((it, index) => {
      // Undated items keep feed order; dates in the future are treated as "now".
      const published = Math.min(it.publishedAt ?? now - index, now);
      const old = firstFetch && published < now - FIRST_FETCH_UNREAD_WINDOW_MS;
      return {
        id: crypto.randomUUID(),
        source_id: sourceId,
        guid: it.guid,
        url: it.url,
        title: it.title,
        author: it.author,
        summary: it.summary,
        image_url: it.imageUrl,
        published_at: published,
        fetched_at: now,
        read: old ? 1 : 0,
        saved: 0,
        read_at: old ? now : null,
      };
    });
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const res = await this.db.kysely
        .insertInto("items")
        .values(rows.slice(i, i + INSERT_CHUNK))
        .onConflict((oc) => oc.columns(["source_id", "guid"]).doNothing())
        .executeTakeFirst();
      inserted += Number(res.numInsertedOrUpdatedRows ?? 0);
    }
    return inserted;
  }

  /** Sources whose next check is due, oldest first. */
  async dueSourceIds(limit = 20): Promise<string[]> {
    const rows = await this.db.kysely
      .selectFrom("sources")
      .select("id")
      .where("enabled", "=", 1)
      .where("next_check_at", "is not", null)
      .where("next_check_at", "<=", this.now())
      .orderBy("next_check_at")
      .limit(limit)
      .execute();
    return rows.map((r) => r.id);
  }

  // ---- reading and editing -----------------------------------------------------------

  async listSources(): Promise<Source[]> {
    const rows = await this.db.kysely.selectFrom("sources").selectAll().orderBy("title").execute();
    const counts = await this.counts();
    return rows.map((r) => this.toSource(r, counts.get(r.id)));
  }

  async getSource(id: string): Promise<Source | undefined> {
    const row = await this.db.kysely.selectFrom("sources").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return undefined;
    return this.toSource(row, (await this.counts(id)).get(id));
  }

  async updateSource(id: string, patch: UpdateSourceRequest): Promise<Source> {
    const row = await this.db.kysely.selectFrom("sources").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) throw new SourceError("not_found", "Source not found", 404);
    const set: Partial<SourceRow> = { updated_at: this.now() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.pollIntervalMinutes !== undefined) set.poll_interval_minutes = patch.pollIntervalMinutes;
    if (patch.enabled === false) {
      set.enabled = 0;
      set.status = "paused";
      set.next_check_at = null;
      set.last_error = null;
    } else if (patch.enabled === true) {
      // Resume (also after the circuit breaker paused it): check again right away.
      set.enabled = 1;
      set.status = "pending";
      set.consecutive_failures = 0;
      set.next_check_at = this.now();
      set.last_error = null;
    }
    await this.db.kysely.updateTable("sources").set(set).where("id", "=", id).execute();
    return (await this.getSource(id))!;
  }

  async removeSource(id: string): Promise<boolean> {
    // Items go with it (ON DELETE CASCADE, plus explicitly for SQLite setups without FK enforcement).
    await this.db.kysely.deleteFrom("items").where("source_id", "=", id).execute();
    const res = await this.db.kysely.deleteFrom("sources").where("id", "=", id).executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  private async counts(onlyId?: string): Promise<Map<string, { total: number; unread: number }>> {
    let q = this.db.kysely
      .selectFrom("items")
      .select((eb) => [
        "source_id",
        eb.fn.countAll<number>().as("total"),
        eb.fn.sum<number>(eb.case().when("read", "=", 0).then(1).else(0).end()).as("unread"),
      ])
      .groupBy("source_id");
    if (onlyId) q = q.where("source_id", "=", onlyId);
    const rows = await q.execute();
    return new Map(rows.map((r) => [r.source_id, { total: Number(r.total), unread: Number(r.unread ?? 0) }]));
  }

  private toSource(r: SourceRow, c?: { total: number; unread: number }): Source {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      siteUrl: r.site_url,
      feedUrl: r.feed_url,
      enabled: r.enabled === 1,
      status: r.enabled === 1 ? r.status : "paused",
      lastError: r.last_error,
      lastCheckedAt: r.last_checked_at,
      lastSuccessAt: r.last_success_at,
      nextCheckAt: r.next_check_at,
      pollIntervalMinutes: r.poll_interval_minutes,
      unreadCount: c?.unread ?? 0,
      itemCount: c?.total ?? 0,
      createdAt: r.created_at,
    };
  }
}
