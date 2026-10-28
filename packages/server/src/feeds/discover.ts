// Finding the feed for a web page: <link rel="alternate" type="application/rss+xml" href="...">.
import { decodeHTML } from "entities";
import { safeHttpUrl } from "./text.js";

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1]!.toLowerCase()] = decodeHTML(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return out;
}

export interface DiscoveredFeed {
  url: string;
  title: string | null;
  type: "rss" | "atom";
}

/**
 * The feed to follow from those a page advertises: the first, except that a vBulletin board's own
 * feed (external.php?…&forumids=44) wins over the whole forum's (external.php?type=RSS2), which
 * vBulletin lists first on every board and thread page (D-121).
 */
export function preferredFeed(feeds: DiscoveredFeed[]): DiscoveredFeed | undefined {
  return feeds.find((f) => isVbulletinBoardFeed(f.url)) ?? feeds[0];
}

function isVbulletinBoardFeed(url: string): boolean {
  const u = new URL(url);
  return /\/external\.php$/i.test(u.pathname) && !!u.searchParams.get("forumids");
}

/** Feeds advertised by an HTML page, in page order. */
export function discoverFeeds(html: string, pageUrl: string): DiscoveredFeed[] {
  const head = html.slice(0, 500_000);
  const found: DiscoveredFeed[] = [];
  const seen = new Set<string>();
  const baseHref = /<base\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
  const base = (baseHref && safeHttpUrl(baseHref, pageUrl)) || pageUrl;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel ?? "").toLowerCase().split(/\s+/);
    const type = (a.type ?? "").toLowerCase();
    if (!rel.includes("alternate")) continue;
    const kind = type.includes("atom") ? "atom" : type.includes("rss") || type === "application/xml" || type === "text/xml" ? "rss" : null;
    if (!kind) continue;
    const url = safeHttpUrl(a.href, base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    found.push({ url, title: a.title ?? null, type: kind });
  }
  return found;
}
