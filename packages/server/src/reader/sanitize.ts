// Cleaning untrusted HTML (feed content, extracted articles) before the reader shows it.
// Allow-list only: basic formatting, http(s) links, https images. No scripts, styles,
// iframes, forms, event handlers or inline styles survive. The page's CSP (script-src 'self')
// is a second line of defence, not the first.
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { safeHttpUrl } from "../feeds/text.js";

const window = new JSDOM("").window;
const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

const ALLOWED_TAGS = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "pre", "code", "kbd", "samp",
  "em", "strong", "b", "i", "u", "s", "small", "sub", "sup", "mark", "abbr", "cite", "q", "time",
  "a", "img", "figure", "figcaption", "picture",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "div", "span", "section", "article", "aside", "details", "summary",
];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "colspan", "rowspan", "datetime"];

let currentBase = "";

// Recover lazy images before the attribute allow-list removes their real addresses.
// This also covers feed HTML and followed-thread posts, which bypass Readability.
export function restoreLazyImage(el: Element, baseUrl: string): void {
  for (const attr of ["data-src", "data-lazy-src", "data-original"]) {
    const src = safeHttpUrl(el.getAttribute(attr), baseUrl);
    if (src?.startsWith("https://")) {
      el.setAttribute("src", src);
      break;
    }
  }
}

purify.addHook("beforeSanitizeAttributes", (node) => {
  const el = node as unknown as Element;
  if (el.tagName === "IMG") restoreLazyImage(el, currentBase);
});

purify.addHook("afterSanitizeAttributes", (node) => {
  const el = node as unknown as Element;
  if (el.tagName === "A") {
    const href = safeHttpUrl(el.getAttribute("href"), currentBase);
    if (href) {
      el.setAttribute("href", href);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer nofollow");
    } else {
      el.removeAttribute("href");
    }
  }
  if (el.tagName === "IMG") {
    const src = safeHttpUrl(el.getAttribute("src"), currentBase);
    // https only: the CSP blocks http images anyway, and mixed content would warn.
    if (src && src.startsWith("https://")) {
      el.setAttribute("src", src);
      el.setAttribute("loading", "lazy");
      el.setAttribute("referrerpolicy", "no-referrer");
    } else {
      el.remove();
    }
  }
});

const MAX_HTML = 400_000;

/** Returns safe HTML; relative links and images are resolved against `baseUrl`. */
export function sanitizeHtml(html: string, baseUrl: string): string {
  currentBase = baseUrl;
  try {
    const clean = purify.sanitize(html.slice(0, MAX_HTML), {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      KEEP_CONTENT: true,
    }) as string;
    // Drop wrappers left empty after cleaning (e.g. a figure whose image was http-only).
    return clean.replace(/<(figure|picture|div|span|p)>\s*<\/\1>/g, "").trim();
  } finally {
    currentBase = "";
  }
}
