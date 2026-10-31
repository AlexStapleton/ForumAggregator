import { safeHttpUrl } from "../feeds/text.js";

const SPACE = /[\t\n\f\r ]/;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif)(?:\.\d+)?\/?$/i;
const LAZY = ["data-src", "data-lazy-src", "data-original"];
const SETS = ["data-srcset", "data-lazy-srcset", "srcset"];

function httpsImage(raw: string | null, base: string): string | null {
  const url = safeHttpUrl(raw, base);
  return url?.startsWith("https://") ? url : null;
}

/** Pick the largest usable candidate, not a viewport-dependent browser layout.
 * Tokenize URLs separately: commas can be part of CDN URLs and data placeholders.
 * https://html.spec.whatwg.org/multipage/images.html#parsing-a-srcset-attribute
 * Unsupported/mixed descriptors fall back to the image's ordinary address.
 */
export function srcsetImage(input: string, base: string, fallback: string | null = null): string | null {
  let pos = 0;
  let best: { url: string; value: number; unit: string } | null = null;
  while (pos < input.length) {
    while (pos < input.length && (SPACE.test(input[pos]!) || input[pos] === ",")) pos++;
    const start = pos;
    while (pos < input.length && !SPACE.test(input[pos]!)) pos++;
    let raw = input.slice(start, pos);
    let descriptor = "";
    if (raw.endsWith(",")) raw = raw.replace(/,+$/, "");
    else {
      const from = pos;
      let inParens = false;
      while (pos < input.length) {
        const c = input[pos++]!;
        if (c === "," && !inParens) break;
        if (c === "(") inParens = true;
        if (c === ")") inParens = false;
      }
      descriptor = input.slice(from, input[pos - 1] === "," ? pos - 1 : pos).trim();
    }
    const match = /^(\d+)w$|^((?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)x$/.exec(descriptor);
    if (descriptor && !match) continue;
    const value = match ? Number(match[1] ?? match[2]) : 1;
    const unit = match?.[1] ? "w" : "x";
    const url = httpsImage(raw, base);
    if (!url || !Number.isFinite(value) || value <= 0) continue;
    if (best && best.unit !== unit) return null;
    if (!best || value > best.value) best = { url, value, unit };
  }
  // An img's ordinary src is an implicit 1x candidate in density-based sets.
  if (best?.unit === "x" && best.value < 1 && fallback) return fallback;
  return best?.url ?? null;
}

function imageSet(el: Element, base: string): string | null {
  const fallback = el.tagName === "IMG" ? httpsImage(el.getAttribute("src"), base) : null;
  for (const attr of SETS) {
    const selected = srcsetImage(el.getAttribute(attr) ?? "", base, fallback);
    if (selected) return selected;
  }
  return null;
}

/** Recover image addresses before Readability or sanitization removes source metadata. */
export function restoreReaderImage(img: Element, base: string): void {
  const href = httpsImage(img.closest("a[href]")?.getAttribute("href") ?? null, base);
  const attachmentImage = img.closest('a.js-lbImage[data-type="image"][href]');
  const xenforoImage = href && attachmentImage && new URL(href).origin === new URL(base).origin && /\/attachments\//.test(new URL(href).pathname);
  let selected = href && (IMAGE_FILE.test(new URL(href).pathname) || xenforoImage) ? href : null;
  const picture = img.parentElement?.tagName === "PICTURE" ? img.parentElement : null;
  if (!selected && picture) {
    for (const source of Array.from(picture.children)) {
      if (source === img) break;
      if (source.tagName !== "SOURCE" || source.getAttribute("media")?.trim()) continue;
      const type = source.getAttribute("type")?.trim().toLowerCase();
      if (type && !/^image\/(?:png|jpeg|gif|webp|avif)$/.test(type)) continue;
      selected = imageSet(source, base);
      if (selected) break;
    }
  }
  selected ??= imageSet(img, base);
  for (const attr of LAZY) selected ??= httpsImage(img.getAttribute(attr), base);
  if (selected) {
    img.setAttribute("src", selected);
    // A later sanitization pass must not replace the chosen picture/attachment with a thumbnail.
    for (const attr of [...LAZY, ...SETS]) img.removeAttribute(attr);
  }
}
