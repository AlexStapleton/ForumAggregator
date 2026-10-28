// Following a vBulletin board's threads (D-123): one card per thread, back with new replies.
import { afterEach, describe, expect, it } from "vitest";
import { boardThreadSummary, parseBoardPage } from "../src/feeds/board.js";
import { FakeWeb, rss } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 28, 18); // 28 Oct 2026, 12:00 PM at GMT -6
const BOARD = "https://vb.example/tandem-cycling/";
const MARKET = "https://vb.example/tandem-marketplace/";

interface Row {
  id: number;
  title: string;
  starter: string;
  replies: number;
  lastPostId: number;
  /** As the forum shows it, in its time zone: "10-16-26 11:55 AM". */
  when: string;
  lastPoster: string;
  /** The page holding the last post. */
  lastPage?: number;
  sticky?: boolean;
}

const slug = (r: Row) => `${r.id}-${r.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/**
 * A board's first page laid out like Bike Forums' vBulletin 3.9 theme (from the user's saved pages,
 * not committed): sub-forum rows with id="f<id>", the thread list in #threadbits_forum_<id>, sticky
 * threads marked with an icon, and the "All times are GMT -6." footer.
 */
function boardPage(base: string, rows: Row[], subforums: string[] = []): string {
  return `<!DOCTYPE html><html><head><title>Tandem Cycling - Bike Forums</title>
  <link rel="alternate" type="application/rss+xml" title="Bike Forums RSS Feed" href="https://vb.example/external.php?type=RSS2"></head><body>
  ${subforums.map((s, i) => `<div class="trow forumbit"><div id="f${331 + i}" class="tcell"><h2><a href="${s}"><strong>Sub ${i}</strong></a></h2></div></div>`).join("")}
  <div id="threadslist"><div id="threadbits_forum_44" class="trow-group">
  <div class="trow thead threadbit"><div class="tcell">Thread / Thread Starter</div></div>
  ${rows
    .map((r) => {
      const [d, t, m] = r.when.split(" ");
      const page1 = `${base}${slug(r)}.html`;
      const last = r.lastPage && r.lastPage > 1 ? `${base}${slug(r)}-${r.lastPage}.html` : page1;
      return `<div class="trow text-center">
    <div class="tcell alt1" id="td_threadstatusicon_${r.id}"><img src="thread.gif" alt=""></div>
    <div class="tcell alt1 text-left" id="td_threadtitle_${r.id}"><div>
      ${r.sticky ? `<span class="right"><img class="inlineimg" src="sticky.gif" alt="Sticky Thread" title="Sticky Thread"></span> Sticky` : ""}
      <h4 class="style-inherit"><a href="${page1}" id="thread_title_${r.id}">${r.title}</a></h4></div>
      <div class="smallfont"><span style="cursor: pointer" onclick="window.open('${base}members/x.html', '_self')">${r.starter}</span><span class="smallfont"> on 01-02-26</span></div>
    </div>
    <div class="tcell alt2 smallfont" title="Replies: ${r.replies.toLocaleString("en-US")}, Views: 1,234"><div class="smallfont text-right">
      ${d} <span class="time">${t} ${m}</span><br>
      by <a href="${base}members/y.html" rel="nofollow">${r.lastPoster}</a> <a href="${last}#post${r.lastPostId}"><img src="lastpost.gif" alt="Go to last post"></a>
    </div></div>
    <div class="tcell alt1"><a href="misc.php?do=whoposted&amp;t=${r.id}">${r.replies}</a></div>
  </div>`;
    })
    .join("")}
  </div></div>
  <div class="smallfont">All times are GMT -6. The time now is <span class="time">12:00 PM</span>.</div>
  </body></html>`;
}

/** A thread page in the same theme, enough for the reader (D-098). */
function threadPage(n: number, of: number, text: string): string {
  return `<!DOCTYPE html><html><head><title>A thread - Bike Forums</title></head><body><h1>A thread</h1>
  <span id="mb_page_current">${n}</span> / <span id="mb_page_total">${of}</span>
  <div id="post${900 + n}"><div class="trow thead"><div class="tcell">10-28-26 | 09:00 AM</div></div>
  <div class="tcell alt2"><a class="bigusername">Rider</a></div><div class="tcell alt1"><div id="post_message_${900 + n}">${text}</div></div></div>
  <div class="smallfont">All times are GMT -6.</div></body></html>`;
}

const sticky: Row = { id: 799956, title: "Hauling a tandem inside", starter: "DubT", replies: 200, lastPostId: 23786978, when: "08-04-26 12:49 PM", lastPoster: "fourhoarder", lastPage: 9, sticky: true };
const forSale: Row = { id: 1000939, title: "Tandems found for sale", starter: "thumpism", replies: 519, lastPostId: 23823292, when: "10-27-26 11:55 AM", lastPoster: "SoCaled", lastPage: 21 };
const rack: Row = { id: 1322358, title: "Front rack for T900", starter: "TDHudson", replies: 3, lastPostId: 23824375, when: "10-26-26 08:53 PM", lastPoster: "TDHudson" };
const quiet: Row = { id: 1319795, title: "Quad or triple", starter: "wsa30h", replies: 2, lastPostId: 23723318, when: "04-06-26 04:43 AM", lastPoster: "wsa30h" };
const burley: Row = { id: 1278832, title: "Burley Duet for sale", starter: "bluesteak", replies: 3, lastPostId: 23720457, when: "10-25-26 11:59 AM", lastPoster: "bluesteak" };
const rules: Row = { id: 924921, title: "Rules of operation", starter: "Allen", replies: 0, lastPostId: 16301999, when: "12-04-13 08:40 PM", lastPoster: "Allen", sticky: true };

describe("parseBoardPage (D-123)", () => {
  it("reads each thread's newest post, in the forum's time zone, and the sub-forums", () => {
    const page = parseBoardPage(boardPage(BOARD, [sticky, forSale, quiet], [MARKET]), BOARD, NOW)!;
    expect(page.subforums).toEqual([MARKET]);
    expect(page.threads.map((t) => [t.id, t.sticky])).toEqual([["799956", true], ["1000939", false], ["1319795", false]]);
    expect(page.threads[1]).toEqual({
      id: "1000939",
      title: "Tandems found for sale",
      url: `${BOARD}1000939-tandems-found-for-sale.html`,
      starter: "thumpism",
      sticky: false,
      replies: 519,
      lastPostId: "23823292",
      lastPageUrl: `${BOARD}1000939-tandems-found-for-sale-21.html`,
      lastPoster: "SoCaled",
      lastPostAt: Date.UTC(2026, 9, 27, 17, 55), // 11:55 AM at GMT -6
    });
    // Stock vBulletin marks stickies with text ("Sticky:") instead of Bike Forums' icon.
    const stock = boardPage(BOARD, [quiet]).replace(`<h4 class="style-inherit">`, "Sticky: <h4>");
    expect(parseBoardPage(stock, BOARD, NOW)!.threads[0]!.sticky).toBe(true);
    // Without the time zone footer, no time is guessed.
    expect(parseBoardPage(boardPage(BOARD, [quiet]).replace(/All times are GMT -6\./, ""), BOARD, NOW)!.threads[0]!.lastPostAt).toBeNull();
    expect(parseBoardPage("<html><body><p>Not a board</p></body></html>", BOARD, NOW)).toBeNull();
  });

  it("summarises a card", () => {
    const t = parseBoardPage(boardPage(BOARD, [forSale, { ...rack, replies: 0 }]), BOARD, NOW)!.threads;
    expect(boardThreadSummary(t[0]!, null)).toBe("519 replies · last by SoCaled");
    expect(boardThreadSummary(t[0]!, 1)).toBe("1 new reply · last by SoCaled");
    expect(boardThreadSummary(t[1]!, null)).toBe("New thread by TDHudson");
  });
});

describe.each(backends)("following a board (%s)", (backend) => {
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start() {
    const clock = { now: NOW };
    const web = new FakeWeb();
    app = await createTestApp(backend, {}, clock, { fetcher: (url, options) => web.fetcher(url, options) });
    const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" }, headers: CSRF });
    const cookie = sessionCookie(setup)!;
    const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
      app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });
    const cards = async () => (await call("GET", "/api/items?filter=all")).json().items as Array<Record<string, any>>;
    return { clock, web, call, cards };
  }

  it("one card per thread (stickies left out, sub-forums in), back unread when it has new replies", async () => {
    const { clock, web, call, cards } = await start();
    const setBoard = (rows: Row[]) => web.set(BOARD, { body: boardPage(BOARD, rows, [MARKET, "https://vb.example/members-only/"]), contentType: "text/html" });
    // Pasted without the trailing slash; the forum redirects to the board's address.
    web.set("https://vb.example/tandem-cycling", { body: boardPage(BOARD, [sticky, forSale, rack, quiet], [MARKET, "https://vb.example/members-only/"]), contentType: "text/html", finalUrl: BOARD });
    setBoard([sticky, forSale, rack, quiet]);
    web.set(MARKET, { body: boardPage(MARKET, [rules, burley]), contentType: "text/html" });
    // https://vb.example/members-only/ isn't there (404): skipped.

    const src = (await call("POST", "/api/sources", { url: "https://vb.example/tandem-cycling" })).json();
    expect(src).toMatchObject({ kind: "board", feedUrl: BOARD, title: "Tandem Cycling - Bike Forums", status: "ok" });
    expect(web.requests.map((q) => q.url)).toEqual(["https://vb.example/tandem-cycling", MARKET, "https://vb.example/members-only/"]);
    let all = await cards();
    expect(all.map((c) => [c.title, c.read])).toEqual([
      ["Tandems found for sale", false],
      ["Front rack for T900", false],
      ["Burley Duet for sale", false],
      ["Quad or triple", true], // quiet for over a week
    ]);
    expect(all[0]).toMatchObject({
      sourceKind: "board",
      url: `${BOARD}1000939-tandems-found-for-sale.html`,
      author: "SoCaled",
      summary: "519 replies · last by SoCaled",
      publishedAt: Date.UTC(2026, 9, 27, 17, 55),
    });

    // Nothing new: the pages are read, no card changes.
    clock.now += 30 * 60_000;
    let before = web.requests.length;
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 0 });
    expect(web.requests.slice(before).map((q) => q.url)).toEqual([BOARD, MARKET, "https://vb.example/members-only/"]);

    // Read, then two replies: the card comes back, unread, with "2 new replies".
    const forSaleCard = all[0]!;
    await call("PATCH", `/api/items/${forSaleCard.id}`, { read: true });
    clock.now += 30 * 60_000;
    setBoard([sticky, { ...forSale, replies: 521, lastPostId: 23830000, when: "10-28-26 01:00 PM", lastPoster: "Stoker" }, rack, quiet]);
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 1 });
    all = await cards();
    expect(all[0]).toMatchObject({ id: forSaleCard.id, read: false, summary: "2 new replies · last by Stoker", author: "Stoker", publishedAt: Date.UTC(2026, 9, 28, 19) });

    // One more before it's read: the count adds up.
    clock.now += 30 * 60_000;
    setBoard([sticky, { ...forSale, replies: 522, lastPostId: 23830100, when: "10-28-26 01:20 PM", lastPoster: "Captain", lastPage: 22 }, rack, quiet]);
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 1 });
    expect((await cards())[0]).toMatchObject({ summary: "3 new replies · last by Captain" });

    // Opening it reads the page with the newest post straight away; the pager reaches the others.
    const T = `${BOARD}1000939-tandems-found-for-sale`;
    web.set(`${T}-22.html`, { body: threadPage(22, 22, "Newest reply"), contentType: "text/html" });
    web.set(`${T}-3.html`, { body: threadPage(3, 22, "An older reply"), contentType: "text/html" });
    before = web.requests.length;
    const newest = (await call("GET", `/api/items/${forSaleCard.id}/reader?page=last`)).json();
    expect(newest).toMatchObject({ kind: "page", pagination: { page: 22, pages: 22 } });
    expect(newest.html).toContain("Newest reply");
    expect(newest.html).toContain(`datetime="${new Date(Date.UTC(2026, 9, 28, 15)).toISOString()}"`); // 09:00 AM at GMT -6
    expect((await call("GET", `/api/items/${forSaleCard.id}/reader`)).json().pagination).toEqual({ page: 22, pages: 22 }); // the default
    expect((await call("GET", `/api/items/${forSaleCard.id}/reader?page=3`)).json()).toMatchObject({ pagination: { page: 3, pages: 22 } });
    expect(web.requests.slice(before).map((q) => q.url)).toEqual([`${T}-22.html`, `${T}-3.html`]);

    // A thread new to the board gets a card.
    clock.now += 30 * 60_000;
    const fresh: Row = { id: 1325000, title: "Kid-back conversion", starter: "Newbie", replies: 0, lastPostId: 23831000, when: "10-28-26 02:00 PM", lastPoster: "Newbie" };
    setBoard([sticky, fresh, { ...forSale, replies: 522, lastPostId: 23830100, when: "10-28-26 01:20 PM", lastPoster: "Captain", lastPage: 22 }, rack, quiet]);
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 1 });
    expect((await cards())[0]).toMatchObject({ title: "Kid-back conversion", summary: "New thread by Newbie", read: false });

    // A quiet thread moving up into the list (another one deleted) isn't news: it starts out read.
    clock.now += 30 * 60_000;
    const old: Row = { id: 1200000, title: "Old tandem question", starter: "Someone", replies: 4, lastPostId: 23000000, when: "01-10-26 10:00 AM", lastPoster: "Someone" };
    setBoard([sticky, fresh, { ...forSale, replies: 522, lastPostId: 23830100, when: "10-28-26 01:20 PM", lastPoster: "Captain", lastPage: 22 }, rack, quiet, old]);
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: true, newItems: 1 });
    expect((await cards()).find((c) => c.title === "Old tandem question")).toMatchObject({ read: true });

    // A board keeps its address, and isn't exported as a feed.
    expect((await call("PATCH", `/api/sources/${src.id}`, { url: "https://vb.example/other-board/" })).statusCode).toBe(400);
    const opml = await call("GET", "/api/sources/opml");
    expect(opml.statusCode).toBe(200);
    expect(opml.body).not.toContain("tandem-cycling");
  });

  it("a board's feed address still follows the feed", async () => {
    const { web, call } = await start();
    web.set("https://vb.example/external.php?type=RSS2&forumids=44", { body: rss("Bike Forums - Tandem Cycling", [{ guid: "t1", title: "Tandem", date: new Date(NOW).toISOString() }]) });
    expect((await call("POST", "/api/sources", { url: "https://vb.example/external.php?type=RSS2&forumids=44" })).json()).toMatchObject({ kind: "feed" });
  });

  it("a board whose page can't be read fails its check with the reason, and keeps its cards", async () => {
    const { clock, web, call, cards } = await start();
    web.set(BOARD, { body: boardPage(BOARD, [forSale]), contentType: "text/html" });
    const src = (await call("POST", "/api/sources", { url: BOARD })).json();
    web.set(BOARD, { body: "<html><body>Maintenance</body></html>", contentType: "text/html" });
    clock.now += 30 * 60_000;
    expect((await call("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ ok: false, error: expect.stringMatching(/list of threads/) });
    expect((await cards()).length).toBe(1);
  });
});
