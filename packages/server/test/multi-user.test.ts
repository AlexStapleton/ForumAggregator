// Several accounts (D-114) sharing the fetching of the sources they follow (D-115).
import { afterEach, describe, expect, it } from "vitest";
import { Migrator } from "kysely/migration";
import { sql } from "kysely";
import { migrationProvider } from "../src/db/migrations.js";
import { FakeWeb, rss } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 25, 12);
const DAY = 24 * 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const FEED = "https://site.example/feed.xml";
const THREAD = "https://forum.example/threads/tandem-talk.4242/";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** A XenForo thread page with posts `from`…`to`. */
function threadPage(from: number, to: number): string {
  const posts = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return `<!DOCTYPE html><html><head><title>Tandem talk | Forum</title></head><body><h1 class="p-title-value">Tandem talk</h1>
  ${posts
    .map(
      (id) => `<article class="message message--post js-post" data-author="Rider${id}" data-content="post-${id}" id="js-post-${id}">
      <div class="message-attribution-main"><time class="u-dt" datetime="2026-10-25T10:00:00+0000" data-time="${Math.floor((NOW - (100000 - id) * 1000) / 1000)}">Today</time></div>
      <article class="message-body"><div class="bbWrapper">Post ${id} about stokers.</div></article></article>`,
    )
    .join("")}</body></html>`;
}

describe.each(backends)("accounts (%s)", (backend) => {
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
    const admin = sessionCookie(setup)!;
    const as = (cookie: string) => (method: Method, url: string, payload?: object) =>
      app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });
    const anon = (method: Method, url: string, payload?: object) => app!.fastify.inject({ method, url, payload, headers: method === "GET" ? {} : CSRF });
    /** Invites someone and accepts as them; returns their cookie and the link's token. */
    const invite = async (username: string) => {
      const created = (await as(admin)("POST", "/api/admin/invites", { note: username })).json();
      const res = await anon("POST", "/api/auth/invite/accept", { token: created.token, username, password: "another long password" });
      expect(res.statusCode).toBe(200);
      return { cookie: sessionCookie(res)!, token: created.token as string };
    };
    return { clock, web, admin: as(admin), as, anon, invite };
  }

  it("saves thread positions per account, resumes with context, and rejects stale or unauthorized writes", async () => {
    const { admin, as, invite, web, clock } = await start();
    web.set(`${THREAD}latest`, { body: threadPage(1, 12), contentType: "text/html", finalUrl: THREAD });
    web.set(THREAD, { body: threadPage(1, 12), contentType: "text/html" });
    const source = (await admin("POST", "/api/sources", { url: THREAD })).json();
    const bob = as((await invite("bob")).cookie);
    const outsider = as((await invite("outsider")).cookie);
    await bob("POST", "/api/sources", { url: THREAD });
    const item = (await admin("GET", "/api/items?filter=all")).json().items[0];
    const reader = `/api/items/${item.id}/reader`;
    const position = `/api/items/${item.id}/thread-position`;
    expect((await admin("GET", reader)).json().threadProgress).toMatchObject({ readPostId: null, firstUnreadPostId: "1" });
    expect((await admin("PUT", position, { postId: 6 })).json()).toEqual({ saved: true });
    const resumed = (await admin("GET", reader)).json();
    expect(resumed.threadProgress).toMatchObject({ readPostId: 6, firstUnreadPostId: "7", tracking: true });
    expect(resumed.html).toContain('id="fa-post-4"');
    expect(resumed.html).not.toContain('id="fa-post-3"');
    expect(resumed.html).toContain("New replies");
    expect((await bob("GET", reader)).json().threadProgress.readPostId).toBeNull();
    expect((await outsider("PUT", position, { postId: 8 })).statusCode).toBe(404);
    for (const postId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "8"]) expect((await admin("PUT", position, { postId })).statusCode).toBe(400);
    await Promise.all([admin("PUT", position, { postId: 9 }), admin("PUT", position, { postId: 7 })]);
    expect((await admin("GET", reader)).json().threadProgress.readPostId).toBe(9);
    // The cached whole page is shared, but the progress overlay must remain account-specific.
    expect((await admin("GET", `${reader}?page=1`)).json().threadProgress.firstUnreadPostId).toBe("10");
    expect((await bob("GET", `${reader}?page=1`)).json().threadProgress.firstUnreadPostId).toBe("1");
    await admin("PATCH", `/api/items/${item.id}`, { read: true });
    web.set(`${THREAD}latest`, { body: threadPage(1, 14), contentType: "text/html", finalUrl: THREAD });
    clock.now += 60_000;
    await admin("POST", `/api/sources/${source.id}/check`);
    // Polling starts a new unread batch, but must not hide unfinished replies 10–12.
    expect((await admin("GET", reader)).json().threadProgress.firstUnreadPostId).toBe("10");
    await admin("PUT", position, { postId: 14 });
    const caughtUp = (await admin("GET", reader)).json();
    expect(caughtUp.threadProgress.firstUnreadPostId).toBeNull();
    expect(caughtUp.notice).toContain("caught up");
  });

  it("continues long stored batches in order and pauses position writes during catch-up", async () => {
    const { admin, web } = await start();
    web.set(`${THREAD}latest`, { body: threadPage(1, 150), contentType: "text/html", finalUrl: THREAD });
    const source = (await admin("POST", "/api/sources", { url: THREAD })).json();
    const item = (await admin("GET", "/api/items?filter=all")).json().items[0];
    const reader = `/api/items/${item.id}/reader`;
    const position = `/api/items/${item.id}/thread-position`;
    const first = (await admin("GET", reader)).json();
    expect(first.threadProgress).toMatchObject({ firstUnreadPostId: "1", hasMore: true });
    expect(first.html).toContain('id="fa-post-100"');
    expect(first.html).not.toContain('id="fa-post-101"');
    await admin("PUT", position, { postId: 100 });
    const next = (await admin("GET", reader)).json();
    expect(next.threadProgress).toMatchObject({ firstUnreadPostId: "101", hasMore: false });
    expect(next.html).toContain('id="fa-post-150"');
    await app!.db.kysely.updateTable("sources").set({ thread_catchup: JSON.stringify({ floor: 100, nextPage: 2, latestUrl: THREAD }) }).where("id", "=", source.id).execute();
    expect((await admin("GET", reader)).json().threadProgress.tracking).toBe(false);
    expect((await admin("PUT", position, { postId: 150 })).json()).toEqual({ saved: false });
    expect((await admin("GET", reader)).json().threadProgress.readPostId).toBe(100);
    await app!.db.kysely.updateTable("sources").set({ thread_catchup: null }).where("id", "=", source.id).execute();
    expect((await admin("PUT", position, { postId: 150 })).json()).toEqual({ saved: true });
  });

  it("the first account is the admin; invitation links make the others", async () => {
    const { admin, anon, as } = await start();
    expect((await admin("GET", "/api/auth/status")).json()).toMatchObject({ username: "alex", role: "admin" });

    const created = await admin("POST", "/api/admin/invites", { note: "Sam" });
    expect(created.statusCode).toBe(200);
    const { token, invite } = created.json();
    expect(invite).toMatchObject({ kind: "invite", note: "Sam", expiresAt: NOW + 7 * DAY });
    // Only the token's hash is stored.
    const stored = await app!.db.kysely.selectFrom("invites").select("id").execute();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).not.toContain(token);
    expect((await admin("GET", "/api/admin/invites")).json()).toHaveLength(1);

    expect((await anon("POST", "/api/auth/link", { token })).json()).toMatchObject({ kind: "invite", username: null });
    expect((await anon("POST", "/api/auth/link", { token: "x".repeat(43) })).statusCode).toBe(410);

    // A taken username leaves the link usable.
    const taken = await anon("POST", "/api/auth/invite/accept", { token, username: "alex", password: "another long password" });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().fields).toMatchObject({ username: "That username is taken" });
    const ok = await anon("POST", "/api/auth/invite/accept", { token, username: "Sam", password: "another long password" });
    expect(ok.statusCode).toBe(200);
    const sam = as(sessionCookie(ok)!);
    expect((await sam("GET", "/api/auth/status")).json()).toMatchObject({ username: "sam", role: "user", authenticated: true });

    // Used once only.
    expect((await anon("POST", "/api/auth/invite/accept", { token, username: "sam2", password: "another long password" })).statusCode).toBe(410);
    expect((await admin("GET", "/api/admin/invites")).json()).toHaveLength(0);
    expect((await anon("POST", "/api/auth/login", { username: "sam", password: "another long password" })).statusCode).toBe(200);
  });

  it("invitation links expire after 7 days, and can be cancelled", async () => {
    const { admin, anon, clock } = await start();
    const a = (await admin("POST", "/api/admin/invites", {})).json();
    const b = (await admin("POST", "/api/admin/invites", {})).json();
    expect((await admin("DELETE", `/api/admin/invites/${b.invite.id}`)).statusCode).toBe(200);
    expect((await anon("POST", "/api/auth/link", { token: b.token })).statusCode).toBe(410);
    clock.now += 7 * DAY + 1;
    expect((await anon("POST", "/api/auth/invite/accept", { token: a.token, username: "late", password: "another long password" })).statusCode).toBe(410);
  });

  it("only the admin manages accounts and the server-wide settings", async () => {
    const { invite, as } = await start();
    const sam = as((await invite("sam")).cookie);
    for (const [method, url] of [
      ["GET", "/api/admin/accounts"],
      ["POST", "/api/admin/invites"],
      ["GET", "/api/settings/checking"],
      ["PUT", "/api/settings/youtube"],
      ["GET", "/api/settings/flaresolverr"],
    ] as const) {
      expect((await sam(method, url, method === "GET" ? undefined : {})).statusCode, url).toBe(403);
    }
    // What every account needs from the server settings.
    expect((await sam("GET", "/api/config")).json()).toMatchObject({ flaresolverr: false, polling: { intervalMinutes: 30 } });
  });

  it("each account sees only its own sources and items", async () => {
    const { admin, invite, as, web } = await start();
    web.set(FEED, { body: rss("Site News", [{ guid: "a", title: "Fresh", date: iso(-3_600_000) }]) });
    const src = (await admin("POST", "/api/sources", { url: FEED, tags: ["news"] })).json();
    const item = (await admin("GET", "/api/items")).json().items[0];
    const sam = as((await invite("sam")).cookie);

    expect((await sam("GET", "/api/sources")).json()).toEqual([]);
    expect((await sam("GET", "/api/items?filter=all")).json().items).toEqual([]);
    expect((await sam("GET", "/api/tags")).json()).toEqual([]);
    expect((await sam("GET", `/api/items/${item.id}/reader`)).statusCode).toBe(404);
    expect((await sam("GET", `/api/items/${item.id}/comments`)).statusCode).toBe(404);
    expect((await sam("PATCH", `/api/items/${item.id}`, { saved: true })).statusCode).toBe(404);
    expect((await sam("PATCH", `/api/sources/${src.id}`, { title: "Mine now" })).statusCode).toBe(404);
    expect((await sam("POST", `/api/sources/${src.id}/check`)).statusCode).toBe(404);
    expect((await sam("POST", `/api/sources/${src.id}/reader-preview`, {})).statusCode).toBe(404);
    expect((await sam("DELETE", `/api/sources/${src.id}`)).statusCode).toBe(404);
    expect((await sam("POST", "/api/items/mark-read", {})).json()).toEqual({ updated: 0 });
    expect((await admin("GET", "/api/items")).json().items).toHaveLength(1); // still unread for alex
    expect((await sam("GET", "/api/sources/opml")).body).not.toContain(FEED);
  });

  it("a feed two accounts follow is one source, with read, saved, names and tags per account", async () => {
    const { admin, invite, as, web, clock } = await start();
    web.set(FEED, {
      body: rss("Site News", [
        { guid: "a", title: "Fresh", date: iso(-3_600_000) },
        { guid: "b", title: "Last month", date: iso(-30 * DAY) },
      ]),
    });
    const mine = (await admin("POST", "/api/sources", { url: FEED, tags: ["news"] })).json();
    expect(mine).toMatchObject({ canEditShared: true, unreadCount: 1 });
    const first = (await admin("GET", "/api/items")).json().items[0];
    await admin("PATCH", `/api/items/${first.id}`, { read: true, saved: true });

    clock.now += 2 * DAY;
    const sam = as((await invite("sam")).cookie);
    const fetchesBefore = web.requests.length;
    const theirs = await sam("POST", "/api/sources", { url: FEED, title: "Sam's news", tags: ["daily"] });
    expect(theirs.statusCode).toBe(201);
    expect(web.requests.length - fetchesBefore).toBe(1); // reading the address to know which feed it is
    expect(theirs.json()).toMatchObject({ id: mine.id, title: "Sam's news", tags: ["daily"], canEditShared: false, unreadCount: 1, itemCount: 2 });
    expect(await app!.db.kysely.selectFrom("sources").select("id").execute()).toHaveLength(1);
    expect((await sam("POST", "/api/sources", { url: FEED })).statusCode).toBe(409);

    // Each account's own marks.
    const samItems = (await sam("GET", "/api/items")).json().items;
    expect(samItems).toMatchObject([{ title: "Fresh", read: false, saved: false, sourceTitle: "Sam's news", tags: ["daily"] }]);
    expect((await sam("GET", "/api/items?filter=saved")).json().items).toEqual([]);
    expect((await admin("GET", "/api/items?filter=saved")).json().items).toMatchObject([{ title: "Fresh", sourceTitle: "Site News", tags: ["news"] }]);
    expect((await sam("GET", "/api/tags")).json()).toEqual([{ tag: "daily", sources: 1, unread: 1 }]);
    expect((await admin("GET", "/api/tags")).json()).toEqual([{ tag: "news", sources: 1, unread: 0 }]);
    expect((await sam("POST", "/api/items/mark-read", {})).json()).toEqual({ updated: 1 });
    expect((await admin("GET", "/api/items?filter=all")).json().items.find((i: { title: string }) => i.title === "Fresh")).toMatchObject({ read: true, saved: true });

    // A new item is unread for both; saved by anyone, it outlives retention.
    web.set(FEED, { body: rss("Site News", [{ guid: "c", title: "Newer", date: iso(2 * DAY - 60_000) }]) });
    await sam("POST", `/api/sources/${mine.id}/check`);
    expect((await admin("GET", "/api/items")).json().items.map((i: { title: string }) => i.title)).toEqual(["Newer"]);
    expect((await sam("GET", "/api/items")).json().items.map((i: { title: string }) => i.title)).toEqual(["Newer"]);

    // How it's checked is shared: the admin may change it, the other follower may not.
    const denied = await sam("PATCH", `/api/sources/${mine.id}`, { pollIntervalMinutes: 60 });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("shared_source");
    // Unchanged values, as an edit form sends them, are fine.
    expect((await sam("PATCH", `/api/sources/${mine.id}`, { title: "Renamed", pollIntervalMinutes: null, retentionDays: null })).statusCode).toBe(200);
    expect((await admin("PATCH", `/api/sources/${mine.id}`, { pollIntervalMinutes: 60 })).json()).toMatchObject({ pollIntervalMinutes: 60, title: "Site News" });
    expect((await sam("GET", `/api/sources`)).json()[0]).toMatchObject({ pollIntervalMinutes: 60, title: "Renamed" });

    // Paused by one, it's still checked for the other; paused by both, it isn't.
    expect((await sam("PATCH", `/api/sources/${mine.id}`, { enabled: false })).json()).toMatchObject({ enabled: false, status: "paused" });
    expect((await admin("GET", "/api/sources")).json()[0]).toMatchObject({ enabled: true });
    const due = async () => (await app!.db.kysely.selectFrom("sources").select(["enabled", "next_check_at"]).executeTakeFirstOrThrow());
    expect((await due()).enabled).toBe(1);
    await admin("PATCH", `/api/sources/${mine.id}`, { enabled: false });
    expect(await due()).toMatchObject({ enabled: 0, next_check_at: null });
    await sam("PATCH", `/api/sources/${mine.id}`, { enabled: true });
    expect(await due()).toMatchObject({ enabled: 1 });
    expect((await admin("GET", "/api/sources")).json()[0]).toMatchObject({ enabled: false, status: "paused" });

    // Moving to another address that someone else follows: only this follower moves, and the
    // shared settings of where they land aren't theirs to change.
    web.set("https://other.example/feed.xml", { body: rss("Other", [{ guid: "o", title: "Other item", date: iso(2 * DAY - 120_000) }]) });
    const other = (await admin("POST", "/api/sources", { url: "https://other.example/feed.xml" })).json();
    const moved = await sam("PATCH", `/api/sources/${mine.id}`, { url: "https://other.example/feed.xml", pollIntervalMinutes: 60, enabled: true });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ id: other.id, title: "Renamed", pollIntervalMinutes: null, canEditShared: false, enabled: true });
    expect((await admin("GET", "/api/sources")).json()).toHaveLength(2);
    await sam("PATCH", `/api/sources/${other.id}`, { url: FEED });
    await admin("DELETE", `/api/sources/${other.id}`);

    // Unfollowing removes only that account's view; the last one out removes the source.
    expect((await sam("DELETE", `/api/sources/${mine.id}`)).statusCode).toBe(200);
    expect((await admin("GET", "/api/sources")).json()).toHaveLength(1);
    expect(await app!.db.kysely.selectFrom("item_states").select("user_id").distinct().execute()).toHaveLength(1);
    expect((await admin("DELETE", `/api/sources/${mine.id}`)).statusCode).toBe(200);
    expect(await app!.db.kysely.selectFrom("sources").select("id").execute()).toHaveLength(0);
    expect(await app!.db.kysely.selectFrom("items").select("id").execute()).toHaveLength(0);
  });

  it("a followed thread has a card per account, each with its own new replies, without fetching it again", async () => {
    const { admin, invite, as, web, clock } = await start();
    web.set(`${THREAD}latest`, { body: threadPage(1000, 1004), contentType: "text/html", finalUrl: THREAD });
    const src = (await admin("POST", "/api/sources", { url: THREAD })).json();
    const card = async (call: typeof admin) => (await call("GET", "/api/items?filter=all")).json().items[0];
    const a1 = await card(admin);
    expect(a1.summary).toMatch(/^5 latest replies · Rider1004/);
    await admin("PATCH", `/api/items/${a1.id}`, { read: true });

    const sam = as((await invite("sam")).cookie);
    const before = web.requests.length;
    expect((await sam("POST", "/api/sources", { url: `${THREAD}page-1#post-1001` })).statusCode).toBe(201);
    expect(web.requests.length).toBe(before); // the stored posts are shared
    expect(await card(sam)).toMatchObject({ id: a1.id, read: false });
    expect((await card(sam)).summary).toMatch(/^5 latest replies/);

    // Two replies: unread again for both. Alex sees just the two; Sam (who hasn't read it yet) all seven.
    clock.now += 31 * 60_000;
    web.set(`${THREAD}latest`, { body: threadPage(1000, 1006), contentType: "text/html", finalUrl: THREAD });
    expect((await admin("POST", `/api/sources/${src.id}/check`)).json().result).toMatchObject({ newItems: 2 });
    expect(await card(admin)).toMatchObject({ read: false });
    expect((await card(admin)).summary).toMatch(/^2 new replies · Rider1006/);
    expect((await card(sam)).summary).toMatch(/^7 latest replies · Rider1006/);
    const adminReader = (await admin("GET", `/api/items/${a1.id}/reader`)).json();
    expect(adminReader.html.split("New replies</p>")[1]).not.toContain("Rider1004");
    const samReader = (await sam("GET", `/api/items/${a1.id}/reader`)).json();
    expect(samReader.html).toContain("Rider1000");

    // Sam reads it; one more reply → Sam's batch starts there, Alex's keeps growing.
    await sam("PATCH", `/api/items/${a1.id}`, { read: true });
    clock.now += 31 * 60_000;
    web.set(`${THREAD}latest`, { body: threadPage(1000, 1007), contentType: "text/html", finalUrl: THREAD });
    await sam("POST", `/api/sources/${src.id}/check`);
    expect((await card(sam)).summary).toMatch(/^1 new reply · Rider1007/);
    expect((await card(admin)).summary).toMatch(/^3 new replies · Rider1007/);
  });

  it("the admin turns accounts off and on, resets passwords, turns off two-factor, deletes accounts", async () => {
    const { admin, invite, as, anon, web } = await start();
    const { cookie } = await invite("sam");
    const sam = as(cookie);
    web.set(FEED, { body: rss("Site News", [{ guid: "a", title: "Fresh", date: iso(-3_600_000) }]) });
    web.set("https://only.example/feed.xml", { body: rss("Only Sam", [{ guid: "x", title: "X", date: iso(-3_600_000) }]) });
    await admin("POST", "/api/sources", { url: FEED });
    await sam("POST", "/api/sources", { url: FEED });
    await sam("POST", "/api/sources", { url: "https://only.example/feed.xml" });

    const accounts = (await admin("GET", "/api/admin/accounts")).json();
    expect(accounts).toMatchObject([
      { username: "alex", role: "admin", you: true, sourceCount: 1, disabled: false },
      { username: "sam", role: "user", you: false, sourceCount: 2, disabled: false, totpEnabled: false },
    ]);
    expect(accounts[1].lastSeenAt).toBe(NOW);
    const samId = accounts[1].id as string;
    const me = accounts[0].id as string;
    expect((await admin("PATCH", `/api/admin/accounts/${me}`, { disabled: true })).statusCode).toBe(400);
    expect((await admin("DELETE", `/api/admin/accounts/${me}`)).statusCode).toBe(400);

    // Turned off: signed out, can't log in, its own sources stop being checked (shared ones go on).
    expect((await admin("PATCH", `/api/admin/accounts/${samId}`, { disabled: true })).statusCode).toBe(200);
    const enabled = async () =>
      Object.fromEntries((await app!.db.kysely.selectFrom("sources").select(["feed_url", "enabled"]).execute()).map((r) => [r.feed_url, r.enabled]));
    expect(await enabled()).toEqual({ [FEED]: 1, "https://only.example/feed.xml": 0 });
    expect((await sam("GET", "/api/sources")).statusCode).toBe(401);
    const refused = await anon("POST", "/api/auth/login", { username: "sam", password: "another long password" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("disabled");
    // A wrong password still says only that.
    expect((await anon("POST", "/api/auth/login", { username: "sam", password: "wrong password here" })).statusCode).toBe(401);
    await admin("PATCH", `/api/admin/accounts/${samId}`, { disabled: false });
    expect(await enabled()).toEqual({ [FEED]: 1, "https://only.example/feed.xml": 1 });
    const back = await anon("POST", "/api/auth/login", { username: "sam", password: "another long password" });
    expect(back.statusCode).toBe(200);
    const sam2 = as(sessionCookie(back)!);

    // A reset link: one per account, signs it out everywhere when used.
    const reset = (await admin("POST", `/api/admin/accounts/${samId}/reset-link`)).json();
    expect(reset.invite).toMatchObject({ kind: "reset", username: "sam", expiresAt: NOW + DAY });
    expect((await anon("POST", "/api/auth/link", { token: reset.token })).json()).toMatchObject({ kind: "reset", username: "sam" });
    expect((await admin("POST", `/api/admin/accounts/${me}/reset-link`)).statusCode).toBe(400);
    expect((await anon("POST", "/api/auth/reset", { token: reset.token, password: "brand new passphrase" })).json()).toMatchObject({ ok: true, username: "sam" });
    expect((await sam2("GET", "/api/sources")).statusCode).toBe(401);
    expect((await anon("POST", "/api/auth/reset", { token: reset.token, password: "again new passphrase" })).statusCode).toBe(410);
    expect((await anon("POST", "/api/auth/login", { username: "sam", password: "another long password" })).statusCode).toBe(401);
    // An invitation token isn't a reset token, and the other way round.
    const inv = (await admin("POST", "/api/admin/invites", {})).json();
    expect((await anon("POST", "/api/auth/reset", { token: inv.token, password: "brand new passphrase 2" })).statusCode).toBe(410);

    // Two-factor off for a lost phone.
    await app!.db.kysely.updateTable("users").set({ totp_enabled: 1, totp_secret: "x" }).where("id", "=", samId).execute();
    expect((await admin("POST", `/api/admin/accounts/${samId}/totp-off`)).statusCode).toBe(200);
    expect(await app!.db.kysely.selectFrom("users").select(["totp_enabled", "totp_secret"]).where("id", "=", samId).executeTakeFirst()).toEqual({ totp_enabled: 0, totp_secret: null });

    // Deleted: its own sources go; the shared one stays for the admin.
    expect((await admin("DELETE", `/api/admin/accounts/${samId}`)).statusCode).toBe(200);
    expect((await admin("GET", "/api/admin/accounts")).json()).toHaveLength(1);
    const sources = await app!.db.kysely.selectFrom("sources").select("feed_url").execute();
    expect(sources).toEqual([{ feed_url: FEED }]);
    expect((await admin("GET", "/api/sources")).json()[0]).toMatchObject({ canEditShared: true });
  });

  it("behind an SSO proxy, each account is found by its username; invitations work with AUTH_MODE=proxy", async () => {
    const clock = { now: NOW };
    app = await createTestApp(backend, { AUTH_MODE: "proxy", AUTH_PROXY_TRUSTED: "127.0.0.1" }, clock);
    const sso = (user: string) => (method: Method, url: string, payload?: object) =>
      app!.fastify.inject({ method, url, payload, headers: { "remote-user": user, ...(method === "GET" ? {} : CSRF) } });
    const setup = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" }, headers: CSRF });
    expect(setup.statusCode).toBe(200);
    const { token } = (await sso("alex")("POST", "/api/admin/invites", {})).json();
    expect((await sso("sam")("GET", "/api/sources")).statusCode).toBe(401); // no account yet
    const accepted = await app.fastify.inject({ method: "POST", url: "/api/auth/invite/accept", payload: { token, username: "sam", password: "unused but required" }, headers: CSRF });
    expect(accepted.statusCode).toBe(200);
    expect(sessionCookie(accepted)).toBeUndefined(); // the proxy logs them in
    expect((await sso("sam")("GET", "/api/auth/status")).json()).toMatchObject({ username: "sam", role: "user", via: "proxy" });
    expect((await sso("sam")("GET", "/api/admin/accounts")).statusCode).toBe(403);
    const accounts = (await sso("alex")("GET", "/api/admin/accounts")).json();
    await sso("alex")("PATCH", `/api/admin/accounts/${accounts[1].id}`, { disabled: true });
    expect((await sso("sam")("GET", "/api/sources")).statusCode).toBe(401);
  });

  it("upgrading a single-account database: the account becomes the admin and keeps everything", async () => {
    // Start from the schema before accounts (0014) with data in it, then migrate.
    const { openDb } = await import("../src/db/index.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-upgrade-"));
    const db = openDb({ databaseUrl: backend === "postgres" ? process.env.TEST_DATABASE_URL : undefined, dataDir: dir });
    try {
      if (backend === "postgres") {
        await sql`drop schema public cascade`.execute(db.kysely);
        await sql`create schema public`.execute(db.kysely);
      }
      const migrator = new Migrator({ db: db.kysely, provider: migrationProvider });
      expect((await migrator.migrateTo("0014_known_devices")).error).toBeUndefined();
      const k = db.kysely as unknown as import("kysely").Kysely<any>;
      await k.insertInto("users").values({ id: "u1", username: "alex", password_hash: "h", totp_enabled: 0, created_at: 1, updated_at: 1 }).execute();
      await k.insertInto("sources").values({ id: "s1", kind: "thread", title: "Tandem talk", feed_url: THREAD, status: "ok", thread_batch_from: 555, created_at: 1, updated_at: 1 }).execute();
      await k.insertInto("source_tags").values({ source_id: "s1", tag: "bikes" }).execute();
      await k
        .insertInto("items")
        .values([
          { id: "i1", source_id: "s1", guid: "g1", title: "Read one", published_at: 10, fetched_at: 10, read: 1, saved: 0, read_at: 11 },
          { id: "i2", source_id: "s1", guid: "g2", title: "Saved one", published_at: 20, fetched_at: 20, read: 0, saved: 1 },
          { id: "i3", source_id: "s1", guid: "g3", title: "Unread one", published_at: 30, fetched_at: 30, read: 0, saved: 0 },
        ])
        .execute();
      expect((await migrator.migrateToLatest()).error).toBeUndefined();

      expect(await k.selectFrom("users").select(["username", "role", "disabled"]).execute()).toEqual([{ username: "alex", role: "admin", disabled: 0 }]);
      expect(await k.selectFrom("subscriptions").select(["user_id", "source_id", "title", "enabled", "thread_batch_from"]).execute()).toEqual([
        { user_id: "u1", source_id: "s1", title: "Tandem talk", enabled: 1, thread_batch_from: 555 },
      ]);
      expect(await k.selectFrom("subscription_tags").selectAll().execute()).toEqual([{ user_id: "u1", source_id: "s1", tag: "bikes" }]);
      expect(await k.selectFrom("item_states").selectAll().orderBy("item_id").execute()).toEqual([
        { user_id: "u1", item_id: "i1", source_id: "s1", read: 1, saved: 0, read_at: 11 },
        { user_id: "u1", item_id: "i2", source_id: "s1", read: 0, saved: 1, read_at: null },
        { user_id: "u1", item_id: "i3", source_id: "s1", read: 0, saved: 0, read_at: null },
      ]);

      // And back down, for a downgrade.
      expect((await migrator.migrateTo("0014_known_devices")).error).toBeUndefined();
      expect(await k.selectFrom("items").select(["id", "read", "saved"]).orderBy("id").execute()).toEqual([
        { id: "i1", read: 1, saved: 0 },
        { id: "i2", read: 0, saved: 1 },
        { id: "i3", read: 0, saved: 0 },
      ]);
      expect(await k.selectFrom("source_tags").selectAll().execute()).toEqual([{ source_id: "s1", tag: "bikes" }]);
    } finally {
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
