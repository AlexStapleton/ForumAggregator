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
