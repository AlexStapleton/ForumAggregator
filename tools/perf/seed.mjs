// Usage: npm run build, then: node tools/perf/seed.mjs <empty data dir> [postgres://… (wiped!)]
// Seeds a "year of heavy use" database: 40 sources (tags), 100k items, 30% with stored bodies.
import crypto from "node:crypto";
import { sql } from "kysely";
import { openDb, migrate } from "../../packages/server/dist/db/index.js";
const [dataDir, databaseUrl] = process.argv.slice(2);
const db = openDb({ databaseUrl: databaseUrl || undefined, dataDir });
if (databaseUrl) await sql`DROP SCHEMA public CASCADE; CREATE SCHEMA public`.execute(db.kysely);
await migrate(db);
const now = Date.now();
const kinds = ["feed", "youtube", "reddit", "feed"];
const sources = Array.from({ length: 40 }, (_, i) => ({ id: crypto.randomUUID(), kind: kinds[i % 4], title: `Source ${i}`, site_url: `https://s${i}.example/`, feed_url: `https://s${i}.example/feed`, status: "ok", last_error: null, last_checked_at: now, last_success_at: now, next_check_at: now + 3600e3, poll_interval_minutes: null, retention_days: null, etag: null, last_modified: null, created_at: now, updated_at: now }));
await db.kysely.insertInto("sources").values(sources).execute();
await db.kysely.insertInto("source_tags").values(sources.flatMap((s, i) => [{ source_id: s.id, tag: ["news", "gpu", "peppers", "cycling"][i % 4] }, ...(i % 3 ? [] : [{ source_id: s.id, tag: "favs" }])])).execute();
const body = "<p>" + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(80) + "</p>";
const N = 100_000;
for (let off = 0; off < N; off += 500) {
  const rows = [], contents = [];
  for (let i = off; i < Math.min(N, off + 500); i++) {
    const id = crypto.randomUUID();
    const src = sources[i % 40];
    const published = now - i * 5 * 60_000 - Math.floor(Math.random() * 60_000);
    rows.push({ id, source_id: src.id, guid: `g${i}`, url: `https://s.example/${i}`, title: `Item ${i} about something interesting`, author: "someone", summary: "A summary of the item. ".repeat(8), image_url: i % 4 === 1 ? "https://i.example/t.jpg" : null, published_at: published, fetched_at: published, read: i > 600 ? 1 : 0, saved: i % 500 === 0 ? 1 : 0, read_at: null });
    if (i % 10 < 3) contents.push({ item_id: id, origin: "feed", status: "raw", html: body, error: null, fetched_at: published });
  }
  await db.kysely.insertInto("items").values(rows).execute();
  if (contents.length) await db.kysely.insertInto("item_content").values(contents).execute();
}
console.log(db.kind, "seeded", N, "items");
await db.close();
