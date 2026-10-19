// YouTube channels have public Atom feeds: no API key, no login.
//   https://www.youtube.com/feeds/videos.xml?channel_id=UC…    (channels)
//   https://www.youtube.com/feeds/videos.xml?playlist_id=PL…   (playlists)
// What people paste is usually a channel page (/@handle, /channel/UC…, /c/name, /user/name),
// so we map that to the feed, looking up the channel ID on the page when it isn't in the URL.

const FEED_BASE = "https://www.youtube.com/feeds/videos.xml";
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

export function isYouTubeUrl(url: URL): boolean {
  return /(^|\.)youtube\.com$/i.test(url.hostname) || /(^|\.)youtu\.be$/i.test(url.hostname);
}

/** Turns "@handle" or a bare channel ID ("UC…") into a URL; leaves anything else alone. */
export function normaliseYouTubeInput(input: string): string {
  const trimmed = input.trim();
  if (/^@[A-Za-z0-9._-]{3,30}$/.test(trimmed)) return `https://www.youtube.com/${trimmed}`;
  if (CHANNEL_ID.test(trimmed)) return `https://www.youtube.com/channel/${trimmed}`;
  return trimmed;
}

/** YouTube sends some visitors (e.g. in the EU) to a cookie-consent page first. */
export function isConsentPage(finalUrl: string): boolean {
  return /^https?:\/\/consent\.(youtube|google)\./i.test(finalUrl);
}

export type YouTubePlan =
  | { kind: "feed"; feedUrl: string; siteUrl: string }
  /** Needs the channel page fetched to find the ID (handles and custom URLs). */
  | { kind: "lookup"; pageUrl: string };

export function planYouTube(url: URL): YouTubePlan | null {
  if (!isYouTubeUrl(url)) return null;
  // Already a feed URL.
  if (url.pathname === "/feeds/videos.xml") {
    const id = url.searchParams.get("channel_id");
    return { kind: "feed", feedUrl: url.href, siteUrl: id ? `https://www.youtube.com/channel/${id}` : "https://www.youtube.com/" };
  }
  const playlist = url.searchParams.get("list");
  if (playlist && url.pathname === "/playlist") {
    return { kind: "feed", feedUrl: `${FEED_BASE}?playlist_id=${encodeURIComponent(playlist)}`, siteUrl: url.href };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "channel" && parts[1] && CHANNEL_ID.test(parts[1])) {
    return { kind: "feed", feedUrl: `${FEED_BASE}?channel_id=${parts[1]}`, siteUrl: `https://www.youtube.com/channel/${parts[1]}` };
  }
  if (parts[0] === "user" && parts[1]) {
    return { kind: "feed", feedUrl: `${FEED_BASE}?user=${encodeURIComponent(parts[1])}`, siteUrl: `https://www.youtube.com/user/${parts[1]}` };
  }
  if (parts[0]?.startsWith("@") || parts[0] === "c") {
    const path = parts[0] === "c" ? `/c/${parts[1] ?? ""}` : `/${parts[0]}`;
    return { kind: "lookup", pageUrl: `https://www.youtube.com${path}` };
  }
  return null;
}

/** Finds the channel ID on a channel page (canonical link first, then embedded metadata). */
export function channelIdFromPage(html: string): string | null {
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})["']/i,
    /<meta[^>]+itemprop=["'](?:identifier|channelId)["'][^>]+content=["'](UC[A-Za-z0-9_-]{22})["']/i,
    /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
    /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function channelFeedUrl(channelId: string): string {
  return `${FEED_BASE}?channel_id=${channelId}`;
}
