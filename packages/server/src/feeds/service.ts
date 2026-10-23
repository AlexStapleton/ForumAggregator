// Sources: adding (with feed discovery and YouTube lookup), checking, and storing new items.
import crypto from "node:crypto";
import type { Selectable } from "kysely";
import type { AddSourceRequest, OpmlImportResult, Source, SourceKind, TagCount, UpdateSourceRequest } from "@fa/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SourcesTable } from "../db/schema.js";
import { discoverFeeds } from "./discover.js";
import { FetchError, type Fetcher, type HostLimiter } from "./fetch.js";
import type { FlareSolverr } from "./flaresolverr.js";
import { FeedParseError, looksLikeFeed, parseFeed, type ParsedFeed } from "./parse.js";
import { buildOpml, parseOpml } from "./opml.js";
import { latestPageUrl, parseThreadPage, postNumber, threadAddress, threadPageUrl, threadSummary } from "./thread.js";
import type { ForumThreadPage } from "../reader/extract.js";
import { htmlToText } from "./text.js";
import { nextCheck } from "./schedule.js";
import { isValidSelector } from "../reader/extract.js";
import { cleanRedditSummary, planReddit } from "./reddit.js";
import { channelFeedUrl, channelIdFromPage, isConsentPage, normaliseYouTubeInput, planYouTube } from "./youtube.js";

type SourceRow = Selectable<SourcesTable>;

/** A user-facing failure with a message that says what to do about it. */
export class SourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly fields?: Record<string, string>,
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
/** Posts kept per followed thread (D-084). */
const THREAD_POSTS_KEPT = 300;
/** Extra (older) pages read in one check when a whole page of replies is new. */
const THREAD_MAX_BACK_PAGES = 2;

/** A thread page without posts we can read. */
class ThreadParseError extends Error {}

/** SourceError codes for a bot check (FetchError kinds). */
const CHALLENGE_CODES = new Set(["cloudflare_challenge", "pow_challenge"]);

export interface CheckResult {
  ok: boolean;
  newItems: number;
  notModified?: boolean;
  error?: string;
}

function friendlyFetchError(err: FetchError, url: string, viaFlareSolverr = false): string {
  const host = new URL(url).host;
  if (err.isChallenge) {
    if (viaFlareSolverr) return `${host}: ${err.message}.`;
    return `${host} answered with a bot check, so the app can't read it by itself. If you run FlareSolverr, add it in Settings → FlareSolverr and turn it on for this source (D-080).`;
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
    private readonly flare?: FlareSolverr,
  ) {}

  private flareFetcher?: Fetcher;

  /** The fetcher for a source: direct, or through FlareSolverr when the source is set to (D-080). */
  private fetcherFor(viaFlareSolverr: boolean): Fetcher {
    if (!viaFlareSolverr || !this.flare) return this.fetcher;
    this.flareFetcher ??= this.flare.wrap(this.fetcher);
    return this.flareFetcher;
  }

  // ---- adding ------------------------------------------------------------------------

  async addSource(input: AddSourceRequest): Promise<Source> {
    const thread = threadFromInput(input.url);
    if (thread) return this.addThread(input, thread);
    let resolved: Awaited<ReturnType<FeedService["resolve"]>>;
    let via = false;
    try {
      try {
        resolved = await this.resolve(input.url);
      } catch (err) {
        // A Cloudflare-style check, and the user has FlareSolverr: try again through it (D-080).
        if (!(err instanceof SourceError && CHALLENGE_CODES.has(err.code) && (await this.flare?.configured()))) throw err;
        this.log?.info({ input: input.url }, "bot check; retrying through FlareSolverr");
        via = true;
        resolved = await this.resolve(input.url, true);
      }
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
        via_flaresolverr: via ? 1 : 0,
        last_error: null,
        last_checked_at: null,
        last_success_at: null,
        next_check_at: null,
        poll_interval_minutes: null,
        retention_days: null,
        etag: null,
        last_modified: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await this.setTags(id, input.tags ?? []);
    // We already have the feed from resolving it, so store its items straight away.
    const added = await this.ingest(id, resolved.parsed, true);
    await this.recordSuccess(id, now, null, null);
    this.log?.info({ sourceId: id, feedUrl: resolved.feedUrl, items: added }, "source added");
    return (await this.getSource(id))!;
  }

  // ---- following a forum thread (D-084) ------------------------------------------------

  private async addThread(input: AddSourceRequest, address: string): Promise<Source> {
    const existing = await this.db.kysely.selectFrom("sources").select("title").where("feed_url", "=", address).executeTakeFirst();
    if (existing) throw new SourceError("duplicate", `You already follow this thread as “${existing.title}”.`, 409);
    let via = false;
    let read: Awaited<ReturnType<FeedService["readThread"]>>;
    try {
      try {
        read = await this.readThread(address, false, null, true);
      } catch (err) {
        if (!(err instanceof SourceError && CHALLENGE_CODES.has(err.code) && (await this.flare?.configured()))) throw err;
        this.log?.info({ input: input.url }, "bot check; retrying through FlareSolverr");
        via = true;
        read = await this.readThread(address, true, null, true);
      }
    } catch (err) {
      if (err instanceof SourceError) this.log?.warn({ input: input.url, code: err.code, reason: err.message }, "could not add source");
      throw err;
    }
    const now = this.now();
    const id = crypto.randomUUID();
    const title = input.title || read.pages.at(-1)?.title || new URL(address).hostname;
    await this.db.kysely
      .insertInto("sources")
      .values({
        id,
        kind: "thread",
        title,
        site_url: address,
        feed_url: address,
        status: "pending",
        via_flaresolverr: via ? 1 : 0,
        last_error: null,
        last_checked_at: null,
        last_success_at: null,
        next_check_at: null,
        poll_interval_minutes: null,
        retention_days: null,
        etag: null,
        last_modified: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await this.setTags(id, input.tags ?? []);
    const added = await this.ingestThread(id, read.pages, read.lastUrl, true);
    await this.recordSuccess(id, now, null, null);
    this.log?.info({ sourceId: id, thread: address, posts: added }, "thread followed");
    return (await this.getSource(id))!;
  }

  /**
   * Reads a thread's newest page; if every post on it is newer than `knownMax`, also the page(s)
   * before it, so a busy thread doesn't lose replies between checks. Pages come back oldest first.
   */
  private async readThread(address: string, via: boolean, knownMax: number | null, interactive: boolean): Promise<{ pages: ForumThreadPage[]; lastUrl: string }> {
    const get = async (url: string) => {
      if (interactive) return this.fetchInteractive(url, "html", via);
      await this.limiter.wait(url);
      const res = await this.fetcherFor(via)(url, { expect: "html" });
      if (res.kind !== "ok") throw new FetchError("error", "The site answered without content");
      return res;
    };
    const latest = await get(latestPageUrl(address));
    const lastUrl = latest.url.replace(/#.*$/, "");
    const page = parseThreadPage(latest.body, lastUrl);
    if (!page) {
      const message = "Couldn't find any posts on that page. It may not be a XenForo thread, or the forum shows it only to members.";
      if (interactive) throw new SourceError("not_a_thread", message, 422);
      throw new ThreadParseError(message);
    }
    const pages = [page];
    let current = page;
    for (let back = 0; back < THREAD_MAX_BACK_PAGES && knownMax !== null && current.page > 1; back++) {
      const oldest = Math.min(...current.posts.map((p) => (p.id ? postNumber(p.id) : Infinity)));
      if (oldest <= knownMax) break; // this page already reaches posts we have
      const previous = await get(threadPageUrl(address, current.page - 1));
      const parsed = parseThreadPage(previous.body, previous.url);
      if (!parsed) break;
      pages.unshift(parsed);
      current = parsed;
    }
    return { pages, lastUrl };
  }

  /** Stores new posts and brings the thread's single card up to date. Returns how many posts were new. */
  private async ingestThread(sourceId: string, pages: ForumThreadPage[], lastUrl: string, firstFetch: boolean): Promise<number> {
    const now = this.now();
    const known = await this.db.kysely.selectFrom("thread_posts").select("post_id").where("source_id", "=", sourceId).execute();
    const knownIds = new Set(known.map((k) => k.post_id));
    const knownMax = Math.max(0, ...known.map((k) => postNumber(k.post_id)));
    const fresh = new Map<string, ForumThreadPage["posts"][number]>();
    for (const post of pages.flatMap((p) => p.posts)) {
      if (!post.id || knownIds.has(post.id) || fresh.has(post.id)) continue;
      if (!firstFetch && postNumber(post.id) <= knownMax) continue; // an old post we trimmed or skipped
      fresh.set(post.id, post);
    }
    if (fresh.size) {
      await this.db.kysely
        .insertInto("thread_posts")
        .values(
          [...fresh.values()].map((p) => ({
            source_id: sourceId,
            post_id: p.id!,
            author: p.author,
            posted_at: p.postedAt,
            posted_label: p.timeLabel,
            html: p.html,
            fetched_at: now,
          })),
        )
        .onConflict((oc) => oc.columns(["source_id", "post_id"]).doNothing())
        .execute();
      // Keep the newest posts only.
      const all = await this.db.kysely.selectFrom("thread_posts").select("post_id").where("source_id", "=", sourceId).execute();
      const drop = all.map((r) => r.post_id).sort((a, b) => postNumber(b) - postNumber(a)).slice(THREAD_POSTS_KEPT);
      if (drop.length) await this.db.kysely.deleteFrom("thread_posts").where("source_id", "=", sourceId).where("post_id", "in", drop).execute();
    }
    if (!fresh.size && !firstFetch) return 0;

    // The card: unread again, with the count since the user last read it.
    const source = await this.db.kysely.selectFrom("sources").select(["title", "thread_batch_from"]).where("id", "=", sourceId).executeTakeFirstOrThrow();
    const card = await this.db.kysely.selectFrom("items").select(["id", "read"]).where("source_id", "=", sourceId).where("guid", "=", "thread").executeTakeFirst();
    const batchFrom = !card || card.read === 1 || source.thread_batch_from === null ? now : source.thread_batch_from;
    await this.db.kysely.updateTable("sources").set({ thread_batch_from: batchFrom }).where("id", "=", sourceId).execute();
    const batch = await this.db.kysely
      .selectFrom("thread_posts")
      .select(["post_id", "author", "html", "posted_at"])
      .where("source_id", "=", sourceId)
      .where("fetched_at", ">=", batchFrom)
      .execute();
    const latest = batch.sort((a, b) => postNumber(b.post_id) - postNumber(a.post_id))[0];
    const summary = firstFetch && !card
      ? threadSummary(batch.length, latest ? { author: latest.author, text: htmlToText(latest.html) } : null).replace(/new (reply|replies)/, "latest $1")
      : threadSummary(batch.length, latest ? { author: latest.author, text: htmlToText(latest.html) } : null);
    const values = {
      title: pages.at(-1)?.title ?? source.title,
      url: lastUrl,
      author: latest?.author ?? null,
      summary,
      image_url: null,
      published_at: Math.min(latest?.posted_at ?? now, now),
      fetched_at: now,
      read: 0,
      read_at: null,
    };
    if (card) await this.db.kysely.updateTable("items").set(values).where("id", "=", card.id).execute();
    else await this.db.kysely.insertInto("items").values({ ...values, id: crypto.randomUUID(), source_id: sourceId, guid: "thread", saved: 0 }).execute();
    return fresh.size;
  }

  private async checkThread(row: SourceRow): Promise<CheckResult> {
    const startedAt = this.now();
    const via = row.via_flaresolverr === 1;
    try {
      const known = await this.db.kysely.selectFrom("thread_posts").select("post_id").where("source_id", "=", row.id).execute();
      const knownMax = known.length ? Math.max(...known.map((k) => postNumber(k.post_id))) : null;
      const read = await this.readThread(row.feed_url, via, knownMax, false);
      const newItems = await this.ingestThread(row.id, read.pages, read.lastUrl, knownMax === null);
      await this.recordSuccess(row.id, startedAt, null, null, row);
      if (newItems) this.log?.info({ sourceId: row.id, newPosts: newItems }, "new replies");
      return { ok: true, newItems };
    } catch (err) {
      const message =
        err instanceof FetchError ? friendlyFetchError(err, row.feed_url, via)
        : err instanceof ThreadParseError ? err.message
        : "Unexpected error while checking this thread";
      if (!(err instanceof FetchError || err instanceof ThreadParseError)) this.log?.warn({ err, sourceId: row.id }, "check failed");
      await this.recordFailure(row, startedAt, message, err instanceof FetchError ? err : undefined);
      return { ok: false, newItems: 0, error: message };
    }
  }

  // ---- OPML import/export (D-073) ---------------------------------------------------

  /**
   * Adds every feed in an OPML file that isn't followed yet. Nothing is fetched here: sources
   * start as "pending" and the scheduler checks them (politely spaced per site) right away.
   */
  async importOpml(xml: string): Promise<OpmlImportResult> {
    const entries = parseOpml(xml);
    const existing = new Set((await this.db.kysely.selectFrom("sources").select("feed_url").execute()).map((r) => r.feed_url));
    const result: OpmlImportResult = { added: 0, skipped: [] };
    const now = this.now();
    for (const e of entries) {
      const planned = planImport(e.feedUrl);
      if (!planned) {
        result.skipped.push({ url: e.feedUrl, title: e.title, reason: "Not an http(s) feed address" });
        continue;
      }
      if (existing.has(planned.feedUrl)) {
        result.skipped.push({ url: planned.feedUrl, title: e.title, reason: "Already followed" });
        continue;
      }
      existing.add(planned.feedUrl);
      const id = crypto.randomUUID();
      await this.db.kysely
        .insertInto("sources")
        .values({
          id,
          kind: planned.kind,
          title: e.title || new URL(planned.feedUrl).hostname,
          site_url: e.siteUrl ?? planned.siteUrl,
          feed_url: planned.feedUrl,
          status: "pending",
          last_error: null,
          last_checked_at: null,
          last_success_at: null,
          next_check_at: now,
          poll_interval_minutes: null,
          retention_days: null,
          etag: null,
          last_modified: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await this.setTags(id, e.tags);
      result.added++;
    }
    this.log?.info({ added: result.added, skipped: result.skipped.length }, "OPML imported");
    return result;
  }

  async exportOpml(): Promise<string> {
    // Followed threads aren't feeds other readers could use.
    const sources = (await this.listSources()).filter((s) => s.kind !== "thread");
    return buildOpml(
      sources.map((s) => ({ title: s.title, feedUrl: s.feedUrl, siteUrl: s.siteUrl, tags: s.tags })),
      this.now(),
    );
  }

  /** Works out the feed URL for whatever the user pasted, fetching as little as possible. */
  private async resolve(raw: string, via = false): Promise<{ kind: SourceKind; feedUrl: string; siteUrl: string | null; parsed: ParsedFeed }> {
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
        const page = await this.fetchInteractive(yt.pageUrl, "html", via);
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
        res = await this.fetchInteractive(feedUrl, "feed", via);
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
        res = await this.fetchInteractive(reddit.feedUrl, "feed", via);
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

    // XenForo boards (…/forums/name.12/) have their feed at …/index.rss. Try it first: it's one
    // request, and some forums answer feeds even when their pages show a bot check.
    const board = /^(\/forums\/[^/]+\.\d+)\/?$/.exec(url.pathname);
    if (board) {
      const feedUrl = `${url.origin}${board[1]}/index.rss`;
      try {
        const feedRes = await this.fetchInteractive(feedUrl, "feed", via);
        if (looksLikeFeed(feedRes.body)) return { kind: "feed", feedUrl, siteUrl: url.href, parsed: this.parse(feedRes.body, feedUrl) };
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        // fall through to reading the page itself
      }
    }

    const res = await this.fetchPageOrParent(url, via);
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
    const feedRes = await this.fetchInteractive(first.url, "feed", via);
    return { kind: "feed", feedUrl: first.url, siteUrl: res.url, parsed: this.parse(feedRes.body, first.url) };
  }

  /**
   * The pasted page, or, when it doesn't exist (404), the nearest folder above it that does
   * (D-090): e.g. factorio.com/blog/post isn't a page, but factorio.com/blog/ is, and it
   * advertises the blog's feed. At most two levels up, never the site's front page.
   */
  private async fetchPageOrParent(url: URL, via: boolean) {
    const tried = [url.href];
    try {
      return await this.fetchInteractive(url.href, "feed", via);
    } catch (err) {
      if (!(err instanceof SourceError) || err.code !== "not_found") throw err;
      const segments = url.pathname.split("/").filter(Boolean);
      for (let up = 1; up <= 2 && segments.length - up >= 1; up++) {
        const parent = new URL(`/${segments.slice(0, -up).join("/")}/`, url.origin).href;
        tried.push(parent);
        try {
          return await this.fetchInteractive(parent, "feed", via);
        } catch (parentErr) {
          if (!(parentErr instanceof SourceError) || parentErr.code !== "not_found") throw parentErr;
        }
      }
      throw new SourceError(
        "not_found",
        `${err.message}${tried.length > 1 ? ` Also tried ${tried.slice(1).join(" and ")}.` : ""} If the site has a feed, paste the feed's own address (often ending in /feed, /rss or .xml).`,
        err.status,
      );
    }
  }

  private async fetchInteractive(url: string, expect: "feed" | "html", via = false) {
    await this.limiter.wait(url, INTERACTIVE);
    try {
      const res = await this.fetcherFor(via)(url, { expect });
      if (res.kind !== "ok") throw new SourceError("unexpected", "The site answered without content.");
      return res;
    } catch (err) {
      if (err instanceof FetchError) throw new SourceError(err.kind, friendlyFetchError(err, url, via), 422);
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
    if (row.kind === "thread") return this.checkThread(row);

    await this.limiter.wait(row.feed_url);
    const startedAt = this.now();
    try {
      const res = await this.fetcherFor(row.via_flaresolverr === 1)(row.feed_url, { expect: "feed", etag: row.etag, lastModified: row.last_modified });
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
        err instanceof FetchError ? friendlyFetchError(err, row.feed_url, row.via_flaresolverr === 1)
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

  /** Days to keep unsaved items for this source (0 = forever). */
  private retentionDays(row: Pick<SourceRow, "retention_days">): number {
    return row.retention_days ?? this.config.retention.keepDays;
  }

  /**
   * Stores items not seen before. Returns how many were new. Skips items that retention
   * already removed (tombstones) or that are older than the source keeps.
   */
  private async ingest(sourceId: string, parsed: ParsedFeed, firstFetch: boolean): Promise<number> {
    const now = this.now();
    const source = await this.db.kysely.selectFrom("sources").select(["retention_days", "kind"]).where("id", "=", sourceId).executeTakeFirst();
    const keepDays = source ? this.retentionDays(source) : 0;
    const cutoff = keepDays > 0 ? now - keepDays * 24 * 3_600_000 : -Infinity;

    const candidates = parsed.items.map((it, index) => {
      // Undated items keep feed order; dates in the future are treated as "now".
      const published = Math.min(it.publishedAt ?? now - index, now);
      const old = firstFetch && published < now - FIRST_FETCH_UNREAD_WINDOW_MS;
      return {
        content: it.contentHtml,
        row: {
          id: crypto.randomUUID(),
          source_id: sourceId,
          guid: it.guid,
          url: it.url,
          title: it.title,
          author: it.author,
          summary: source?.kind === "reddit" ? cleanRedditSummary(it.summary) : it.summary,
          image_url: it.imageUrl,
          published_at: published,
          fetched_at: now,
          read: old ? 1 : 0,
          saved: 0,
          read_at: old ? now : null,
        },
      };
    });

    let inserted = 0;
    for (let i = 0; i < candidates.length; i += INSERT_CHUNK) {
      let chunk = candidates.slice(i, i + INSERT_CHUNK).filter((c) => c.row.published_at >= cutoff);
      if (!chunk.length) continue;
      const removed = await this.db.kysely
        .selectFrom("item_tombstones")
        .select("guid")
        .where("source_id", "=", sourceId)
        .where("guid", "in", chunk.map((c) => c.row.guid))
        .execute();
      if (removed.length) {
        const gone = new Set(removed.map((r) => r.guid));
        chunk = chunk.filter((c) => !gone.has(c.row.guid));
        if (!chunk.length) continue;
      }
      await this.db.kysely
        .insertInto("items")
        .values(chunk.map((c) => c.row))
        .onConflict((oc) => oc.columns(["source_id", "guid"]).doNothing())
        .execute();
      // Which of our new IDs made it in (the rest were already known)?
      const fresh = new Set(
        (await this.db.kysely.selectFrom("items").select("id").where("id", "in", chunk.map((c) => c.row.id)).execute()).map((r) => r.id),
      );
      inserted += fresh.size;
      const contents = chunk
        .filter((c) => c.content && fresh.has(c.row.id))
        .map((c) => ({ item_id: c.row.id, origin: "feed" as const, status: "raw" as const, html: c.content, error: null, fetched_at: now }));
      if (contents.length) await this.db.kysely.insertInto("item_content").values(contents).execute();
      await this.backfillContent(sourceId, source?.kind, chunk.filter((c) => c.content && !fresh.has(c.row.id)), now);
    }
    return inserted;
  }

  /**
   * Items stored before feed bodies were kept at any length (v1.0.0 kept only 500+ characters)
   * get their body when the feed shows them again (D-076). Reddit bodies are also re-stored raw
   * where an older version cached its cleaned copy, so the current Reddit layout applies.
   */
  private async backfillContent(sourceId: string, kind: SourceKind | undefined, known: Array<{ content: string | null; row: { guid: string } }>, now: number) {
    if (!known.length) return;
    const rows = await this.db.kysely
      .selectFrom("items")
      .leftJoin("item_content", "item_content.item_id", "items.id")
      .select(["items.id", "items.guid", "item_content.status", "item_content.origin"])
      .where("items.source_id", "=", sourceId)
      .where("items.guid", "in", known.map((c) => c.row.guid))
      .execute();
    const bodies = new Map(known.map((c) => [c.row.guid, c.content!]));
    for (const r of rows) {
      const missing = r.status === null;
      const staleReddit = kind === "reddit" && r.origin === "feed" && r.status !== "raw";
      const html = bodies.get(r.guid);
      if (!html || !(missing || staleReddit)) continue;
      await this.db.kysely
        .insertInto("item_content")
        .values({ item_id: r.id, origin: "feed", status: "raw", html, error: null, fetched_at: now })
        .onConflict((oc) => oc.column("item_id").doUpdateSet({ origin: "feed", status: "raw", html, error: null, fetched_at: now }))
        .execute();
    }
  }

  /**
   * Deletes unsaved items older than each source keeps (all sources, or one), remembering
   * their IDs so the next check doesn't add them back. Returns how many were removed.
   */
  async applyRetention(onlySourceId?: string): Promise<number> {
    const now = this.now();
    let q = this.db.kysely.selectFrom("sources").select(["id", "retention_days"]);
    if (onlySourceId) q = q.where("id", "=", onlySourceId);
    let removed = 0;
    for (const src of await q.execute()) {
      const days = this.retentionDays(src);
      if (days <= 0) continue;
      const cutoff = now - days * 24 * 3_600_000;
      const doomed = await this.db.kysely
        .selectFrom("items")
        .select(["id", "guid"])
        .where("source_id", "=", src.id)
        .where("saved", "=", 0)
        .where("published_at", "<", cutoff)
        .execute();
      for (let i = 0; i < doomed.length; i += 200) {
        const batch = doomed.slice(i, i + 200);
        await this.db.kysely.transaction().execute(async (trx) => {
          await trx
            .insertInto("item_tombstones")
            .values(batch.map((d) => ({ source_id: src.id, guid: d.guid, deleted_at: now })))
            .onConflict((oc) => oc.columns(["source_id", "guid"]).doNothing())
            .execute();
          await trx.deleteFrom("item_content").where("item_id", "in", batch.map((d) => d.id)).execute();
          await trx.deleteFrom("items").where("id", "in", batch.map((d) => d.id)).execute();
        });
      }
      removed += doomed.length;
    }
    // Feeds don't keep items for long; forget tombstones after ~13 months.
    await this.db.kysely.deleteFrom("item_tombstones").where("deleted_at", "<", now - 400 * 24 * 3_600_000).execute();
    if (removed) this.log?.info({ removed, sourceId: onlySourceId }, "retention removed old items");
    return removed;
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
    const [counts, tags] = await Promise.all([this.counts(), this.tagsBySource()]);
    return rows.map((r) => this.toSource(r, counts.get(r.id), tags.get(r.id)));
  }

  async getSource(id: string): Promise<Source | undefined> {
    const row = await this.db.kysely.selectFrom("sources").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return undefined;
    const [counts, tags] = await Promise.all([this.counts(id), this.tagsBySource(id)]);
    return this.toSource(row, counts.get(id), tags.get(id));
  }

  async updateSource(id: string, patch: UpdateSourceRequest): Promise<Source> {
    const row = await this.db.kysely.selectFrom("sources").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) throw new SourceError("not_found", "Source not found", 404);
    const set: Partial<SourceRow> = { updated_at: this.now() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.pollIntervalMinutes !== undefined) set.poll_interval_minutes = patch.pollIntervalMinutes;
    if (patch.retentionDays !== undefined) set.retention_days = patch.retentionDays;
    const via = patch.viaFlareSolverr ?? row.via_flaresolverr === 1;
    if (patch.viaFlareSolverr !== undefined && via !== (row.via_flaresolverr === 1)) {
      set.via_flaresolverr = via ? 1 : 0;
      // A different route: start fresh (no validators, check soon).
      set.etag = null;
      set.last_modified = null;
      if (row.enabled === 1) set.next_check_at = this.now();
    }
    const selectorsChanged =
      (patch.articleSelector !== undefined && patch.articleSelector !== row.article_selector) ||
      (patch.removeSelector !== undefined && patch.removeSelector !== row.remove_selector);
    if (selectorsChanged) {
      checkSelectors(patch);
      if (patch.articleSelector !== undefined) set.article_selector = patch.articleSelector;
      if (patch.removeSelector !== undefined) set.remove_selector = patch.removeSelector;
    }

    // A new address is checked before anything is saved; existing items are kept.
    let moved: Awaited<ReturnType<FeedService["resolve"]>> | undefined;
    if (patch.url !== undefined && patch.url !== row.feed_url && patch.url !== row.site_url) {
      if (row.kind === "thread" || threadFromInput(patch.url)) {
        throw new SourceError("thread_address", "A followed thread keeps its address. To follow another thread, add it as a new source.", 400, { url: "Add the other thread as a new source" });
      }
      try {
        moved = await this.resolve(patch.url, via);
      } catch (err) {
        if (err instanceof SourceError) this.log?.warn({ input: patch.url, code: err.code, reason: err.message }, "could not change source address");
        throw err;
      }
      if (moved.feedUrl !== row.feed_url) {
        const clash = await this.db.kysely.selectFrom("sources").select("title").where("feed_url", "=", moved.feedUrl).where("id", "!=", id).executeTakeFirst();
        if (clash) throw new SourceError("duplicate", `That feed is already followed as “${clash.title}”.`, 409);
      }
      set.feed_url = moved.feedUrl;
      set.site_url = moved.siteUrl;
      set.kind = moved.kind;
      set.etag = null;
      set.last_modified = null;
    }
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
    if (patch.tags !== undefined) await this.setTags(id, patch.tags);
    if (moved) {
      await this.ingest(id, moved.parsed, true);
      await this.recordSuccess(id, this.now(), null, null, { ...row, ...set } as SourceRow);
    }
    if (patch.retentionDays !== undefined) await this.applyRetention(id);
    // Articles already read from the page used the old selectors: read them again next time.
    if (selectorsChanged) {
      await this.db.kysely
        .deleteFrom("item_content")
        .where("origin", "=", "page")
        .where("item_id", "in", (eb) => eb.selectFrom("items").select("items.id").where("items.source_id", "=", id))
        .execute();
    }
    return (await this.getSource(id))!;
  }

  private async setTags(sourceId: string, tags: string[]): Promise<void> {
    await this.db.kysely.transaction().execute(async (trx) => {
      await trx.deleteFrom("source_tags").where("source_id", "=", sourceId).execute();
      if (tags.length) await trx.insertInto("source_tags").values(tags.map((tag) => ({ source_id: sourceId, tag }))).execute();
    });
  }

  private async tagsBySource(onlyId?: string): Promise<Map<string, string[]>> {
    let q = this.db.kysely.selectFrom("source_tags").select(["source_id", "tag"]).orderBy("tag");
    if (onlyId) q = q.where("source_id", "=", onlyId);
    const map = new Map<string, string[]>();
    for (const r of await q.execute()) map.set(r.source_id, [...(map.get(r.source_id) ?? []), r.tag]);
    return map;
  }

  /** All tags in use, with how many sources use each and how many unread items they cover. */
  async listTags(): Promise<TagCount[]> {
    const rows = await this.db.kysely
      .selectFrom("source_tags")
      .leftJoin("items", (j) => j.onRef("items.source_id", "=", "source_tags.source_id").on("items.read", "=", 0))
      .select((eb) => [
        "source_tags.tag",
        eb.fn.count<number>("source_tags.source_id").distinct().as("sources"),
        eb.fn.count<number>("items.id").as("unread"),
      ])
      .groupBy("source_tags.tag")
      .orderBy("source_tags.tag")
      .execute();
    return rows.map((r) => ({ tag: r.tag, sources: Number(r.sources), unread: Number(r.unread) }));
  }

  async removeSource(id: string): Promise<boolean> {
    // Everything goes with it (ON DELETE CASCADE, plus explicitly in case FKs aren't enforced).
    await this.db.kysely
      .deleteFrom("item_content")
      .where("item_id", "in", (eb) => eb.selectFrom("items").select("id").where("source_id", "=", id))
      .execute();
    await this.db.kysely.deleteFrom("items").where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("source_tags").where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("item_tombstones").where("source_id", "=", id).execute();
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

  private toSource(r: SourceRow, c?: { total: number; unread: number }, tags: string[] = []): Source {
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
      retentionDays: r.retention_days,
      articleSelector: r.article_selector,
      removeSelector: r.remove_selector,
      viaFlareSolverr: r.via_flaresolverr === 1,
      tags,
      unreadCount: c?.unread ?? 0,
      itemCount: c?.total ?? 0,
      createdAt: r.created_at,
    };
  }
}

/** Rejects CSS selectors the browser engine can't parse, naming the field. */
export function checkSelectors(s: { articleSelector?: string | null; removeSelector?: string | null }): void {
  const fields: Record<string, string> = {};
  if (s.articleSelector && !isValidSelector(s.articleSelector)) fields.articleSelector = "That isn't a valid CSS selector";
  if (s.removeSelector && !isValidSelector(s.removeSelector)) fields.removeSelector = "That isn't a valid CSS selector";
  if (Object.keys(fields).length) throw new SourceError("validation", "Some fields are invalid", 400, fields);
}

/** Kind and canonical feed address for an imported feed URL, without fetching anything. */
function planImport(raw: string): { kind: SourceKind; feedUrl: string; siteUrl: string | null } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const yt = planYouTube(url);
  if (yt?.kind === "feed") return { kind: "youtube", feedUrl: yt.feedUrl, siteUrl: yt.siteUrl };
  const reddit = planReddit(url);
  if (reddit) return { kind: "reddit", feedUrl: reddit.feedUrl, siteUrl: reddit.siteUrl };
  return { kind: "feed", feedUrl: url.href, siteUrl: null };
}

/** A forum thread link in what the user pasted (D-084), as the thread's own address. */
function threadFromInput(raw: string): string | null {
  let input = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `https://${input}`;
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return threadAddress(url);
  } catch {
    return null;
  }
}
