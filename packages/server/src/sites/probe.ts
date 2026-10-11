// Classifies what a forum served us: a normal page, a bot challenge, or a block.
// Used by the site-check tool now and by the fetcher later (to stop and report
// instead of hammering a site that is challenging us).

export type ResponseKind =
  | "ok"
  | "cloudflare_challenge"
  | "pow_challenge"
  | "blocked"
  | "rate_limited"
  | "not_found"
  | "error";

export interface ProbeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function classifyResponse(res: ProbeResponse): ResponseKind {
  const h = (name: string) => res.headers[name.toLowerCase()] ?? "";
  if (h("cf-mitigated") === "challenge" || /<title>Just a moment\.\.\.<\/title>/i.test(res.body) || res.body.includes("/cdn-cgi/challenge-platform/")) {
    return "cloudflare_challenge";
  }
  if (res.body.includes("POW_CHALLENGE_DATA")) return "pow_challenge";
  if (res.status === 429) return "rate_limited";
  if (res.status === 404) return "not_found";
  if (res.status === 401 || res.status === 403) return "blocked";
  if (res.status >= 200 && res.status < 300) return "ok";
  return "error";
}

export type ForumSoftware = "xenforo" | "unknown";

export function detectSoftware(res: ProbeResponse): ForumSoftware {
  const cookies = res.headers["set-cookie"] ?? "";
  if (/\bxf_(csrf|session|user)=/.test(cookies)) return "xenforo";
  if (/<html[^>]+id="XF"/i.test(res.body) || /data-app="public"[^>]*data-template=/.test(res.body)) return "xenforo";
  return "unknown";
}

export function isRss(res: ProbeResponse): boolean {
  return /application\/(rss|atom)\+xml|text\/xml|application\/xml/.test(res.headers["content-type"] ?? "") && /<(rss|feed)[\s>]/.test(res.body);
}

export const KIND_HELP: Record<ResponseKind, string> = {
  ok: "reachable",
  cloudflare_challenge: "Cloudflare browser check ('Just a moment...'): plain requests are not let through",
  pow_challenge: "JavaScript proof-of-work bot check: plain requests are not let through",
  blocked: "refused (401/403)",
  rate_limited: "rate limited (429): slow down",
  not_found: "not found (404)",
  error: "unexpected response",
};
