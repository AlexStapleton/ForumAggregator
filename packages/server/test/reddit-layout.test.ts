// Reddit posts in the reader: unwrapped thumbnail table, full images, notes (D-076).
import { afterEach, describe, expect, it } from "vitest";
import { cleanRedditHtml, redditPostKind, redditPostLink } from "../src/feeds/reddit.js";
import { layoutRedditPost } from "../src/reader/redditLayout.js";
import { sanitizeHtml } from "../src/reader/sanitize.js";
import { FakeWeb } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const POST = "https://www.reddit.com/r/overclocking/comments/1q2w3e/vbios_override/";
const THUMB = "https://preview.redd.it/thumb1.png?width=640&amp;crop=smart&amp;auto=webp&amp;s=aa";

/** An entry's HTML the way Reddit's feed shapes it: thumbnail cell, text cell, footer. */
function entry(opts: { link: string; text?: string; thumb?: boolean }): string {
  const thumb = opts.thumb === false ? "" : `<a href="${POST}"> <img src="${THUMB}" alt="VBIOS override" title="VBIOS override" /> </a>`;
  const text = opts.text ? `<!-- SC_OFF --><div class="md">${opts.text}</div><!-- SC_ON -->` : "";
  return `<table> <tr><td> ${thumb} </td><td> ${text} &#32; submitted by &#32; <a href="https://www.reddit.com/user/someone"> /u/someone </a> <br/> <span><a href="${opts.link}">[link]</a></span> &#32; <span><a href="${POST}">[comments]</a></span> </td></tr></table>`;
}

/** The reader's pipeline for a Reddit body. */
const render = (raw: string) => layoutRedditPost(sanitizeHtml(cleanRedditHtml(raw), POST), redditPostLink(raw), "VBIOS override");
const imgs = (html: string) => [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&"));

describe("Reddit post layout", () => {
  it("classifies posts by their [link]", () => {
    expect(redditPostKind("https://i.redd.it/abc.jpeg")).toBe("image");
    expect(redditPostKind("https://i.imgur.com/abc.png")).toBe("image");
    expect(redditPostKind("https://www.reddit.com/gallery/1abc")).toBe("gallery");
    expect(redditPostKind("https://v.redd.it/xyz")).toBe("video");
    expect(redditPostKind(POST)).toBe("self");
    expect(redditPostKind("https://videocardz.com/news/vbios")).toBe("link");
    expect(redditPostKind(null)).toBe("self");
  });

  it("image post: the full image, not the thumbnail and no 'Linked' line", () => {
    const html = render(entry({ link: "https://i.redd.it/full1.jpeg" }));
    expect(imgs(html)).toEqual(["https://i.redd.it/full1.jpeg"]);
    expect(html).toContain('<a href="https://i.redd.it/full1.jpeg"'); // tap to open full size
    expect(html).not.toMatch(/<table|Linked/);
  });

  it("text post with a thumbnail: table unwrapped, thumbnail above the text", () => {
    const html = render(entry({ link: POST, text: "<p>Using W11 driver 546.65.</p>" }));
    expect(html).not.toMatch(/<table|<td/);
    expect(imgs(html)).toEqual([THUMB.replace(/&amp;/g, "&")]);
    expect(html.indexOf("<img")).toBeLessThan(html.indexOf("Using W11"));
  });

  it("image links in the text become pictures, replacing the thumbnail crop", () => {
    const full = "https://preview.redd.it/shot.png?width=2560&amp;format=png&amp;auto=webp&amp;s=bb";
    const text = `<p>My results:</p><p><a href="${full}">${full}</a></p><p>See <a href="https://i.redd.it/chart.png">the chart</a>.</p>`;
    const html = render(entry({ link: POST, text }));
    expect(imgs(html)).toEqual(["https://preview.redd.it/shot.png?width=2560&format=png&auto=webp&s=bb", "https://i.redd.it/chart.png"]);
    expect(html).toContain("the chart"); // described links keep their words
    expect(html).not.toContain(">https://preview.redd.it"); // bare URLs are replaced
  });

  it("gallery and video posts keep the thumbnail and say to open Reddit", () => {
    const gallery = render(entry({ link: "https://www.reddit.com/gallery/1q2w3e" }));
    expect(imgs(gallery)).toHaveLength(1);
    expect(gallery).toMatch(/Gallery post: open the original/);
    expect(render(entry({ link: "https://v.redd.it/abc" }))).toMatch(/Video post: open the original/);
  });

  it("link posts keep the article's thumbnail and the 'Linked' line; real tables stay", () => {
    const html = render(entry({ link: "https://videocardz.com/news/vbios", text: "<table><tr><th>Card</th></tr><tr><td>5080</td></tr></table>" }));
    expect(html).toContain("Linked:");
    expect(imgs(html)).toHaveLength(1);
    expect(html).toContain("<td>5080</td>");
  });

  it("never turns unsafe links into images", () => {
    const html = render(entry({ link: POST, text: '<p><a href="http://i.redd.it/plain.png">http://i.redd.it/plain.png</a> <a href="javascript:alert(1)">x.png</a></p>', thumb: false }));
    expect(imgs(html)).toEqual([]);
    expect(html).not.toContain("javascript:");
  });
});

describe.each(backends)("Reddit bodies for items stored by older versions (%s)", (backend) => {
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("stores a missing or old-format body when the feed shows the item again", async () => {
    const NOW = Date.UTC(2026, 9, 19, 12);
    const clock = { now: NOW };
    const web = new FakeWeb();
    app = await createTestApp(backend, {}, clock, { fetcher: web.fetcher });
    const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" }, headers: CSRF });
    const cookie = sessionCookie(setup)!;
    const call = (method: "GET" | "POST", url: string, payload?: object) => app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });

    const feed = (body: string) =>
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>r/overclocking</title>
      <entry><id>t3_1q2w3e</id><title>VBIOS override</title><link href="${POST}"/><updated>${new Date(NOW - 60_000).toISOString()}</updated>
      <content type="html">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</content></entry></feed>`;
    const url = "https://www.reddit.com/r/overclocking/.rss";
    web.set(url, { body: feed(entry({ link: "https://i.redd.it/full1.jpeg" })) });
    const src = (await call("POST", "/api/sources", { url })).json();
    const item = (await call("GET", "/api/items")).json().items[0];

    // Simulate v1.0.0: no body stored for this short post.
    await app.db.kysely.deleteFrom("item_content").execute();
    expect((await call("GET", `/api/items/${item.id}/reader`)).json()).toMatchObject({ kind: "summary", notice: expect.stringMatching(/Open the original/) });

    await call("POST", `/api/sources/${src.id}/check`);
    const r = (await call("GET", `/api/items/${item.id}/reader`)).json();
    expect(r.kind).toBe("feed");
    expect(imgs(r.html)).toEqual(["https://i.redd.it/full1.jpeg"]);

    // Simulate v1.0.1: the cleaned copy cached as "ok" (no [link] left): replaced by the raw body.
    await app.db.kysely.updateTable("item_content").set({ status: "ok", html: "<table><tr><td><img src=\"https://preview.redd.it/t.png\"></td><td><p>old</p></td></tr></table>" }).execute();
    expect((await call("GET", `/api/items/${item.id}/reader`)).json().html).not.toContain("<table"); // unwrapped even when cached
    await call("POST", `/api/sources/${src.id}/check`);
    const row = await app.db.kysely.selectFrom("item_content").select("status").executeTakeFirstOrThrow();
    expect(row.status).toBe("raw");
  });
});
