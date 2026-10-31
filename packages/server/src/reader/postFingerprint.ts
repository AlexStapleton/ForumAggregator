import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";

/** Sanitized bodies only: author and relative date labels are outside this identity. */
export function postFingerprint(html: string): string {
  const fragment = JSDOM.fragment(html);
  const visit = (node: Node, verbatim = false): unknown => {
    if (node.nodeType === 3) return verbatim ? node.textContent : node.textContent?.replace(/\s+/g, " ");
    if (node.nodeType !== 1) return null;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    // Ignore cosmetic attributes and their ordering; preserve complete asset URLs.
    const attrs = ["href", "src", "srcset", "alt", "title", "colspan", "rowspan", "start", "value", "datetime"]
      .filter(name => el.hasAttribute(name)).map(name => [name, el.getAttribute(name)]);
    return [tag, attrs, Array.from(el.childNodes).map(n => visit(n, verbatim || tag === "pre" || tag === "code")).filter(n => n !== null)];
  };
  return createHash("sha256").update(JSON.stringify(Array.from(fragment.childNodes).map(n => visit(n)))).digest("hex");
}
