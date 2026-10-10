# ForumAggregator — Design

Status: **Draft v0.1** (2026-10-10). Nothing is built yet. This document records
what we want, the decisions made so far, and the questions still open.
Decisions are logged in [DECISIONS.md](DECISIONS.md).

---

## 1. Goal

A self-hosted personal news feed that combines the forums, subreddits and
YouTube creators I follow into one stream. I can choose exactly what to follow
and how much of it I see, read it on desktop and phone, and keep track of what
I have already read.

### Initial sources

| Site | What to follow | Notes |
|---|---|---|
| thehotpepper.com | Whole site at first | Narrow it down later using board discovery |
| overclock.net | RTX 5070 Ti and RTX 3080 boards, plus the 5070 Ti Owners Club thread | Huge site, so whole-site follow isn't practical |
| bikeforums.net | Tandem Cycling board | |
| Reddit | Subreddits (to be decided) | Phase 2 |
| YouTube | Creators I follow | Phase 2 |

### Requirements

- **R1** Runs as a single Docker container on a Linux server or Raspberry Pi (arm64 + amd64), and serves everything on **one port**.
- **R2** Logs in to every forum as me. This is a requirement, not an option.
- **R3** I can follow different **levels**: a whole site, a board, a thread, or individual posts. (An author or a saved search are possible later.)
- **R4** Each forum has a different structure, so the app learns that structure itself. I pick what to follow from the discovered tree instead of typing URLs.
- **R5** Keyword filtering (include/exclude) per subscription and globally.
- **R6** I read everything in this app through a web UI that works well on a phone. An Android app may come later, so the UI talks to a JSON API.
- **R7** Polling rates, request delays and limits are **configurable**, so I can respond to blocking or API limits.
- **R8** Mark items read or unread, save them, and mute a thread.
- **R9** Settings start out in a config file and move to a settings screen in the UI.
- **R10** Single user for now.
- **R11** No AI in the first version. The design leaves room to add it later (see §9).

---

## 2. Architecture

```
                 ┌──────────────────── Docker container (one port, e.g. 8080) ───────────────────┐
  Browser/phone ─┤  Web UI (server-rendered + HTMX, installable PWA)                              │
                 │  JSON API  (/api/...)  ← future Android app                                    │
                 │        │                                                                       │
                 │  Core: subscriptions · filters · read state · search (SQLite FTS5)             │
                 │        │                                                                       │
                 │  Scheduler ──► Fetch queue ──► Per-host rate limiter ──► Source adapters       │
                 │                                                     ├─ XenForo (cookies)      │
                 │                                                     ├─ Reddit                 │
                 │                                                     └─ YouTube (RSS)          │
                 │  /data volume: app.db · config.yaml · secrets (encrypted cookies)              │
                 └────────────────────────────────────────────────────────────────────────────────┘
```

### Proposed stack (to be confirmed — see Q-STACK)

| Part | Choice | Why |
|---|---|---|
| Language | Python 3.12 | Strongest scraping ecosystem, easy to read |
| Web/API | FastAPI + Jinja2 + HTMX | One process and one port. Needs no JS build step. The API is reusable by an Android app |
| Database | SQLite (WAL mode, FTS5) | No separate database server. Fine on a Pi. Full-text search is built in |
| HTTP | httpx (HTTP/2, cookie jar) | Async and fast. Keeps cookies per site |
| HTML parsing | selectolax (lxml fallback) | Fast on a Pi |
| Scheduler | APScheduler (in-process) | No Redis or Celery needed for one user |
| Headless browser | Playwright, **optional and not installed by default** | Only needed if a site sits behind a JS challenge. Keeps the image small |
| Packaging | Multi-arch Docker image (amd64/arm64) and `docker-compose.yml` | Matches R1 |

---

## 3. Data model (first cut)

- **Site**: one per forum or service. Holds the adapter type (`xenforo`, `reddit`, `youtube`), the base URL, login state and the rate-limit settings.
- **Node**: a discovered piece of a site's structure: category → board → sub-board. This is a tree (`parent_id`). It holds the forum's own ID, title and URL. Refreshed from time to time.
- **Subscription**: what I follow:
  - `target`: a site, node (board), thread, author, search, subreddit or channel
  - `level`: what counts as a new item (see §4)
  - `include_subboards`: yes/no
  - `filters`: keyword rules (§5)
  - `poll_interval`: overrides the site default
  - `enabled`, `priority`
- **Thread**: a forum thread or Reddit post. Holds title, author, reply count, last-post time, and muted/followed flags.
- **Item**: what appears in my feed. Either a new thread, a new post, a video or a digest. Holds source, URL, author, time, an excerpt, the full text (for search) and a content hash for de-duplication.
- **ItemState**: read, saved, hidden.
- **FetchLog**: one row per request. Holds status code, timing and errors. Feeds the health page and the backoff logic.

---

## 4. "Levels": what I follow vs. what I get

Every forum is a tree:

```
Site ─► Category ─► Board ─► (Sub-board) ─► Thread ─► Post
```

A subscription sets **where** in the tree I'm following and **what counts as an item**:

| Follow at… | Item mode `new_threads` | Item mode `all_posts` | Item mode `activity` |
|---|---|---|---|
| Site | Every new thread on the site | (too noisy, not offered) | Threads with new replies, grouped by thread |
| Board | New threads in this board (and sub-boards if chosen) | Every new post in the board | Threads with new replies since I last looked |
| Thread | — | Every new reply | One rolled-up entry: "12 new replies in X" |

- **`activity`** answers "a way to see recent activity". The feed shows one card per thread with the number of new replies and the newest snippet. It doesn't show every post. This is the recommended default for big boards like the GPU ones.
- **Promote and demote from the feed**: any thread card has **Follow thread**, which creates a thread-level `all_posts` subscription, and **Mute thread**, which hides that thread from every subscription.
- Rules for overlapping subscriptions: the same post is never shown twice. The most specific subscription wins: thread over board over site.

---

## 5. Filters vs. search

These are two separate features:

- **Filters** decide what goes into the feed. They are stored on a subscription, or globally.
  - `include`: any of these words or phrases (matched on title, body, or both)
  - `exclude`: none of these
  - `authors_include` / `authors_exclude`
  - `min_replies` (good for `activity` mode)
  - Matching is case-insensitive and on whole words, and `"quoted phrases"` are supported. Regex is available as an advanced option.
  - Filtered-out items are **kept but hidden**. If I change a filter later, it applies to past items too.
- **Search** finds things in everything already collected. It uses SQLite FTS5 over titles and bodies and can be narrowed by site, board, author and date. This runs locally and doesn't touch the forums.

---

## 6. Logging in (R2)

Most forums block or challenge automated password logins with captchas, 2FA and bot protection. The plan has two options:

1. **Cookie import (default, most reliable).** I log in normally in my browser and export that site's cookies using a cookies.txt exporter extension. Then I paste or upload them in Settings. XenForo's "Stay logged in" cookie lasts a long time.
2. **Username and password (optional).** The app submits the site's login form. This only works when the site shows no captcha or JS challenge.

For both options:

- Secrets are **encrypted at rest** in `/data` using a key from an environment variable (`FA_SECRET_KEY`).
- Each poll checks that the session is still logged in, for example by looking for the logged-in username or a logout link on the page. If the session has expired, the site is marked **"needs login"** and a banner appears in the UI. The app doesn't keep making anonymous requests.
- The app uses a realistic browser User-Agent. Optionally I can set the same User-Agent as the browser the cookies came from.
- Logging in at all means the app acts as my account. Request rates stay low and human-like (§7) to protect the account.

**Reddit**: The official API now appears to need approval even for a personal "script" app, and reports in 2026 vary. Fallback: Reddit's per-user **private RSS feeds** (front page, subreddits, saved) authenticated by a feed token, plus `/r/<sub>/.rss`. Not confirmed yet; we'll try it in Phase 2.

**YouTube**: Following creators doesn't need a login. Each channel has a public feed: `https://www.youtube.com/feeds/videos.xml?channel_id=…`. I can import my subscriptions once from a Google Takeout file (`subscriptions.csv`). That avoids YouTube Data API quotas and OAuth.

---

## 7. Politeness, rate limits and blocking (R7)

All settings below are configurable globally, per site and per subscription:

| Setting | Default (proposed) |
|---|---|
| `poll_interval` | 30 min for a site or board, 15 min for a followed thread |
| `min_delay_between_requests` (per host) | 5 s, plus 0–3 s random jitter |
| `max_concurrent_requests` (per host) | 1 |
| `max_pages_per_poll` | 3 (how far back to page through a busy thread) |
| `quiet_hours` | None |
| Backoff | On 429/503: wait ×2 each time, up to 6 h. Honours `Retry-After` |
| Circuit breaker | 5 failures in a row → pause the site and show it in the UI |

- **Incremental fetching**: the app remembers the last post ID or time per thread and board, so it only fetches what's new. For a thread it jumps to the last page and works backward until it reaches known posts.
- **Prefer feeds**: if a site serves an RSS feed for a board or thread, the app uses it first because it's cheaper. It falls back to reading the HTML for the full post body or when no feed exists.
- A **Health page** shows each site's last success, error rate, login state and next poll.

---

## 8. Board discovery (R4)

1. Add a site: enter the base URL and set up login.
2. The adapter fetches the forum index (for XenForo, `/forums/`) and builds the **Node** tree.
3. Settings shows the tree with checkboxes, each with a choice of level and item mode.
4. Discovery re-runs weekly so new or renamed boards appear. Boards that vanish are flagged, not deleted.

**Unverified assumption:** all three forums appear to run XenForo, but I couldn't check them from the build environment. Overclock.net and BikeForums are both VerticalScope sites, which reportedly use a shared, customised XenForo. If that holds, one `xenforo` adapter covers all three. The adapter will use per-site **CSS selector profiles** so differences in themes only need config changes, not code. The first milestone checks this against the real sites.

---

## 9. AI proposal (not in the first version)

AI would be a **plug-in stage** in the pipeline, **off by default**:
`fetch → store → filter → [AI enrich] → feed`.

| Feature | What it does | When it runs | Cost control |
|---|---|---|---|
| **Catch me up** | Summarizes the new replies in a big thread, e.g. "the last 3 pages of the 5070 Ti club: people are discussing driver 58x.xx crashes…" | Only when I press the button | Summaries are cached per thread and post range |
| **Relevance scoring** | Scores each item 0–100 against a short interest profile I write per subscription, e.g. "undervolting, memory overclocks, coil whine. Not: buying advice". The feed can sort or filter by score | On new items in subscriptions where I turn it on | Uses a small, cheap model. Scores only titles and excerpts. Has a daily budget cap |
| **Natural-language filters** | "Hide sale posts and 'which should I buy' threads" compiles to a classifier prompt | With relevance scoring | Same as above |
| **Daily digest** | One readable briefing across all sources | Once a day on a schedule | One call per day |
| **Cross-source de-duplication** | Groups the same story across forum, Reddit and YouTube | Later | Can use local embeddings |

Implementation notes:
- A provider interface (`LLMProvider`) supports a hosted API (e.g. Claude) or a **local model** via Ollama on a stronger machine. A Raspberry Pi is too slow to run useful models itself.
- Settings has a **monthly spend cap** and an AI on/off switch per subscription.
- **Privacy**: forum content, some of it from members-only boards, would be sent to the provider. The UI makes that explicit for each subscription.
- The data model gets an `ItemEnrichment` table (score, summary, model, cost) now, so adding AI later needs no migration.

---

## 10. Milestones

| # | Scope | Done when |
|---|---|---|
| **M0** | Skeleton: FastAPI app, SQLite, config file, Dockerfile and compose file (multi-arch), health endpoint, app password | `docker compose up` serves a login page on one port on the Pi |
| **M1** | XenForo adapter: cookie login, board discovery, `new_threads` / `activity` / `all_posts`, incremental fetch, rate limiter | BikeForums Tandem and the 5070 Ti thread appear in a combined feed |
| **M2** | Feed UI: read/unread, save, mute, follow-from-card, mobile layout, PWA install | Usable daily on my phone |
| **M3** | Filters and full-text search | Keyword rules work. Search returns results |
| **M4** | Settings screen (sites, login, discovery tree, subscriptions, rate limits). The config file becomes an import/export | No file editing needed |
| **M5** | YouTube (RSS and Takeout import) and Reddit adapters | Videos and subreddit posts appear in the feed |
| **M6** | Notifications (web push or ntfy), health page polish | |
| **M7** | AI stage (§9) | |

---

## 11. Open questions

See the bottom of [DECISIONS.md](DECISIONS.md#open-questions).
