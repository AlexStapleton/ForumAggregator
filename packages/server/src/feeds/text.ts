// Turning untrusted feed content into safe, plain values. Nothing from a feed is ever
// rendered as HTML: summaries are plain text, and URLs must be http(s).
import { decodeHTML } from "entities";

export const SUMMARY_MAX = 400;
export const TITLE_MAX = 300;

/** Strips tags and decodes entities, collapsing whitespace. */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|iframe|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|blockquote|tr|table|section|article)\b[^>]*>/gi, " ");
  const noTags = withoutBlocks.replace(/<[^>]*>/g, "");
  return decodeHTML(noTags).replace(/\s+/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Absolute http(s) URL, resolved against `base`, or null for anything else (javascript:, data:, junk). */
export function safeHttpUrl(value: unknown, base?: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}
