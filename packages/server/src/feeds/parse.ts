// RSS 2.0, RSS 1.0 (RDF) and Atom parsing into one normalised shape.
import { XMLParser } from "fast-xml-parser";
import { htmlToText, safeHttpUrl, SUMMARY_MAX, TITLE_MAX, truncate } from "./text.js";

export interface ParsedItem {
  guid: string;
  url: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  imageUrl: string | null;
  /** A podcast episode's audio file (RSS enclosure, Media RSS, Atom rel="enclosure"), D-093. */
  audio: { url: string; durationSeconds: number | null } | null;
  /** null when the feed gave no usable date. */
  publishedAt: number | null;
  /**
   * Full article HTML when the feed carries it (content:encoded / Atom content), else null.
   * UNTRUSTED: only ever shown after reader/sanitize.ts has cleaned it.
   */
  contentHtml: string | null;
}

export interface ParsedFeed {
  format: "rss" | "atom" | "rdf";
  title: string | null;
  siteUrl: string | null;
  items: ParsedItem[];
}

export class FeedParseError extends Error {}

const MAX_ITEMS = 200;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  // Values stay strings (a title like "1080" must not become a number).
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Numeric character references (&#34;, &#x27;, &#8217;) too, not just the five XML ones:
  // Factorio's Atom feed writes the quotes in its escaped HTML as &#34; (D-091).
  htmlEntities: true,
  isArray: (name) => ["item", "entry", "link", "category", "media:thumbnail", "media:content", "enclosure"].includes(name),
});

type Node = Record<string, unknown>;

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object") {
    const v = (value as Node)["#text"];
    return v == null ? null : String(v);
  }
  return null;
}

function cleanTitle(value: unknown): string | null {
  const t = text(value);
  if (!t) return null;
  const plain = htmlToText(t);
  return plain ? truncate(plain, TITLE_MAX) : null;
}

function cleanSummary(...values: unknown[]): string | null {
  for (const v of values) {
    const t = text(v);
    if (t) {
      // WordPress's feed footer isn't part of the summary (D-103).
      const plain = htmlToText(t).replace(/\s*The post .+? appeared first on [^.]+\.\s*$/, "").trim();
      if (plain) return truncate(plain, SUMMARY_MAX);
    }
  }
  return null;
}

/** A description counts as full text only above this much text; dedicated content fields always count. */
const FULL_TEXT_MIN = 500;
/**
 * The item's HTML body for the reader: a dedicated content field (content:encoded, Atom
 * <content>) at any length, or a long description. The reader decides whether it's enough.
 */
function fullContent(dedicated: unknown, ...descriptions: unknown[]): string | null {
  const own = text(dedicated);
  if (own && htmlToText(own)) return own.slice(0, 500_000);
  for (const v of descriptions) {
    const t = text(v);
    if (t && htmlToText(t).length >= FULL_TEXT_MIN) return t.slice(0, 500_000);
  }
  return null;
}

function parseDate(...values: unknown[]): number | null {
  for (const v of values) {
    const t = text(v);
    if (!t) continue;
    const ms = Date.parse(t.trim());
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function imageFrom(node: Node, base: string | undefined): string | null {
  const group = (node["media:group"] as Node | undefined) ?? {};
  for (const holder of [node, group]) {
    for (const thumb of asArray(holder["media:thumbnail"] as Node[] | undefined)) {
      const u = safeHttpUrl(thumb?.["@_url"], base);
      if (u) return u;
    }
    for (const content of asArray(holder["media:content"] as Node[] | undefined)) {
      const type = String(content?.["@_type"] ?? content?.["@_medium"] ?? "");
      if (/image/.test(type)) {
        const u = safeHttpUrl(content["@_url"], base);
        if (u) return u;
      }
    }
  }
  for (const enc of asArray(node["enclosure"] as Node[] | undefined)) {
    if (/^image\//.test(String(enc?.["@_type"] ?? ""))) {
      const u = safeHttpUrl(enc["@_url"], base);
      if (u) return u;
    }
  }
  return null;
}

/** Not a picture of the article: tracking pixels, spacers, avatars, emoji, feed buttons. */
const NOT_A_PICTURE = /pixel|spacer|blank\.gif|tracking|feedburner|gravatar|avatar|emoji|smilies|icon|logo|badge|\.svg(\?|$)/i;

/**
 * The card's picture when the feed names none (D-103): the first real image in the item's HTML
 * (e.g. the Factorio blog, NASA Science). Only https, so the page's CSP allows it.
 */
function firstImage(html: unknown, base: string | undefined): string | null {
  const t = text(html);
  if (!t) return null;
  for (const m of t.slice(0, 200_000).matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (/\b(width|height)\s*=\s*["']?[0-9]\b(?!\d)/i.test(tag)) continue; // 1×1 trackers
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.replace(/&amp;/g, "&");
    const url = safeHttpUrl(src, base);
    if (url && url.startsWith("https://") && !NOT_A_PICTURE.test(url)) return url;
  }
  return null;
}

const AUDIO_FILE = /\.(mp3|m4a|aac|ogg|oga|opus|wav)(\?|$)/i;

/**
 * The episode's audio, if this item is a podcast episode: an <enclosure> (RSS) or
 * <link rel="enclosure"> (Atom) that is audio/* (or, untyped, an audio file name), else Media
 * RSS audio. Length from itunes:duration, else the media element's duration.
 */
function audioFrom(node: Node, base: string | undefined): ParsedItem["audio"] {
  const isAudio = (type: unknown, url: unknown) =>
    /^audio\//i.test(String(type ?? "")) || (!type && AUDIO_FILE.test(String(url ?? "")));
  let url: string | null = null;
  let mediaDuration: unknown;
  for (const enc of asArray(node["enclosure"] as Node[] | undefined)) {
    if (!url && isAudio(enc?.["@_type"], enc?.["@_url"])) url = safeHttpUrl(enc["@_url"], base);
  }
  for (const l of asArray(node["link"] as Array<Node | string> | undefined)) {
    if (!url && typeof l === "object" && l["@_rel"] === "enclosure" && isAudio(l["@_type"], l["@_href"])) url = safeHttpUrl(l["@_href"], base);
  }
  const group = (node["media:group"] as Node | undefined) ?? {};
  for (const holder of [node, group]) {
    for (const m of asArray(holder["media:content"] as Node[] | undefined)) {
      const audio = m?.["@_medium"] === "audio" || isAudio(m?.["@_type"], m?.["@_url"]);
      if (!url && audio) {
        url = safeHttpUrl(m["@_url"], base);
        mediaDuration = m["@_duration"];
      }
    }
  }
  if (!url) return null;
  return { url, durationSeconds: parseDuration(node["itunes:duration"]) ?? parseDuration(mediaDuration) };
}

/** "3600", "59:59" or "1:02:03" → seconds; null if unreadable or zero. */
export function parseDuration(value: unknown): number | null {
  const t = text(value)?.trim();
  if (!t || !/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return null;
  const seconds = t.split(":").reduce((sum, part) => sum * 60 + Math.floor(Number(part)), 0);
  return seconds > 0 && seconds < 100 * 3600 ? seconds : null;
}

function atomLink(links: unknown, base: string | undefined): string | null {
  const list = asArray(links as Node[] | Node | undefined) as Node[];
  const alternate = list.find((l) => typeof l === "object" && (l["@_rel"] === undefined || l["@_rel"] === "alternate"));
  const chosen = alternate ?? list[0];
  if (typeof chosen === "string") return safeHttpUrl(chosen, base);
  return safeHttpUrl(chosen?.["@_href"], base);
}

function finish(item: Omit<ParsedItem, "guid"> & { guid: string | null }): ParsedItem | null {
  const guid = item.guid ?? item.url ?? (item.title ? `${item.title}|${item.publishedAt ?? ""}` : null);
  if (!guid) return null;
  return { ...item, guid: guid.slice(0, 1000), title: item.title || "(untitled)", imageUrl: item.imageUrl && cardSized(item.imageUrl) };
}

/** Card pictures are shown at most ~260 px wide (on 2× screens); 400 is plenty. */
const CARD_IMAGE_WIDTH = 400;

/**
 * A card picture at card size where the image server can resize (D-107): an address that already
 * asks for a width ("?w=2048", NASA's and WordPress.com's image servers) asks for 400 instead, and
 * NASA's /dynamicimage/ gets one. NASA's 0.1–0.9 MB pictures become 17–44 kB. Others unchanged.
 */
export function cardSized(url: string): string {
  try {
    const u = new URL(url);
    const w = Number(u.searchParams.get("w"));
    if (w > CARD_IMAGE_WIDTH || (!u.searchParams.has("w") && u.pathname.includes("/dynamicimage/"))) {
      u.searchParams.set("w", String(CARD_IMAGE_WIDTH));
      u.searchParams.delete("h");
      return u.href;
    }
  } catch {
    // not a URL: unchanged
  }
  return url;
}

/** Parses feed XML. `feedUrl` resolves relative links. Throws FeedParseError if it isn't a feed. */
export function parseFeed(xml: string, feedUrl?: string): ParsedFeed {
  // Refuse internal entity declarations ("billion laughs") outright; real feeds don't use them.
  if (/<!DOCTYPE[^>]*\[/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new FeedParseError("Feed contains a DOCTYPE with entity declarations, which isn't allowed");
  }
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (err) {
    throw new FeedParseError(`Not valid XML: ${(err as Error).message}`);
  }

  if (doc.rss) {
    const channel = ((doc.rss as Node).channel ?? {}) as Node;
    const siteUrl = safeHttpUrl(text(asArray(channel.link as unknown[])[0]), feedUrl);
    const items = asArray(channel.item as Node[] | undefined)
      .slice(0, MAX_ITEMS)
      .map((it) => {
        const link = safeHttpUrl(text(asArray(it.link as unknown[])[0]), feedUrl ?? siteUrl ?? undefined);
        const guidNode = it.guid as Node | string | undefined;
        const guid = text(guidNode);
        return finish({
          guid: guid ?? link,
          // RSS: a <guid> is a permalink unless isPermaLink="false" says otherwise.
          url: link ?? (typeof guidNode === "object" && guidNode?.["@_isPermaLink"] === "false" ? null : safeHttpUrl(guid)),
          title: cleanTitle(it.title) ?? "",
          author: cleanTitle(it["dc:creator"] ?? it.author),
          summary: cleanSummary(it.description, it["content:encoded"]),
          imageUrl: imageFrom(it, feedUrl) ?? firstImage(it["content:encoded"] ?? it.description, link ?? feedUrl),
          audio: audioFrom(it, feedUrl),
          publishedAt: parseDate(it.pubDate, it["dc:date"], it.published, it.updated),
          contentHtml: fullContent(it["content:encoded"], it.description),
        });
      })
      .filter((i): i is ParsedItem => i !== null);
    return { format: "rss", title: cleanTitle(channel.title), siteUrl, items };
  }

  if (doc.feed) {
    const feed = doc.feed as Node;
    const siteUrl = atomLink(feed.link, feedUrl);
    const feedAuthor = cleanTitle((feed.author as Node | undefined)?.name);
    const items = asArray(feed.entry as Node[] | undefined)
      .slice(0, MAX_ITEMS)
      .map((e) => {
        const link = atomLink(e.link, feedUrl);
        const group = (e["media:group"] as Node | undefined) ?? {};
        return finish({
          guid: text(e.id) ?? link,
          url: link,
          title: cleanTitle(e.title) ?? "",
          author: cleanTitle((asArray(e.author as Node[] | Node | undefined)[0] as Node | undefined)?.name) ?? feedAuthor,
          summary: cleanSummary(e.summary, e.content, group["media:description"]),
          imageUrl: imageFrom(e, feedUrl) ?? firstImage(e.content ?? e.summary, link ?? feedUrl),
          audio: audioFrom(e, feedUrl),
          publishedAt: parseDate(e.published, e.updated, e.issued, e.modified),
          contentHtml: fullContent(e.content, e.summary),
        });
      })
      .filter((i): i is ParsedItem => i !== null);
    return { format: "atom", title: cleanTitle(feed.title), siteUrl, items };
  }

  if (doc["rdf:RDF"]) {
    const rdf = doc["rdf:RDF"] as Node;
    const channel = (rdf.channel ?? {}) as Node;
    const siteUrl = safeHttpUrl(text(asArray(channel.link as unknown[])[0]), feedUrl);
    const items = asArray(rdf.item as Node[] | undefined)
      .slice(0, MAX_ITEMS)
      .map((it) => {
        const link = safeHttpUrl(text(asArray(it.link as unknown[])[0]), feedUrl);
        return finish({
          guid: text(it["@_rdf:about"]) ?? link,
          url: link,
          title: cleanTitle(it.title) ?? "",
          author: cleanTitle(it["dc:creator"]),
          summary: cleanSummary(it.description, it["content:encoded"]),
          imageUrl: imageFrom(it, feedUrl),
          audio: audioFrom(it, feedUrl),
          publishedAt: parseDate(it["dc:date"]),
          contentHtml: fullContent(it["content:encoded"], it.description),
        });
      })
      .filter((i): i is ParsedItem => i !== null);
    return { format: "rdf", title: cleanTitle(channel.title), siteUrl, items };
  }

  throw new FeedParseError("This is XML, but not an RSS or Atom feed");
}

/** Cheap check before parsing: does this body look like a feed at all? */
export function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 2000);
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(head);
}
