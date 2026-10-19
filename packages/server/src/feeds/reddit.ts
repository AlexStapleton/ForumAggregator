// Reddit: subreddit and user pages have RSS at …/.rss on www.reddit.com.
// People paste www., old., new., np. or m. links; all map to the same feed.

const REDDIT_HOST = /(^|\.)reddit\.com$/i;

export function isRedditUrl(url: URL): boolean {
  return REDDIT_HOST.test(url.hostname) || /^redd\.it$/i.test(url.hostname);
}

export interface RedditPlan {
  feedUrl: string;
  siteUrl: string;
}

/** Maps a subreddit or user link to its RSS feed. Returns null for other Reddit pages. */
export function planReddit(url: URL): RedditPlan | null {
  if (!REDDIT_HOST.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  // Already a feed: keep it, but on www (old.reddit.com disallows all bots in robots.txt).
  if (url.pathname.endsWith(".rss")) {
    const feed = new URL(url.href);
    feed.hostname = "www.reddit.com";
    const site = new URL(feed.href);
    site.search = "";
    site.pathname = site.pathname.replace(/\/?\.rss$/, "/");
    return { feedUrl: feed.href, siteUrl: site.href };
  }
  const [kind, name] = parts;
  if (!name || !/^[A-Za-z0-9_-]{2,50}$/.test(name)) return null;
  if (kind === "r") {
    return { feedUrl: `https://www.reddit.com/r/${name}/.rss`, siteUrl: `https://www.reddit.com/r/${name}/` };
  }
  if (kind === "user" || kind === "u") {
    return { feedUrl: `https://www.reddit.com/user/${name}/.rss`, siteUrl: `https://www.reddit.com/user/${name}/` };
  }
  return null;
}

// ---- cleaning Reddit's feed content ------------------------------------------------------
// Reddit appends "submitted by /u/name [link] [comments]" to every entry's content and summary.

const FOOTER_TEXT = /\s*submitted by\s+\/u\/[\w-]+(?:\s*\[link\])?(?:\s*\[comments\])?\s*$/i;

/** Summary without the "submitted by … [link] [comments]" tail. */
export function cleanRedditSummary(summary: string | null): string | null {
  if (!summary) return summary;
  const cleaned = summary.replace(FOOTER_TEXT, "").trim();
  return cleaned || null;
}

/**
 * Entry HTML without Reddit's footer. For link posts the "[link]" target is the article being
 * discussed, so it's kept as a "Linked: host" line. Run the result through sanitizeHtml.
 */
export function cleanRedditHtml(html: string): string {
  const at = html.lastIndexOf("submitted by");
  if (at < 0) return html;
  const footer = html.slice(at);
  const body = html.slice(0, at).replace(/(&#32;|\s)+$/, "");
  const link = /<a [^>]*href="([^"]+)"[^>]*>\s*\[link\]\s*<\/a>/i.exec(footer)?.[1];
  let external = "";
  if (link) {
    try {
      const u = new URL(link.replace(/&amp;/g, "&"));
      if (!/(^|\.)(reddit\.com|redd\.it)$/i.test(u.hostname)) {
        external = `<p class="reddit-link">Linked: <a href="${u.href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener noreferrer nofollow">${u.hostname}</a></p>`;
      }
    } catch {
      // not a URL; drop it
    }
  }
  return body + external;
}

/** The comments feed of a Reddit post permalink, or null if it isn't one. */
export function redditCommentsFeedUrl(postUrl: string | null): string | null {
  if (!postUrl) return null;
  try {
    const u = new URL(postUrl);
    if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return null;
    const m = /^\/r\/([A-Za-z0-9_]+)\/comments\/([a-z0-9]+)(?:\/([^/]*))?/i.exec(u.pathname);
    if (!m) return null;
    return `https://www.reddit.com/r/${m[1]}/comments/${m[2]}/${m[3] ? `${m[3]}/` : ""}.rss`;
  } catch {
    return null;
  }
}
