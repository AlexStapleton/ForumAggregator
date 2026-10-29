import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

export class OutboundBlocked extends Error {
  constructor(message = "This destination is not public. Ask the administrator to allow its exact origin in FA_ALLOWED_INTERNAL_ORIGINS.") {
    super(message);
  }
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const resolve: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });
const hostnameOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

/** Reject ambiguous schemes and credentials before making any request, including admin services. */
export function webUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new OutboundBlocked("Invalid outbound URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hostname.includes("*")) {
    throw new OutboundBlocked("Only HTTP/HTTPS URLs without embedded credentials are allowed");
  }
  return url;
}

export function publicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  // Mapped IPv4, NAT64, 6to4, Teredo and other special ranges fail closed too.
  if (parsed.range() !== "unicast") return false;
  // Only currently allocated global IPv6 unicast, not future/reserved address space.
  return parsed.kind() === "ipv4" || parsed.match(ipaddr.parse("2000::"), 3);
}

/** One policy shared by feeds, discovered URLs, articles, JSON APIs and redirects. */
export class OutboundPolicy {
  private readonly allowed: Set<string>;

  constructor(origins: string[] = [], private readonly resolver: Resolver = resolve) {
    this.allowed = new Set(origins.map((input) => {
      const url = webUrl(input);
      if (url.pathname !== "/" || url.search || url.hash) throw new Error("FA_ALLOWED_INTERNAL_ORIGINS must contain exact HTTP/HTTPS origins, without paths, queries or fragments");
      return url.origin;
    }));
  }

  private url(input: string): URL {
    const url = webUrl(input);
    const host = hostnameOf(url);
    if (isIP(host) && !this.allowed.has(url.origin) && !publicAddress(host)) throw new OutboundBlocked();
    return url;
  }

  private async addresses(url: URL) {
    const host = hostnameOf(url);
    const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await this.resolver(host);
    if (!records.length || records.some((r) => !isIP(r.address) || (!this.allowed.has(url.origin) && !publicAddress(r.address)))) {
      throw new OutboundBlocked();
    }
    return records;
  }

  /** Preflight only; remote browsers additionally require network-level isolation. */
  async check(input: string): Promise<void> {
    await this.addresses(this.url(input));
  }

  /** Resolve and validate inside the socket lookup; never resolve again after validation. */
  connectionLookup(input: string): LookupFunction {
    const url = this.url(input);
    return (_host, options, callback) => {
      void this.addresses(url).then((records) => {
        if (options.all) callback(null, records);
        else callback(null, records[0]!.address, records[0]!.family);
      }, (error: Error) => callback(error, "", 4));
    };
  }

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
      throw new OutboundBlocked("Content fetching only supports GET and HEAD");
    }
    let url = this.url(input);
    const headers = new Headers(init.headers);
    const signal = init.signal ?? AbortSignal.timeout(20_000);
    for (let hop = 0; hop <= 5; hop++) {
      signal.throwIfAborted();
      // A new dispatcher for each hop prevents connections crossing policy boundaries.
      const dispatcher = new Agent({ connect: { lookup: this.connectionLookup(url.href) } });
      let response: Response;
      try {
        const options = { ...init, headers, signal, redirect: "manual" as const, dispatcher };
        response = await fetch(url, options);
      } catch (error) {
        // Native fetch wraps lookup failures in TypeError.cause.
        const cause = (error as { cause?: unknown }).cause;
        if (cause instanceof OutboundBlocked) throw cause;
        throw error;
      } finally {
        // Graceful close waits for the response body; it does not truncate streaming reads.
        void dispatcher.close().catch(() => undefined);
      }
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has("location")) return response;
      await response.body?.cancel();
      if (hop === 5) throw new OutboundBlocked("Too many redirects (maximum 5)");
      const next = this.url(new URL(response.headers.get("location")!, url).href);
      if (next.origin !== url.origin) {
        headers.delete("cookie");
        headers.delete("authorization");
        headers.delete("if-none-match");
        headers.delete("if-modified-since");
      }
      url = next;
    }
    throw new Error("Unreachable redirect state");
  }
}

export const publicOutbound = new OutboundPolicy();
