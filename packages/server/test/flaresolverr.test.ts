// FlareSolverr routing (D-080) and XenForo thread reading (D-081).
import { afterEach, describe, expect, it } from "vitest";
import { FetchError, type Fetcher, type FetchOptions } from "../src/feeds/fetch.js";
import { feedFromBrowserSource, FlareSolverr, type JsonPoster } from "../src/feeds/flaresolverr.js";
import { extractWithSelectors, isForumThreadUrl } from "../src/reader/extract.js";
import { FakeWeb } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const FS = "http://flaresolverr.lan:8191";
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0 Safari/537.36";
const NOW = Date.UTC(2026, 9, 19, 12);

const RSS = (items: Array<{ id: number; title: string; date: number }>) =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Hot Pepper Growing</title><link>https://forum.example/forums/hot-pepper-growing.4/</link>${items
    .map(
      (i) =>
        `<item><title>${i.title}</title><pubDate>${new Date(i.date).toUTCString()}</pubDate><link>https://forum.example/threads/${i.title.toLowerCase().replace(/\W+/g, "-")}.${i.id}/</link><guid isPermaLink="false">${i.id}</guid><content:encoded><![CDATA[<div>${"First post text. ".repeat(50)}</div>]]></content:encoded></item>`,
    )
    .join("")}</channel></rss>`;

/** A XenForo 2 thread page (the markup the default style renders). */
const THREAD = (posts: Array<{ author: string; text: string }>, pages = 3) => `<!DOCTYPE html><html><head><title>Superhots in 5 gallon pots | Hot Pepper Forum</title></head><body>
  <div class="p-title"><h1 class="p-title-value">Superhots in 5 gallon pots</h1></div>
  <nav class="pageNav"><ul class="pageNav-main">${Array.from({ length: pages }, (_, i) => `<li class="pageNav-page${i === 0 ? " pageNav-page--current" : ""}"><a href="#">${i + 1}</a></li>`).join("")}</ul></nav>
  ${posts
    .map(
      (p, i) => `<article class="message message--post js-post" data-author="${p.author}" data-content="post-${i}" id="js-post-${i}">
      <div class="message-cell message-cell--user"><h4 class="message-name"><a class="username">${p.author}</a></h4></div>
      <div class="message-attribution-main"><a href="/threads/x.1/post-${i}"><time class="u-dt" datetime="2026-10-1${i}T10:00:00+0000" data-time="1">Oct 1${i}, 2026</time></a></div>
      <div class="message-content"><div class="message-userContent"><article class="message-body js-selectToQuote"><div class="bbWrapper">${p.text}</div></article></div>
      <aside class="message-signature"><div class="bbWrapper">My grow log signature</div></aside></div>
    </article>`,
    )
    .join("")}
  <aside class="p-body-sidebar">${"<p>Sidebar: who's online, sponsors and links to other threads.</p>".repeat(30)}</aside>
</body></html>`;

describe("XenForo thread pages", () => {
  it("recognises thread links", () => {
    expect(isForumThreadUrl("https://forum.example/threads/superhots-in-5-gallon-pots.98765/")).toBe(true);
    expect(isForumThreadUrl("https://forum.example/threads/superhots.98765/page-3")).toBe(true);
    expect(isForumThreadUrl("https://forum.example/forums/hot-pepper-growing.4/")).toBe(false);
    expect(isForumThreadUrl(null)).toBe(false);
  });

  it("shows each post with its author and time, quotes kept, and which page of how many", () => {
    const html = THREAD([
      { author: "PepperGrower", text: 'Here are mine. <img src="https://forum.example/attachments/pot.jpg" class="bbImage">' },
      {
        author: "Reaper55",
        text: '<blockquote class="bbCodeBlock bbCodeBlock--quote"><div class="bbCodeBlock-title">PepperGrower said:</div><div class="bbCodeBlock-content"><div class="bbCodeBlock-expandContent">Here are mine.</div><div class="bbCodeBlock-expandLink"><a>Click to expand...</a></div></div></blockquote>Looking great!',
      },
    ]);
    const r = extractWithSelectors(html, "https://forum.example/threads/superhots.98765/", {});
    const out = r.article!.html;
    expect(r.article!.byline).toBe("PepperGrower");
    expect(r.article!.title).toBe("Superhots in 5 gallon pots");
    expect(out).toContain("<strong>PepperGrower</strong>");
    expect(out).toContain('<time datetime="2026-10-11T10:00:00.000Z">Oct 11, 2026</time>');
    expect(out).toContain('src="https://forum.example/attachments/pot.jpg"');
    expect(out).toContain("PepperGrower said:");
    expect(out).toContain("Looking great!");
    expect(out.indexOf("PepperGrower</strong>")).toBeLessThan(out.indexOf("Reaper55</strong>"));
    expect(out).not.toMatch(/Click to expand|Sidebar|signature/);
    expect(r.article!.pages).toEqual({ page: 1, pages: 3 }); // shown as a pager, not text (D-088)
    expect(out).not.toContain("Page 1 of 3");
  });
});

describe("feedFromBrowserSource", () => {
  const rss = '<rss version="2.0"><channel><title>T</title></channel></rss>';
  it("finds the feed in the browser's copy of an XML page", () => {
    expect(feedFromBrowserSource(rss)).toContain(rss);
    expect(feedFromBrowserSource(`<html><body><div id="webkit-xml-viewer-source-xml">${rss}</div><div>tree</div></body></html>`)).toContain(rss);
    const escaped = rss.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(feedFromBrowserSource(`<html><body><pre style="word-wrap: break-word">${escaped}</pre></body></html>`)).toContain(rss);
    expect(feedFromBrowserSource("<html><body><p>Just a page</p></body></html>")).toBeNull();
  });
});

/** A site behind Cloudflare: plain requests get a challenge unless they carry the clearance and the browser's identity. */
function cloudflared(web: FakeWeb, host: string): { fetcher: Fetcher; seen: FetchOptions[] } {
  const seen: FetchOptions[] = [];
  return {
    seen,
    fetcher: async (url, options) => {
      if (new URL(url).host === host) {
        seen.push(options);
        if (!(options.cookie?.includes("cf_clearance=granted") && options.userAgent === BROWSER_UA)) {
          throw new FetchError("cloudflare_challenge", "Cloudflare browser check ('Just a moment...'): plain requests are not let through [HTTP 403]", 403);
        }
      }
      return web.fetcher(url, options);
    },
  };
}

/** A fake FlareSolverr: "opens" the page in its browser and returns it with the clearance cookie. */
function fakeFlareSolverr(web: FakeWeb, opts: { fail?: string; wrapXml?: boolean; now: () => number } ) {
  const calls: Array<{ url: string; body: { cmd: string; url: string } }> = [];
  const post: JsonPoster = async (url, body) => {
    const b = body as { cmd: string; url: string };
    calls.push({ url, body: b });
    if (opts.fail) return { status: 500, body: { status: "error", message: opts.fail } };
    const route = web.routes.get(b.url);
    const page = route && "body" in route ? route.body : "<html><body>404</body></html>";
    // Chrome's view of an XML document wraps it in its viewer.
    const response = opts.wrapXml && page.startsWith("<?xml") ? `<html><head></head><body><div id="webkit-xml-viewer-source-xml">${page.replace(/<\?xml[^>]*\?>/, "")}</div></body></html>` : page;
    return {
      status: 200,
      body: {
        status: "ok",
        message: "Challenge solved!",
        solution: {
          url: b.url,
          status: route ? 200 : 404,
          response,
          userAgent: BROWSER_UA,
          cookies: [
            { name: "cf_clearance", value: "granted", domain: ".forum.example", expires: Math.floor((opts.now() + 3_600_000) / 1000) },
            { name: "tracker", value: "other-site", domain: ".elsewhere.example" },
          ],
        },
      },
    };
  };
  return { calls, post };
}

describe("FlareSolverr client", () => {
  it("uses the browser's copy once, then the clearance for plain requests; re-solves when challenged again", async () => {
    const web = new FakeWeb();
    let now = NOW;
    web.set("https://forum.example/forums/board.4/index.rss", { body: RSS([{ id: 1, title: "Hello", date: NOW }]) });
    const site = cloudflared(web, "forum.example");
    const fs = fakeFlareSolverr(web, { wrapXml: true, now: () => now });
    const flare = new FlareSolverr(async () => FS, fs.post, async () => ({ status: 503, body: null }), () => now, async () => {});
    const fetcher = flare.wrap(site.fetcher);

    const first = await fetcher("https://forum.example/forums/board.4/index.rss", { expect: "feed" });
    expect(first.kind === "ok" && first.body).toContain("<rss");
    expect(fs.calls).toHaveLength(1);
    expect(fs.calls[0]).toMatchObject({ url: `${FS}/v1`, body: { cmd: "request.get", url: "https://forum.example/forums/board.4/index.rss" } });

    // Next time: one plain request with the clearance (only this site's cookies), no FlareSolverr.
    await fetcher("https://forum.example/forums/board.4/index.rss", { expect: "feed" });
    expect(fs.calls).toHaveLength(1);
    expect(site.seen.at(-1)).toMatchObject({ cookie: "cf_clearance=granted", userAgent: BROWSER_UA });

    // The clearance expires → FlareSolverr again.
    now += 2 * 3_600_000;
    await fetcher("https://forum.example/forums/board.4/index.rss", { expect: "feed" });
    expect(fs.calls).toHaveLength(2);
  });

  it("falls back to a plain request with the clearance when the browser's copy isn't usable", async () => {
    const web = new FakeWeb();
    web.set("https://forum.example/forums/board.4/index.rss", { body: RSS([]) });
    const site = cloudflared(web, "forum.example");
    // The browser's copy has no recognisable feed in it.
    const post: JsonPoster = async () => ({
      status: 200,
      body: { status: "ok", solution: { url: "x", status: 200, response: "<html><body><p>XML viewer</p></body></html>", userAgent: BROWSER_UA, cookies: [{ name: "cf_clearance", value: "granted", domain: "forum.example" }] } },
    });
    const flare = new FlareSolverr(async () => FS, post, async () => ({ status: 503, body: null }), () => NOW, async () => {});
    const res = await flare.wrap(site.fetcher)("https://forum.example/forums/board.4/index.rss", { expect: "feed" });
    expect(res.kind === "ok" && res.body).toContain("<rss");
    expect(site.seen.at(-1)).toMatchObject({ cookie: "cf_clearance=granted", userAgent: BROWSER_UA });
  });

  it("uses FlareSolverr's copy of pages carrying Cloudflare's background script, and stops trying plain requests a site refuses", async () => {
    let now = NOW;
    const url = "https://forum.example/threads/seeds.555/";
    // A real page that passed the check still loads Cloudflare's detection script.
    const page = `<html><head><title>Seeds | Forum</title></head><body>${THREAD([{ author: "Valdus", text: "What's best to store them?" }, { author: "Reply1", text: "Paper envelopes in the fridge." }], 1)}<script>window.__CF$cv$params={r:'8f'};a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';</script></body></html>`;
    let plainTries = 0;
    // Cloudflare tells the app's requests from Chrome's: plain requests are refused even with the cookie.
    const refusing: Fetcher = async () => {
      plainTries++;
      throw new FetchError("cloudflare_challenge", "Cloudflare browser check [HTTP 403]", 403);
    };
    let solves = 0;
    const post: JsonPoster = async () => {
      solves++;
      return { status: 200, body: { status: "ok", solution: { url, status: 200, response: page, userAgent: BROWSER_UA, cookies: [{ name: "cf_clearance", value: "granted", domain: ".forum.example" }] } } };
    };
    const fetcher = new FlareSolverr(async () => FS, post, async () => ({ status: 503, body: null }), () => now, async () => {}).wrap(refusing);
    for (let i = 0; i < 4; i++) {
      const res = await fetcher(url, { expect: "html" });
      expect(res.kind === "ok" && res.body).toContain("Paper envelopes");
    }
    expect(solves).toBe(4);
    expect(plainTries).toBe(1); // tried once with the clearance, then FlareSolverr only
    // After a while plain requests get another chance (once a fresh clearance is held).
    now += 7 * 3_600_000;
    await fetcher(url, { expect: "html" }); // old clearance expired too: FlareSolverr first
    expect(plainTries).toBe(1);
    await fetcher(url, { expect: "html" });
    expect(plainTries).toBe(2);
  });

  it("reports FlareSolverr's own failure", async () => {
    const web = new FakeWeb();
    const site = cloudflared(web, "forum.example");
    const fs = fakeFlareSolverr(web, { fail: "Error solving the challenge. Timeout after 60.0 seconds.", now: () => NOW });
    const flare = new FlareSolverr(async () => FS, fs.post, async () => ({ status: 503, body: null }), () => NOW, async () => {});
    await expect(flare.wrap(site.fetcher)("https://forum.example/forums/board.4/", { expect: "html" })).rejects.toMatchObject({
      kind: "cloudflare_challenge",
      message: expect.stringMatching(/FlareSolverr couldn't get past.*Timeout after 60/),
    });
  });
});

describe.each(backends)("forums through FlareSolverr (%s)", (backend) => {
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("set up FlareSolverr, add a Cloudflare-protected board, poll it, and read a thread's posts", async () => {
    const clock = { now: NOW };
    const web = new FakeWeb();
    const site = cloudflared(web, "forum.example");
    const fs = fakeFlareSolverr(web, { wrapXml: true, now: () => clock.now });
    let pingAnswer: { status: number; body: unknown } = { status: 200, body: { msg: "FlareSolverr is ready!", version: "3.3.21" } };
    app = await createTestApp(backend, {}, clock, { fetcher: site.fetcher, postJson: fs.post, fetchJson: async () => pingAnswer });
    const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" }, headers: CSRF });
    const cookie = sessionCookie(setup)!;
    const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) =>
      app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });

    const board = "https://forum.example/forums/hot-pepper-growing.4/";
    web.set(`${board}index.rss`, { body: RSS([{ id: 98765, title: "Superhots in 5 gallon pots", date: NOW - 60_000 }]) });
    web.set(board, { body: "<html><body>board page</body></html>", contentType: "text/html" });
    web.set("https://forum.example/threads/superhots-in-5-gallon-pots.98765/", {
      body: THREAD([{ author: "PepperGrower", text: "Here are mine." }, { author: "Reaper55", text: "Looking great!" }], 1),
      contentType: "text/html",
    });

    // Without FlareSolverr: the error says what to do.
    const blocked = await call("POST", "/api/sources", { url: board });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().message).toMatch(/FlareSolverr.*Settings/);
    expect(fs.calls).toHaveLength(0);

    // Settings: a wrong address is refused; FlareSolverr's own answer is accepted.
    pingAnswer = { status: 200, body: { hello: "not it" } };
    const wrong = await call("PUT", "/api/settings/flaresolverr", { url: "http://192.168.1.50:8080" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().fields.url).toMatch(/not like FlareSolverr/);
    expect((await call("PUT", "/api/settings/flaresolverr", { url: "not a url" })).statusCode).toBe(400);
    pingAnswer = { status: 200, body: { msg: "FlareSolverr is ready!", version: "3.3.21" } };
    expect((await call("PUT", "/api/settings/flaresolverr", { url: `${FS}/` })).json()).toEqual({ url: FS, version: "3.3.21" });

    // Adding the board now goes through FlareSolverr and marks the source.
    const added = await call("POST", "/api/sources", { url: board });
    expect(added.statusCode).toBe(201);
    const src = added.json();
    expect(src).toMatchObject({ viaFlareSolverr: true, feedUrl: `${board}index.rss`, title: "Hot Pepper Growing" });
    expect((await call("GET", "/api/items")).json().items.map((i: { title: string }) => i.title)).toEqual(["Superhots in 5 gallon pots"]);

    // Scheduled check: plain request with the clearance, no new FlareSolverr call.
    const solves = fs.calls.length;
    web.set(`${board}index.rss`, {
      body: RSS([
        { id: 98766, title: "Fertiliser schedule", date: NOW },
        { id: 98765, title: "Superhots in 5 gallon pots", date: NOW - 60_000 },
      ]),
    });
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 1 });
    expect(fs.calls.length).toBe(solves);

    // Opening a thread shows its posts (not the feed's first-post excerpt).
    const thread = (await call("GET", "/api/items")).json().items.find((i: { title: string }) => i.title.startsWith("Superhots"));
    const r = (await call("GET", `/api/items/${thread.id}/reader`)).json();
    expect(r).toMatchObject({ kind: "page", notice: null });
    expect(r.html).toContain("<strong>Reaper55</strong>");
    expect(r.html).not.toContain("First post text.");

    // Later: new replies are picked up; if the site can't be reached, the earlier copy is kept.
    clock.now += 31 * 60_000;
    web.set("https://forum.example/threads/superhots-in-5-gallon-pots.98765/", {
      body: THREAD([{ author: "PepperGrower", text: "Here are mine." }, { author: "Reaper55", text: "Looking great!" }, { author: "NewPerson", text: "Late reply" }], 1),
      contentType: "text/html",
    });
    expect((await call("GET", `/api/items/${thread.id}/reader`)).json().html).toContain("NewPerson");
    clock.now += 31 * 60_000;
    web.set("https://forum.example/threads/superhots-in-5-gallon-pots.98765/", { error: new FetchError("timeout", "The site took too long to answer") });
    const stale = (await call("GET", `/api/items/${thread.id}/reader`)).json();
    expect(stale.html).toContain("NewPerson");
    expect(stale.notice).toMatch(/Couldn't load new replies.*copy read earlier/);

    // The route can be switched off per source.
    expect((await call("PATCH", `/api/sources/${src.id}`, { viaFlareSolverr: false })).json().viaFlareSolverr).toBe(false);
    expect((await call("PUT", "/api/settings/flaresolverr", { url: null })).json()).toEqual({ url: null, version: null });
  });
});
