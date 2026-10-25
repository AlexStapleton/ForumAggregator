// YouTube top comments via the YouTube Data API v3, with the user's own (free) API key (D-075).
// YouTube has no comments feed, so this is the only supported way. Each call costs 1 unit of
// the key's 10,000-unit daily quota. The key goes in the query string, so URLs built here are
// never logged or put in error messages.
import type { ReaderComment } from "@fa/shared";
import type { JsonFetcher } from "../feeds/fetch.js";
import type { ParsedFeed } from "../feeds/parse.js";
import { htmlToText, safeHttpUrl, SUMMARY_MAX, TITLE_MAX, truncate } from "../feeds/text.js";
import { sanitizeHtml } from "./sanitize.js";

const API = "https://www.googleapis.com/youtube/v3";
/** "Me at the zoo", YouTube's first video: a stable, public ID for checking a key. */
const PROBE_VIDEO = "jNQXAC9IVRw";

export class YouTubeApiError extends Error {
  constructor(
    /** keyInvalid | commentsDisabled | quotaExceeded | apiDisabled | keyRestricted | notFound | other */
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

function errorFor(status: number, body: unknown): YouTubeApiError {
  const err = ((body as Json | null)?.error ?? {}) as Json;
  const reasons = [
    ...(((err.errors as Json[] | undefined) ?? []).map((e) => String(e.reason ?? ""))),
    ...(((err.details as Json[] | undefined) ?? []).map((d) => String(d.reason ?? ""))),
    String(err.status ?? ""),
  ];
  const has = (...r: string[]) => r.some((x) => reasons.includes(x));
  const text = String(err.message ?? "");
  if (has("keyInvalid", "API_KEY_INVALID") || /API key not valid/i.test(text)) return new YouTubeApiError("keyInvalid", "The YouTube API key isn't valid. Check it in Settings.");
  if (has("commentsDisabled")) return new YouTubeApiError("commentsDisabled", "Comments are turned off for this video.");
  if (has("quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded")) {
    return new YouTubeApiError("quotaExceeded", "The YouTube API key has used up today's quota. Comments come back after it resets (midnight Pacific time).");
  }
  if (has("accessNotConfigured", "SERVICE_DISABLED")) {
    return new YouTubeApiError("apiDisabled", "The YouTube Data API v3 isn't enabled for this key's Google Cloud project. Enable it in the Google Cloud console.");
  }
  if (has("ipRefererBlocked", "API_KEY_HTTP_REFERRER_BLOCKED", "API_KEY_IP_ADDRESS_BLOCKED", "API_KEY_SERVICE_BLOCKED", "forbidden")) {
    return new YouTubeApiError("keyRestricted", "The YouTube API key is restricted in a way that blocks this server (for example to websites or Android apps). Use no application restriction, or restrict it to this server's IP address.");
  }
  if (status === 404 || has("videoNotFound")) return new YouTubeApiError("notFound", "YouTube couldn't find this video.");
  return new YouTubeApiError("other", `YouTube answered with an error (HTTP ${status}).`);
}

/** Checks a key with one cheap request (1 quota unit). Throws YouTubeApiError if it can't be used. */
export async function checkApiKey(fetchJson: JsonFetcher, apiKey: string): Promise<void> {
  const res = await fetchJson(`${API}/videos?part=id&id=${PROBE_VIDEO}&key=${encodeURIComponent(apiKey)}`);
  if (res.status !== 200) throw errorFor(res.status, res.body);
}

/** The video's top comments ("relevance" order, as on YouTube), sanitised. */
export async function topComments(fetchJson: JsonFetcher, apiKey: string, videoId: string, max = 20): Promise<ReaderComment[]> {
  const url = `${API}/commentThreads?part=snippet&order=relevance&textFormat=html&maxResults=${max}&videoId=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetchJson(url);
  if (res.status !== 200) throw errorFor(res.status, res.body);
  const items = ((res.body as Json | null)?.items as Json[] | undefined) ?? [];
  const out: ReaderComment[] = [];
  for (const thread of items) {
    const top = ((thread.snippet as Json | undefined)?.topLevelComment ?? {}) as Json;
    const s = (top.snippet ?? {}) as Json;
    const html = sanitizeHtml(String(s.textDisplay ?? ""), "https://www.youtube.com/");
    if (!html) continue;
    const published = Date.parse(String(s.publishedAt ?? ""));
    const likes = Number(s.likeCount);
    out.push({
      author: typeof s.authorDisplayName === "string" ? s.authorDisplayName : null,
      html,
      publishedAt: Number.isFinite(published) ? published : null,
      url: typeof top.id === "string" ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(top.id)}` : null,
      likes: Number.isFinite(likes) ? likes : null,
    });
  }
  return out;
}

/**
 * A channel's latest uploads, shaped like its feed (D-105): used when YouTube's channel feed
 * doesn't answer. Its uploads playlist is the channel ID with "UU" for "UC"; one call, 1 unit.
 * Video IDs become the feed's own guids ("yt:video:…"), so nothing is stored twice.
 */
export async function latestUploads(fetchJson: JsonFetcher, apiKey: string, channelId: string, max = 15): Promise<ParsedFeed> {
  if (!/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) throw new YouTubeApiError("notFound", "That isn't a YouTube channel ID.");
  const playlist = `UU${channelId.slice(2)}`;
  const url = `${API}/playlistItems?part=snippet,contentDetails&maxResults=${max}&playlistId=${playlist}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetchJson(url);
  if (res.status === 404) throw new YouTubeApiError("notFound", "YouTube couldn't find this channel's uploads.");
  if (res.status !== 200) throw errorFor(res.status, res.body);
  const items = ((res.body as Json | null)?.items as Json[] | undefined) ?? [];
  let channelTitle: string | null = null;
  const out: ParsedFeed["items"] = [];
  for (const it of items) {
    const s = (it.snippet ?? {}) as Json;
    const c = (it.contentDetails ?? {}) as Json;
    const videoId = String(c.videoId ?? ((s.resourceId as Json | undefined)?.videoId ?? ""));
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) continue;
    // Private and deleted videos stay in the playlist without a picture or title.
    if (s.title === "Private video" || s.title === "Deleted video") continue;
    channelTitle ??= typeof s.videoOwnerChannelTitle === "string" ? s.videoOwnerChannelTitle : typeof s.channelTitle === "string" ? s.channelTitle : null;
    const thumbs = (s.thumbnails ?? {}) as Record<string, Json | undefined>;
    const thumb = thumbs.maxres ?? thumbs.high ?? thumbs.medium ?? thumbs.default;
    const published = Date.parse(String(c.videoPublishedAt ?? s.publishedAt ?? ""));
    const description = htmlToText(String(s.description ?? ""));
    out.push({
      guid: `yt:video:${videoId}`,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: truncate(String(s.title ?? "(untitled)"), TITLE_MAX),
      author: channelTitle,
      summary: description ? truncate(description, SUMMARY_MAX) : null,
      imageUrl: safeHttpUrl(thumb?.url) ?? `https://i1.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      audio: null,
      publishedAt: Number.isFinite(published) ? published : null,
      contentHtml: null,
    });
  }
  return { format: "atom", title: channelTitle, siteUrl: `https://www.youtube.com/channel/${channelId}`, items: out };
}
