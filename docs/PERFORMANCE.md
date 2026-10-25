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

## Accounts (2026-10-25, D-115)

Read and saved moved from the item row to a per-account table. Same data (100k items, now in
one account, a state row per item), p50 ms:

| Call | SQLite before | SQLite now | Postgres now (after `vacuum analyze`) |
|---|---|---|---|
| `GET /api/items` (unread, all, saved, tag, one source) | 1.6–2.6 | 1.7–2.9 | 3.4–9 |
| `GET /api/sources` | 9–10 | **10.5** | 10.9 |
| `GET /api/tags` | 1.7–2.7 | **1.9** | 3.4 |

The first design kept a row only for items read or saved ("no row = unread"); counting unread
then meant visiting every item, and sources took 163 ms and tags 227 ms. With a row per item and
the index `item_states(user_id, source_id, read)`, both read only that index.

## Second pass (2026-10-25, D-107)

The list and article calls above were re-measured on the same data and are unchanged
(items 1.6–2.1 ms, sources 9 ms, tags 1.7 ms, a stored article 1.5 ms). This pass looked at what
was added since: forum threads, followed threads, page reading and card pictures. Page timings use
the user's saved pages (Overclock.net 820 kB, Bike Forums 790 kB, NPR 250 kB), read locally.

### Reading forum pages

| What | Before | After | Why |
|---|---|---|---|
| Reading an Overclock.net thread page (build machine) | 466 ms | **316 ms** | Scripts, styles, inline SVG and comments (40 % of that page) are dropped before the page is built; extraction never used them |
| Slowest answer to any other request while a thread page is read | 413 ms | **69 ms** | Pages are read on a worker thread, so the server keeps answering (on a Pi the "before" is seconds) |

The worker reads one page at a time, gives up on a page after 30 s, and is replaced every 500
pages. `FA_PAGE_WORKER=0` reads pages in-process instead (an escape hatch). Tests run in-process.

**Memory:** a first benchmark looked like a leak (memory grew ~45 MB per page read). It was the
benchmark: it read pages back-to-back without letting Node's event loop turn, and jsdom frees a
closed page only after it does. With the loop turning, as in the server, ten Overclock reads leave
memory flat (44 → 52 MB).

### Followed threads

- Each check loaded the text of every stored post (up to 300) to compare with the page just read;
  now only the posts on that page.
- The card's "Earlier in the thread" loaded every earlier post's text to show three; now IDs
  first, then those three.

### Card pictures

Pictures taken from an article's first image can be full-size: NASA's were 0.1–0.9 MB each,
shown at 128 × 72. Where the image server can resize (the address already asks for a width,
or NASA's `/dynamicimage/`), cards ask for 400 px: **17–44 kB** each, about 20 × less. Ten NASA
cards: ~5 MB → ~0.3 MB.

### Checked, no change needed

- Web app: 72.6 kB compressed (70 kB at the first pass); React is most of it.
- Feeds: NASA's 530 kB Earth feed parses in 6 ms and answers "not modified" (ETag) when unchanged.
