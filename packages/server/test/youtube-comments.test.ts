// YouTube top comments with the user's API key, and the key setting (D-075).
import { afterEach, describe, expect, it } from "vitest";
import type { JsonFetcher } from "../src/feeds/fetch.js";
import { FakeWeb, rss } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const NOW = Date.UTC(2026, 9, 19, 12);
const GOOD_KEY = "AIzaSyTESTKEY_0123456789abcdefghijklmn";
const OTHER_KEY = "AIzaSyWRONGKEY_0123456789abcdefghijklm";

const apiError = (status: number, reason: string, message = "error") => ({ status, body: { error: { code: status, message, errors: [{ reason }] } } });

/** A fake YouTube Data API: answers by endpoint and key, and records every call. */
function fakeYouTube() {
  const calls: URL[] = [];
  let threads: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: {
      items: [
        {
          snippet: {
            topLevelComment: {
              id: "Ugx1",
              snippet: { authorDisplayName: "@gpu_fan", textDisplay: 'Great guide!<br><a href="https://www.youtube.com/watch?v=x&amp;t=60">1:00</a><script>x()</script>', publishedAt: "2026-10-19T10:00:00Z", likeCount: 42 },
            },
          },
        },
        { snippet: { topLevelComment: { id: "Ugx2", snippet: { authorDisplayName: "@second", textDisplay: "Thanks", publishedAt: "2026-10-19T11:00:00Z", likeCount: 3 } } } },
      ],
    },
  });
  const fetchJson: JsonFetcher = async (raw) => {
    const url = new URL(raw);
    calls.push(url);
    if (url.searchParams.get("key") !== GOOD_KEY) return apiError(400, "badRequest", "API key not valid. Please pass a valid API key.");
    if (url.pathname.endsWith("/videos")) return { status: 200, body: { items: [{ id: "jNQXAC9IVRw" }] } };
    if (url.pathname.endsWith("/commentThreads")) return threads();
    return { status: 404, body: null };
  };
  return { calls, fetchJson, setThreads: (fn: typeof threads) => (threads = fn) };
}

describe.each(backends)("YouTube comments (%s)", (backend) => {
  let app: TestApp | undefined;
  let cookie = "";
  let yt: ReturnType<typeof fakeYouTube>;
  const clock = { now: NOW };

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start() {
    clock.now = NOW;
    const web = new FakeWeb();
    yt = fakeYouTube();
    web.set("https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv", {
      body: rss("Creator", [{ guid: "v", title: "Undervolting", date: new Date(NOW).toISOString(), link: "https://www.youtube.com/watch?v=vid00000001" }]),
    });
    app = await createTestApp(backend, {}, clock, { fetcher: web.fetcher, fetchJson: yt.fetchJson });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" },
      headers: CSRF,
    });
    cookie = sessionCookie(res)!;
    await call("POST", "/api/sources", { url: "UCabcdefghijklmnopqrstuv" });
    return (await call("GET", "/api/items")).json().items[0] as { id: string };
  }
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
    app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });

  it("explains how to turn comments on when no key is set, without calling the API", async () => {
    const item = await start();
    expect((await call("GET", "/api/settings/youtube")).json()).toEqual({ configured: false, keyHint: null });
    const c = (await call("GET", `/api/items/${item.id}/comments`)).json();
    expect(c).toMatchObject({ available: false, comments: [], notice: expect.stringMatching(/API key in Settings/) });
    expect(yt.calls).toHaveLength(0);
  });

  it("checks a key before saving it, stores it encrypted, and never sends it back", async () => {
    await start();
    const badFormat = await call("PUT", "/api/settings/youtube", { apiKey: "not a key!" });
    expect(badFormat.statusCode).toBe(400);
    expect(badFormat.json().fields.apiKey).toMatch(/doesn't look like an API key.*AIza/);

    const rejected = await call("PUT", "/api/settings/youtube", { apiKey: OTHER_KEY });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: "youtube_keyInvalid", fields: { apiKey: expect.stringMatching(/isn't valid/) } });
    expect((await call("GET", "/api/settings/youtube")).json().configured).toBe(false);

    const saved = await call("PUT", "/api/settings/youtube", { apiKey: ` ${GOOD_KEY} ` });
    expect(saved.json()).toEqual({ configured: true, keyHint: "…klmn" });
    expect(saved.body).not.toContain(GOOD_KEY);
    const row = await app!.db.kysely.selectFrom("settings").select("value").where("key", "=", "youtube_api_key").executeTakeFirstOrThrow();
    expect(row.value).toMatch(/^v1:/);
    expect(row.value).not.toContain(GOOD_KEY);

    expect((await call("PUT", "/api/settings/youtube", { apiKey: null })).json()).toEqual({ configured: false, keyHint: null });
    // Changing settings needs the CSRF header like every other change.
    const noCsrf = await app!.fastify.inject({ method: "PUT", url: "/api/settings/youtube", payload: { apiKey: null }, headers: { cookie } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it("shows top comments, sanitised, with likes and links; caches them", async () => {
    const item = await start();
    await call("PUT", "/api/settings/youtube", { apiKey: GOOD_KEY });
    const c = (await call("GET", `/api/items/${item.id}/comments`)).json();
    expect(c.available).toBe(true);
    expect(c.notice).toBeNull();
    expect(c.comments).toHaveLength(2);
    expect(c.comments[0]).toMatchObject({
      author: "@gpu_fan",
      likes: 42,
      publishedAt: Date.parse("2026-10-19T10:00:00Z"),
      url: "https://www.youtube.com/watch?v=vid00000001&lc=Ugx1",
    });
    expect(c.comments[0].html).toContain("Great guide!");
    expect(c.comments[0].html).not.toMatch(/script|x\(\)/);
    const threadCall = yt.calls.find((u) => u.pathname.endsWith("/commentThreads"))!;
    expect(Object.fromEntries(threadCall.searchParams)).toMatchObject({ videoId: "vid00000001", order: "relevance", part: "snippet" });

    const before = yt.calls.length;
    await call("GET", `/api/items/${item.id}/comments`);
    expect(yt.calls.length).toBe(before); // cached for 15 minutes
    expect(JSON.stringify(c)).not.toContain(GOOD_KEY);
  });

  it("says why comments are missing: turned off, quota used up", async () => {
    const item = await start();
    await call("PUT", "/api/settings/youtube", { apiKey: GOOD_KEY });
    yt.setThreads(() => apiError(403, "commentsDisabled"));
    expect((await call("GET", `/api/items/${item.id}/comments`)).json()).toMatchObject({ comments: [], notice: "Comments are turned off for this video." });

    // "Turned off" is cached for the usual 15 minutes; move past it.
    clock.now += 16 * 60_000;
    yt.setThreads(() => apiError(403, "quotaExceeded"));
    const q = (await call("GET", `/api/items/${item.id}/comments`)).json();
    expect(q.notice).toMatch(/used up today's quota/);
  });
});
