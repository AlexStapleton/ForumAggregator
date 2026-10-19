// OPML: the standard file for moving feed subscriptions between readers (D-073).
// Export: one <outline> per source, inside a folder named after its first tag, with all tags in
// `category`. Import: every outline with an xmlUrl; tags come from its folders and `category`.
import { XMLParser } from "fast-xml-parser";
import { MAX_TAGS, normaliseTag } from "@fa/shared";
import { safeHttpUrl, truncate } from "./text.js";

export const OPML_MAX_ENTRIES = 1000;
const SOURCE_TITLE_MAX = 200; // same limit as naming a source in the UI

export class OpmlError extends Error {}

export interface OpmlEntry {
  feedUrl: string;
  title: string | null;
  siteUrl: string | null;
  tags: string[];
}

export interface OpmlSource {
  title: string;
  feedUrl: string;
  siteUrl: string | null;
  tags: string[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => name === "outline",
});

type Node = Record<string, unknown>;

const attr = (node: Node, name: string): string | null => {
  const v = node[`@_${name}`];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** Reads the feeds out of an OPML file. Folder names and `category` values become tags. */
export function parseOpml(xml: string): OpmlEntry[] {
  // Same guard as feeds: no internal entity declarations ("billion laughs").
  if (/<!DOCTYPE[^>]*\[/i.test(xml) || /<!ENTITY/i.test(xml)) throw new OpmlError("The file contains entity declarations, which aren't allowed.");
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch {
    throw new OpmlError("The file isn't valid XML.");
  }
  const body = (doc.opml as Node | undefined)?.body as Node | undefined;
  if (!body || typeof body !== "object") throw new OpmlError("This doesn't look like an OPML file (no <opml><body>).");

  const out: OpmlEntry[] = [];
  const walk = (outlines: unknown, folders: string[], depth: number) => {
    if (!Array.isArray(outlines) || depth > 10) return;
    for (const o of outlines as Node[]) {
      if (!o || typeof o !== "object") continue;
      const label = attr(o, "title") ?? attr(o, "text");
      const xmlUrl = attr(o, "xmlUrl") ?? attr(o, "xmlurl");
      if (xmlUrl) {
        if (out.length >= OPML_MAX_ENTRIES) throw new OpmlError(`The file has more than ${OPML_MAX_ENTRIES} feeds.`);
        const feedUrl = safeHttpUrl(xmlUrl);
        const categories = (attr(o, "category") ?? "").split(",").map((c) => c.replace(/^\/+/, ""));
        const tags = [...new Set([...folders, ...categories].map(normaliseTag).filter(Boolean))].slice(0, MAX_TAGS);
        out.push({
          feedUrl: feedUrl ?? xmlUrl,
          title: label ? truncate(label, SOURCE_TITLE_MAX) : null,
          siteUrl: safeHttpUrl(attr(o, "htmlUrl") ?? attr(o, "htmlurl")),
          tags,
        });
      }
      // A folder (or a feed with children, which some readers produce).
      walk(o.outline, label && !xmlUrl ? [...folders, label] : folders, depth + 1);
    }
  };
  walk(body.outline, [], 0);
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function outline(s: OpmlSource, indent: string): string {
  const parts = [`type="rss"`, `text="${esc(s.title)}"`, `title="${esc(s.title)}"`, `xmlUrl="${esc(s.feedUrl)}"`];
  if (s.siteUrl) parts.push(`htmlUrl="${esc(s.siteUrl)}"`);
  if (s.tags.length) parts.push(`category="${esc(s.tags.join(","))}"`);
  return `${indent}<outline ${parts.join(" ")}/>`;
}

/** OPML 2.0 with sources grouped into folders by their first tag. */
export function buildOpml(sources: OpmlSource[], now: number): string {
  const folders = new Map<string, OpmlSource[]>();
  const loose: OpmlSource[] = [];
  for (const s of [...sources].sort((a, b) => a.title.localeCompare(b.title))) {
    const first = s.tags[0];
    if (first) folders.set(first, [...(folders.get(first) ?? []), s]);
    else loose.push(s);
  }
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="2.0">`,
    `  <head>`,
    `    <title>ForumAggregator subscriptions</title>`,
    `    <dateCreated>${new Date(now).toUTCString()}</dateCreated>`,
    `  </head>`,
    `  <body>`,
  ];
  for (const [tag, list] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    <outline text="${esc(tag)}" title="${esc(tag)}">`);
    for (const s of list) lines.push(outline(s, "      "));
    lines.push(`    </outline>`);
  }
  for (const s of loose) lines.push(outline(s, "    "));
  lines.push(`  </body>`, `</opml>`, ``);
  return lines.join("\n");
}
