// Rich post content the sanitizer's allow-list would otherwise delete without a trace (D-139):
// embedded videos and posts (iframes), forum spoilers, and sprite smilies. Runs on a DOM before
// sanitizing; the result uses only allowed tags, so nothing here widens what reaches the page.
import { safeHttpUrl } from "../feeds/text.js";

/** Cheap test, so most HTML skips the extra parse in sanitizeHtml. */
export const RICH_CONTENT_HINT = /<(?:iframe|video|audio|embed|object)\b|data-s9e-mediaembed|data-media-site-id|bbCodeSpoiler|\bsmilie\b/i;

interface Embed { url: string; label: string; thumbnail?: string }

const YOUTUBE_ID = /^[\w-]{11}$/;

function youtube(id: string | null | undefined): Embed | null {
  const key = id?.slice(0, 11);
  return key && YOUTUBE_ID.test(key)
    ? { url: `https://www.youtube.com/watch?v=${key}`, label: "Video on YouTube", thumbnail: `https://i.ytimg.com/vi/${key}/hqdefault.jpg` }
    : null;
}

/** A site and its key, as XenForo (`data-media-site-id`/`-key`) and s9e (`#key`) give them. */
function fromSite(site: string, key: string): Embed | null {
  const k = key.trim();
  if (!k) return null;
  const enc = encodeURIComponent;
  switch (site.toLowerCase()) {
    case "youtube": return youtube(k);
    case "vimeo": return /^\d+/.test(k) ? { url: `https://vimeo.com/${/^\d+/.exec(k)![0]}`, label: "Video on Vimeo" } : null;
    case "twitter": case "x": return /^\d+$/.test(k) ? { url: `https://x.com/i/status/${k}`, label: "Post on X (Twitter)" } : null;
    case "instagram": return /^[\w-]+$/.test(k) ? { url: `https://www.instagram.com/p/${k}/`, label: "Post on Instagram" } : null;
    case "reddit": return /^r\/[\w/-]+$/.test(k) ? { url: `https://www.reddit.com/${k}`, label: "Post on Reddit" } : null;
    case "imgur": return /^[\w/-]+$/.test(k) ? { url: `https://imgur.com/${k}`, label: "Imgur" } : null;
    case "giphy": return /^[\w-]+$/.test(k) ? { url: `https://giphy.com/gifs/${enc(k)}`, label: "GIF on Giphy" } : null;
    case "dailymotion": return /^\w+$/.test(k) ? { url: `https://www.dailymotion.com/video/${k}`, label: "Video on Dailymotion" } : null;
    case "tiktok": return /^\d+$/.test(k) ? { url: `https://www.tiktok.com/embed/v2/${k}`, label: "Video on TikTok" } : null;
    default: return null;
  }
}

/** An embed from a player address alone (blogs, feeds, sites without a site ID). */
function fromAddress(raw: string | null, base: string): Embed | null {
  const src = safeHttpUrl(raw, base);
  if (!src) return null;
  const url = new URL(src);
  const host = url.hostname.replace(/^www\./, "");
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return youtube(/^\/(?:embed|shorts|v)\/([\w-]{11})/.exec(url.pathname)?.[1] ?? url.searchParams.get("v"));
  if (host === "youtu.be") return youtube(url.pathname.slice(1));
  if (host === "player.vimeo.com") return fromSite("vimeo", /^\/video\/(\d+)/.exec(url.pathname)?.[1] ?? "");
  // s9e's iframes carry the site in the file name and the key after '#'.
  if (host === "s9e.github.io") {
    const site = /\/([a-z]+)(?:\.min)?\.html$/.exec(url.pathname)?.[1];
    return site ? fromSite(site, decodeURIComponent(url.hash.slice(1))) : null;
  }
  return { url: src, label: `Embedded content from ${host}` };
}

function embedElement(doc: Document, embed: Embed): Element {
  const link = (child: Node | string) => {
    const a = doc.createElement("a");
    a.setAttribute("href", embed.url);
    a.append(child);
    return a;
  };
  if (embed.thumbnail) {
    const figure = doc.createElement("figure");
    const img = doc.createElement("img");
    img.setAttribute("src", embed.thumbnail);
    img.setAttribute("alt", embed.label);
    const caption = doc.createElement("figcaption");
    caption.append(link(`▶ ${embed.label}`));
    figure.append(link(img), caption);
    return figure;
  }
  const p = doc.createElement("p");
  p.append(link(`↗ ${embed.label}`));
  return p;
}

const mediaSource = (el: Element, base: string) =>
  safeHttpUrl(el.getAttribute("src"), base) ??
  Array.from(el.querySelectorAll("source[src]")).map((s) => safeHttpUrl(s.getAttribute("src"), base)).find(Boolean) ?? null;

/** Rewrites `root` in place. Safe to run more than once: its output has nothing left to convert. */
export function normalizeRichContent(root: Element | DocumentFragment, base: string): void {
  const doc = root.ownerDocument!;

  // Forum spoilers (XenForo): click to reveal. Before the button is thrown away with other junk.
  for (const spoiler of Array.from(root.querySelectorAll(".bbCodeSpoiler")).reverse()) {
    const title = spoiler.querySelector(".bbCodeSpoiler-button-title")?.textContent?.trim();
    const content = spoiler.querySelector(".bbCodeSpoiler-content .bbCodeBlock-content") ?? spoiler.querySelector(".bbCodeSpoiler-content");
    const details = doc.createElement("details");
    const summary = doc.createElement("summary");
    summary.textContent = title ? `Spoiler: ${title}` : "Spoiler";
    details.append(summary, ...Array.from(content?.childNodes ?? []));
    spoiler.replaceWith(details);
  }

  // Embeds with a known site: XenForo's media BB code, then s9e's MediaEmbed add-on.
  for (const el of Array.from(root.querySelectorAll("[data-media-site-id][data-media-key]"))) {
    const embed = fromSite(el.getAttribute("data-media-site-id")!, el.getAttribute("data-media-key")!) ??
      fromAddress(el.querySelector("iframe")?.getAttribute("src") ?? null, base);
    if (embed) el.replaceWith(embedElement(doc, embed));
  }
  for (const el of Array.from(root.querySelectorAll("[data-s9e-mediaembed]"))) {
    if (!root.contains(el)) continue; // replaced along with an outer embed
    const frame = el.querySelector("iframe");
    const address = frame?.getAttribute("data-s9e-mediaembed-src") ?? frame?.getAttribute("src") ?? null;
    const fromHash = address && /#(.+)$/.exec(address)?.[1];
    const embed = (fromHash ? fromSite(el.getAttribute("data-s9e-mediaembed")!, decodeURIComponent(fromHash)) : null) ?? fromAddress(address, base);
    if (embed) el.replaceWith(embedElement(doc, embed));
  }
  // Anything else that would vanish: a link to what it showed, or a note that something was there.
  for (const el of Array.from(root.querySelectorAll("iframe, embed, object"))) {
    if (!root.contains(el)) continue; // replaced along with an outer embed
    const address = el.getAttribute("data-s9e-mediaembed-src") ?? el.getAttribute("data-src") ?? el.getAttribute("src") ?? el.getAttribute("data");
    const embed = fromAddress(address, base);
    if (embed) el.replaceWith(embedElement(doc, embed));
    else {
      const note = doc.createElement("p");
      note.textContent = "[Embedded content not shown]";
      el.replaceWith(note);
    }
  }

  // Video and audio files play in the reader when served over https; always with a link too.
  for (const el of Array.from(root.querySelectorAll("video, audio"))) {
    const src = mediaSource(el, base);
    const label = el.tagName === "VIDEO" ? "video" : "audio";
    // Converted on an earlier pass: a bare player followed by its own link.
    const next = el.nextElementSibling;
    if (src && !el.children.length && next?.tagName === "P" && Array.from(next.querySelectorAll("a[href]")).some((a) => a.getAttribute("href") === src)) continue;
    if (!src) {
      const note = doc.createElement("p");
      note.textContent = `[${label[0]!.toUpperCase()}${label.slice(1)} not shown]`;
      el.replaceWith(note);
      continue;
    }
    const player = doc.createElement(el.tagName.toLowerCase());
    player.setAttribute("src", src);
    const p = doc.createElement("p");
    const a = doc.createElement("a");
    a.setAttribute("href", src);
    a.textContent = `↗ Open the ${label}`;
    p.append(a);
    el.replaceWith(...(src.startsWith("https://") ? [player, p] : [p]));
  }

  // Sprite smilies have no picture of their own (a transparent placeholder): keep their text.
  for (const img of Array.from(root.querySelectorAll("img.smilie"))) {
    const usable = ["src", "data-src"].some((attr) => safeHttpUrl(img.getAttribute(attr), base));
    if (usable && !img.classList.contains("smilie--sprite")) continue;
    const text = (img.getAttribute("alt") || img.getAttribute("title") || "").trim();
    img.replaceWith(text ? doc.createTextNode(text) : "");
  }
}
