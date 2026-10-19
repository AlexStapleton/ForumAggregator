import { describe, expect, it } from "vitest";
import { checkRobots, productToken } from "../src/sites/robots.js";
import { classifyResponse, detectSoftware, isRss } from "../src/sites/probe.js";
import { USER_AGENT } from "../src/sites/userAgent.js";
import { rssUrlFor } from "../src/tools/check-sites.js";

const ROBOTS = `
User-agent: ClaudeBot
User-agent: anthropic-ai
Disallow: /

User-agent: *
Disallow: /login/
Disallow: /search/
Disallow: /*?order=
Disallow: /posts/*/bookmark$
Allow: /search/help
`;

describe("robots.txt", () => {
  it("extracts the product token from a full user agent", () => {
    expect(productToken(USER_AGENT)).toBe("forumaggregator");
    expect(productToken("ClaudeBot/1.0")).toBe("claudebot");
  });

  it("applies the * group to this app and honours Disallow/Allow", () => {
    expect(checkRobots(ROBOTS, USER_AGENT, "/forums/tandem.12/").allowed).toBe(true);
    expect(checkRobots(ROBOTS, USER_AGENT, "/login/login")).toMatchObject({ allowed: false, group: "*", rule: "Disallow: /login/" });
    expect(checkRobots(ROBOTS, USER_AGENT, "/search/help").allowed).toBe(true); // longer Allow wins
    expect(checkRobots(ROBOTS, USER_AGENT, "/threads/x.1/?order=date").allowed).toBe(false);
    expect(checkRobots(ROBOTS, USER_AGENT, "/posts/5/bookmark").allowed).toBe(false);
    expect(checkRobots(ROBOTS, USER_AGENT, "/posts/5/bookmark/x").allowed).toBe(true); // $ anchors
  });

  it("uses a named group when one matches the agent", () => {
    expect(checkRobots(ROBOTS, "Mozilla/5.0 (compatible; ClaudeBot/1.0)", "/forums/")).toMatchObject({ allowed: false, group: "claudebot" });
  });

  it("allows everything when there is no applicable group", () => {
    expect(checkRobots("User-agent: OtherBot\nDisallow: /\n", USER_AGENT, "/x").allowed).toBe(true);
    expect(checkRobots("", USER_AGENT, "/x").allowed).toBe(true);
  });
});

describe("response classification", () => {
  const res = (status: number, body = "", headers: Record<string, string> = {}) => ({ status, body, headers });

  it("recognises bot challenges regardless of status code", () => {
    expect(classifyResponse(res(403, "<html><head><title>Just a moment...</title>"))).toBe("cloudflare_challenge");
    expect(classifyResponse(res(200, "", { "cf-mitigated": "challenge" }))).toBe("cloudflare_challenge");
    expect(classifyResponse(res(200, "<script>window.POW_CHALLENGE_DATA={}</script>"))).toBe("pow_challenge");
  });

  it("maps plain status codes", () => {
    expect(classifyResponse(res(200, "<html>forum</html>"))).toBe("ok");
    expect(classifyResponse(res(403))).toBe("blocked");
    expect(classifyResponse(res(429))).toBe("rate_limited");
    expect(classifyResponse(res(404))).toBe("not_found");
    expect(classifyResponse(res(502))).toBe("error");
  });

  it("detects XenForo from its cookies or markup", () => {
    expect(detectSoftware(res(200, "", { "set-cookie": "xf_csrf=abc; path=/" }))).toBe("xenforo");
    expect(detectSoftware(res(200, '<html id="XF" lang="en">'))).toBe("xenforo");
    expect(detectSoftware(res(200, "<html>"))).toBe("unknown");
  });

  it("recognises RSS", () => {
    expect(isRss(res(200, '<?xml version="1.0"?><rss version="2.0">', { "content-type": "application/rss+xml" }))).toBe(true);
    expect(isRss(res(200, "<?xml version=\"1.0\"?><errors>", { "content-type": "application/rss+xml" }))).toBe(false);
  });
});

describe("rssUrlFor", () => {
  it("maps boards, threads and the site root to XenForo feed URLs", () => {
    expect(rssUrlFor(new URL("https://f.example/tandem-cycling/"))).toBe("https://f.example/tandem-cycling/index.rss");
    expect(rssUrlFor(new URL("https://f.example/forums/gpus.12/"))).toBe("https://f.example/forums/gpus.12/index.rss");
    // A feed address is checked as is (it used to get a second /index.rss).
    expect(rssUrlFor(new URL("https://f.example/forums/gpus.12/index.rss"))).toBe("https://f.example/forums/gpus.12/index.rss");
    expect(rssUrlFor(new URL("https://f.example/threads/owners-club.1816698/"))).toBe("https://f.example/forums/-/index.rss");
    expect(rssUrlFor(new URL("https://f.example/"))).toBe("https://f.example/forums/-/index.rss");
  });
});
