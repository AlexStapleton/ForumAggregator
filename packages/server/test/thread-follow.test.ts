// Following a forum thread with one updating card (D-084).
import { afterEach, describe, expect, it } from "vitest";
import type { JsonPoster } from "../src/feeds/flaresolverr.js";
import { FetchError } from "../src/feeds/fetch.js";
import { threadAddress } from "../src/feeds/thread.js";
import { FakeWeb } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 19, 12);
const THREAD = "https://forum.example/threads/official-nvidia-rtx-5070-ti-owners-club.1816698/";

interface Post {
  id: number;
  author: string;
  text: string;
}

/** One page of a XenForo 2 thread, 20 posts a page like XenForo's default. */
function page(n: number, of: number, posts: Post[]): string {
  return `<!DOCTYPE html><html><head><title>Official NVIDIA RTX 5070 Ti Owners Club | Page ${n} | Forum</title></head><body>
  <h1 class="p-title-value">Official NVIDIA RTX 5070 Ti Owners Club</h1>
  <nav class="pageNav"><ul>${Array.from({ length: of }, (_, i) => `<li class="pageNav-page${i + 1 === n ? " pageNav-page--current" : ""}"><a>${i + 1}</a></li>`).join("")}</ul></nav>
  ${posts
    .map(
      (p) => `<article class="message message--post js-post" data-author="${p.author}" data-content="post-${p.id}" id="js-post-${p.id}">
      <div class="message-attribution-main"><time class="u-dt" datetime="2026-10-19T10:00:00+0000" data-time="${Math.floor((NOW - (100000 - p.id) * 1000) / 1000)}">Today at 10:00 AM</time></div>
      <article class="message-body"><div class="bbWrapper">${p.text}</div></article></article>`,
    )
    .join("")}</body></html>`;
}

const posts = (from: number, count: number, who = "Member"): Post[] =>
  Array.from({ length: count }, (_, i) => ({ id: from + i, author: `${who}${from + i}`, text: `Post number ${from + i}: my card runs at 3200 MHz.` }));

describe("threadAddress", () => {
  it("turns any link into a thread into the thread's own address", () => {
    const own = (u: string) => threadAddress(new URL(u));
    expect(own("https://www.overclock.net/threads/official-nvidia-rtx-5070-ti-owners-club.1816698/page-21?post_id=29633565#post-29633565")).toBe(
      "https://www.overclock.net/threads/official-nvidia-rtx-5070-ti-owners-club.1816698/",
    );
    expect(own("https://forum.example/threads/abc.12")).toBe("https://forum.example/threads/abc.12/");
    expect(own("https://forum.example/forums/gpus.12/")).toBeNull();
  });
});

describe.each(backends)("following a thread (%s)", (backend) => {
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(deps: { postJson?: JsonPoster; fetchJson?: Parameters<typeof createTestApp>[3]["fetchJson"] } = {}) {
    const clock = { now: NOW };
    const web = new FakeWeb();
    // Looked up on each call, so a test can swap the site's behaviour.
    app = await createTestApp(backend, {}, clock, { fetcher: (url, options) => web.fetcher(url, options), ...deps });
    const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" }, headers: CSRF });
    const cookie = sessionCookie(setup)!;
    const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
      app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });
    /** The thread now has `total` posts (ids 1000…), 20 a page; "latest" serves the last page. */
    const setThread = (total: number) => {
      const all = posts(1000, total);
      const pages = Math.max(1, Math.ceil(total / 20));
      for (let n = 1; n <= pages; n++) {
        const url = n === 1 ? THREAD : `${THREAD}page-${n}`;
        web.set(url, { body: page(n, pages, all.slice((n - 1) * 20, n * 20)), contentType: "text/html" });
      }
      web.set(`${THREAD}latest`, { body: page(pages, pages, all.slice((pages - 1) * 20)), contentType: "text/html", finalUrl: pages > 1 ? `${THREAD}page-${pages}` : THREAD });
    };
    return { clock, web, call, setThread };
  }

  it("follows a thread: one card, the new replies since last read, and catching up on busy threads", async () => {
    const { clock, web, call, setThread } = await start();
    setThread(45); // 3 pages; the last has 5 posts

    // Any link into the thread works (page and post anchors are dropped).
    const added = await call("POST", "/api/sources", { url: `${THREAD}page-2?post_id=1030#post-1030`, tags: ["gpu"] });
    expect(added.statusCode).toBe(201);
    const src = added.json();
    expect(src).toMatchObject({ kind: "thread", title: "Official NVIDIA RTX 5070 Ti Owners Club", feedUrl: THREAD, tags: ["gpu"] });
    expect(web.requests.map((r) => r.url)).toEqual([`${THREAD}latest`]); // only the newest page

    const card = () => call("GET", "/api/items?filter=all").then((r) => r.json().items as Array<{ id: string; title: string; summary: string; read: boolean; url: string; sourceKind: string }>);
    let items = await card();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Official NVIDIA RTX 5070 Ti Owners Club", read: false, url: `${THREAD}page-3`, sourceKind: "thread" });
    expect(items[0]!.summary).toMatch(/^5 latest replies · Member1044: Post number 1044/);
    const reader = (id: string) => call("GET", `/api/items/${id}/reader`).then((r) => r.json());
    let r = await reader(items[0]!.id);
    expect(r.kind).toBe("page");
    expect(r.html.indexOf("Member1040")).toBeLessThan(r.html.indexOf("Member1044")); // oldest first

    // Read it; two replies arrive → the card is unread again, with just those two.
    await call("PATCH", `/api/items/${items[0]!.id}`, { read: true });
    clock.now += 31 * 60_000;
    setThread(47);
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 2 });
    items = await card();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ read: false });
    expect(items[0]!.summary).toMatch(/^2 new replies · Member1046:/);
    r = await reader(items[0]!.id);
    expect(r.html).toContain("Member1045");
    expect(r.html).not.toContain("Member1044");

    // Not read yet; one more arrives → added to the same batch.
    clock.now += 31 * 60_000;
    setThread(48);
    await call("POST", `/api/sources/${src.id}/check`);
    expect((await card())[0]!.summary).toMatch(/^3 new replies · Member1047:/);

    // Nothing new → nothing changes.
    clock.now += 31 * 60_000;
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 0 });

    // Read, then 30 replies in one go (more than a page): the page before the newest is read too.
    await call("PATCH", `/api/items/${items[0]!.id}`, { read: true });
    clock.now += 31 * 60_000;
    setThread(78); // posts 1048…1077 are new; pages 3 and 4 hold them
    const before = web.requests.length;
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 30 });
    expect(web.requests.slice(before).map((q) => q.url)).toEqual([`${THREAD}latest`, `${THREAD}page-3`]);
    expect((await card())[0]!.summary).toMatch(/^30 new replies/);
  });

  it("refuses duplicates, address changes and pages without posts; leaves threads out of OPML", async () => {
    const { web, call, setThread } = await start();
    setThread(5);
    const src = (await call("POST", "/api/sources", { url: THREAD })).json();
    expect((await call("POST", "/api/sources", { url: `${THREAD}page-1` })).statusCode).toBe(409);
    const moved = await call("PATCH", `/api/sources/${src.id}`, { url: "https://forum.example/threads/other.5/" });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().fields.url).toMatch(/new source/);

    web.set("https://forum.example/threads/gone.9/latest", { body: "<html><body>The requested thread could not be found.</body></html>", contentType: "text/html" });
    const empty = await call("POST", "/api/sources", { url: "https://forum.example/threads/gone.9/" });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().message).toMatch(/Couldn't find any posts/);

    const opml = (await call("GET", "/api/sources/opml")).body;
    expect(opml).not.toContain("threads/");
  });

  it("follows a thread behind a bot check through FlareSolverr", async () => {
    const UA = "Mozilla/5.0 Chrome/142.0";
    let solves = 0;
    const holder: { web?: FakeWeb } = {};
    const post: JsonPoster = async (_url, body) => {
      solves++;
      const target = (body as { url: string }).url;
      const route = holder.web!.routes.get(target);
      return {
        status: 200,
        body: { status: "ok", solution: { url: route && "finalUrl" in route && route.finalUrl ? route.finalUrl : target, status: 200, response: route && "body" in route ? route.body : "", userAgent: UA, cookies: [{ name: "cf_clearance", value: "ok", domain: "forum.example" }] } },
      };
    };
    const { web, call, setThread } = await start({ postJson: post, fetchJson: async () => ({ status: 200, body: { msg: "FlareSolverr is ready!", version: "3.3.21" } }) });
    holder.web = web;
    setThread(3);
    // Plain requests to the forum get the check.
    const original = web.fetcher;
    web.fetcher = async (url, options) => {
      if (url.startsWith("https://forum.example/")) throw new FetchError("cloudflare_challenge", "check [HTTP 403]", 403);
      return original(url, options);
    };
    expect((await call("PUT", "/api/settings/flaresolverr", { url: "http://fs.lan:8191" })).statusCode).toBe(200);
    const added = await call("POST", "/api/sources", { url: THREAD });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ kind: "thread", viaFlareSolverr: true });
    expect(solves).toBeGreaterThan(0);
    expect((await call("GET", "/api/items")).json().items[0].summary).toMatch(/^3 latest replies/);
  });
});
