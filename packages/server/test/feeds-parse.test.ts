import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFeeds } from "../src/feeds/discover.js";
import { FeedParseError, looksLikeFeed, parseFeed } from "../src/feeds/parse.js";
import { htmlToText, safeHttpUrl, truncate } from "../src/feeds/text.js";
import { channelIdFromPage, normaliseYouTubeInput, planYouTube } from "../src/feeds/youtube.js";

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures/feeds", name), "utf8");

describe("text helpers", () => {
  it("turns HTML into plain text and drops scripts", () => {
    expect(htmlToText("<p>Got <b>-100mV</b> &amp; cooler</p><script>alert(1)</script>")).toBe("Got -100mV & cooler");
    expect(htmlToText("a<br>b&nbsp;&hellip;")).toBe("a b …");
  });

  it("truncates on a word boundary", () => {
    expect(truncate("one two three four", 15)).toBe("one two three…");
    // A cut that would lose too much text keeps the partial word instead.
    expect(truncate("one two three four", 12)).toBe("one two thr…");
    expect(truncate("short", 12)).toBe("short");
  });

  it("only allows http(s) URLs", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,x")).toBeNull();
    expect(safeHttpUrl("/x", "https://a.example/b/")).toBe("https://a.example/x");
    expect(safeHttpUrl("  https://a.example ")).toBe("https://a.example/");
    expect(safeHttpUrl(42)).toBeNull();
  });
});

describe("parseFeed", () => {
  it("parses RSS 2.0, keeping everything safe and plain", () => {
    const feed = parseFeed(fixture("rss2.xml"), "https://forum.example/forums/gpus.12/index.rss");
    expect(feed).toMatchObject({ format: "rss", title: "Example Board & Friends", siteUrl: "https://forum.example/forums/gpus.12/" });
    expect(feed.items).toHaveLength(3);

    const [a, b, c] = feed.items;
    expect(a).toEqual({
      guid: "thread-100",
      url: "https://forum.example/threads/undervolt.100/",
      title: "RTX 5070 Ti undervolt results",
      author: "volt_fan",
      summary: "Got -100mV stable & cooler.",
      imageUrl: "https://forum.example/img/100.jpg",
      publishedAt: Date.UTC(2026, 9, 10, 18, 30),
    });
    // Number-like title stays a string; relative link resolved; bad date → null; image enclosure.
    expect(b).toMatchObject({ title: "1080", url: "https://forum.example/threads/relative.101/", publishedAt: null, imageUrl: "https://forum.example/img/101.png" });
    // javascript: link dropped, permalink guid used as the URL instead.
    expect(c).toMatchObject({ url: "https://forum.example/threads/safe-guid.102/", summary: "Long body only in content:encoded" });
  });

  it("parses Atom, preferring the alternate link", () => {
    const feed = parseFeed(fixture("atom.xml"), "https://blog.example/feed.atom");
    expect(feed).toMatchObject({ format: "atom", title: "Example Blog", siteUrl: "https://blog.example/" });
    expect(feed.items[0]).toMatchObject({
      guid: "tag:blog.example,2026:post-1",
      url: "https://blog.example/posts/1",
      title: "Tandem couplers explained",
      author: "Blog Author",
      summary: "Short summary.",
      publishedAt: Date.UTC(2026, 9, 9, 8),
    });
    expect(feed.items[1]).toMatchObject({ url: "https://blog.example/posts/2", author: "Guest Writer", summary: "Full content", publishedAt: Date.UTC(2026, 9, 8, 8) });
  });

  it("parses a YouTube channel feed with thumbnail and description", () => {
    const feed = parseFeed(fixture("youtube.xml"));
    expect(feed.title).toBe("Example Creator");
    expect(feed.items[0]).toMatchObject({
      guid: "yt:video:vid00000001",
      url: "https://www.youtube.com/watch?v=vid00000001",
      imageUrl: "https://i1.ytimg.com/vi/vid00000001/hqdefault.jpg",
      summary: "In this video we build a tent. Links below.",
      publishedAt: Date.UTC(2026, 9, 10, 15),
    });
  });

  it("parses RSS 1.0 (RDF)", () => {
    const feed = parseFeed(fixture("rdf.xml"));
    expect(feed).toMatchObject({ format: "rdf", title: "Old School" });
    expect(feed.items[0]).toMatchObject({ guid: "https://old.example/a", author: "someone", publishedAt: Date.UTC(2026, 9, 1, 12) });
  });

  it("rejects non-feeds and entity bombs", () => {
    expect(() => parseFeed("<html><body>hi</body></html>")).toThrow(FeedParseError);
    expect(() => parseFeed('<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><rss><channel/></rss>')).toThrow(/entity/i);
    expect(looksLikeFeed(fixture("atom.xml"))).toBe(true);
    expect(looksLikeFeed("<!doctype html><html>")).toBe(false);
  });
});

describe("discoverFeeds", () => {
  it("finds advertised RSS/Atom feeds and resolves relative URLs", () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/s.css">
      <link rel="alternate" type="application/rss+xml" title="Posts &amp; news" href="/feed.xml">
      <link type="application/atom+xml" href="https://blog.example/atom" rel="alternate">
      <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      <link rel="alternate" hreflang="de" href="/de/">
    </head></html>`;
    expect(discoverFeeds(html, "https://blog.example/some/page")).toEqual([
      { url: "https://blog.example/feed.xml", title: "Posts & news", type: "rss" },
      { url: "https://blog.example/atom", title: null, type: "atom" },
    ]);
  });
});

describe("YouTube", () => {
  it("maps channel, user, playlist and feed URLs directly", () => {
    const plan = (u: string) => planYouTube(new URL(u));
    expect(plan("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/videos")).toEqual({
      kind: "feed",
      feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv",
      siteUrl: "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
    });
    expect(plan("https://youtube.com/user/oldname")).toMatchObject({ kind: "feed", feedUrl: "https://www.youtube.com/feeds/videos.xml?user=oldname" });
    expect(plan("https://www.youtube.com/playlist?list=PL123")).toMatchObject({ feedUrl: "https://www.youtube.com/feeds/videos.xml?playlist_id=PL123" });
    expect(plan("https://www.youtube.com/@SomeCreator/featured")).toEqual({ kind: "lookup", pageUrl: "https://www.youtube.com/@SomeCreator" });
    expect(plan("https://example.com/@x")).toBeNull();
  });

  it("accepts a bare @handle", () => {
    expect(normaliseYouTubeInput(" @SomeCreator ")).toBe("https://www.youtube.com/@SomeCreator");
    expect(normaliseYouTubeInput("https://x.example")).toBe("https://x.example");
  });

  it("finds the channel ID on a channel page", () => {
    expect(channelIdFromPage('<link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv">')).toBe("UCabcdefghijklmnopqrstuv");
    expect(channelIdFromPage('..."externalId":"UCabcdefghijklmnopqrstuv",...')).toBe("UCabcdefghijklmnopqrstuv");
    expect(channelIdFromPage("<html>nothing</html>")).toBeNull();
  });
});
