// FlareSolverr (D-080): for sources the user chose to route through their own FlareSolverr
// instance, because the site sits behind a Cloudflare browser check the app can't pass itself.
//
// How a request goes:
//   1. A clearance for the host is known → plain request with its cookie and browser identity.
//      If Cloudflare asks again, the clearance is dropped.
//   2. Otherwise FlareSolverr opens the page in its browser. Its copy of the page is used when it
//      is what we wanted (an HTML page, or a feed we can recognise in the browser's view), and its
//      cookies are kept for later requests to that host.
//   3. If its copy isn't usable, one plain request with the new clearance.
// Some sites refuse the plain requests even with the clearance (Cloudflare can tell a program
// from a real Chrome). After one such refusal the host is fetched only through FlareSolverr for
// a while, instead of wasting a request on it each time (D-083).
// Only opted-in sources use this; the per-site spacing still applies (callers wait first).
import { FetchError, type FetchOptions, type FetchResult, type Fetcher, type JsonFetcher } from "./fetch.js";
import { classifyResponse } from "../sites/probe.js";

/** POST with a JSON body; returns the status and parsed JSON (even for errors). */
export type JsonPoster = (url: string, body: unknown, timeoutMs: number) => Promise<{ status: number; body: unknown }>;

export const httpPostJson: JsonPoster = async (url, body, timeoutMs) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new FetchError("timeout", "FlareSolverr took too long to answer");
    throw new FetchError("network", `Couldn't reach FlareSolverr (${e.cause?.code ?? e.name})`);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed };
};

interface Clearance {
  cookie: string;
  userAgent: string;
  expiresAt: number;
}

interface Solution {
  url: string;
  status: number;
  body: string;
  cookies: Array<{ name: string; value: string; domain?: string; expires?: number }>;
  userAgent: string;
}

/** FlareSolverr waits up to this long for a challenge to clear. */
const SOLVE_TIMEOUT_MS = 60_000;
/** Reuse a clearance for at most this long, even if its cookie says longer. */
const MAX_CLEARANCE_MS = 2 * 3_600_000;
const DEFAULT_CLEARANCE_MS = 30 * 60_000;
/** After plain requests with a clearance are refused, use only FlareSolverr's copies this long. */
const PLAIN_REFUSED_MS = 6 * 3_600_000;

type Json = Record<string, unknown>;

function cookieMatches(domain: string | undefined, host: string): boolean {
  if (!domain) return true;
  const d = domain.replace(/^\./, "").toLowerCase();
  return host === d || host.endsWith(`.${d}`);
}

/**
 * A feed inside the browser's copy of the page. Chrome shows XML in a viewer or as text in a
 * <pre>; either way the feed's own markup (or its escaped text) is in there.
 */
export function feedFromBrowserSource(source: string): string | null {
  for (const [open, close] of [
    ["<rss", "</rss>"],
    ["<feed", "</feed>"],
    ["<rdf:RDF", "</rdf:RDF>"],
  ] as const) {
    const start = source.indexOf(open);
    const end = source.lastIndexOf(close);
    if (start >= 0 && end > start) return `<?xml version="1.0" encoding="UTF-8"?>\n${source.slice(start, end + close.length)}`;
  }
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(source)?.[1];
  if (pre && /&lt;(rss|feed|rdf:RDF)\b/.test(pre)) {
    const text = pre.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    return feedFromBrowserSource(text);
  }
  return null;
}

export class FlareSolverr {
  private clearances = new Map<string, Clearance>();
  /** host → until when plain requests with a clearance aren't worth trying. */
  private plainRefused = new Map<string, number>();
  private solving = new Map<string, Promise<Solution>>();

  constructor(
    /** The instance's base URL from Settings, or null when not set up. */
    private readonly baseUrl: () => Promise<string | null>,
    private readonly post: JsonPoster,
    private readonly get: JsonFetcher,
    private readonly now: () => number = Date.now,
  ) {}

  async configured(): Promise<boolean> {
    return (await this.baseUrl()) !== null;
  }

  /** Checks an instance answers like FlareSolverr; returns its version. */
  async ping(base: string): Promise<string> {
    const res = await this.get(base.replace(/\/+$/, "") + "/");
    const body = (res.body ?? {}) as Json;
    if (res.status !== 200 || !/FlareSolverr/i.test(String(body.msg ?? ""))) {
      throw new FetchError("error", `That address answered, but not like FlareSolverr [HTTP ${res.status}]`);
    }
    return String(body.version ?? "unknown");
  }

  /** Has the browser open the page; one solve per host at a time. */
  private solve(url: string): Promise<Solution> {
    const host = new URL(url).host;
    const running = this.solving.get(host);
    if (running) return running;
    const p = this.doSolve(url).finally(() => this.solving.delete(host));
    this.solving.set(host, p);
    return p;
  }

  private async doSolve(url: string): Promise<Solution> {
    const base = await this.baseUrl();
    if (!base) throw new FetchError("error", "FlareSolverr isn't set up (Settings → FlareSolverr)");
    const res = await this.post(`${base.replace(/\/+$/, "")}/v1`, { cmd: "request.get", url, maxTimeout: SOLVE_TIMEOUT_MS }, SOLVE_TIMEOUT_MS + 15_000);
    const body = (res.body ?? {}) as Json;
    const solution = body.solution as Json | undefined;
    if (body.status !== "ok" || !solution) {
      const why = String(body.message ?? `HTTP ${res.status}`);
      throw new FetchError("cloudflare_challenge", `FlareSolverr couldn't get past the site's check either (${why})`);
    }
    const out: Solution = {
      url: String(solution.url ?? url),
      status: Number(solution.status ?? 0),
      body: String(solution.response ?? ""),
      cookies: Array.isArray(solution.cookies) ? (solution.cookies as Solution["cookies"]) : [],
      userAgent: String(solution.userAgent ?? ""),
    };
    const host = new URL(url).hostname.toLowerCase();
    const cookies = out.cookies.filter((c) => c && typeof c.name === "string" && cookieMatches(c.domain, host));
    if (cookies.length && out.userAgent) {
      const clearanceExpiry = cookies.find((c) => c.name === "cf_clearance")?.expires;
      const fromCookie = typeof clearanceExpiry === "number" && clearanceExpiry > 0 ? clearanceExpiry * 1000 : this.now() + DEFAULT_CLEARANCE_MS;
      this.clearances.set(new URL(url).host, {
        cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
        userAgent: out.userAgent,
        expiresAt: Math.min(fromCookie, this.now() + MAX_CLEARANCE_MS),
      });
    }
    return out;
  }

  private clearanceFor(url: string): Clearance | null {
    const host = new URL(url).host;
    const c = this.clearances.get(host);
    if (!c) return null;
    if (c.expiresAt <= this.now()) {
      this.clearances.delete(host);
      return null;
    }
    return c;
  }

  private whyUnusable(s: Solution, options: FetchOptions): string {
    if (s.status < 200 || s.status >= 300) return `the site answered HTTP ${s.status}`;
    if (classifyResponse({ status: s.status, headers: {}, body: s.body }) !== "ok") return "it still showed the site's check";
    return options.expect === "feed" ? "no feed found in it" : "it was empty";
  }

  /** The browser's copy of the page, if it is what the caller asked for. */
  private usable(s: Solution, options: FetchOptions): FetchResult | null {
    if (s.status < 200 || s.status >= 300) return null;
    if (classifyResponse({ status: s.status, headers: {}, body: s.body }) !== "ok") return null;
    const body = options.expect === "feed" ? feedFromBrowserSource(s.body) : s.body;
    if (!body) return null;
    return {
      kind: "ok",
      status: s.status,
      url: s.url,
      body,
      contentType: options.expect === "feed" ? "application/xml" : "text/html; charset=utf-8",
      etag: null,
      lastModified: null,
    };
  }

  private plainWorks(url: string): boolean {
    const host = new URL(url).host;
    const until = this.plainRefused.get(host);
    if (until === undefined) return true;
    if (until <= this.now()) {
      this.plainRefused.delete(host);
      return true;
    }
    return false;
  }

  /** Wraps a fetcher so its requests go through FlareSolverr's clearance (see the top of this file). */
  wrap(base: Fetcher): Fetcher {
    return async (url, options) => {
      const plain = this.plainWorks(url);
      const known = plain ? this.clearanceFor(url) : null;
      if (known) {
        try {
          return await base(url, { ...options, cookie: known.cookie, userAgent: known.userAgent });
        } catch (err) {
          if (!(err instanceof FetchError && err.isChallenge)) throw err;
          // Expired, or the site refuses plain requests: either way FlareSolverr only, for a while.
          this.clearances.delete(new URL(url).host);
          this.plainRefused.set(new URL(url).host, this.now() + PLAIN_REFUSED_MS);
        }
      }
      const solution = await this.solve(url);
      const direct = this.usable(solution, options);
      if (direct) return direct;
      if (!this.plainWorks(url)) throw new FetchError("cloudflare_challenge", `FlareSolverr's copy of the page wasn't usable (${this.whyUnusable(solution, options)})`);
      const fresh = this.clearanceFor(url);
      if (!fresh) throw new FetchError("cloudflare_challenge", "FlareSolverr opened the page but got no usable clearance for it");
      try {
        // Conditional headers don't apply: this is a fresh clearance.
        return await base(url, { ...options, etag: null, lastModified: null, cookie: fresh.cookie, userAgent: fresh.userAgent });
      } catch (err) {
        if (err instanceof FetchError && err.isChallenge) {
          this.clearances.delete(new URL(url).host);
          this.plainRefused.set(new URL(url).host, this.now() + PLAIN_REFUSED_MS);
          throw new FetchError(err.kind, "FlareSolverr got past the check, but the site still refused the app's follow-up request", err.status);
        }
        throw err;
      }
    };
  }
}
