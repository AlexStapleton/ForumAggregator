// YouTube channel feeds that fail on and off on YouTube's side (D-105): retries, the Data API with
// the user's key, and never pausing the source over it.
import { afterEach, describe, expect, it } from "vitest";
import { FetchError, type Fetcher, type JsonFetcher } from "../src/feeds/fetch.js";
import { migrations } from "../src/db/migrations.js";
import { FakeWeb } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

const NOW = Date.UTC(2026, 9, 25, 12);
const KEY = "AIzaSyTESTKEY_0123456789abcdefghijklmn";
const CHANNEL = "UCabcdefghijklmnopqrstuv";
const FEED = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`;

const youtubeFeed = (ids: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Example Creator</title><link rel="alternate" href="https://www.youtube.com/channel/${CHANNEL}"/>
  ${ids
    .map(
      (id, i) => `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId><title>Video ${id}</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/><author><name>Example Creator</name></author>
    <published>${new Date(NOW - i * 3_600_000).toISOString()}</published>
    <media:group><media:thumbnail url="https://i1.ytimg.com/vi/${id}/hqdefault.jpg" width="480" height="360"/><media:description>About ${id}</media:description></media:group></entry>`,
    )
    .join("")}
</feed>`;

describe.each(backends)("YouTube feed failures (%s)", (backend) => {
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;
  let cookie = "";
  const clock = { now: NOW };
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** The feed answers from `feedAnswers` in turn (a status fails, a list of IDs succeeds), then repeats the last. */
  async function start(feedAnswers: Array<number | string[]>) {
    clock.now = NOW;
    const web = new FakeWeb();
    const feedCalls: number[] = [];
    let i = 0;
    const fetcher: Fetcher = async (url, options) => {
      if (url !== FEED) return web.fetcher(url, options);
      const answer = feedAnswers[Math.min(i++, feedAnswers.length - 1)]!;
      feedCalls.push(typeof answer === "number" ? answer : 200);
      if (typeof answer === "number") throw new FetchError(answer === 404 ? "not_found" : "error", `HTTP ${answer}`, answer);
      return { kind: "ok", status: 200, url, body: youtubeFeed(answer), contentType: "application/atom+xml", etag: null, lastModified: null };
    };
    const apiCalls: URL[] = [];
    const fetchJson: JsonFetcher = async (raw) => {
      const url = new URL(raw);
      apiCalls.push(url);
      if (url.searchParams.get("key") !== KEY) return { status: 400, body: { error: { message: "API key not valid.", errors: [{ reason: "badRequest" }] } } };
      if (url.pathname.endsWith("/videos")) return { status: 200, body: { items: [{ id: "jNQXAC9IVRw" }] } };
      if (url.pathname.endsWith("/playlistItems")) {
        return {
          status: 200,
          body: {
            items: ["vid00000003", "vid00000002", "vid00000001"].map((id, n) => ({
              snippet: { title: `Video ${id}`, description: `About ${id}`, videoOwnerChannelTitle: "Example Creator", thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } }, publishedAt: new Date(NOW - n * 3_600_000).toISOString() },
              contentDetails: { videoId: id, videoPublishedAt: new Date(NOW - n * 3_600_000).toISOString() },
            })).concat([{ snippet: { title: "Private video" } as never, contentDetails: { videoId: "vidPRIVATE1" } as never }]),
          },
        };
      }
      return { status: 404, body: null };
    };
    app = await createTestApp(backend, {}, clock, { fetcher, fetchJson });
    const res = await app.fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" }, headers: CSRF });
    cookie = sessionCookie(res)!;
    return { feedCalls, apiCalls };
  }
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
    app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });
  const check = async (id: string) => (await call("POST", `/api/sources/${id}/check`)).json().result;

  it("retries a failing feed within one check", async () => {
    const { feedCalls } = await start([404, 500, ["vid00000001"]]);
    const added = await call("POST", "/api/sources", { url: CHANNEL });
    expect(added.statusCode).toBe(201);
    expect(feedCalls).toEqual([404, 500, 200]);
    expect((await call("GET", "/api/items")).json().items).toHaveLength(1);
  });

  it("without a key: says how to fix it, backs off, and never pauses the channel", async () => {
    await start([["vid00000001"], 404]);
    const src = (await call("POST", "/api/sources", { url: CHANNEL })).json();
    for (let n = 0; n < 7; n++) {
      clock.now += 7 * 3_600_000;
      const r = await check(src.id);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/isn't answering .* Add a YouTube API key in Settings .*\[HTTP 404\]/);
    }
    const after = (await call("GET", "/api/sources")).json()[0];
    expect(after.status).toBe("error");
    expect(after.nextCheckAt).not.toBeNull();
  });

  it("with a key: reads the channel through the API, without storing videos twice", async () => {
    const { feedCalls, apiCalls } = await start([["vid00000001"], 500, 500, 500, ["vid00000004", "vid00000003", "vid00000001"]]);
    expect((await call("PUT", "/api/settings/youtube", { apiKey: KEY })).statusCode).toBe(200);
    const src = (await call("POST", "/api/sources", { url: CHANNEL })).json();
    clock.now += 31 * 60_000;
    expect(await check(src.id)).toMatchObject({ ok: true, newItems: 2 }); // vid…3 and vid…2 (vid…1 known, the private one skipped)
    expect(feedCalls).toEqual([200, 500, 500, 500]);
    const playlist = apiCalls.find((u) => u.pathname.endsWith("/playlistItems"))!;
    expect(playlist.searchParams.get("playlistId")).toBe(`UU${CHANNEL.slice(2)}`);
    let items = (await call("GET", "/api/items?filter=all")).json().items as Array<{ url: string; title: string; imageUrl: string; sourceKind: string }>;
    expect(items.map((i) => i.title).sort()).toEqual(["Video vid00000001", "Video vid00000002", "Video vid00000003"]);
    expect(items.find((i) => i.title === "Video vid00000003")).toMatchObject({ url: "https://www.youtube.com/watch?v=vid00000003", imageUrl: "https://i.ytimg.com/vi/vid00000003/hqdefault.jpg", sourceKind: "youtube" });

    // The feed answers again: only the really new video is added.
    feedCalls.length = 0;
    clock.now += 31 * 60_000;
    await check(src.id);
    items = (await call("GET", "/api/items?filter=all")).json().items;
    expect(items.map((i) => i.title).sort()).toEqual(["Video vid00000001", "Video vid00000002", "Video vid00000003", "Video vid00000004"]);
  });

  it("migration 0012 resumes YouTube channels paused by those failures", async () => {
    await start([["vid00000001"]]);
    const src = (await call("POST", "/api/sources", { url: CHANNEL })).json();
    await app!.db.kysely.updateTable("sources").set({ status: "paused", next_check_at: null, consecutive_failures: 5 }).where("id", "=", src.id).execute();
    await migrations["0012_resume_paused_youtube"]!.up(app!.db.kysely);
    const row = await app!.db.kysely.selectFrom("sources").select(["status", "next_check_at", "consecutive_failures"]).where("id", "=", src.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "error", consecutive_failures: 0 });
    expect(row.next_check_at).not.toBeNull();
  });
});
