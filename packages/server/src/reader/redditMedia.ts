// Reddit video and gallery posts in the reader (D-117). The feed gives only the post's "[link]"
// (v.redd.it/<id> or reddit.com/gallery/<id>) and a preview picture. When such a post is opened,
// the post's details are asked for once (reddit.com/comments/<id>.json): the video's stream
// address and size, or every picture of the gallery. If Reddit doesn't answer, a video still
// gets its usual stream address, and a gallery its first picture (the preview points to it).
import type { RedditGalleryImage, RedditMedia, RedditMediaHint } from "@fa/shared";
import { redditPostKind, redditPostLink } from "../feeds/reddit.js";

/** Hosts Reddit serves media from; anything else in the post's details is ignored. */
const MEDIA_HOSTS = /^(v\.redd\.it|i\.redd\.it|preview\.redd\.it|external-preview\.redd\.it)$/i;

export interface RedditMediaPlan extends RedditMediaHint {
  /** The post's id (t3_<id>). */
  postId: string;
  /** Video: the v.redd.it id. */
  videoId: string | null;
  /** Gallery: the first picture, full size, from the preview's file name. */
  firstImage: string | null;
}

function mediaUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw.replace(/&amp;/g, "&"));
    return u.protocol === "https:" && MEDIA_HOSTS.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** What the reader needs to know about a Reddit post's media, from its feed body; null if it's neither a video nor a gallery. */
export function redditMediaPlan(rawHtml: string, postUrl: string | null, guid: string): RedditMediaPlan | null {
  const link = redditPostLink(rawHtml);
  const kind = redditPostKind(link);
  if (kind !== "video" && kind !== "gallery") return null;
  const postId = /^t3_([a-z0-9]+)$/i.exec(guid)?.[1] ?? (postUrl ? /\/comments\/([a-z0-9]+)/i.exec(postUrl)?.[1] : undefined);
  if (!postId) return null;
  // The thumbnail: the first picture in the entry, before "submitted by".
  const head = rawHtml.slice(0, Math.max(0, rawHtml.lastIndexOf("submitted by")) || rawHtml.length);
  const poster = mediaUrl(/<img [^>]*src="([^"]+)"/i.exec(head)?.[1]);
  const videoId = kind === "video" ? (/^https:\/\/v\.redd\.it\/([A-Za-z0-9]+)/.exec(link ?? "")?.[1] ?? null) : null;
  if (kind === "video" && !videoId) return null;
  // preview.redd.it/<name>.png?width=140… is a crop of i.redd.it/<name>.png.
  const first = poster ? /^https:\/\/preview\.redd\.it\/([A-Za-z0-9]+\.(?:jpe?g|png|gif|webp))/i.exec(poster) : null;
  return { kind, poster, postId, videoId, firstImage: first ? `https://i.redd.it/${first[1]}` : null };
}

/** The post's details: one request, comments left out. */
export function redditPostJsonUrl(postId: string): string {
  return `https://www.reddit.com/comments/${postId}.json?raw_json=1&limit=1&depth=1`;
}

/** What to show when Reddit didn't answer. */
export function fallbackMedia(plan: RedditMediaPlan, reason: string | null): RedditMedia {
  if (plan.kind === "video") {
    return {
      kind: "video",
      hlsUrl: `https://v.redd.it/${plan.videoId}/HLSPlaylist.m3u8`,
      mp4Url: null,
      poster: plan.poster,
      width: null,
      height: null,
      durationSeconds: null,
      fromPost: false,
      notice: null,
    };
  }
  const images: RedditGalleryImage[] = plan.firstImage ? [{ url: plan.firstImage, width: null, height: null, caption: null, mp4: null }] : [];
  return {
    kind: "gallery",
    images,
    complete: false,
    notice: `${reason ? `${reason} ` : ""}Showing the first picture; open the original for the rest of the gallery.`,
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** Reads the video or the gallery out of the post's details; null if they don't have it. */
export function parseRedditPost(body: unknown, plan: RedditMediaPlan): RedditMedia | null {
  const listing = Array.isArray(body) ? obj(body[0]) : null;
  const children = obj(listing?.data)?.children;
  let post = Array.isArray(children) ? obj(obj(children[0])?.data) : null;
  if (!post) return null;
  // A crosspost carries the original post's media.
  const parent = Array.isArray(post.crosspost_parent_list) ? obj(post.crosspost_parent_list[0]) : null;
  if (parent && !post.secure_media && !post.media_metadata) post = parent;

  if (plan.kind === "video") {
    const video =
      obj(obj(post.secure_media)?.reddit_video) ?? obj(obj(post.media)?.reddit_video) ?? obj(obj(post.preview)?.reddit_video_preview);
    const hlsUrl = mediaUrl(video?.hls_url);
    if (!video || !hlsUrl) return null;
    return {
      kind: "video",
      hlsUrl,
      mp4Url: mediaUrl(video.fallback_url),
      poster: plan.poster,
      width: num(video.width),
      height: num(video.height),
      durationSeconds: num(video.duration),
      fromPost: true,
      notice: null,
    };
  }

  const items = obj(post.gallery_data)?.items;
  const meta = obj(post.media_metadata);
  if (!Array.isArray(items) || !meta) return null;
  const images: RedditGalleryImage[] = [];
  for (const raw of items) {
    const item = obj(raw);
    const m = obj(meta[String(item?.media_id)]);
    if (!item || !m || m.status !== "valid") continue;
    const s = obj(m.s);
    const url = mediaUrl(s?.u) ?? mediaUrl(s?.gif);
    if (!url) continue;
    const caption = typeof item.caption === "string" && item.caption.trim() ? item.caption.trim().slice(0, 500) : null;
    images.push({ url, width: num(s?.x), height: num(s?.y), caption, mp4: m.e === "AnimatedImage" ? mediaUrl(s?.mp4) : null });
  }
  return images.length ? { kind: "gallery", images, complete: true, notice: null } : null;
}
