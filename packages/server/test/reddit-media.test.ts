// Reddit video and gallery posts in the reader (D-117). Entries are shaped like Reddit's
// subreddit feed (Atom; the post in a two-column table, the media in the "[link]"), and the
// post's details like reddit.com/comments/<id>.json. Content is made up.
import { afterEach, describe, expect, it } from "vitest";
import { fallbackMedia, parseRedditPost, redditMediaPlan } from "../src/reader/redditMedia.js";
import { layoutRedditPost } from "../src/reader/redditLayout.js";
import type { JsonFetcher } from "../src/feeds/fetch.js";
import { FakeWeb } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 25, 12);
const SUB = "https://www.reddit.com/r/flyingthings/";

/** One entry's body, as Reddit's feed has it (before escaping into the Atom <content>). */
function body(postId: string, slug: string, thumb: string, link: string, text = ""): string {
  const permalink = `${SUB}comments/${postId}/${slug}/`;
  return `<table> <tr><td> <a href="${permalink}"> <img src="${thumb}" alt="t" title="t" /> </a> </td><td> ${text} &#32; submitted by &#32; <a href="https://www.reddit.com/user/pilot"> /u/pilot </a> <br/> <span><a href="${link}">[link]</a></span> &#32; <span><a href="${permalink}">[comments]</a></span> </td></tr></table>`;
}

const VIDEO_THUMB = "https://external-preview.redd.it/aGVsbG8.png?width=640&amp;crop=smart&amp;auto=webp&amp;s=abc";
const GALLERY_THUMB = "https://preview.redd.it/firstpic123.png?width=140&amp;height=98&amp;auto=webp&amp;s=def";
const VIDEO = body("1aaaaaa", "landing_on_one_engine", VIDEO_THUMB, "https://v.redd.it/vid42xyz");
const GALLERY = body("1bbbbbb", "hangar_tour", GALLERY_THUMB, "https://www.reddit.com/gallery/1bbbbbb", '<!-- SC_OFF --><div class="md"><p>Three shots from the hangar.</p> </div><!-- SC_ON -->');
const IMAGE = body("1cccccc", "sunset", "https://preview.redd.it/sun.png?width=140", "https://i.redd.it/sun.png");

function feed(entries: Array<{ id: string; title: string; html: string; link: string }>): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>flying things</title><link rel="alternate" href="${SUB}" type="text/html" />${entries
    .map(
      (e, i) =>
        `<entry><author><name>/u/pilot</name></author><content type="html">${esc(e.html)}</content><id>t3_${e.id}</id><link href="${e.link}" /><updated>${new Date(NOW - (i + 1) * 3_600_000).toISOString()}</updated><published>${new Date(NOW - (i + 1) * 3_600_000).toISOString()}</published><title>${e.title}</title></entry>`,
    )
    .join("")}</feed>`;
}

/** The post's details, as Reddit's JSON (raw_json=1) has them. */
const videoJson = (extra: object = {}) => [
  {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: {
            id: "1aaaaaa",
            is_video: true,
            secure_media: {
              reddit_video: {
                hls_url: "https://v.redd.it/vid42xyz/HLSPlaylist.m3u8?a=1790000000%2Csig&v=1&f=sd",
                fallback_url: "https://v.redd.it/vid42xyz/CMAF_720.mp4?source=fallback",
                width: 1280,
                height: 720,
                duration: 31,
              },
            },
            ...extra,
          },
        },
      ],
    },
  },
  { kind: "Listing", data: { children: [] } },
];

const galleryJson = [
  {
    kind: "Listing",
    data: {
      children: [
        {
          kind: "t3",
          data: {
            id: "1bbbbbb",
            is_gallery: true,
            gallery_data: { items: [{ media_id: "firstpic123", caption: "The VT-7" }, { media_id: "loop456" }, { media_id: "broken789" }, { media_id: "second999" }] },
            media_metadata: {
              firstpic123: { status: "valid", e: "Image", m: "image/png", s: { u: "https://preview.redd.it/firstpic123.png?width=1920&format=png&s=1", x: 1920, y: 1080 } },
              loop456: { status: "valid", e: "AnimatedImage", m: "image/gif", s: { gif: "https://i.redd.it/loop456.gif", mp4: "https://preview.redd.it/loop456.gif?format=mp4&s=2", x: 640, y: 360 } },
              broken789: { status: "failed" },
              second999: { status: "valid", e: "Image", s: { u: "https://evil.example/second999.png", x: 1, y: 1 } },
            },
          },
        },
      ],
    },
  },
];

describe("Reddit media helpers", () => {
  it("knows a video or gallery post from its feed body, and finds the preview and first picture", () => {
    expect(redditMediaPlan(VIDEO, `${SUB}comments/1aaaaaa/landing_on_one_engine/`, "t3_1aaaaaa")).toEqual({
      kind: "video",
      postId: "1aaaaaa",
      videoId: "vid42xyz",
      poster: "https://external-preview.redd.it/aGVsbG8.png?width=640&crop=smart&auto=webp&s=abc",
      firstImage: null,
    });
    expect(redditMediaPlan(GALLERY, `${SUB}comments/1bbbbbb/hangar_tour/`, "t3_1bbbbbb")).toMatchObject({
      kind: "gallery",
      postId: "1bbbbbb",
      firstImage: "https://i.redd.it/firstpic123.png",
    });
    expect(redditMediaPlan(IMAGE, `${SUB}comments/1cccccc/sunset/`, "t3_1cccccc")).toBeNull();
  });

  it("reads the stream from the post's details, and only from Reddit's media hosts", () => {
    const plan = redditMediaPlan(VIDEO, null, "t3_1aaaaaa")!;
    expect(parseRedditPost(videoJson(), plan)).toEqual({
      kind: "video",
      hlsUrl: "https://v.redd.it/vid42xyz/HLSPlaylist.m3u8?a=1790000000%2Csig&v=1&f=sd",
      mp4Url: "https://v.redd.it/vid42xyz/CMAF_720.mp4?source=fallback",
      poster: plan.poster,
      width: 1280,
      height: 720,
      durationSeconds: 31,
      fromPost: true,
      notice: null,
    });
    const bad = videoJson({ secure_media: { reddit_video: { hls_url: "https://evil.example/x.m3u8" } } });
    expect(parseRedditPost(bad, plan)).toBeNull();
    // A crosspost: the original's video.
    const cross = videoJson({ secure_media: null, crosspost_parent_list: [videoJson()[0]!.data.children[0]!.data] });
    expect(parseRedditPost(cross, plan)).toMatchObject({ kind: "video", width: 1280 });
    expect(parseRedditPost({ error: 429 }, plan)).toBeNull();
    // Without the details, the stream's usual address.
    expect(fallbackMedia(plan, "Reddit refused the request (403).")).toMatchObject({ kind: "video", hlsUrl: "https://v.redd.it/vid42xyz/HLSPlaylist.m3u8", mp4Url: null, fromPost: false });
  });

  it("reads every valid picture of a gallery, in order, with captions and animated ones as mp4", () => {
    const plan = redditMediaPlan(GALLERY, null, "t3_1bbbbbb")!;
    expect(parseRedditPost(galleryJson, plan)).toEqual({
      kind: "gallery",
      complete: true,
      notice: null,
      images: [
        { url: "https://preview.redd.it/firstpic123.png?width=1920&format=png&s=1", width: 1920, height: 1080, caption: "The VT-7", mp4: null },
        { url: "https://i.redd.it/loop456.gif", width: 640, height: 360, caption: null, mp4: "https://preview.redd.it/loop456.gif?format=mp4&s=2" },
      ],
    });
    expect(fallbackMedia(plan, null)).toMatchObject({ kind: "gallery", complete: false, images: [{ url: "https://i.redd.it/firstpic123.png" }] });
  });

  it("leaves the thumbnail and note out when the reader shows the media itself", () => {
    const html = (player: boolean) => layoutRedditPost(VIDEO.replace(/&amp;/g, "&"), "https://v.redd.it/vid42xyz", "Landing", player);
    expect(html(false)).toContain("Video post: open the original");
    expect(html(true)).not.toContain("Video post");
    expect(html(true)).not.toContain("<img");
  });
});

describe.each(backends)("Reddit media in the reader (%s)", (backend) => {
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(fetchJson: JsonFetcher) {
    const web = new FakeWeb();
    web.set(`${SUB}.rss`, {
      body: feed([
        { id: "1aaaaaa", title: "Landing on one engine", html: VIDEO, link: `${SUB}comments/1aaaaaa/landing_on_one_engine/` },
        { id: "1bbbbbb", title: "Hangar tour", html: GALLERY, link: `${SUB}comments/1bbbbbb/hangar_tour/` },
        { id: "1cccccc", title: "Sunset", html: IMAGE, link: `${SUB}comments/1cccccc/sunset/` },
      ]),
    });
    app = await createTestApp(backend, {}, { now: NOW }, { fetcher: web.fetcher, fetchJson });
    const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" }, headers: CSRF });
    const cookie = sessionCookie(setup)!;
    const call = (method: "GET" | "POST", url: string, payload?: object) => app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });
    expect((await call("POST", "/api/sources", { url: SUB })).statusCode).toBe(201);
    const items = (await call("GET", "/api/items")).json().items as Array<{ id: string; title: string }>;
    const id = (title: string) => items.find((i) => i.title === title)!.id;
    return { call, id, web };
  }

  it("asks Reddit once for a post's video or gallery, and keeps the answer", async () => {
    const asked: string[] = [];
    const { call, id, web } = await start(async (url) => {
      asked.push(url);
      return { status: 200, body: url.includes("1aaaaaa") ? videoJson() : galleryJson };
    });

    const reader = (await call("GET", `/api/items/${id("Landing on one engine")}/reader`)).json();
    expect(reader.redditMedia).toEqual({ kind: "video", poster: "https://external-preview.redd.it/aGVsbG8.png?width=640&crop=smart&auto=webp&s=abc" });
    expect(reader.html).not.toContain("Video post");
    expect(asked).toEqual([]); // nothing asked until the player wants it

    const video = (await call("GET", `/api/items/${id("Landing on one engine")}/media`)).json();
    expect(video).toMatchObject({ kind: "video", fromPost: true, width: 1280, durationSeconds: 31 });
    await call("GET", `/api/items/${id("Landing on one engine")}/media`);
    expect(asked).toEqual(["https://www.reddit.com/comments/1aaaaaa.json?raw_json=1&limit=1&depth=1"]);

    const gallery = (await call("GET", `/api/items/${id("Hangar tour")}/media`)).json();
    expect(gallery).toMatchObject({ kind: "gallery", complete: true });
    expect(gallery.images).toHaveLength(2);
    expect((await call("GET", `/api/items/${id("Hangar tour")}/reader`)).json().html).toContain("Three shots from the hangar.");

    // An image post has neither; Reddit's pages are never fetched.
    expect((await call("GET", `/api/items/${id("Sunset")}/reader`)).json().redditMedia).toBeNull();
    expect((await call("GET", `/api/items/${id("Sunset")}/media`)).statusCode).toBe(404);
    expect(web.requests.map((r) => r.url)).toEqual([`${SUB}.rss`]);
  });

  it("when Reddit refuses: the video's usual stream address, the gallery's first picture, and the reason", async () => {
    const { call, id } = await start(async () => ({ status: 403, body: null }));
    expect((await call("GET", `/api/items/${id("Landing on one engine")}/media`)).json()).toMatchObject({
      kind: "video",
      hlsUrl: "https://v.redd.it/vid42xyz/HLSPlaylist.m3u8",
      fromPost: false,
    });
    const gallery = (await call("GET", `/api/items/${id("Hangar tour")}/media`)).json();
    expect(gallery).toMatchObject({ kind: "gallery", complete: false, images: [{ url: "https://i.redd.it/firstpic123.png" }] });
    expect(gallery.notice).toMatch(/^Reddit refused the request \(403\)\. Showing the first picture/);
  });

  it("only for accounts that follow the source, and the page may load the stream", async () => {
    const { call, id } = await start(async () => ({ status: 200, body: videoJson() }));
    const other = (await call("POST", "/api/admin/invites", {})).json();
    const accepted = await app!.fastify.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token: other.token, username: "sam", password: "another long password" }, headers: CSRF });
    const res = await app!.fastify.inject({ method: "GET", url: `/api/items/${id("Landing on one engine")}/media`, headers: { cookie: sessionCookie(accepted)! } });
    expect(res.statusCode).toBe(404);
    const csp = String((await call("GET", "/api/version")).headers["content-security-policy"]);
    expect(csp).toContain("connect-src 'self' https://v.redd.it");
    expect(csp).toMatch(/media-src [^;]*blob:/);
  });
});
