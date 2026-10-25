// Screenshots for the README, from made-up demo content (no real feeds, posts or people).
// Usage: npm run build, then: node tools/screenshots/demo.mjs [output dir, default docs/screenshots]
// Needs Playwright with Chromium, installed globally (npm i -g playwright && npx playwright install chromium);
// it isn't a project dependency.
// Starts the built app on :8099 with an empty temporary data folder and a stand-in "internet" on
// :8098 (a forum, a blog, a podcast). Pictures are generated SVG served to the browser only.
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const { chromium } = await import("playwright").catch(() =>
  import(path.join(execSync("npm root -g").toString().trim(), "playwright", "index.mjs")),
);

const out = path.resolve(process.argv[2] ?? "docs/screenshots");
fs.mkdirSync(out, { recursive: true });
const NOW = Date.now();
const ago = (h) => new Date(NOW - h * 3_600_000);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---- pictures: little generated landscapes, served as https://img.demo.example/<name>.jpg ----
const art = {
  aurora: ["#0b1d3a", "#1f6f6b", "#7ef0c2", "aurora"],
  glacier: ["#cfe8ff", "#7fb3e0", "#ffffff", "ice"],
  canyon: ["#f6c27a", "#c0602f", "#6b2a17", "rock"],
  reef: ["#0a4f7a", "#1fa3b8", "#ffd27a", "sea"],
  peppers: ["#163d12", "#3f8f2a", "#e8341c", "pods"],
  seedlings: ["#2b1b10", "#5b3a22", "#7dd35a", "pods"],
  podcast: ["#2a1450", "#6d28d9", "#f0abfc", "waves"],
};
function svg([a, b, c, kind]) {
  const shapes = {
    aurora: `<path d="M0 260 Q200 120 400 220 T800 180 V450 H0Z" fill="${c}" opacity=".35"/><path d="M0 300 Q250 200 520 280 T800 250 V450 H0Z" fill="${c}" opacity=".25"/><path d="M0 360 L180 300 L330 350 L520 290 L800 340 V450 H0Z" fill="#06101f"/>`,
    ice: `<path d="M0 300 L140 180 L260 260 L400 140 L560 250 L700 170 L800 230 V450 H0Z" fill="${c}"/><path d="M0 360 H800 V450 H0Z" fill="${b}"/>`,
    rock: `<path d="M0 220 L200 240 L260 380 L540 380 L600 230 L800 210 V450 H0Z" fill="${c}"/><path d="M260 380 L540 380 L520 450 L280 450Z" fill="#3a7bd5" opacity=".7"/>`,
    sea: `<circle cx="620" cy="90" r="50" fill="${c}"/><path d="M0 260 Q100 230 200 260 T400 260 T600 260 T800 260 V450 H0Z" fill="${b}"/><path d="M0 330 Q100 300 200 330 T400 330 T600 330 T800 330 V450 H0Z" fill="#0d6e8c"/>`,
    pods: `${[120, 260, 400, 540, 680].map((x, i) => `<path d="M${x} ${150 + (i % 2) * 40} q30 10 22 110 q-8 70 -40 40 q-20 -60 18 -150Z" fill="${c}"/><path d="M${x} ${150 + (i % 2) * 40} q-10 -30 10 -50" stroke="${b}" stroke-width="8" fill="none"/>`).join("")}`,
    waves: `${[0, 1, 2, 3, 4].map((i) => `<path d="M0 ${200 + i * 40} Q200 ${140 + i * 40} 400 ${200 + i * 40} T800 ${200 + i * 40}" stroke="${c}" stroke-width="10" fill="none" opacity="${1 - i * 0.18}"/>`).join("")}`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="800" height="450" fill="url(#g)"/>${shapes[kind]}</svg>`;
}
const img = (name) => `https://img.demo.example/${name}.jpg`;

// ---- a science blog (RSS with full articles) ----
const blogPosts = [
  ["aurora", "Why this autumn's auroras reach so far south", "Solar maximum is here, and with it the best aurora season in two decades. Here is what drives the glow, why it sometimes looks pink, and how to read the forecast before heading out."],
  ["glacier", "A year of satellite photos of one shrinking glacier", "We lined up 52 weekly images of the same valley glacier. The ice lost about 40 metres at its front, and the meltwater lake doubled in size."],
  ["reef", "Mapping coral reefs from space, one pixel at a time", "New ocean-colour instruments can tell healthy coral from bleached coral at a resolution of a few metres, which changes how reefs are surveyed."],
  ["canyon", "How rivers carve canyons faster than we thought", "Flash floods do most of the work: a single storm can move more rock than ten quiet years."],
];
const blogFeed = () => `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Planet Notes</title><link>http://127.0.0.1:8098/blog/</link>
${blogPosts.map(([pic, title, lead], i) => `<item><guid>blog-${i}</guid><title>${esc(title)}</title><link>http://127.0.0.1:8098/blog/${pic}</link><dc:creator>Sam Rivera</dc:creator><pubDate>${ago(3 + i * 20).toUTCString()}</pubDate>
<description>${esc(lead)}</description><content:encoded><![CDATA[<figure><img src="${img(pic)}" alt=""><figcaption>Illustration for this article.</figcaption></figure><p>${lead}</p>
<p>We compared what the instruments recorded with what people on the ground reported, week by week, and asked two researchers who work with this data every day to walk us through it.</p>
<p>The short version: the signal is real, it is stronger than in most years, and it is easy to see for yourself if you know when and where to look.</p>
<h3>What to look for</h3><p>Patterns repeat over weeks rather than days, so a single image can mislead. Line up a few weeks of pictures and the trend is hard to miss.</p>
<p>Free tools now make that easy: pick a place, pick a date range, and compare.</p>]]></content:encoded></item>`).join("\n")}
</channel></rss>`;

// ---- a podcast ----
// 27:41 of quiet 8-bit audio at 4 kHz (~6.6 MB), so the player shows the episode's real length.
const rate = 4000, secs = 27 * 60 + 41, n = rate * secs;
const wav = Buffer.alloc(44 + n, 128);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + n, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write("data", 36); wav.writeUInt32LE(n, 40);
const podcastFeed = () => `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Small Questions</title><link>http://127.0.0.1:8098/podcast/</link>
<item><guid>ep-42</guid><title>Do plants know what time it is?</title><link>http://127.0.0.1:8098/podcast/42</link><pubDate>${ago(5).toUTCString()}</pubDate><description>Plants keep a 24-hour clock without ever seeing one. We ask a botanist how it works, and why your peppers droop at night.</description>
<itunes:image href="${img("podcast")}"/><enclosure url="http://127.0.0.1:8098/podcast/ep42.wav" type="audio/wav"/><itunes:duration>27:41</itunes:duration><media:thumbnail xmlns:media="http://search.yahoo.com/mrss/" url="${img("podcast")}"/></item>
<item><guid>ep-41</guid><title>The surprisingly long history of the bicycle</title><link>http://127.0.0.1:8098/podcast/41</link><pubDate>${ago(80).toUTCString()}</pubDate><description>From wooden hobby-horses to carbon frames in fourteen minutes.</description><enclosure url="http://127.0.0.1:8098/podcast/ep42.wav" type="audio/wav"/><itunes:duration>14:05</itunes:duration><media:thumbnail xmlns:media="http://search.yahoo.com/mrss/" url="${img("podcast")}"/></item>
</channel></rss>`;

// ---- a XenForo forum: a board feed and a thread with pages ----
const people = ["PodPicker", "SeedSaver", "HabaneroHank", "Capsicum_Kate", "GreenThumbGus", "ChiliChris"];
const lines = [
  "Germination took nine days on a heat mat at 28 °C. Two of the six seeds came up so far.",
  "Nice! Keep the light close but not too close, they stretch fast at this stage.",
  "I switched to a coco and perlite mix this year and the roots look much healthier.",
  "First pods are setting on the Carolina Reapers. Going to pinch the early flowers on the others.",
  "How often are you feeding? Mine are getting yellow lower leaves.",
  "Every second watering, half strength. Yellow lower leaves usually means they want more nitrogen.",
  "Here's this week's update: twelve pods, three starting to turn red.",
  "That's a great haul for October. What variety is the tall one on the left?",
  "Aji Charapita. Tiny pods, huge plant. Taste is citrusy with a quick, sharp heat.",
  "Harvested the first batch today. Drying half and fermenting the rest for a sauce.",
];
const threadPosts = Array.from({ length: 47 }, (_, i) => ({ id: 5000 + i, author: people[i % people.length], text: lines[i % lines.length], at: NOW - (47 - i) * 5 * 3_600_000 }));
let shown = 44; // posts that "exist" so far; the demo adds three later
const T = "/threads/superhot-grow-log-2026.4321/";
function xfPage(page) {
  const all = threadPosts.slice(0, shown);
  const pages = Math.max(1, Math.ceil(all.length / 20));
  const posts = all.slice((page - 1) * 20, page * 20);
  return `<!DOCTYPE html><html><head><title>Superhot grow log 2026 | Page ${page} | Pepper Growers Forum</title></head><body>
  <h1 class="p-title-value">Superhot grow log 2026</h1>
  <nav class="pageNav"><ul>${Array.from({ length: pages }, (_, i) => `<li class="pageNav-page${i + 1 === page ? " pageNav-page--current" : ""}"><a>${i + 1}</a></li>`).join("")}</ul></nav>
  ${posts.map((p) => `<article class="message message--post" data-author="${p.author}" data-content="post-${p.id}">
    <header class="message-attribution"><div class="message-attribution-main"><time class="u-dt" datetime="${new Date(p.at).toISOString()}" data-time="${Math.floor(p.at / 1000)}">x</time></div></header>
    <article class="message-body"><div class="bbWrapper">${p.id % 7 === 3 ? `<blockquote class="bbCodeBlock bbCodeBlock--quote"><div class="bbCodeBlock-title">${people[(p.id + 5) % 6]} said:</div><div class="bbCodeBlock-content">${lines[(p.id + 9) % lines.length]}</div></blockquote>` : ""}${p.text}${p.id % 9 === 4 ? `<br><img src="${img(p.id % 2 ? "peppers" : "seedlings")}" class="bbImage">` : ""}</div></article></article>`).join("\n")}
  </body></html>`;
}
const boardFeed = () => `<?xml version="1.0"?><rss version="2.0"><channel><title>Pepper Growers Forum: Grow logs</title><link>http://127.0.0.1:8098/forums/grow-logs.12/</link>
<item><guid>t4321</guid><title>Superhot grow log 2026</title><link>http://127.0.0.1:8098${T}</link><pubDate>${ago(1).toUTCString()}</pubDate><description>Germination took nine days on a heat mat…</description></item>
<item><guid>t4320</guid><title>Best soil mix for container peppers?</title><link>http://127.0.0.1:8098${T}</link><pubDate>${ago(9).toUTCString()}</pubDate><description>I'm moving everything into 20-litre pots this year. What mix are you all using?</description></item>
</channel></rss>`;

const site = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (type, body) => res.writeHead(200, { "content-type": type }).end(body);
  if (u.pathname === "/blog/feed/") return send("application/rss+xml", blogFeed());
  if (u.pathname === "/podcast/feed/") return send("application/rss+xml", podcastFeed());
  if (u.pathname === "/podcast/ep42.wav") {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (!m) return res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "accept-ranges": "bytes" }).end(wav);
    const start = Number(m[1]), end = m[2] ? Number(m[2]) : wav.length - 1;
    return res.writeHead(206, { "content-type": "audio/wav", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${wav.length}`, "content-length": end - start + 1 }).end(wav.subarray(start, end + 1));
  }
  if (u.pathname === "/forums/grow-logs.12/index.rss") return send("application/rss+xml", boardFeed());
  if (u.pathname === `${T}latest`) {
    const pages = Math.ceil(shown / 20);
    return res.writeHead(302, { location: pages > 1 ? `${T}page-${pages}` : T }).end();
  }
  const m = new RegExp(`^${T}(?:page-(\\d+))?$`).exec(u.pathname);
  if (m) return send("text/html; charset=utf-8", xfPage(Number(m[1] ?? 1)));
  if (u.pathname.startsWith("/blog/")) return send("text/html", "<html><body><p>Demo page</p></body></html>");
  res.writeHead(404).end();
});
await new Promise((r) => site.listen(8098, "127.0.0.1", r));

// ---- the app ----
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-demo-"));
const app = spawn(process.execPath, ["packages/server/dist/index.js"], {
  env: { ...process.env, DATA_DIR: dataDir, FA_SETUP_CODE: "DEMO-SETUP-0001", PORT: "8099", COOKIE_SECURE: "false", LOG_LEVEL: "warn" },
  stdio: "inherit",
});
for (let i = 0; i < 50; i++) {
  try { if ((await fetch("http://localhost:8099/healthz")).ok) break; } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch().catch(() => chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }));
try {
  const setup = await browser.newContext();
  const api = async (method, p, data) => {
    const r = await setup.request.fetch(`http://localhost:8099${p}`, { method, headers: { "x-fa-request": "1" }, data });
    if (r.status() >= 400) throw new Error(`${method} ${p}: ${r.status()} ${await r.text()}`);
    return r.json();
  };
  await api("POST", "/api/auth/setup", { setupCode: "DEMO-SETUP-0001", username: "demo", password: "demo password 1234" });
  await api("POST", "/api/sources", { url: "http://127.0.0.1:8098/blog/feed/", tags: ["science"] });
  await api("POST", "/api/sources", { url: "http://127.0.0.1:8098/podcast/feed/", tags: ["podcasts"] });
  await api("POST", "/api/sources", { url: "http://127.0.0.1:8098/forums/grow-logs.12/", tags: ["peppers"] });
  const thread = await api("POST", "/api/sources", { url: `http://127.0.0.1:8098${T}`, tags: ["peppers"] });
  // Read the thread's card, then three replies arrive: the card shows them, with context.
  let items = (await api("GET", "/api/items?filter=all")).items;
  await api("PATCH", `/api/items/${items.find((i) => i.sourceKind === "thread").id}`, { read: true });
  shown = 47;
  await api("POST", `/api/sources/${thread.id}/check`);
  items = (await api("GET", "/api/items?filter=all")).items;
  // A couple read, one saved, so the feed looks lived-in.
  const blogItems = items.filter((i) => i.sourceTitle === "Planet Notes");
  await api("PATCH", `/api/items/${blogItems[2].id}`, { read: true });
  await api("PATCH", `/api/items/${blogItems[3].id}`, { read: true, saved: true });
  const state = await setup.storageState();

  // A time zone where it's mid-afternoon now, so the day headings read naturally whenever this runs.
  const shift = (((15 - new Date().getUTCHours()) % 24) + 24) % 24;
  const hours = shift > 12 ? shift - 24 : shift;
  const timezoneId = hours === 0 ? "Etc/UTC" : `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
  const context = async (opts) => {
    const ctx = await browser.newContext({ storageState: state, timezoneId, ...opts });
    await ctx.route("https://img.demo.example/**", (r) => r.fulfill({ contentType: "image/svg+xml", body: svg(art[new URL(r.request().url()).pathname.slice(1).replace(/\.jpg$/, "")] ?? art.aurora) }));
    return ctx;
  };
  const settle = (page) => page.waitForTimeout(600);
  const open = async (page, title) => {
    await page.locator(".item", { hasText: title }).first().locator(".item-meta").click();
    await page.locator(".reader-content, .audio").first().waitFor({ timeout: 30_000 });
  };

  // 1. Desktop, dark: the feed beside an article.
  let ctx = await context({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  let page = await ctx.newPage();
  await page.goto("http://localhost:8099/");
  await page.getByRole("tab", { name: /All/ }).click();
  await open(page, "auroras");
  await settle(page);
  await page.screenshot({ path: path.join(out, "feed-and-reader.png") });
  // 2. Desktop, light: a forum thread with the page bar.
  await ctx.close();
  ctx = await context({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  page = await ctx.newPage();
  await page.goto("http://localhost:8099/");
  await page.getByRole("tab", { name: /All/ }).click();
  await open(page, "Best soil mix");
  await page.locator(".reader-pager").waitFor();
  await settle(page);
  await page.screenshot({ path: path.join(out, "forum-thread.png") });
  await ctx.close();

  // 3–5. Phone (the reduced-colour copies in docs/screenshots were made with Pillow's quantize, 256 colours).
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  ctx = await context({ ...phone, colorScheme: "dark" });
  page = await ctx.newPage();
  await page.goto("http://localhost:8099/");
  await settle(page);
  await page.screenshot({ path: path.join(out, "phone-feed.png") });
  // The followed thread's card (the board lists the same thread too).
  await page.locator(".item:has(.kind-thread)").first().locator(".item-meta").click();
  await page.locator(".thread-context").waitFor({ timeout: 30_000 });
  await settle(page);
  await page.screenshot({ path: path.join(out, "phone-followed-thread.png") });
  await ctx.close();

  ctx = await context({ ...phone, colorScheme: "light" });
  // The place you stopped and your speed, as if listened to earlier on this phone.
  const episode = items.find((i) => i.title.startsWith("Do plants know"));
  await ctx.addInitScript(([id]) => {
    localStorage.setItem("fa.audioPositions", JSON.stringify({ [id]: { at: Date.now(), seconds: 754 } }));
    localStorage.setItem("fa.prefs", JSON.stringify({ playbackRate: 1.25 }));
  }, [episode.id]);
  page = await ctx.newPage();
  await page.goto("http://localhost:8099/");
  await open(page, "Do plants know");
  await page.getByText(/Resumed at/).waitFor({ timeout: 30_000 });
  await settle(page);
  await page.screenshot({ path: path.join(out, "phone-podcast.png") });
  await ctx.close();

  console.log(`screenshots in ${out}`);
} finally {
  await browser.close();
  app.kill();
  site.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
