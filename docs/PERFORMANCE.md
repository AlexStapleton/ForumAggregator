# Performance

Measured 2026-10-20 for the optimisation pass (D-086). Scripts: [`tools/perf/`](../tools/perf/).

## Method

- **Data:** `tools/perf/seed.mjs` builds "a year of heavy use": 40 sources with tags, 100,000
  items (600 unread, 200 saved), 30 % with a stored article body.
- **Server timings:** `tools/perf/bench.mjs` logs in and times each call the screens make,
  40 times after 5 warm-ups, on the build machine (x86, local disk). Numbers are the median
  (p50) in milliseconds, uncompressed so they show server work only. A Raspberry Pi 4 is
  several times slower in absolute terms; the ratios carry over.
- **Browser:** Playwright with the CPU slowed 4× (roughly a mid-range phone), and for the
  first visit a 1.6 Mbit/s, 150 ms link with the cache disabled.

## Results

### Server (SQLite, p50 ms)

| Call | Before | After | Why |
|---|---|---|---|
| `GET /api/sources` (every feed load) | 159 | **10** | Index `items(source_id, read)`: counts read the index only |
| `GET /api/tags` (every feed load) | 155 | **2.7** | Same index, used by the unread join |
| Items filtered by tag | 47 | **2.6** | `EXISTS` instead of `IN`: walks items newest first and stops at 41 |
| Opening an article (stored) | 11 | **1.9** | Finished reader HTML cached in memory (by content hash) |
| Other item lists | 2–4 | 2–3 | Already indexed |

Postgres (same data): sources 25 → 11 ms once autovacuum has run (index-only scan), saved
9.6 → 4.2 ms (new `items(saved, published_at)` index), reader 16.5 → 3.4 ms.

### Network

| What | Before | After |
|---|---|---|
| App JavaScript | 265 kB | **70 kB** (brotli, compressed at build time) |
| A page of 40 items | 21 kB | **2.7 kB** (compressed per response) |
| First visit on a slow mobile link, until the feed shows | 2.9 s (321 kB) | **1.85 s** (84 kB) |

### Browser (400 cards in the feed, phone-speed CPU, median)

| Action | Before | After |
|---|---|---|
| "Mark read" on a card | 119 ms | **40 ms** |
| Opening an item in the side-by-side view | 130 ms | **46 ms** |

Cards are memoised (only changed cards re-render) and off-screen cards skip layout and paint
(`content-visibility: auto`).

## Settings worth knowing

- SQLite runs with WAL, a 16 MB page cache, memory-mapped reads (up to 256 MB) and
  `PRAGMA optimize` at start-up.
- The reader's HTML cache holds at most 200 articles or ~16 MB of text.
- Nginx Proxy Manager doesn't need its own compression for this app; responses arrive already
  compressed (`Vary: Accept-Encoding` is set).
