// One HTTP GET, done politely: honest User-Agent, conditional request headers, a size cap,
// a timeout, and bot-check / block detection, so callers stop instead of retrying hard.
import { classifyResponse, KIND_HELP, type ResponseKind } from "../sites/probe.js";
import { USER_AGENT } from "../sites/userAgent.js";

export interface FetchOptions {
  etag?: string | null;
  lastModified?: string | null;
  /** What we expect back; only affects the Accept header. */
  expect: "feed" | "html";
  timeoutMs?: number;
  maxBytes?: number;
}

export type FetchResult =
  | {
      kind: "ok";
      status: number;
      /** Final URL after redirects. */
      url: string;
      body: string;
      contentType: string;
      etag: string | null;
      lastModified: string | null;
    }
  | { kind: "not_modified" };

export type FetchErrorKind = ResponseKind | "timeout" | "network" | "too_large";

export class FetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    message: string,
    readonly status?: number,
    /** From a Retry-After header, when the server sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** A bot check or block: the site doesn't want automated requests from us right now. */
  get isChallenge(): boolean {
    return this.kind === "cloudflare_challenge" || this.kind === "pow_challenge";
  }
}

export type Fetcher = (url: string, options: FetchOptions) => Promise<FetchResult>;

const ACCEPT = {
  feed: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
  html: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
};

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

function decode(bytes: Uint8Array, contentType: string): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
  const fromXml = /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  for (const label of [fromHeader, fromXml, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // unknown label; try the next one
    }
  }
  return new TextDecoder().decode(bytes);
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError("too_large", `Response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export const httpFetch: Fetcher = async (url, options) => {
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: ACCEPT[options.expect] };
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.lastModified) headers["if-modified-since"] = options.lastModified;

  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new FetchError("timeout", "The site took too long to answer");
    throw new FetchError("network", `Couldn't connect (${e.cause?.code ?? e.cause?.message ?? e.message})`);
  }
  if (res.status === 304) {
    await res.body?.cancel();
    return { kind: "not_modified" };
  }

  const contentType = res.headers.get("content-type") ?? "";
  const body = decode(await readCapped(res, options.maxBytes ?? 5 * 1024 * 1024), contentType);
  const flatHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (flatHeaders[k] = v));
  const kind = classifyResponse({ status: res.status, headers: flatHeaders, body });
  if (kind !== "ok") {
    throw new FetchError(kind, `${KIND_HELP[kind]} [HTTP ${res.status}]`, res.status, parseRetryAfter(res.headers.get("retry-after")));
  }
  return {
    kind: "ok",
    status: res.status,
    url: res.url || url,
    body,
    contentType,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
};

/**
 * Spaces out requests to the same host (DESIGN §7): at least `minDelayMs` plus random jitter
 * between two requests, across the scheduler and manual refreshes alike.
 */
/**
 * Sites that need more space than the default between requests, whatever triggered them.
 * Reddit allows unregistered clients only a few requests a minute.
 */
export const HOST_MIN_DELAY_MS: Record<string, number> = {
  "www.reddit.com": 10_000,
  "reddit.com": 10_000,
  "old.reddit.com": 10_000,
};

export class HostLimiter {
  private nextAllowed = new Map<string, number>();

  constructor(
    private readonly minDelayMs: number,
    private readonly jitterMs: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = Date.now,
    private readonly hostMinDelayMs: Record<string, number> = HOST_MIN_DELAY_MS,
  ) {}

  /**
   * Waits for this host's turn. `minDelayMs` can be lowered for interactive actions, but never
   * below a host's own minimum (HOST_MIN_DELAY_MS).
   */
  async wait(url: string, override?: { minDelayMs: number; jitterMs: number }): Promise<void> {
    const host = new URL(url).host;
    const delay = Math.max(override?.minDelayMs ?? this.minDelayMs, this.hostMinDelayMs[host] ?? 0);
    const jitter = override?.jitterMs ?? this.jitterMs;
    const now = this.now();
    const allowedAt = Math.max(now, this.nextAllowed.get(host) ?? 0);
    // Reserve the slot before sleeping, so concurrent callers queue up behind each other.
    this.nextAllowed.set(host, allowedAt + delay + Math.random() * jitter);
    if (allowedAt > now) await this.sleep(allowedAt - now);
  }
}
