// Sources: adding (with feed discovery and YouTube lookup), checking, and storing new items.
import crypto from "node:crypto";
import type { Selectable } from "kysely";
import type { AddSourceRequest, CheckingValues, OpmlImportResult, Source, SourceKind, TagCount, UpdateSourceRequest } from "@fa/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { SourcesTable } from "../db/schema.js";
import type { Viewer } from "../auth/service.js";
import { discoverFeeds, preferredFeed } from "./discover.js";
import { FetchError, type Fetcher, type HostLimiter, type JsonFetcher } from "./fetch.js";
import type { FlareSolverr } from "./flaresolverr.js";
import { FeedParseError, looksLikeFeed, parseFeed, type ParsedFeed } from "./parse.js";
import { buildOpml, parseOpml } from "./opml.js";
import { pageParser } from "../reader/pageParser.js";
import { followedThreadPager, postNumber, threadAddress, threadSummary, vbulletinThreadAddress } from "./thread.js";
import { boardThreadSummary, looksLikeVbulletinBoard, type BoardThread } from "./board.js";
import type { ForumThreadPage } from "../reader/extract.js";
import { ThreadExtractionError, threadQualityMessage, validateThreadResponse } from "../reader/threadQuality.js";
import { htmlToText } from "./text.js";
import { nextCheck } from "./schedule.js";
import { isValidSelector } from "../reader/extract.js";
import { cleanRedditSummary, planReddit } from "./reddit.js";
import { channelFeedUrl, channelIdFromPage, isConsentPage, normaliseYouTubeInput, planYouTube } from "./youtube.js";
import { latestUploads, YouTubeApiError } from "../reader/youtubeApi.js";

type SourceRow = Selectable<SourcesTable>;

interface ThreadCatchup {
  nextPage: number;
  /** Highest post known before this gap started; never advanced while filling it. */
  floor: number;
  /** Null while a one-page vBulletin check is still discovering the newest page. */
  latestUrl: string | null;
  /** Recheck the page count after a previously existing page disappears. */
  discover?: boolean;
}

/** A user-facing failure with a message that says what to do about it. */
/**
 * A feed body stored before numeric character references were decoded (D-091): quotes left as
 * &#34; inside a tag (raw), or the broken ".../%22https://..." links that made once cleaned.
 */
const MISDECODED = /<[^>]*=\s*&#(?:34|x22);|="[^"]*%22https?:/i;

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
/** Tries of a YouTube channel feed per check: it answers 404/500 at random lately (D-105). */
const YOUTUBE_FEED_TRIES = 3;

/** The user's YouTube Data API key, for reading a channel when its feed doesn't answer (D-105). */
export interface YouTubeAccess {
  apiKey(): Promise<string | null>;
  fetchJson: JsonFetcher;
}

/** YouTube's channel feed failing on YouTube's side (404/5xx), as opposed to a bad address. */
function isYouTubeHiccup(err: unknown): err is FetchError {
  return err instanceof FetchError && (err.status === 404 || (err.status !== undefined && err.status >= 500));
}

const YOUTUBE_FEED_DOWN =
  "YouTube's channel feed isn't answering (it fails on and off on YouTube's side lately). Add a YouTube API key in Settings → YouTube comments and the app reads the channel through the API when this happens.";
/** On a source's first fetch, or for a new follower, items older than this start out as read. */
export const FIRST_FETCH_UNREAD_WINDOW_MS = 7 * 24 * 3_600_000;
/** Shared settings of a source others follow too (D-115): only the admin changes them. */
const SHARED_SETTINGS =
  "Other accounts follow this source too, so only the admin can change how it's checked and read (check interval, keep items, reader selectors, FlareSolverr). Your name for it, its tags and pausing it are yours to change.";
const INSERT_CHUNK = 50;
/** Posts kept per followed thread (D-084). */
const THREAD_POSTS_KEPT = 300;

/** What an address resolves to: the feed to follow and its first fetch. */
/** `board`: a vBulletin board's threads (D-123), stored instead of `parsed`'s items. */
type ResolvedSource = { kind: SourceKind; feedUrl: string; siteUrl: string | null; parsed: ParsedFeed; board?: BoardThread[] };

/** Sub-forums of a followed board read on each check (D-123), one page request each. */
const MAX_SUBFORUMS = 5;

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
    private readonly youtube?: YouTubeAccess,
  ) {
    this.polling = { ...config.polling };
  }

  /** config.yaml's polling, with Settings → Checking applied on top (D-095). */
  private polling: AppConfig["polling"];

  /** The check intervals and thread pages in use now. */
  checking(): CheckingValues {
    return { intervalMinutes: this.polling.intervalMinutes, threadIntervalMinutes: this.polling.threadIntervalMinutes, threadPagesPerCheck: this.polling.maxPagesPerPoll };
  }

  /** What Settings → Checking falls back to: config.yaml, else the built-in defaults. */
  checkingDefaults(): CheckingValues {
    const p = this.config.polling;
    return { intervalMinutes: p.intervalMinutes, threadIntervalMinutes: p.threadIntervalMinutes, threadPagesPerCheck: p.maxPagesPerPoll };
  }

  /**
   * Applies Settings → Checking (null = the default). Sources on the default interval whose next
   * check is now further away than the new interval allows are brought forward; a longer
   * interval applies from each source's next check.
   */
  async applyChecking(saved: { [K in keyof CheckingValues]: number | null }, reschedule = true): Promise<void> {
    const d = this.checkingDefaults();
    this.polling = {
      ...this.config.polling,
      intervalMinutes: saved.intervalMinutes ?? d.intervalMinutes,
      threadIntervalMinutes: saved.threadIntervalMinutes ?? d.threadIntervalMinutes,
      maxPagesPerPoll: saved.threadPagesPerCheck ?? d.threadPagesPerCheck,
    };
    if (!reschedule) return;
    for (const [threads, minutes] of [[false, this.polling.intervalMinutes], [true, this.polling.threadIntervalMinutes]] as const) {
      await this.db.kysely
        .updateTable("sources")
        .set((eb) => ({ next_check_at: eb("last_checked_at", "+", minutes * 60_000) }))
        .where("poll_interval_minutes", "is", null)
        .where("kind", threads ? "=" : "!=", "thread")
        .where("consecutive_failures", "=", 0)
        .where("last_checked_at", "is not", null)
        // Beyond the new interval plus its jitter (nextCheck adds up to 10 %), so unchanged ones stay put.
        .where((eb) => eb("next_check_at", ">", eb("last_checked_at", "+", Math.round(minutes * 60_000 * 1.1))))
        .execute();
    }
  }

  private flareFetcher?: Fetcher;

  /** The fetcher for a source: direct, or through FlareSolverr when the source is set to (D-080). */
  private fetcherFor(viaFlareSolverr: boolean): Fetcher {
    if (!viaFlareSolverr || !this.flare) return this.fetcher;
    this.flareFetcher ??= this.flare.wrap(this.fetcher);
    return this.flareFetcher;
  }

  // ---- adding ------------------------------------------------------------------------

  async addSource(viewer: Viewer, input: AddSourceRequest): Promise<Source> {
    const thread = threadFromInput(input.url);
    if (thread) return this.addThread(viewer, input, thread);
    // A vBulletin-style link (D-120) is followed as a thread if its page is one; else it's added as
    // any other page (one more request, only when adding).
    const vbThread = vbulletinThreadFromInput(input.url);
    if (vbThread) {
      try {
        return await this.addThread(viewer, input, vbThread, true);
      } catch (err) {
        if (!(err instanceof SourceError && err.code === "not_a_thread")) throw err;
      }
    }
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
    const id = await this.followResolved(viewer, resolved, via, input.title, input.tags ?? []);
    return (await this.getSource(viewer, id))!;
  }

  /**
   * Follows a feed just read: a new source, or (D-115) the one another account already follows,
   * which isn't fetched again for this. Returns the source's id.
   */
  private async followResolved(viewer: Viewer, resolved: ResolvedSource, via: boolean, title: string | undefined, tags: string[]): Promise<string> {
    const existing = await this.db.kysely.selectFrom("sources").select(["id", "title"]).where("feed_url", "=", resolved.feedUrl).executeTakeFirst();
    if (existing) {
      await this.subscribeExisting(viewer, existing, title, tags, "You already follow this feed.");
      // Items the feed lists now that the source doesn't have yet (e.g. while it was paused).
      if (resolved.board) await this.ingestBoard(existing.id, resolved.board);
      else await this.ingest(existing.id, resolved.parsed, false);
      return existing.id;
    }
    const now = this.now();
    const feedTitle = resolved.parsed.title || new URL(resolved.siteUrl ?? resolved.feedUrl).hostname;
    const id = await this.insertSource({ kind: resolved.kind, title: feedTitle, site_url: resolved.siteUrl, feed_url: resolved.feedUrl, via_flaresolverr: via ? 1 : 0, next_check_at: null });
    if (id !== null) {
      await this.subscribe(viewer.id, id, title || feedTitle, tags);
      // We already have the feed from resolving it, so store its items straight away.
      const added = resolved.board ? await this.ingestBoard(id, resolved.board) : await this.ingest(id, resolved.parsed, true);
      await this.recordSuccess(id, now, null, null, { poll_interval_minutes: null, kind: resolved.kind });
      this.log?.info({ sourceId: id, feedUrl: resolved.feedUrl, items: added }, "source added");
      return id;
    }
    // Another account added the same feed at the same moment.
    const raced = await this.db.kysely.selectFrom("sources").select(["id", "title"]).where("feed_url", "=", resolved.feedUrl).executeTakeFirstOrThrow();
    await this.subscribeExisting(viewer, raced, title, tags, "You already follow this feed.");
    return raced.id;
  }

  /** A new source row; null if its address is already a source (the unique feed_url). */
  private async insertSource(v: Pick<SourceRow, "kind" | "title" | "site_url" | "feed_url" | "via_flaresolverr" | "next_check_at">): Promise<string | null> {
    const now = this.now();
    const id = crypto.randomUUID();
    const res = await this.db.kysely
      .insertInto("sources")
      .values({
        id,
        ...v,
        status: "pending",
        last_error: null,
        last_checked_at: null,
        last_success_at: null,
        poll_interval_minutes: null,
        retention_days: null,
        etag: null,
        last_modified: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column("feed_url").doNothing())
      .executeTakeFirst();
    return Number(res.numInsertedOrUpdatedRows ?? 0) > 0 ? id : null;
  }

  /** Follows a source another account (or nobody, any more) already follows. */
  private async subscribeExisting(viewer: Viewer, source: { id: string; title: string }, title: string | undefined, tags: string[], duplicateMessage: string) {
    const mine = await this.subscription(viewer.id, source.id);
    if (mine) throw new SourceError("duplicate", duplicateMessage.replace("{title}", mine.title), 409);
    await this.subscribe(viewer.id, source.id, title || source.title, tags);
    this.log?.info({ sourceId: source.id, userId: viewer.id }, "followed a source another account follows");
  }

  /** Adds a follower. Of the items the source has already, those over a week old start out read for them. */
  private async subscribe(userId: string, sourceId: string, title: string, tags: string[], enabled = true): Promise<void> {
    const now = this.now();
    await this.db.kysely
      .insertInto("subscriptions")
      .values({ user_id: userId, source_id: sourceId, title, enabled: enabled ? 1 : 0, thread_batch_from: null, created_at: now, updated_at: now })
      .execute();
    const old = now - FIRST_FETCH_UNREAD_WINDOW_MS;
    await this.db.kysely
      .insertInto("item_states")
      .columns(["user_id", "item_id", "source_id", "read", "saved", "read_at"])
      .expression((eb) =>
        eb
          .selectFrom("items")
          .select((s) => [
            s.val(userId).as("user_id"),
            "items.id",
            "items.source_id",
            s.case().when("items.published_at", "<", old).then(1).else(0).end().as("read"),
            s.val(0).as("saved"),
            s.case().when("items.published_at", "<", old).then(now).else(null).end().as("read_at"),
          ])
          .where("items.source_id", "=", sourceId),
      )
      .onConflict((oc) => oc.columns(["user_id", "item_id"]).doNothing())
      .execute();
    await this.setTags(userId, sourceId, tags);
    await this.syncEnabled(sourceId);
  }

  private subscription(userId: string, sourceId: string) {
    return this.db.kysely.selectFrom("subscriptions").selectAll().where("user_id", "=", userId).where("source_id", "=", sourceId).executeTakeFirst();
  }

  private async followerCount(sourceId: string): Promise<number> {
    const row = await this.db.kysely.selectFrom("subscriptions").select((eb) => eb.fn.countAll<number>().as("n")).where("source_id", "=", sourceId).executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /**
   * A source is checked while any follower whose account is on has it on (D-115): turned off when
   * the last one pauses it (or is turned off), checked again right away when someone turns it on.
   */
  private async syncEnabled(sourceId: string): Promise<void> {
    const on = await this.db.kysely
      .selectFrom("subscriptions")
      .innerJoin("users", "users.id", "subscriptions.user_id")
      .select("subscriptions.user_id")
      .where("subscriptions.source_id", "=", sourceId)
      .where("subscriptions.enabled", "=", 1)
      .where("users.disabled", "=", 0)
      .limit(1)
      .executeTakeFirst();
    const row = await this.db.kysely.selectFrom("sources").select(["enabled", "status"]).where("id", "=", sourceId).executeTakeFirst();
    if (!row) return;
    if (on && row.enabled !== 1) {
      await this.db.kysely
        .updateTable("sources")
        .set({ enabled: 1, status: "pending", consecutive_failures: 0, next_check_at: this.now(), last_error: null, updated_at: this.now() })
        .where("id", "=", sourceId)
        .execute();
    } else if (!on && row.enabled === 1) {
      await this.db.kysely
        .updateTable("sources")
        .set({ enabled: 0, status: "paused", next_check_at: null, last_error: null, updated_at: this.now() })
        .where("id", "=", sourceId)
        .execute();
    }
  }

  // ---- following a forum thread (D-084) ------------------------------------------------

  /** `tryOnly`: a link that may not be a thread (D-120), so "not a thread" isn't logged as a failure. */
  private async addThread(viewer: Viewer, input: AddSourceRequest, address: string, tryOnly = false): Promise<Source> {
    const duplicate = "You already follow this thread as “{title}”.";
    const existing = await this.db.kysely.selectFrom("sources").select(["id", "title"]).where("feed_url", "=", address).executeTakeFirst();
    if (existing) {
      // Another account follows it: its stored posts are shared, nothing to fetch (D-115).
      await this.subscribeExisting(viewer, existing, input.title, input.tags ?? [], duplicate);
      return (await this.getSource(viewer, existing.id))!;
    }
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
      if (err instanceof SourceError && !(tryOnly && err.code === "not_a_thread")) this.log?.warn({ input: input.url, code: err.code, reason: err.message }, "could not add source");
      throw err;
    }
    // A vBulletin link to a later page ("…-title-2.html") is the thread's page 2, not its address.
    if (read.address !== address) {
      address = read.address;
      const known = await this.db.kysely.selectFrom("sources").select(["id", "title"]).where("feed_url", "=", address).executeTakeFirst();
      if (known) {
        await this.subscribeExisting(viewer, known, input.title, input.tags ?? [], duplicate);
        return (await this.getSource(viewer, known.id))!;
      }
    }
    const now = this.now();
    const threadTitle = read.pages.at(-1)?.title || new URL(address).hostname;
    const id = await this.insertSource({ kind: "thread", title: threadTitle, site_url: address, feed_url: address, via_flaresolverr: via ? 1 : 0, next_check_at: null });
    if (id === null) {
      // Another account followed it at the same moment.
      const raced = await this.db.kysely.selectFrom("sources").select(["id", "title"]).where("feed_url", "=", address).executeTakeFirstOrThrow();
      await this.subscribeExisting(viewer, raced, input.title, input.tags ?? [], duplicate);
      return (await this.getSource(viewer, raced.id))!;
    }
    await this.subscribe(viewer.id, id, input.title || threadTitle, input.tags ?? []);
    const added = await this.ingestThread(id, read.pages, read.lastUrl, true);
    await this.recordSuccess(id, now, null, null, { poll_interval_minutes: null, kind: "thread" });
    this.log?.info({ sourceId: id, thread: address, posts: added }, "thread followed");
    return (await this.getSource(viewer, id))!;
  }

  /**
   * Reads a thread's newest page; if every post on it is newer than `knownMax`, also the page(s)
   * before it, so a busy thread doesn't lose replies between checks. Pages come back oldest first.
   * `address` comes back corrected when a vBulletin link turned out to be a later page (D-120).
   */
  private async readThread(
    address: string,
    via: boolean,
    knownMax: number | null,
    interactive: boolean,
    lastRead: string | null = null,
    catchup: ThreadCatchup | null = null,
  ): Promise<{ pages: ForumThreadPage[]; lastUrl: string; address: string; catchup: ThreadCatchup | null }> {
    const get = (url: string) => this.fetchHtml(url, via, interactive);
    const read = async (url: string, expectedPage?: number | "last") => {
      const res = await get(url);
      const pageUrl = res.url.replace(/#.*$/, "");
      const inspection = validateThreadResponse(await pageParser.inspectThread(res.body, pageUrl), url, pageUrl, expectedPage);
      if (inspection.status !== "complete" || !inspection.value) {
        if (interactive) throw new SourceError(inspection.codes.includes("challenge") ? "cloudflare_challenge" : inspection.status === "unrecognized" ? "not_a_thread" : "incomplete_thread", threadQualityMessage(inspection), 422);
        throw new ThreadExtractionError(inspection);
      }
      return { page: inspection.value, url: pageUrl };
    };
    let pager = followedThreadPager(address);
    if (!pager) throw new ThreadParseError("This source's address isn't a forum thread.");

    // XenForo: one request for the newest page. vBulletin has no such address (D-120): the page
    // read last time (the first page when adding), then the newest page if the thread has grown.
    let newest: { page: ForumThreadPage; url: string };
    let started: ForumThreadPage | null = null;
    // Adding a vBulletin thread may require discovery plus its newest page.
    let budget = interactive ? Math.max(2, this.polling.maxPagesPerPoll) : this.polling.maxPagesPerPoll;
    if (catchup) {
      try {
        newest = await read(pager.pageUrl(catchup.nextPage), catchup.nextPage);
      } catch (err) {
        if (catchup.discover || !(err instanceof FetchError && err.status === 404)) throw err;
        return { pages: [], lastUrl: lastRead ?? address, address,
          catchup: { nextPage: 1, floor: catchup.floor, latestUrl: null, discover: true } };
      }
      budget--;
      if (newest.page.page !== Math.min(catchup.nextPage, newest.page.pages)) throw new ThreadParseError("The forum returned a different page while catching up. Will retry the missing page.");
      knownMax = catchup.floor;
      if (catchup.discover && newest.page.pages > newest.page.page) {
        if (budget <= 0) return { pages: [newest.page], lastUrl: newest.url, address,
          catchup: { nextPage: newest.page.pages, floor: catchup.floor, latestUrl: null } };
        newest = await read(pager.pageUrl(newest.page.pages), newest.page.pages);
        budget--;
      }
    } else if (pager.latestUrl) {
      newest = await read(pager.latestUrl, "last");
      budget--;
    } else {
      let from = lastRead && pager.pageOf(lastRead) ? lastRead : address;
      let first;
      try {
        first = await read(from, interactive ? undefined : pager.pageOf(from) ?? undefined);
      } catch (err) {
        // That page is gone (posts deleted, so fewer pages): start again from the first page.
        if (from === address || !(err instanceof FetchError && err.status === 404)) throw err;
        budget--;
        if (budget <= 0) return { pages: [], lastUrl: from, address,
          catchup: { nextPage: 1, floor: knownMax ?? 0, latestUrl: null, discover: true } };
        from = address;
        first = await read(from);
      }
      budget--;
      // A pasted later page ("…-title-2.html", page 2 of 21): the thread's address is page 1.
      if (from === address && first.page.page > 1 && address.endsWith(`-${first.page.page}.html`)) {
        address = `${address.slice(0, -`-${first.page.page}.html`.length)}.html`;
        pager = followedThreadPager(address)!;
      }
      started = first.page;
      newest = first;
      if (first.page.pages > first.page.page) {
        if (budget <= 0) {
          return { pages: [first.page], lastUrl: first.url, address,
            catchup: { nextPage: first.page.pages, floor: knownMax ?? 0, latestUrl: null } };
        }
        newest = await read(pager.pageUrl(first.page.pages), first.page.pages);
        budget--;
      }
    }
    const lastUrl = catchup?.latestUrl ?? newest.url;
    const pages = [newest.page];
    let current = newest.page;
    // Earlier pages, while a whole page of replies is new, up to the pages allowed per check (D-095).
    while (budget > 0 && knownMax !== null && current.page > 1) {
      const oldest = Math.min(...current.posts.map((p) => (p.id ? postNumber(p.id) : Infinity)));
      if (oldest <= knownMax) break; // this page already reaches posts we have
      if (started && started.page === current.page - 1) {
        pages.unshift(started); // read already, at the start of this check
        current = started;
        break;
      }
      const previous = await read(pager.pageUrl(current.page - 1), current.page - 1);
      const parsed = previous.page;
      budget--;
      if (!parsed || parsed.page !== Math.min(current.page - 1, parsed.pages)) throw new ThreadParseError("Couldn't read the previous thread page. Will retry without skipping replies.");
      pages.unshift(parsed);
      current = parsed;
    }
    const oldest = Math.min(...current.posts.map((p) => p.id ? postNumber(p.id) : Infinity));
    const remaining = knownMax !== null && current.page > 1 && oldest > knownMax
      ? { nextPage: current.page - 1, floor: knownMax, latestUrl: lastUrl } : null;
    return { pages, lastUrl, address, catchup: remaining };
  }

  /** A forum page: while adding (with the user waiting, errors as SourceError), or on a check. */
  private async fetchHtml(url: string, via: boolean, interactive: boolean) {
    if (interactive) return this.fetchInteractive(url, "html", via);
    await this.limiter.wait(url);
    const res = await this.fetcherFor(via)(url, { expect: "html" });
    if (res.kind !== "ok") throw new FetchError("error", "The site answered without content");
    return res;
  }

  // ---- following a vBulletin board's threads (D-123) ------------------------------------

  /**
   * A board's first page and its sub-forums' first pages: their threads, stickies left out. A
   * sub-forum that can't be read (e.g. members only) is skipped; the board itself must be readable.
   */
  private async readBoard(address: string, via: boolean, interactive: boolean, fetched?: { body: string; url: string }): Promise<{ title: string | null; threads: BoardThread[] }> {
    const res = fetched ?? (await this.fetchHtml(address, via, interactive));
    const page = await pageParser.board(res.body, res.url);
    if (!page) {
      const message = "Couldn't find the board's list of threads on that page. The forum may have changed its layout, or show it only to members.";
      if (interactive) throw new SourceError("not_a_board", message, 422);
      throw new ThreadParseError(message);
    }
    const threads = [...page.threads];
    for (const sub of page.subforums.slice(0, MAX_SUBFORUMS)) {
      try {
        const subRes = await this.fetchHtml(sub, via, interactive);
        const subPage = await pageParser.board(subRes.body, subRes.url);
        if (subPage) threads.push(...subPage.threads);
        else this.log?.info({ board: address, subforum: sub }, "sub-forum has no thread list; skipped");
      } catch (err) {
        if (!(err instanceof FetchError || err instanceof SourceError)) throw err;
        this.log?.info({ board: address, subforum: sub, reason: err.message }, "sub-forum couldn't be read; skipped");
      }
    }
    const seen = new Set<string>();
    return { title: page.title, threads: threads.filter((t) => !t.sticky && !seen.has(t.id) && !!seen.add(t.id)) };
  }

  /**
   * One card per thread (guid "thread-<id>"): added when the board first lists it, and brought back
   * unread, with how many replies are new, when its newest post changes. Returns how many cards
   * were added or brought back.
   */
  private async ingestBoard(sourceId: string, threads: BoardThread[]): Promise<number> {
    const now = this.now();
    const source = await this.db.kysely.selectFrom("sources").select(["retention_days"]).where("id", "=", sourceId).executeTakeFirst();
    const keepDays = source ? this.retentionDays(source) : 0;
    const cutoff = keepDays > 0 ? now - keepDays * 24 * 3_600_000 : -Infinity;
    const known = new Map((await this.db.kysely.selectFrom("board_threads").selectAll().where("source_id", "=", sourceId).execute()).map((r) => [r.thread_id, r]));
    const followers = (await this.db.kysely.selectFrom("subscriptions").select("user_id").where("source_id", "=", sourceId).execute()).map((r) => r.user_id);
    const unchanged: string[] = [];
    let changed = 0;
    for (const t of threads) {
      if (!t.lastPostId) continue; // e.g. a moved thread's placeholder
      const was = known.get(t.id);
      if (was && postNumber(t.lastPostId) <= postNumber(was.last_post_id)) {
        unchanged.push(t.id);
        continue;
      }
      const guid = `thread-${t.id}`;
      const at = Math.min(t.lastPostAt ?? now, now);
      const card = await this.db.kysely.selectFrom("items").select("id").where("source_id", "=", sourceId).where("guid", "=", guid).executeTakeFirst();
      // "N new replies" counts from when everyone had read the card; while someone hasn't, it adds up.
      let base = t.replies;
      let newReplies: number | null = null;
      if (was) {
        const unread = card
          ? await this.db.kysely.selectFrom("item_states").select("user_id").where("item_id", "=", card.id).where("read", "=", 0).limit(1).executeTakeFirst()
          : undefined;
        base = unread ? was.base_replies : was.replies;
        newReplies = base !== null && t.replies !== null ? Math.max(0, t.replies - base) : null;
      }
      const row = { last_post_id: t.lastPostId, replies: t.replies, base_replies: base, last_page_url: t.lastPageUrl, seen_at: now };
      if (was) await this.db.kysely.updateTable("board_threads").set(row).where("source_id", "=", sourceId).where("thread_id", "=", t.id).execute();
      else await this.db.kysely.insertInto("board_threads").values({ ...row, source_id: sourceId, thread_id: t.id }).execute();
      // Older than the source keeps, and no card yet: remembered, but no card (like a feed's old items).
      if (!card && at < cutoff) continue;
      const values = {
        title: t.title,
        url: t.url,
        author: t.lastPoster ?? t.starter,
        summary: boardThreadSummary(t, newReplies),
        image_url: null,
        published_at: at,
        fetched_at: now,
      };
      const cardId = card?.id ?? crypto.randomUUID();
      if (card) await this.db.kysely.updateTable("items").set(values).where("id", "=", card.id).execute();
      else await this.db.kysely.insertInto("items").values({ ...values, id: cardId, source_id: sourceId, guid }).execute();
      if (followers.length) {
        // New activity is unread for everyone; a thread seen for the first time that has been quiet for
        // over a week (on the first check, or moved up the board without a reply) starts out read.
        const old = !was && at < now - FIRST_FETCH_UNREAD_WINDOW_MS;
        await this.db.kysely
          .insertInto("item_states")
          .values(followers.map((user_id) => ({ user_id, item_id: cardId, source_id: sourceId, read: old ? 1 : 0, saved: 0, read_at: old ? now : null })))
          .onConflict((oc) => oc.columns(["user_id", "item_id"]).doUpdateSet({ read: 0, read_at: null }))
          .execute();
      }
      changed++;
    }
    for (let i = 0; i < unchanged.length; i += INSERT_CHUNK) {
      await this.db.kysely.updateTable("board_threads").set({ seen_at: now }).where("source_id", "=", sourceId).where("thread_id", "in", unchanged.slice(i, i + INSERT_CHUNK)).execute();
    }
    return changed;
  }

  private async checkBoard(row: SourceRow): Promise<CheckResult> {
    const startedAt = this.now();
    const via = row.via_flaresolverr === 1;
    try {
      const board = await this.readBoard(row.feed_url, via, false);
      const newItems = await this.ingestBoard(row.id, board.threads);
      await this.recordSuccess(row.id, startedAt, null, null, row);
      if (newItems) this.log?.info({ sourceId: row.id, threads: newItems }, "board activity");
      return { ok: true, newItems };
    } catch (err) {
      const message =
        err instanceof FetchError ? friendlyFetchError(err, row.feed_url, via)
        : err instanceof ThreadParseError ? err.message
        : "Unexpected error while checking this board";
      if (!(err instanceof FetchError || err instanceof ThreadParseError)) this.log?.warn({ err, sourceId: row.id }, "check failed");
      await this.recordFailure(row, startedAt, message, err instanceof FetchError ? err : undefined);
      return { ok: false, newItems: 0, error: message };
    }
  }

  /** Stores new posts and brings the thread's single card up to date. Returns how many posts were new. */
  private async ingestThread(sourceId: string, pages: ForumThreadPage[], lastUrl: string, firstFetch: boolean, floor?: number, catchingUp = false, db = this.db.kysely): Promise<number> {
    const now = this.now();
    const known = await db.selectFrom("thread_posts").select("post_id").where("source_id", "=", sourceId).execute();
    const knownIds = new Set(known.map((k) => k.post_id));
    // Full rows only for the stored posts on the pages just read (D-107): not all 300 bodies each check.
    const onPages = pages.flatMap((p) => p.posts.map((post) => post.id)).filter((id): id is string => !!id && knownIds.has(id));
    const storedRows = onPages.length
      ? await db.selectFrom("thread_posts").select(["post_id", "posted_at", "posted_label", "html", "author"]).where("source_id", "=", sourceId).where("post_id", "in", onPages).execute()
      : [];
    // Posts already stored that are on the pages read: keep them as the forum shows them now (edits,
    // and dates misread before D-102 from Overclock.net's member box).
    const stored = new Map(storedRows.map((k) => [k.post_id, k]));
    let repaired = false;
    for (const post of pages.flatMap((p) => p.posts)) {
      const was = post.id ? stored.get(post.id) : undefined;
      if (!was || (was.posted_at === post.postedAt && was.posted_label === post.timeLabel && was.html === post.html && was.author === post.author)) continue;
      await db
        .updateTable("thread_posts")
        .set({ posted_at: post.postedAt, posted_label: post.timeLabel, html: post.html, author: post.author })
        .where("source_id", "=", sourceId)
        .where("post_id", "=", post.id!)
        .execute();
      repaired = true;
    }
    const knownMax = Math.max(0, ...known.map((k) => postNumber(k.post_id)));
    const fresh = new Map<string, ForumThreadPage["posts"][number]>();
    for (const post of pages.flatMap((p) => p.posts)) {
      if (!post.id || knownIds.has(post.id) || fresh.has(post.id)) continue;
      if (!firstFetch && postNumber(post.id) <= (floor ?? knownMax)) continue; // outside the gap, or an old trimmed post
      fresh.set(post.id, post);
    }
    if (fresh.size) {
      await db
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
    }
    // Keep the active gap until it is complete, then apply the normal history limit.
    if (!catchingUp) {
      const all = await db.selectFrom("thread_posts").select("post_id").where("source_id", "=", sourceId).execute();
      const drop = all.map((r) => r.post_id).sort((a, b) => postNumber(b) - postNumber(a)).slice(THREAD_POSTS_KEPT);
      if (drop.length) await db.deleteFrom("thread_posts").where("source_id", "=", sourceId).where("post_id", "in", drop).execute();
    }
    // The thread's title as the page shows it; a source still named after the old (tab) title follows it.
    const title = pages.at(-1)?.title ?? null;
    const card = await db.selectFrom("items").select(["id", "title", "published_at"]).where("source_id", "=", sourceId).where("guid", "=", "thread").executeTakeFirst();
    if (title && card && card.title !== title) {
      await db.updateTable("items").set({ title }).where("id", "=", card.id).execute();
      await db.updateTable("sources").set({ title }).where("id", "=", sourceId).where("title", "=", card.title).execute();
      await db.updateTable("subscriptions").set({ title }).where("source_id", "=", sourceId).where("title", "=", card.title).execute();
    }
    if (!fresh.size && !firstFetch) {
      // Dates corrected: the card is dated by its newest post again (read state unchanged).
      if (repaired && card) {
        const newest = await db.selectFrom("thread_posts").select(({ fn }) => fn.max("posted_at").as("at")).where("source_id", "=", sourceId).executeTakeFirst();
        const at = Number(newest?.at);
        if (at > 0) await db.updateTable("items").set({ published_at: Math.min(at, this.now()) }).where("id", "=", card.id).execute();
      }
      return 0;
    }

    // Each follower's batch (D-115): a follower who read the card starts a new one now; one who
    // hasn't keeps theirs (none yet: the card shows the newest stored posts).
    if (card) {
      const followers = await db
        .selectFrom("subscriptions as s")
        .leftJoin("item_states as st", (j) => j.onRef("st.user_id", "=", "s.user_id").on("st.item_id", "=", card.id))
        .select(["s.user_id", "st.read"])
        .where("s.source_id", "=", sourceId)
        .execute();
      for (const f of followers) {
        const read = f.read === 1;
        if (read) await db.updateTable("subscriptions").set({ thread_batch_from: now }).where("user_id", "=", f.user_id).where("source_id", "=", sourceId).execute();
      }
    }
    const source = await db.selectFrom("sources").select(["title"]).where("id", "=", sourceId).executeTakeFirstOrThrow();
    const latest = (await db.selectFrom("thread_posts").select(["post_id", "author", "html", "posted_at"]).where("source_id", "=", sourceId).execute())
      .sort((a, b) => postNumber(b.post_id) - postNumber(a.post_id))[0];
    // Shown only where a follower's own count can't be worked out; the feed recounts per follower.
    const summary = threadSummary(fresh.size, latest ? { author: latest.author, text: htmlToText(latest.html) } : null);
    const values = {
      title: title ?? source.title,
      url: lastUrl,
      author: latest?.author ?? null,
      summary: firstFetch && !card ? summary.replace(/new (reply|replies)/, "latest $1") : summary,
      image_url: null,
      published_at: Math.min(latest?.posted_at ?? now, now),
      fetched_at: now,
    };
    const cardId = card?.id ?? crypto.randomUUID();
    if (card) await db.updateTable("items").set(values).where("id", "=", card.id).execute();
    else await db.insertInto("items").values({ ...values, id: cardId, source_id: sourceId, guid: "thread" }).execute();
    // The card is unread again for every follower (saved stays as it was).
    const userIds = (await db.selectFrom("subscriptions").select("user_id").where("source_id", "=", sourceId).execute()).map((r) => r.user_id);
    if (userIds.length) {
      await db
        .insertInto("item_states")
        .values(userIds.map((user_id) => ({ user_id, item_id: cardId, source_id: sourceId, read: 0, saved: 0, read_at: null })))
        .onConflict((oc) => oc.columns(["user_id", "item_id"]).doUpdateSet({ read: 0, read_at: null }))
        .execute();
    }
    return fresh.size;
  }

  private async checkThread(row: SourceRow): Promise<CheckResult> {
    const startedAt = this.now();
    const via = row.via_flaresolverr === 1;
    try {
      const known = await this.db.kysely.selectFrom("thread_posts").select("post_id").where("source_id", "=", row.id).execute();
      const knownMax = known.length ? Math.max(...known.map((k) => postNumber(k.post_id))) : null;
      // vBulletin threads start from the page read last time, which the card links to (D-120).
      const card = await this.db.kysely.selectFrom("items").select("url").where("source_id", "=", row.id).where("guid", "=", "thread").executeTakeFirst();
      const catchup: ThreadCatchup | null = row.thread_catchup ? JSON.parse(row.thread_catchup) : null;
      const read = await this.readThread(row.feed_url, via, knownMax, false, card?.url ?? null, catchup);
      // Posts, card state and checkpoint must commit together, including the first gap discovery.
      const newItems = await this.db.kysely.transaction().execute(async (db) => {
        const added = await this.ingestThread(row.id, read.pages, read.lastUrl, knownMax === null && !catchup, catchup?.floor, !!read.catchup, db);
        await db.updateTable("sources").set({ thread_catchup: read.catchup ? JSON.stringify(read.catchup) : null }).where("id", "=", row.id).execute();
        return added;
      });
      await this.recordSuccess(row.id, startedAt, null, null, row);
      if (newItems) this.log?.info({ sourceId: row.id, newPosts: newItems }, "new replies");
      return { ok: true, newItems };
    } catch (err) {
      const message =
        err instanceof FetchError ? friendlyFetchError(err, row.feed_url, via)
        : err instanceof ThreadParseError || err instanceof ThreadExtractionError ? err.message
        : "Unexpected error while checking this thread";
      if (err instanceof ThreadExtractionError) {
        const { status, codes, counts } = err.inspection;
        this.log?.warn({ sourceId: row.id, status, codes, counts }, "thread extraction incomplete");
      } else if (!(err instanceof FetchError || err instanceof ThreadParseError)) this.log?.warn({ sourceId: row.id }, "thread page parsing failed");
      const failure = err instanceof FetchError ? err : err instanceof ThreadExtractionError && err.inspection.codes.includes("challenge")
        ? new FetchError("cloudflare_challenge", message) : undefined;
      await this.recordFailure(row, startedAt, message, failure);
      return { ok: false, newItems: 0, error: message };
    }
  }

  // ---- OPML import/export (D-073) ---------------------------------------------------

  /**
   * Adds every feed in an OPML file that isn't followed yet. Nothing is fetched here: sources
   * start as "pending" and the scheduler checks them (politely spaced per site) right away.
   */
  async importOpml(viewer: Viewer, xml: string): Promise<OpmlImportResult> {
    const entries = parseOpml(xml);
    const sources = new Map((await this.db.kysely.selectFrom("sources").select(["id", "feed_url", "title"]).execute()).map((r) => [r.feed_url, r]));
    const mine = new Set((await this.db.kysely.selectFrom("subscriptions").select("source_id").where("user_id", "=", viewer.id).execute()).map((r) => r.source_id));
    const result: OpmlImportResult = { added: 0, skipped: [] };
    const now = this.now();
    for (const e of entries) {
      const planned = planImport(e.feedUrl);
      if (!planned) {
        result.skipped.push({ url: e.feedUrl, title: e.title, reason: "Not an http(s) feed address" });
        continue;
      }
      const existing = sources.get(planned.feedUrl);
      if (existing && mine.has(existing.id)) {
        result.skipped.push({ url: planned.feedUrl, title: e.title, reason: "Already followed" });
        continue;
      }
      const title = e.title || new URL(planned.feedUrl).hostname;
      // Followed by another account already (D-115): just follow it too.
      const id = existing?.id ?? (await this.insertSource({ kind: planned.kind, title, site_url: e.siteUrl ?? planned.siteUrl, feed_url: planned.feedUrl, via_flaresolverr: 0, next_check_at: now }));
      if (!id) continue;
      sources.set(planned.feedUrl, { id, feed_url: planned.feedUrl, title });
      mine.add(id);
      await this.subscribe(viewer.id, id, title, e.tags);
      result.added++;
    }
    this.log?.info({ added: result.added, skipped: result.skipped.length }, "OPML imported");
    return result;
  }

  async exportOpml(viewer: Viewer): Promise<string> {
    // Followed threads and boards aren't feeds other readers could use.
    const sources = (await this.listSources(viewer)).filter((s) => s.kind !== "thread" && s.kind !== "board");
    return buildOpml(
      sources.map((s) => ({ title: s.title, feedUrl: s.feedUrl, siteUrl: s.siteUrl, tags: s.tags })),
      this.now(),
    );
  }

  /** Works out the feed URL for whatever the user pasted, fetching as little as possible. */
  private async resolve(raw: string, via = false): Promise<ResolvedSource> {
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
      let read;
      try {
        read = await this.readYouTube(feedUrl, null, true);
      } catch (err) {
        if (err instanceof FetchError || err instanceof YouTubeApiError) {
          const reason = err instanceof FetchError ? friendlyFetchError(err, feedUrl, false) : err.message;
          const hint = isYouTubeHiccup(err) && !(await this.youtube?.apiKey()) ? ` ${YOUTUBE_FEED_DOWN}` : " YouTube's feeds are sometimes briefly unavailable, so try again in a few minutes.";
          throw new SourceError("youtube_feed_failed", `Found the channel, but YouTube didn't return its video feed (${reason}).${hint} Feed address: ${feedUrl}`, 422);
        }
        if (err instanceof FeedParseError) throw new SourceError("not_a_feed", `That address isn't a readable feed: ${err.message}`, 422);
        throw err;
      }
      if (read.kind !== "ok") throw new SourceError("unexpected", "The site answered without content.");
      return { kind: "youtube", feedUrl, siteUrl, parsed: read.parsed };
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
    // A vBulletin board (D-123): its threads with their newest replies, read from the page. Its
    // feed lists only threads started lately, never older ones with new replies.
    if (looksLikeVbulletinBoard(res.body)) {
      const board = await this.readBoard(res.url, via, true, res);
      return { kind: "board", feedUrl: res.url, siteUrl: res.url, parsed: { format: "rss", title: board.title, siteUrl: res.url, items: [] }, board: board.threads };
    }
    const feeds = discoverFeeds(res.body, res.url);
    const first = preferredFeed(feeds);
    if (!first) {
      throw new SourceError(
        "no_feed",
        "No RSS or Atom feed found at this address. If the site has one, paste the feed's own address (often ending in /feed, /rss or .xml).",
      );
    }
    const section = await this.wordpressSectionFeed(new URL(res.url), res.body, feeds.map((f) => f.url), via);
    if (section) return section;
    const feedRes = await this.fetchInteractive(first.url, "feed", via);
    return { kind: "feed", feedUrl: first.url, siteUrl: res.url, parsed: this.parse(feedRes.body, first.url) };
  }

  /**
   * A section of a WordPress site (D-103), e.g. science.nasa.gov/earth/: the page advertises only
   * the whole site's feed, but WordPress serves the section's own at …/earth/feed/,
   * /category/earth/feed/ or /tag/earth/feed/. Tried in that order (at most three requests, only
   * when adding); the first with items wins. null to use the advertised feed.
   */
  private async wordpressSectionFeed(page: URL, html: string, advertised: string[], via: boolean): Promise<ResolvedSource | null> {
    const segments = page.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    if (!last || !/wp-content\/|wp-json|content="WordPress/i.test(html.slice(0, 500_000))) return null;
    const path = `/${segments.join("/")}/`;
    // A feed advertised for this section already (its address is under the page's) is used as is.
    if (advertised.some((f) => new URL(f).pathname.startsWith(path))) return null;
    const candidates = [...new Set([`${path}feed/`, `/category/${last}/feed/`, `/tag/${last}/feed/`])].map((p) => new URL(p, page.origin).href);
    for (const feedUrl of candidates) {
      try {
        const res = await this.fetchInteractive(feedUrl, "feed", via);
        if (!looksLikeFeed(res.body)) continue;
        const parsed = this.parse(res.body, feedUrl);
        // WordPress answers …/<page>/feed/ with the page's comments ("Comments on: Earth"): not articles.
        if (/^comments (on|for)\b/i.test(parsed.title ?? "")) continue;
        if (parsed.items.length) return { kind: "feed", feedUrl, siteUrl: page.href, parsed };
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
      }
    }
    return null;
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

  /**
   * A YouTube channel's videos (D-105): its feed, tried up to three times, since YouTube's feed
   * answers 404/500 at random lately; then, with the user's API key, the channel's uploads through
   * the Data API (1 quota unit). Throws the feed's error when there's no key.
   */
  private async readYouTube(
    feedUrl: string,
    cached: { etag: string | null; lastModified: string | null } | null,
    interactive: boolean,
  ): Promise<{ kind: "not_modified" } | { kind: "ok"; parsed: ParsedFeed; etag: string | null; lastModified: string | null; via: "feed" | "api" }> {
    let lastError: FetchError | null = null;
    for (let attempt = 0; attempt < YOUTUBE_FEED_TRIES; attempt++) {
      if (attempt || interactive) await this.limiter.wait(feedUrl, interactive ? INTERACTIVE : undefined);
      try {
        const res = await this.fetcher(feedUrl, { expect: "feed", etag: cached?.etag, lastModified: cached?.lastModified });
        if (res.kind === "not_modified") return res;
        return { kind: "ok", parsed: parseFeed(res.body, feedUrl), etag: res.etag, lastModified: res.lastModified, via: "feed" };
      } catch (err) {
        if (!isYouTubeHiccup(err)) throw err;
        lastError = err;
      }
    }
    const channelId = new URL(feedUrl).searchParams.get("channel_id");
    const key = channelId ? await this.youtube?.apiKey() : null;
    if (!key || !channelId || !this.youtube) throw lastError!;
    const parsed = await latestUploads(this.youtube.fetchJson, key, channelId);
    this.log?.info({ feedUrl, videos: parsed.items.length }, "YouTube feed not answering; read the channel through the API");
    return { kind: "ok", parsed, etag: null, lastModified: null, via: "api" };
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
    if (row.kind === "board") return this.checkBoard(row);

    await this.limiter.wait(row.feed_url);
    const startedAt = this.now();
    if (row.kind === "youtube") return this.checkYouTube(row, startedAt);
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

  /** A YouTube channel's check (D-105): feed with retries, else the API; YouTube's hiccups never pause it. */
  private async checkYouTube(row: SourceRow, startedAt: number): Promise<CheckResult> {
    try {
      const read = await this.readYouTube(row.feed_url, { etag: row.etag, lastModified: row.last_modified }, false);
      if (read.kind === "not_modified") {
        await this.recordSuccess(row.id, startedAt, row.etag, row.last_modified, row);
        return { ok: true, newItems: 0, notModified: true };
      }
      const newItems = await this.ingest(row.id, read.parsed, row.last_success_at === null);
      // Through the API there are no validators: the next check reads the feed afresh.
      await this.recordSuccess(row.id, startedAt, read.via === "feed" ? read.etag : null, read.via === "feed" ? read.lastModified : null, row);
      if (newItems) this.log?.info({ sourceId: row.id, newItems, via: read.via }, "new items");
      return { ok: true, newItems };
    } catch (err) {
      const hiccup = isYouTubeHiccup(err);
      const message =
        hiccup && !(await this.youtube?.apiKey()) ? `${YOUTUBE_FEED_DOWN} [HTTP ${err.status}]`
        : err instanceof YouTubeApiError ? `YouTube's feed isn't answering, and reading the channel through the API failed: ${err.message}`
        : err instanceof FetchError ? friendlyFetchError(err, row.feed_url, false)
        : err instanceof FeedParseError ? `The feed couldn't be read: ${err.message}`
        : "Unexpected error while checking this source";
      if (!(err instanceof FetchError || err instanceof FeedParseError || err instanceof YouTubeApiError)) this.log?.warn({ err, sourceId: row.id }, "check failed");
      await this.recordFailure(row, startedAt, message, err instanceof FetchError ? err : undefined, !hiccup && !(err instanceof YouTubeApiError));
      return { ok: false, newItems: 0, error: message };
    }
  }

  private intervalMinutes(row: Pick<SourceRow, "poll_interval_minutes" | "kind">): number {
    return row.poll_interval_minutes ?? (row.kind === "thread" ? this.polling.threadIntervalMinutes : this.polling.intervalMinutes);
  }

  private async recordSuccess(id: string, at: number, etag: string | null, lastModified: string | null, row: Pick<SourceRow, "poll_interval_minutes" | "kind">) {
    const next = nextCheck({ now: at, intervalMinutes: this.intervalMinutes(row), failures: 0, polling: this.polling });
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

  /** `pausable` false: failures back off as usual but never pause the source (YouTube's hiccups, D-105). */
  private async recordFailure(row: SourceRow, at: number, message: string, err?: FetchError, pausable = true) {
    const failures = row.consecutive_failures + 1;
    const next = nextCheck({
      now: at,
      intervalMinutes: this.intervalMinutes(row),
      failures,
      polling: pausable ? this.polling : { ...this.polling, circuitBreakerFailures: Number.POSITIVE_INFINITY },
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
          audio_url: it.audio?.url ?? null,
          audio_duration: it.audio?.durationSeconds ?? null,
          published_at: published,
          fetched_at: now,
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
      // Each follower's row for each new item (D-115); on a first fetch, ones over a week old start out read.
      const followers = fresh.size ? (await this.db.kysely.selectFrom("subscriptions").select("user_id").where("source_id", "=", sourceId).execute()).map((r) => r.user_id) : [];
      const added = chunk.filter((c) => fresh.has(c.row.id));
      if (followers.length && added.length) {
        await this.db.kysely
          .insertInto("item_states")
          .values(
            followers.flatMap((user_id) =>
              added.map((c) => {
                const old = firstFetch && c.row.published_at < now - FIRST_FETCH_UNREAD_WINDOW_MS;
                return { user_id, item_id: c.row.id, source_id: sourceId, read: old ? 1 : 0, saved: 0, read_at: old ? now : null };
              }),
            ),
          )
          .onConflict((oc) => oc.columns(["user_id", "item_id"]).doNothing())
          .execute();
      }
      const contents = chunk
        .filter((c) => c.content && fresh.has(c.row.id))
        .map((c) => ({ item_id: c.row.id, origin: "feed" as const, status: "raw" as const, html: c.content, error: null, fetched_at: now }));
      if (contents.length) await this.db.kysely.insertInto("item_content").values(contents).execute();
      await this.backfillContent(sourceId, source?.kind, chunk.filter((c) => c.content && !fresh.has(c.row.id)), now);
      // Episodes stored before audio was kept (D-093) get their player when the feed shows them again.
      const withAudio = new Map(chunk.filter((c) => !fresh.has(c.row.id) && c.row.audio_url).map((c) => [c.row.guid, c.row]));
      if (withAudio.size) {
        const missing = await this.db.kysely
          .selectFrom("items")
          .select(["id", "guid"])
          .where("source_id", "=", sourceId)
          .where("guid", "in", [...withAudio.keys()])
          .where("audio_url", "is", null)
          .execute();
        for (const m of missing) {
          const row = withAudio.get(m.guid)!;
          await this.db.kysely.updateTable("items").set({ audio_url: row.audio_url, audio_duration: row.audio_duration }).where("id", "=", m.id).execute();
        }
      }
    }
    return inserted;
  }

  /**
   * Items stored before feed bodies were kept at any length (v1.0.0 kept only 500+ characters)
   * get their body when the feed shows them again (D-076). Reddit bodies are also re-stored raw
   * where an older version cached its cleaned copy, so the current Reddit layout applies.
   * Bodies stored before v1.4.1 with &#34; left in their tags are replaced too (D-091).
   */
  private async backfillContent(sourceId: string, kind: SourceKind | undefined, known: Array<{ content: string | null; row: { guid: string } }>, now: number) {
    if (!known.length) return;
    const rows = await this.db.kysely
      .selectFrom("items")
      .leftJoin("item_content", "item_content.item_id", "items.id")
      .select(["items.id", "items.guid", "item_content.status", "item_content.origin", "item_content.html"])
      .where("items.source_id", "=", sourceId)
      .where("items.guid", "in", known.map((c) => c.row.guid))
      .execute();
    const bodies = new Map(known.map((c) => [c.row.guid, c.content!]));
    for (const r of rows) {
      const missing = r.status === null;
      const staleReddit = kind === "reddit" && r.origin === "feed" && r.status !== "raw";
      const misdecoded = r.origin === "feed" && r.status !== "failed" && MISDECODED.test(r.html ?? "");
      const html = bodies.get(r.guid);
      if (!html || !(missing || staleReddit || misdecoded) || (misdecoded && MISDECODED.test(html))) continue;
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
        .where("published_at", "<", cutoff)
        // Kept while anyone has it saved.
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom("item_states").select("item_states.item_id").whereRef("item_states.item_id", "=", "items.id").where("item_states.saved", "=", 1))))
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
          await trx.deleteFrom("item_states").where("item_id", "in", batch.map((d) => d.id)).execute();
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

  /** The viewer's sources: only those they follow, with their own names, tags and counts. */
  async listSources(viewer: Viewer): Promise<Source[]> {
    return this.sourcesFor(viewer);
  }

  /** undefined if the viewer doesn't follow it. */
  async getSource(viewer: Viewer, id: string): Promise<Source | undefined> {
    return (await this.sourcesFor(viewer, id))[0];
  }

  /** Whether the viewer follows the source: every source route checks this first. */
  async follows(viewer: Viewer, sourceId: string): Promise<boolean> {
    return !!(await this.subscription(viewer.id, sourceId));
  }

  private async sourcesFor(viewer: Viewer, onlyId?: string): Promise<Source[]> {
    let q = this.db.kysely
      .selectFrom("subscriptions as s")
      .innerJoin("sources", "sources.id", "s.source_id")
      .selectAll("sources")
      .select(["s.title as sub_title", "s.enabled as sub_enabled", "s.created_at as sub_created_at"])
      .where("s.user_id", "=", viewer.id);
    if (onlyId) q = q.where("sources.id", "=", onlyId);
    const rows = (await q.execute()).sort((a, b) => a.sub_title.localeCompare(b.sub_title));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [counts, tags, followers] = await Promise.all([
      this.counts(viewer.id, onlyId),
      this.tagsBySource(viewer.id, onlyId),
      this.db.kysely
        .selectFrom("subscriptions")
        .select((eb) => ["source_id", eb.fn.countAll<number>().as("n")])
        .where("source_id", "in", ids)
        .groupBy("source_id")
        .execute(),
    ]);
    const shared = new Map(followers.map((f) => [f.source_id, Number(f.n) > 1]));
    return rows.map((r) =>
      this.toSource(
        { ...r, title: r.sub_title, created_at: r.sub_created_at },
        r.sub_enabled === 1,
        viewer.role === "admin" || !shared.get(r.id),
        counts.get(r.id),
        tags.get(r.id),
      ),
    );
  }

  async updateSource(viewer: Viewer, id: string, patch: UpdateSourceRequest): Promise<Source> {
    const row = await this.db.kysely.selectFrom("sources").selectAll().where("id", "=", id).executeTakeFirst();
    const sub = row && (await this.subscription(viewer.id, id));
    if (!row || !sub) throw new SourceError("not_found", "Source not found", 404);
    const sole = (await this.followerCount(id)) === 1;
    const via = patch.viaFlareSolverr ?? row.via_flaresolverr === 1;

    // A new address is checked before anything is saved; existing items are kept.
    let moved: Awaited<ReturnType<FeedService["resolve"]>> | undefined;
    if (patch.url !== undefined && patch.url !== row.feed_url && patch.url !== row.site_url) {
      if (row.kind === "thread" || threadFromInput(patch.url)) {
        throw new SourceError("thread_address", "A followed thread keeps its address. To follow another thread, add it as a new source.", 400, { url: "Add the other thread as a new source" });
      }
      if (row.kind === "board") {
        throw new SourceError("board_address", "A followed board keeps its address. To follow another board, add it as a new source.", 400, { url: "Add the other board as a new source" });
      }
      try {
        moved = await this.resolve(patch.url, via);
      } catch (err) {
        if (err instanceof SourceError) this.log?.warn({ input: patch.url, code: err.code, reason: err.message }, "could not change source address");
        throw err;
      }
      // A feed's cards can't turn into a board's (D-123): one card per thread works differently.
      if (moved.kind === "board") {
        throw new SourceError("board_address", "That address is a forum board. To follow its threads, add it as a new source.", 400, { url: "Add the board as a new source" });
      }
      if (moved.feedUrl !== row.feed_url) {
        const clash = await this.db.kysely.selectFrom("sources").select(["id"]).where("feed_url", "=", moved.feedUrl).where("id", "!=", id).executeTakeFirst();
        const clashMine = clash && (await this.subscription(viewer.id, clash.id));
        if (clashMine) throw new SourceError("duplicate", `That feed is already followed as “${clashMine.title}”.`, 409);
        if (clash || !sole) {
          // The new address is another source, or others still follow this one: the viewer moves
          // to the new feed and the others keep the old one (D-115). The rest of the edit applies
          // to the viewer's new source.
          const tags = patch.tags ?? (await this.tagsBySource(viewer.id, id)).get(id) ?? [];
          const newId = await this.followResolved(viewer, moved, via, patch.title ?? sub.title, tags);
          await this.removeSource(viewer, id);
          const { url: _url, title: _title, tags: _tags, ...rest } = patch;
          try {
            return await this.updateSource(viewer, newId, rest);
          } catch (err) {
            // Moved to a feed others follow: its shared settings stay as they are.
            if (err instanceof SourceError && err.code === "shared_source") {
              return this.updateSource(viewer, newId, { enabled: rest.enabled, articleSelector: undefined, removeSelector: undefined });
            }
            throw err;
          }
        }
      }
    }

    const set: Partial<SourceRow> = { updated_at: this.now() };
    if (patch.pollIntervalMinutes !== undefined && patch.pollIntervalMinutes !== row.poll_interval_minutes) set.poll_interval_minutes = patch.pollIntervalMinutes;
    if (patch.retentionDays !== undefined && patch.retentionDays !== row.retention_days) set.retention_days = patch.retentionDays;
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
    if (moved && moved.feedUrl !== row.feed_url) {
      set.feed_url = moved.feedUrl;
      set.site_url = moved.siteUrl;
      set.kind = moved.kind;
      set.etag = null;
      set.last_modified = null;
    }
    // How it's checked and read is shared by its followers (D-115).
    if (Object.keys(set).length > 1 && !sole && viewer.role !== "admin") throw new SourceError("shared_source", SHARED_SETTINGS, 403);

    // The viewer's own: their name for it, tags, and whether they want it checked.
    const own: { title?: string; enabled?: number; updated_at: number } = { updated_at: this.now() };
    if (patch.title !== undefined) own.title = patch.title;
    if (patch.enabled !== undefined) own.enabled = patch.enabled ? 1 : 0;
    await this.db.kysely.updateTable("subscriptions").set(own).where("user_id", "=", viewer.id).where("source_id", "=", id).execute();
    if (patch.enabled === true) {
      // Resume (also after the circuit breaker paused it): check again right away.
      set.enabled = 1;
      set.status = "pending";
      set.consecutive_failures = 0;
      set.next_check_at = this.now();
      set.last_error = null;
    }
    await this.db.kysely.updateTable("sources").set(set).where("id", "=", id).execute();
    if (patch.enabled === false) await this.syncEnabled(id);
    if (patch.tags !== undefined) await this.setTags(viewer.id, id, patch.tags);
    if (moved && set.feed_url) {
      await this.ingest(id, moved.parsed, true);
      await this.recordSuccess(id, this.now(), null, null, { ...row, ...set } as SourceRow);
    }
    if (set.retention_days !== undefined) await this.applyRetention(id);
    // Articles already read from the page used the old selectors: read them again next time.
    if (selectorsChanged) {
      await this.db.kysely
        .deleteFrom("item_content")
        .where("origin", "=", "page")
        .where("item_id", "in", (eb) => eb.selectFrom("items").select("items.id").where("items.source_id", "=", id))
        .execute();
    }
    return (await this.getSource(viewer, id))!;
  }

  private async setTags(userId: string, sourceId: string, tags: string[]): Promise<void> {
    await this.db.kysely.transaction().execute(async (trx) => {
      await trx.deleteFrom("subscription_tags").where("user_id", "=", userId).where("source_id", "=", sourceId).execute();
      if (tags.length) await trx.insertInto("subscription_tags").values(tags.map((tag) => ({ user_id: userId, source_id: sourceId, tag }))).execute();
    });
  }

  private async tagsBySource(userId: string, onlyId?: string): Promise<Map<string, string[]>> {
    let q = this.db.kysely.selectFrom("subscription_tags").select(["source_id", "tag"]).where("user_id", "=", userId).orderBy("tag");
    if (onlyId) q = q.where("source_id", "=", onlyId);
    const map = new Map<string, string[]>();
    for (const r of await q.execute()) map.set(r.source_id, [...(map.get(r.source_id) ?? []), r.tag]);
    return map;
  }

  /** The viewer's tags, with how many of their sources use each and how many unread items they cover. */
  async listTags(viewer: Viewer): Promise<TagCount[]> {
    const rows = await this.db.kysely
      .selectFrom("subscription_tags as t")
      .leftJoin("item_states as st", (j) => j.onRef("st.user_id", "=", "t.user_id").onRef("st.source_id", "=", "t.source_id").on("st.read", "=", 0))
      .select((eb) => ["t.tag", eb.fn.count<number>("t.source_id").distinct().as("sources"), eb.fn.count<number>("st.item_id").as("unread")])
      .where("t.user_id", "=", viewer.id)
      .groupBy("t.tag")
      .orderBy("t.tag")
      .execute();
    return rows.map((r) => ({ tag: r.tag, sources: Number(r.sources), unread: Number(r.unread) }));
  }

  /**
   * Stops the viewer following a source; their read/saved marks and tags for it go too. The
   * source itself, with its items, is removed once nobody follows it (D-115).
   */
  async removeSource(viewer: Viewer, id: string): Promise<boolean> {
    if (!(await this.subscription(viewer.id, id))) return false;
    await this.db.kysely.deleteFrom("item_states").where("user_id", "=", viewer.id).where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("subscription_tags").where("user_id", "=", viewer.id).where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("subscriptions").where("user_id", "=", viewer.id).where("source_id", "=", id).execute();
    if ((await this.followerCount(id)) > 0) {
      await this.syncEnabled(id);
      return true;
    }
    await this.deleteSource(id);
    return true;
  }

  /** Removes sources nobody follows any more (after an account is deleted). */
  async removeUnfollowed(): Promise<number> {
    const orphans = await this.db.kysely
      .selectFrom("sources")
      .select("id")
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom("subscriptions").select("subscriptions.source_id").whereRef("subscriptions.source_id", "=", "sources.id"))))
      .execute();
    for (const o of orphans) await this.deleteSource(o.id);
    return orphans.length;
  }

  /** After an account is deleted: sources it alone had on stop being checked. */
  async resyncEnabled(): Promise<void> {
    for (const r of await this.db.kysely.selectFrom("sources").select("id").execute()) await this.syncEnabled(r.id);
  }

  private async deleteSource(id: string): Promise<void> {
    // Everything goes with it (ON DELETE CASCADE, plus explicitly in case FKs aren't enforced).
    await this.db.kysely
      .deleteFrom("item_content")
      .where("item_id", "in", (eb) => eb.selectFrom("items").select("id").where("source_id", "=", id))
      .execute();
    await this.db.kysely.deleteFrom("item_states").where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("items").where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("subscription_tags").where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("subscriptions").where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("item_tombstones").where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("thread_posts").where("source_id", "=", id).execute();
    await this.db.kysely.deleteFrom("sources").where("id", "=", id).execute();
  }

  /**
   * Per source the viewer follows: items, and how many are unread for them, from the viewer's
   * item_states rows alone (an index-only scan of item_states(user_id, source_id, read)).
   */
  private async counts(userId: string, onlyId?: string): Promise<Map<string, { total: number; unread: number }>> {
    let q = this.db.kysely
      .selectFrom("item_states")
      .select((eb) => ["source_id", eb.fn.countAll<number>().as("total"), eb.fn.sum<number>(eb.case().when("read", "=", 0).then(1).else(0).end()).as("unread")])
      .where("user_id", "=", userId)
      .groupBy("source_id");
    if (onlyId) q = q.where("source_id", "=", onlyId);
    const rows = await q.execute();
    return new Map(rows.map((r) => [r.source_id, { total: Number(r.total), unread: Number(r.unread ?? 0) }]));
  }

  private toSource(r: SourceRow, enabled: boolean, canEditShared: boolean, c?: { total: number; unread: number }, tags: string[] = []): Source {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      siteUrl: r.site_url,
      feedUrl: r.feed_url,
      enabled,
      status: enabled && r.enabled === 1 ? r.status : "paused",
      lastError: r.last_error,
      lastCheckedAt: r.last_checked_at,
      lastSuccessAt: r.last_success_at,
      nextCheckAt: r.next_check_at,
      pollIntervalMinutes: r.poll_interval_minutes,
      retentionDays: r.retention_days,
      articleSelector: r.article_selector,
      removeSelector: r.remove_selector,
      viaFlareSolverr: r.via_flaresolverr === 1,
      canEditShared,
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
  const url = pastedUrl(raw);
  return url ? threadAddress(url) : null;
}

/** A vBulletin-style thread link in what the user pasted (D-120), as the thread's first page. */
function vbulletinThreadFromInput(raw: string): string | null {
  const url = pastedUrl(raw);
  return url ? vbulletinThreadAddress(url) : null;
}

function pastedUrl(raw: string): URL | null {
  let input = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `https://${input}`;
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
