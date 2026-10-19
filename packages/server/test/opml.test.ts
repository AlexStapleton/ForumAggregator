// OPML import/export (D-073).
import { afterEach, describe, expect, it } from "vitest";
import { buildOpml, OpmlError, parseOpml } from "../src/feeds/opml.js";
import { FakeWeb, rss } from "./fakeWeb.js";
import { backends, createTestApp, CSRF, SETUP_CODE, sessionCookie } from "./helpers.js";

// The shape other readers export: folders for categories, attributes in mixed case.
const FROM_ANOTHER_READER = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>My feeds</title></head>
  <body>
    <outline text="Tech News" title="Tech News">
      <outline type="rss" text="Ars &amp; Co" xmlUrl="https://ars.example/feed" htmlUrl="https://ars.example/"/>
      <outline text="GPUs">
        <outline type="rss" text="GPU Blog" xmlUrl="https://gpu.example/rss" category="/hardware,/Overclocking"/>
      </outline>
    </outline>
    <outline type="rss" text="Loose feed" xmlUrl="https://loose.example/atom.xml"/>
    <outline type="rss" text="Bad scheme" xmlUrl="javascript:alert(1)"/>
    <outline text="Empty folder"/>
  </body>
</opml>`;

describe("parseOpml", () => {
  it("reads feeds with folders and categories as tags", () => {
    expect(parseOpml(FROM_ANOTHER_READER)).toEqual([
      { feedUrl: "https://ars.example/feed", title: "Ars & Co", siteUrl: "https://ars.example/", tags: ["tech-news"] },
      { feedUrl: "https://gpu.example/rss", title: "GPU Blog", siteUrl: null, tags: ["tech-news", "gpus", "hardware", "overclocking"] },
      { feedUrl: "https://loose.example/atom.xml", title: "Loose feed", siteUrl: null, tags: [] },
      { feedUrl: "javascript:alert(1)", title: "Bad scheme", siteUrl: null, tags: [] },
    ]);
  });

  it("rejects files that aren't OPML or that declare entities", () => {
    expect(() => parseOpml("<rss><channel/></rss>")).toThrow(OpmlError);
    expect(() => parseOpml("not xml at all <<<")).toThrow(OpmlError);
    expect(() => parseOpml(`<!DOCTYPE opml [<!ENTITY a "aaaa">]><opml><body/></opml>`)).toThrow(/entity/);
  });

  it("round-trips its own export, escaping names and URLs", () => {
    const xml = buildOpml(
      [
        { title: "B <News> & \"More\"", feedUrl: "https://b.example/rss?a=1&b=2", siteUrl: "https://b.example/", tags: ["news", "world"] },
        { title: "A blog", feedUrl: "https://a.example/feed", siteUrl: null, tags: [] },
      ],
      Date.UTC(2026, 9, 19),
    );
    expect(xml).toContain(`<outline text="news" title="news">`);
    expect(xml).toContain(`xmlUrl="https://b.example/rss?a=1&amp;b=2"`);
    expect(parseOpml(xml)).toEqual([
      // First tag is the folder, all tags are in `category`, so nothing is lost or duplicated.
      { feedUrl: "https://b.example/rss?a=1&b=2", title: 'B <News> & "More"', siteUrl: "https://b.example/", tags: ["news", "world"] },
      { feedUrl: "https://a.example/feed", title: "A blog", siteUrl: null, tags: [] },
    ]);
  });
});

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
const NOW = Date.UTC(2026, 9, 19, 12);

describe.each(backends)("OPML API (%s)", (backend) => {
  let app: TestApp | undefined;
  let cookie = "";
  let web: FakeWeb;
  const clock = { now: NOW };

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start() {
    clock.now = NOW;
    web = new FakeWeb();
    app = await createTestApp(backend, {}, clock, { fetcher: web.fetcher });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { setupCode: SETUP_CODE, username: "alex", password: "correct horse battery" },
      headers: CSRF,
    });
    cookie = sessionCookie(res)!;
  }
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    app!.fastify.inject({ method, url, payload, headers: { cookie, ...(method === "GET" ? {} : CSRF) } });

  it("imports new feeds without fetching, skips duplicates, then the scheduler checks them", async () => {
    await start();
    web.set("https://ars.example/feed", { body: rss("Ars", [{ guid: "1", title: "Hello", date: new Date(NOW - 60_000).toISOString() }]) });
    await call("POST", "/api/sources", { url: "https://ars.example/feed" });
    const before = web.requests.length;

    const opml = FROM_ANOTHER_READER.replace("</body>", `
      <outline type="rss" text="Old reddit" xmlUrl="https://old.reddit.com/r/overclocking/.rss"/>
      <outline type="rss" text="Channel" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890123456789012"/>
      <outline type="rss" text="Loose again" xmlUrl="https://loose.example/atom.xml"/>
    </body>`);
    const res = await call("POST", "/api/sources/opml", { opml });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      added: 4,
      skipped: [
        { url: "https://ars.example/feed", title: "Ars & Co", reason: "Already followed" },
        { url: "javascript:alert(1)", title: "Bad scheme", reason: "Not an http(s) feed address" },
        { url: "https://loose.example/atom.xml", title: "Loose again", reason: "Already followed" },
      ],
    });
    expect(web.requests.length).toBe(before); // nothing fetched during the import

    const sources = (await call("GET", "/api/sources")).json() as Array<{ title: string; kind: string; feedUrl: string; status: string; tags: string[] }>;
    const byTitle = Object.fromEntries(sources.map((s) => [s.title, s]));
    expect(byTitle["GPU Blog"]).toMatchObject({ kind: "feed", status: "pending", tags: ["gpus", "hardware", "overclocking", "tech-news"] });
    // Reddit links move to www (old.reddit disallows bots); YouTube feeds get the YouTube kind.
    expect(byTitle["Old reddit"]).toMatchObject({ kind: "reddit", feedUrl: "https://www.reddit.com/r/overclocking/.rss" });
    expect(byTitle["Channel"]).toMatchObject({ kind: "youtube" });

    web.set("https://gpu.example/rss", { body: rss("GPU", [{ guid: "g", title: "Undervolting", date: new Date(NOW).toISOString() }]) });
    expect(await app!.feeds.dueSourceIds()).toHaveLength(4);
    await app!.feeds.checkSource((sources.find((s) => s.title === "GPU Blog") as unknown as { id: string }).id);
    expect((await call("GET", "/api/items?tag=hardware")).json().items.map((i: { title: string }) => i.title)).toEqual(["Undervolting"]);
  });

  it("exports every source as OPML, and rejects bad files", async () => {
    await start();
    web.set("https://ars.example/feed", { body: rss("Ars", []) });
    await call("POST", "/api/sources", { url: "https://ars.example/feed", tags: ["news"] });
    const res = await call("GET", "/api/sources/opml");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/x-opml/);
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="forumaggregator-\d{4}-\d{2}-\d{2}\.opml"/);
    expect(parseOpml(res.body)).toEqual([{ feedUrl: "https://ars.example/feed", title: "Ars", siteUrl: expect.any(String), tags: ["news"] }]);

    const bad = await call("POST", "/api/sources/opml", { opml: "<html></html>" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_opml");
    // Needs the CSRF header like every other change.
    const noCsrf = await app!.fastify.inject({ method: "POST", url: "/api/sources/opml", payload: { opml: FROM_ANOTHER_READER }, headers: { cookie } });
    expect(noCsrf.statusCode).toBe(403);
  });
});
