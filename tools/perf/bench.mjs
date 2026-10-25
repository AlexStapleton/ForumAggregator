// Usage: start the server on :8099 with FA_SETUP_CODE=TESTCODE-1234 and the seeded DATA_DIR, then
// node tools/perf/bench.mjs <label>   (ENC="br, gzip" to include compression; default uncompressed)
const base = "http://localhost:8099";
const label = process.argv[2] ?? "";
const h = { "x-fa-request": "1", "content-type": "application/json" };
let r = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: h, body: JSON.stringify({ setupCode: "TESTCODE-1234", username: "alex", password: "correct horse battery" }) });
if (r.status !== 200 && r.status !== 201) r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: h, body: JSON.stringify({ username: "alex", password: "correct horse battery" }) });
// The session cookie (login also sets the known-device cookie, D-111).
const cookie = r.headers.getSetCookie().find((c) => c.startsWith("fa_session=")).split(";")[0];
const enc = process.env.ENC ?? "identity";
const get = (p) => fetch(base + p, { headers: { cookie, "accept-encoding": enc } });
const sources = await (await get("/api/sources")).json();
const page1 = await (await get("/api/items?filter=all&limit=40")).json();
const deep = await (async () => { let c = page1.nextCursor; for (let i = 0; i < 50; i++) c = (await (await get(`/api/items?filter=all&limit=40&cursor=${c}`)).json()).nextCursor; return c; })();
const readerItem = (await (await get("/api/items?filter=all&limit=100")).json()).items.find((i) => i.sourceKind === "feed")?.id;
const cases = {
  "items unread": "/api/items?filter=unread&limit=40",
  "items all": "/api/items?filter=all&limit=40",
  "items all (page 51)": `/api/items?filter=all&limit=40&cursor=${deep}`,
  "items oldest first": "/api/items?filter=all&order=oldest&limit=40",
  "items saved": "/api/items?filter=saved&limit=40",
  "items tag": "/api/items?filter=all&tag=gpu&limit=40",
  "items 1 source": `/api/items?filter=all&sourceId=${sources[3].id}&limit=40`,
  "items excl 5 sources": `/api/items?filter=unread&excludeSourceIds=${sources.slice(0, 5).map((s) => s.id).join(",")}&limit=40`,
  "sources": "/api/sources",
  "tags": "/api/tags",
  "reader (stored body)": `/api/items/${readerItem}/reader`,
  "index.html": "/",
};
const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const out = [];
for (const [name, path] of Object.entries(cases)) {
  for (let i = 0; i < 5; i++) await (await get(path)).arrayBuffer(); // warm
  const t = [];
  let bytes = 0;
  for (let i = 0; i < 40; i++) {
    const s = performance.now();
    const res = await get(path);
    bytes = (await res.arrayBuffer()).byteLength;
    t.push(performance.now() - s);
  }
  out.push({ name, p50: +pct(t, 0.5).toFixed(1), p95: +pct(t, 0.95).toFixed(1), kB: +(bytes / 1024).toFixed(1) });
}
console.log(`--- ${label}`);
console.table(out);
