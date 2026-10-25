import fs from "node:fs";
import path from "node:path";
// Following a forum thread with one updating card (D-084).
import { afterEach, describe, expect, it } from "vitest";
import type { JsonPoster } from "../src/feeds/flaresolverr.js";
import { FetchError } from "../src/feeds/fetch.js";
import { threadAddress } from "../src/feeds/thread.js";
import { FakeWeb, rss } from "./fakeWeb.js";
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

/**
 * The same, in Overclock.net's theme (D-102): plain <h1>, the tab title with an unread count and
 * page/site suffix, "22/23" on the current page's button, and each member's join date as the
 * first <time> in a post (in the member box), before the post's own time.
 */
function ocPage(n: number, of: number, posts: Post[]): string {
  return `<!DOCTYPE html><html><head><title>(3) Official NVIDIA RTX 5070 Ti Owners Club | Page ${n} | Overclock.net</title></head><body>
  <div class="p-body-header"><h1>Official NVIDIA RTX 5070 Ti Owners Club</h1></div>
  <nav aria-label="Pagination" class="pageNav"><a class="button pageNav-jump" aria-label="Goto Page 1" href="#">1</a>
    <a class="button button--primary pageNav-jump" role="button" aria-current="page"> ${n}/${of} </a></nav>
  ${posts
    .map(
      (p) => `<article class="message message--post js-post" data-author="${p.author}" data-content="post-${p.id}" id="js-post-${p.id}">
      <div class="message-cell message-cell--user"><section class="message-user"><div class="message-userDetails"><div class="message-userStats">
        Joined <time class="u-dt" datetime="2013-07-05T13:43:19.000Z" california-data-time="1373031799" qid="message-register-date">Jul 5, 2013</time></div></div></section></div>
      <header class="message-attribution"><div class="message-attribution-main"><a class="u-concealed"><time class="u-dt" datetime="2026-10-19T10:00:00.000Z" california-data-time="${Math.floor((NOW - (100000 - p.id) * 1000) / 1000)}" qid="post-date-time">2d ago</time></a></div></header>
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
    // Member1044 was read before: it's only in the dimmed context above the new replies (D-102).
    expect(r.html.split("New replies</p>")[1]).not.toContain("Member1044");

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

  it("Settings → Checking: intervals for feeds and threads, and thread pages per check (D-095)", async () => {
    const { clock, web, call, setThread } = await start();
    const checking = await call("GET", "/api/settings/checking");
    expect(checking.json()).toEqual({
      intervalMinutes: 30,
      threadIntervalMinutes: 15,
      threadPagesPerCheck: 3,
      defaults: { intervalMinutes: 30, threadIntervalMinutes: 15, threadPagesPerCheck: 3 },
    });

    // Threads use their own interval (±10 % jitter); feeds the general one.
    setThread(45);
    const thread = (await call("POST", "/api/sources", { url: THREAD })).json();
    web.set("https://blog.example/rss", { body: rss("Blog", [{ guid: "p1", title: "Post", date: new Date(NOW - 60_000).toISOString() }]) });
    const feed = (await call("POST", "/api/sources", { url: "https://blog.example/rss" })).json();
    expect(thread.nextCheckAt - NOW).toBeGreaterThanOrEqual(13.5 * 60_000);
    expect(thread.nextCheckAt - NOW).toBeLessThanOrEqual(16.5 * 60_000);
    expect(feed.nextCheckAt - NOW).toBeGreaterThanOrEqual(27 * 60_000);

    // Out of range.
    const bad = await call("PUT", "/api/settings/checking", { intervalMinutes: 2, threadIntervalMinutes: 15, threadPagesPerCheck: 11 });
    expect(bad.statusCode).toBe(400);

    // Shorter intervals bring next checks forward; values equal to the default are stored as "default".
    const put = await call("PUT", "/api/settings/checking", { intervalMinutes: 30, threadIntervalMinutes: 5, threadPagesPerCheck: 1 });
    expect(put.json()).toMatchObject({ intervalMinutes: 30, threadIntervalMinutes: 5, threadPagesPerCheck: 1 });
    const stored = await app!.db.kysely.selectFrom("settings").select(["key", "value"]).where("key", "in", ["check_interval_minutes", "thread_interval_minutes", "thread_pages_per_check"]).orderBy("key").execute();
    expect(stored).toEqual([{ key: "thread_interval_minutes", value: "5" }, { key: "thread_pages_per_check", value: "1" }]);
    const sources = (await call("GET", "/api/sources")).json() as Array<{ id: string; nextCheckAt: number }>;
    expect(sources.find((x) => x.id === thread.id)!.nextCheckAt).toBe(NOW + 5 * 60_000);
    expect(sources.find((x) => x.id === feed.id)!.nextCheckAt).toBe(feed.nextCheckAt);
    expect((await call("GET", "/api/config")).json().polling).toMatchObject({ intervalMinutes: 30, threadIntervalMinutes: 5, maxPagesPerPoll: 1 });

    // One page per check: a busy thread reads only the newest page.
    clock.now += 6 * 60_000;
    setThread(78);
    let before = web.requests.length;
    await call("POST", `/api/sources/${thread.id}/check`);
    expect(web.requests.slice(before).map((q) => q.url)).toEqual([`${THREAD}latest`]);

    // Up to 10: reads back while whole pages are new.
    await call("PUT", "/api/settings/checking", { intervalMinutes: 30, threadIntervalMinutes: 5, threadPagesPerCheck: 10 });
    clock.now += 6 * 60_000;
    setThread(140); // posts 1078…1139 are new: pages 4–7
    before = web.requests.length;
    expect((await call("POST", `/api/sources/${thread.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 62 });
    expect(web.requests.slice(before).map((q) => q.url)).toEqual([`${THREAD}latest`, `${THREAD}page-6`, `${THREAD}page-5`, `${THREAD}page-4`]);

    // Back to the defaults.
    await call("PUT", "/api/settings/checking", { intervalMinutes: 30, threadIntervalMinutes: 15, threadPagesPerCheck: 3 });
    expect(await app!.db.kysely.selectFrom("settings").select("key").where("key", "like", "%interval%").execute()).toEqual([]);
  });

  it("pages vBulletin threads from a vBulletin board's feed; 'last' reads page 1 for the count (D-099)", async () => {
    const { web, call } = await start();
    const fixture = fs.readFileSync(path.join(import.meta.dirname, "fixtures/pages/vbulletin-thread.html"), "utf8");
    const pageOf = (n: number) => fixture.replace(/Page 1 of 3/, `Page ${n} of 3`).replace(/Rider One/g, `Rider P${n}`);
    const T = "https://vb.example/classic-vintage/100-steel-frames";
    web.set("https://vb.example/external.php?type=RSS2&forumids=181", { body: rss("Classic & Vintage", [{ guid: "t100", title: "Steel frames", date: new Date(NOW - 60_000).toISOString(), link: `${T}.html` }]) });
    for (const n of [1, 2, 3]) web.set(n === 1 ? `${T}.html` : `${T}-${n}.html`, { body: pageOf(n), contentType: "text/html" });
    expect((await call("POST", "/api/sources", { url: "https://vb.example/external.php?type=RSS2&forumids=181" })).statusCode).toBe(201);
    const item = (await call("GET", "/api/items")).json().items[0];

    const p1 = (await call("GET", `/api/items/${item.id}/reader`)).json();
    expect(p1).toMatchObject({ kind: "page", pagination: { page: 1, pages: 3 } });
    expect(p1.html).toContain("Rider P1");
    expect(p1.html).not.toContain("Page 1 of 3"); // the app's pager shows it
    const p2 = (await call("GET", `/api/items/${item.id}/reader?page=2`)).json();
    expect(p2).toMatchObject({ pagination: { page: 2, pages: 3 } });
    expect(p2.html).toContain("Rider P2");
    const before = web.requests.length;
    const last = (await call("GET", `/api/items/${item.id}/reader?page=last`)).json();
    expect(last).toMatchObject({ pagination: { page: 3, pages: 3 } });
    expect(web.requests.slice(before).map((q) => q.url)).toEqual([`${T}-3.html`]); // page 1 was still cached
  });

  it("Overclock.net's theme: post times (not join dates), page count and title (D-102)", async () => {
    const { web, call } = await start();
    const all = posts(1000, 45);
    for (const n of [1, 2, 3]) web.set(n === 1 ? THREAD : `${THREAD}page-${n}`, { body: ocPage(n, 3, all.slice((n - 1) * 20, n * 20)), contentType: "text/html" });
    web.set(`${THREAD}latest`, { body: ocPage(3, 3, all.slice(40)), contentType: "text/html", finalUrl: `${THREAD}page-3` });
    const src = (await call("POST", "/api/sources", { url: THREAD })).json();
    expect(src.title).toBe("Official NVIDIA RTX 5070 Ti Owners Club");
    const card = (await call("GET", "/api/items?filter=all")).json().items[0];
    expect(card.title).toBe("Official NVIDIA RTX 5070 Ti Owners Club");
    // Dated by the newest post's own time, not 2013.
    expect(card.publishedAt).toBe(NOW - (100000 - 1044) * 1000);
    const whole = (await call("GET", `/api/items/${card.id}/reader?page=last`)).json();
    expect(whole.pagination).toEqual({ page: 3, pages: 3 });
    expect(whole.html).toContain(`datetime="${new Date(NOW - (100000 - 1040) * 1000).toISOString()}"`);
  });

  it("repairs dates and titles stored before D-102 at the next check, and shows context on the card", async () => {
    const { clock, call, setThread } = await start();
    setThread(45);
    const src = (await call("POST", "/api/sources", { url: THREAD })).json();
    let card = (await call("GET", "/api/items?filter=all")).json().items[0];
    // As an earlier version stored Overclock.net: join dates, and the tab title.
    const tab = "(3) Official NVIDIA RTX 5070 Ti Owners Club | Page 3 | Overclock.net";
    await app!.db.kysely.updateTable("thread_posts").set({ posted_at: Date.UTC(2013, 6, 5), posted_label: "Jul 5, 2013" }).execute();
    await app!.db.kysely.updateTable("items").set({ title: tab, published_at: Date.UTC(2013, 6, 5) }).execute();
    await app!.db.kysely.updateTable("sources").set({ title: tab }).execute();
    await call("PATCH", `/api/items/${card.id}`, { read: true });

    clock.now += 16 * 60_000;
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 0 });
    card = (await call("GET", "/api/items?filter=all")).json().items[0];
    expect(card).toMatchObject({ title: "Official NVIDIA RTX 5070 Ti Owners Club", read: true, publishedAt: NOW - (100000 - 1044) * 1000 });
    expect((await call("GET", "/api/sources")).json()[0].title).toBe("Official NVIDIA RTX 5070 Ti Owners Club");
    const stored = await app!.db.kysely.selectFrom("thread_posts").select("posted_label").execute();
    expect(stored.every((r) => r.posted_label !== "Jul 5, 2013")).toBe(true);

    // Two replies: the card shows the three posts before them, dimmed, then the new ones.
    clock.now += 16 * 60_000;
    setThread(47);
    await call("POST", `/api/sources/${src.id}/check`);
    const html = (await call("GET", `/api/items/${card.id}/reader`)).json().html as string;
    const [context, fresh] = html.split('<p class="thread-new-label">New replies</p>');
    expect(context).toMatch(/^<div class="thread-context"><p class="thread-context-label">Earlier in the thread<\/p>/);
    expect(["Member1042", "Member1043", "Member1044"].every((m) => context!.includes(m))).toBe(true);
    expect(context).not.toContain("Member1041");
    expect(fresh).toContain("Member1045");
    expect(fresh).toContain("Member1046");
  });

  it("reads any page of a thread in the reader, the newest with page=last, kept for 30 minutes (D-088)", async () => {
    const { clock, web, call, setThread } = await start();
    setThread(45); // pages 1–3 (20, 20, 5 posts)
    // A board feed whose item links to the thread, like a forum's board RSS.
    web.set("https://forum.example/forums/gpus.12/index.rss", {
      body: `<?xml version="1.0"?><rss version="2.0"><channel><title>GPUs</title><item><guid>1816698</guid><title>Owners Club</title><link>${THREAD}</link><pubDate>${new Date(NOW).toUTCString()}</pubDate></item></channel></rss>`,
    });
    await call("POST", "/api/sources", { url: "https://forum.example/forums/gpus.12/" });
    const item = (await call("GET", "/api/items")).json().items[0];
    const read = (q = "") => call("GET", `/api/items/${item.id}/reader${q}`).then((r) => r.json());

    const first = await read();
    expect(first.pagination).toEqual({ page: 1, pages: 3 });
    expect(first.html).toContain("Member1000");
    expect(first.html).not.toContain("Member1020");

    const second = await read("?page=2");
    expect(second.pagination).toEqual({ page: 2, pages: 3 });
    expect(second.html).toContain("Member1020");
    expect(second.html).not.toContain("Member1000");

    const newest = await read("?page=last");
    expect(newest.pagination).toEqual({ page: 3, pages: 3 });
    expect(newest.html).toContain("Member1044");

    // Pages read in the last 30 minutes come from memory; "last" also filled page 3.
    const before = web.requests.length;
    await read("?page=2");
    await read("?page=3");
    expect(web.requests.length).toBe(before);

    // Junk page values are ignored (page 1).
    expect((await read("?page=abc")).pagination).toEqual({ page: 1, pages: 3 });

    // Later, the newest page is read again and shows new replies.
    clock.now += 31 * 60_000;
    setThread(48);
    expect((await read("?page=last")).html).toContain("Member1047");
  });

  it("a followed thread's card can open the whole thread", async () => {
    const { call, setThread } = await start();
    setThread(25);
    await call("POST", "/api/sources", { url: THREAD });
    const card = (await call("GET", "/api/items")).json().items[0];
    const replies = (await call("GET", `/api/items/${card.id}/reader`)).json();
    expect(replies.pagination ?? null).toBeNull(); // the new replies, no pager
    const whole = (await call("GET", `/api/items/${card.id}/reader?page=1`)).json();
    expect(whole.pagination).toEqual({ page: 1, pages: 2 });
    expect(whole.html).toContain("Member1000");
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
