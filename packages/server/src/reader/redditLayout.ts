// Reddit posts in the reader (D-076). Reddit's feed wraps each post in a two-column table:
// a thumbnail on the left, the text on the right. In a narrow reader that squeezes the picture
// to a stamp, and for image posts the picture *is* the post. So:
//   - the wrapper table is unwrapped (thumbnail above the text, at its own size);
//   - image posts (the "[link]" is i.redd.it, i.imgur.com or an image file) show the full image
//     instead of the thumbnail;
//   - image links in the text (preview.redd.it etc.) become pictures that open full size;
//   - gallery and video posts keep the thumbnail and say to open Reddit for the rest.
// Input must already be sanitised; everything added here is built with DOM calls from https URLs.
import { JSDOM } from "jsdom";
import { redditImageUrl, redditPostKind } from "../feeds/reddit.js";

export function layoutRedditPost(html: string, link: string | null, title: string): string {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  try {
    const doc = dom.window.document;
    const body = doc.body;
    const kind = redditPostKind(link);

    /** <a href=src><img src=src></a>: the image, opening full size when tapped. */
    const picture = (src: string): HTMLElement => {
      const a = doc.createElement("a");
      a.setAttribute("href", src);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer nofollow");
      const img = doc.createElement("img");
      img.setAttribute("src", src);
      img.setAttribute("alt", title);
      img.setAttribute("loading", "lazy");
      img.setAttribute("referrerpolicy", "no-referrer");
      a.append(img);
      return a;
    };
    const block = (child: Node): HTMLElement => {
      const p = doc.createElement("p");
      p.append(child);
      return p;
    };

    // 1. Unwrap the one-row wrapper table (a table in the post's own text has more rows).
    const thumbs: Element[] = [];
    for (const table of Array.from(body.querySelectorAll("table"))) {
      const rows = table.querySelectorAll("tr");
      const cells = rows.length === 1 ? Array.from(rows[0]!.children) : [];
      if (!cells.length || cells.length > 2) continue;
      const frag = doc.createDocumentFragment();
      cells.forEach((cell, i) => {
        if (cells.length === 2 && i === 0) {
          // The left cell holds only the thumbnail.
          const imgs = Array.from(cell.querySelectorAll("img"));
          if (!imgs.length) return;
          const wrap = doc.createElement("p");
          wrap.append(...imgs);
          thumbs.push(wrap);
          frag.append(wrap);
        } else {
          frag.append(...Array.from(cell.childNodes));
        }
      });
      table.replaceWith(frag);
    }

    // 2. Image links in the text become pictures.
    let inlineImages = 0;
    for (const a of Array.from(body.querySelectorAll("a[href]"))) {
      if (a.querySelector("img")) continue;
      const src = redditImageUrl(a.getAttribute("href"));
      if (!src) continue;
      inlineImages++;
      const text = (a.textContent ?? "").trim();
      if (text && !/^https?:\/\//i.test(text)) {
        // A described link ("my results"): keep the words, show the picture after them.
        a.after(picture(src));
        continue;
      }
      // A bare URL: the picture takes its place (the whole paragraph if that's all it was).
      const p = a.parentElement;
      if (p?.tagName === "P" && (p.textContent ?? "").trim() === text) p.replaceWith(block(picture(src)));
      else a.replaceWith(picture(src));
    }

    // 3. Image posts: the full image instead of the thumbnail. Posts whose text has the images:
    //    the thumbnail is only a crop of the first one.
    if (kind === "image" && link) {
      for (const t of thumbs) t.remove();
      body.prepend(block(picture(redditImageUrl(link)!)));
    } else if (inlineImages > 0) {
      for (const t of thumbs) t.remove();
    }
    if (kind === "gallery" || kind === "video") {
      const em = doc.createElement("em");
      em.textContent = kind === "gallery" ? "Gallery post: open the original to see every image." : "Video post: open the original to play it.";
      const note = block(em);
      const lastThumb = thumbs.at(-1);
      if (lastThumb?.isConnected) lastThumb.after(note);
      else body.prepend(note);
    }
    return body.innerHTML.trim();
  } finally {
    dom.window.close();
  }
}
