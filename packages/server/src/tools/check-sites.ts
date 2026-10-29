// Site check: what does each forum serve to *this* server?
//
//   docker compose exec forumaggregator node packages/server/dist/tools/check-sites.js [url ...]
//
// With no URLs it checks the addresses the user gave for the forums in DESIGN.md §1. Makes at most 3 requests per site,
// 5 s apart, never touches login pages and skips anything robots.txt disallows.
import { checkRobots } from "../sites/robots.js";
import { classifyResponse, detectSoftware, isRss, KIND_HELP, type ProbeResponse, type ResponseKind } from "../sites/probe.js";
import { USER_AGENT } from "../sites/userAgent.js";
import { OutboundPolicy } from "../feeds/outbound.js";
import { splitList } from "../env.js";

const DEFAULT_TARGETS = [
  "https://thehotpepper.com/",
  "https://www.overclock.net/threads/official-nvidia-rtx-5070-ti-owners-club.1816698/",
  "https://www.bikeforums.net/tandem-cycling/",
];
const DELAY_MS = 5000;
const MAX_BODY = 2 * 1024 * 1024;

interface CheckResult {
  url: string;
  kind: ResponseKind | "skipped_robots";
  status?: number;
  note?: string;
}

interface SiteReport {
  target: string;
  software?: string;
  robots: CheckResult;
  page: CheckResult;
  rss?: CheckResult;
  loginAllowedByRobots?: boolean;
  verdict: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchProbe(url: string): Promise<ProbeResponse> {
  const policy = new OutboundPolicy(splitList(process.env.FA_ALLOWED_INTERNAL_ORIGINS ?? ""));
  const res = await policy.fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,application/rss+xml;q=0.9,*/*;q=0.8" },
    signal: AbortSignal.timeout(20_000),
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  headers["set-cookie"] = res.headers.getSetCookie().join("\n");
  const body = (await res.text()).slice(0, MAX_BODY);
  return { status: res.status, headers, body };
}

async function check(url: string): Promise<CheckResult & { res?: ProbeResponse }> {
  try {
    const res = await fetchProbe(url);
    return { url, kind: classifyResponse(res), status: res.status, res };
  } catch (err) {
    const e = err as Error & { cause?: { message?: string; code?: string } };
    return { url, kind: "error", note: e.cause?.code ?? e.cause?.message ?? e.message };
  }
}

export function rssUrlFor(target: URL): string {
  // XenForo: every forum (board) has <board>/index.rss and the site-wide feed is
  // /forums/-/index.rss. Threads have no feed, so a thread URL checks the site-wide one.
  const path = target.pathname.replace(/\/$/, "");
  // Already a feed address: check that one.
  if (/(\.rss|\.xml|\/feed|\/rss)$/i.test(path)) return `${target.origin}${path}`;
  if (path === "" || path === "/forums" || path.startsWith("/threads/")) return `${target.origin}/forums/-/index.rss`;
  return `${target.origin}${path}/index.rss`;
}

export async function checkSite(target: string): Promise<SiteReport> {
  const url = new URL(target);
  const robots = await check(`${url.origin}/robots.txt`);
  const robotsTxt = robots.kind === "ok" ? robots.res!.body : "";
  const allowed = (path: string) => (robotsTxt ? checkRobots(robotsTxt, USER_AGENT, path).allowed : true);

  await sleep(DELAY_MS);
  let page: CheckResult & { res?: ProbeResponse };
  if (allowed(url.pathname)) page = await check(url.href);
  else page = { url: url.href, kind: "skipped_robots" };

  let rss: CheckResult | undefined;
  const rssUrl = rssUrlFor(url);
  if (allowed(new URL(rssUrl).pathname)) {
    await sleep(DELAY_MS);
    const r = await check(rssUrl);
    rss = { url: r.url, kind: r.kind === "ok" && r.res && !isRss(r.res) ? "error" : r.kind, status: r.status, note: r.kind === "ok" && r.res && !isRss(r.res) ? "not an RSS feed" : r.note };
  } else {
    rss = { url: rssUrl, kind: "skipped_robots" };
  }

  const software = page.res ? detectSoftware(page.res) : undefined;
  const pageOk = page.kind === "ok";
  const rssOk = rss?.kind === "ok";
  const verdict = pageOk
    ? "Direct reading should work from this server."
    : rssOk
      ? "Pages are blocked, but the RSS feed works: new threads can be followed via RSS; replies need another route."
      : "Neither pages nor RSS are reachable from this server: this site needs another route (see SITE-ACCESS.md).";

  return {
    target,
    software,
    robots: { url: robots.url, kind: robots.kind, status: robots.status, note: robots.note },
    page: { url: page.url, kind: page.kind, status: page.status, note: page.note },
    rss,
    loginAllowedByRobots: robotsTxt ? allowed("/login/login") : undefined,
    verdict,
  };
}

function describe(r: CheckResult): string {
  if (r.kind === "skipped_robots") return "skipped (robots.txt disallows it)";
  const help = KIND_HELP[r.kind];
  return `${help}${r.status ? ` [HTTP ${r.status}]` : ""}${r.note ? ` (${r.note})` : ""}`;
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const targets = args.filter((a) => !a.startsWith("--"));
  const list = targets.length ? targets : DEFAULT_TARGETS;
  const reports: SiteReport[] = [];
  for (const t of list) {
    if (!json) console.log(`Checking ${t} …`);
    reports.push(await checkSite(t));
  }
  if (json) {
    console.log(JSON.stringify({ userAgent: USER_AGENT, reports }, null, 2));
    return;
  }
  console.log(`\nUser-Agent: ${USER_AGENT}\n`);
  for (const r of reports) {
    console.log(`■ ${r.target}`);
    console.log(`  forum software : ${r.software ?? "unknown (page not readable)"}`);
    console.log(`  robots.txt     : ${describe(r.robots)}`);
    console.log(`  page           : ${describe(r.page)}`);
    if (r.rss) console.log(`  RSS            : ${describe(r.rss)}  ${r.rss.url}`);
    if (r.loginAllowedByRobots !== undefined) {
      console.log(`  /login/ in robots.txt: ${r.loginAllowedByRobots ? "allowed" : "disallowed for automated clients"}`);
    }
    console.log(`  → ${r.verdict}\n`);
  }
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
