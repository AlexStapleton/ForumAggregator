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
      const plain = htmlToText(t);
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
  return { ...item, guid: guid.slice(0, 1000), title: item.title || "(untitled)" };
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
          imageUrl: imageFrom(it, feedUrl),
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
          imageUrl: imageFrom(e, feedUrl),
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
