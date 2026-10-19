# ForumAggregator — Design

Status: **v0.5** (2026-10-19). M0 is released. M1 (RSS/Atom and YouTube reader) is built. Progress: [ROADMAP.md](ROADMAP.md). This document records
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
| YouTube | Specific creators | Phase 2 |
| Reddit | Subreddits (to be decided) | Phase 2 |

### Requirements

- **R1** Runs as a single Docker container behind my reverse proxy at its own hostname (e.g. `forumaggregator.<domain>`), and serves everything on **one port**. It must run on both an x86 server and a Raspberry Pi (amd64 + arm64).
- **R2** Logs in to every forum as me. Logging in must be easy, and it must not depend on me exporting cookies by hand.
- **R3** I can follow different **levels**: a whole site, a board, a thread, or individual posts.
- **R4** The app **discovers** each forum's structure. I can **correct** it, and my corrections survive later re-discovery.
- **R5** Flexible filtering (§5).
- **R6** I read everything in this app through a web UI that works well on a phone and can be installed as an app (PWA). An Android app may come later, so the UI talks to a JSON API.
- **R7** Polling rates, request delays and limits are **configurable**.
- **R8** Mark items read or unread, save them, and mute a thread.
- **R9** Settings start out in a config file and move to a settings screen in the UI.
- **R10** Single user. Because the app is reachable from the internet, it needs a proper login of its own.
- **R11** SQLite by default. Postgres is optional for people who want a more robust database.
- **R12** No AI in the first version. The design leaves room to add it later (see §11).
- **R13** No notifications for now. Opening the app is enough.

---

## 2. Language and stack

### Options compared

| | Python | **TypeScript (Node)** | Rust | Go | C++ |
|---|---|---|---|---|---|
| Speed of building and changing it | Fast | Fast | Slow | Medium | Slow |
| Tools for reading web pages | Excellent | Excellent | OK | Good | Poor |
| Built-in browser automation (needed for login, §6) | Supported | **Native: Playwright is a Node project** | Community libraries only | Community libraries only | None worth using |
| Memory at idle | ~60–100 MB | ~60–100 MB | ~10 MB | ~15 MB | ~10 MB |
| Same language for UI, API and an Android app later | No | **Yes** (React / Capacitor / React Native) | No | No | No |
| Database layer that handles both SQLite and Postgres | SQLAlchemy | Drizzle / Kysely | sqlx / diesel | sqlc / gorm | Hand-rolled |

**Why not Rust or C++:** the app spends nearly all its time *waiting*, partly on the network and mostly on the polite delays we add deliberately (§7). Raw speed gains us nothing here. Meanwhile, forum page parsers break whenever a site changes its theme, so it matters most that the code is quick to fix. A Pi runs Node or Python comfortably for this workload.

### Recommendation: TypeScript

My earlier draft suggested Python. I now recommend TypeScript, for three reasons:

1. **Login** (§6) relies on a real browser that the app controls. Playwright is a Node project, so TypeScript uses it directly.
2. The server, the web UI and a possible Android app later can **share code and data types**.
3. A good database layer (Kysely) handles both SQLite and Postgres from one set of code (R11).

| Part | Choice |
|---|---|
| Runtime | Node.js 22 LTS. Will move to 24 LTS once it's tested |
| Server/API | Fastify, with Zod for checking config and API input |
| Database | Kysely query builder. **SQLite** (better-sqlite3, WAL mode) by default; **Postgres** if `DATABASE_URL` is set. One set of migrations for both (Drizzle would need a separate schema per database) |
| Search | Behind an interface: SQLite FTS5, or Postgres `tsvector` |
| Fetching and parsing | undici (HTTP with a cookie jar), cheerio (HTML) |
| Browser | Playwright with Chromium, used for logins (§6) and for sites that need it |
| Scheduler | In-process job queue with a per-host rate limiter |
| UI | React + Vite, built into static files the server delivers. PWA (M2), so it installs on a phone home screen. Capacitor can wrap the same app for Android later |
| Shared code | `@fa/shared`: API types and constants, used by both server and UI (and a future Android app) |
| Packaging | Multi-arch Docker image (amd64/arm64) and `docker-compose.yml` |

---

## 3. Data model (first cut)

- **Site**: one per forum or service. Holds the adapter type, the base URL, login state and rate-limit settings.
- **Node**: a discovered piece of a site's structure (category → board → sub-board). Holds the forum's own ID, title, URL and parent. Holds `discovered_*` fields **and** separate `user_*` override fields (§8).
- **Subscription**: what I follow. Holds the target, `level`, item mode (§4), `include_subboards`, filter rules (§5), `poll_interval`, and `enabled`.
- **Thread**: a forum thread, Reddit post or video. Holds title, author, reply count, last-post time, and muted/followed flags.
- **Item**: what appears in my feed. Holds source, URL, author, time, an excerpt, the full text and a content hash.
- **ItemState**: read, saved, hidden-by-filter (with the rule that hid it), tags and highlight.
- **Rule** / **KeywordSet**: filtering (§5).
- **FetchLog**: one row per request. Feeds the health page and the backoff logic.
- **ItemEnrichment**: reserved for AI (§11). Empty at first.

Retention is configurable and defaults to keeping everything. Saved items are never deleted automatically.

**Built so far (M1, 2026-10-19):** two tables cover RSS/Atom/YouTube sources.
- `sources`: kind (`feed` / `youtube`), title, site URL, feed URL (unique), enabled, status
  (`pending` / `ok` / `error` / `challenged` / `paused`), last error, consecutive failures,
  last checked / last success / next check times, optional per-source interval, and ETag /
  Last-Modified for conditional requests.
- `items`: source, guid (unique per source), URL, title, author, plain-text summary, image
  URL, published / fetched times, and `read` / `saved` flags on the row itself (one user, so a
  separate ItemState table isn't needed yet; D-048).

The forum-specific parts above (Site, Node, Subscription levels, Thread) arrive with M2. They'll
sit alongside these tables rather than replace them.

---

## 4. "Levels": what I follow vs. what I get

```
Site ─► Category ─► Board ─► (Sub-board) ─► Thread ─► Post
```

| Follow at… | `new_threads` | `all_posts` | `activity` |
|---|---|---|---|
| Site | Every new thread on the site | (too noisy, not offered) | Threads with new replies, one card per thread |
| Board | New threads in the board (and sub-boards if chosen) | Every new post | One card per active thread: "12 new replies" |
| Thread | — | Every new reply | One rolled-up card |

- Every card has **Follow thread** and **Mute thread** buttons.
- The same post never appears twice. The most specific subscription wins: thread over board over site.
- `activity` is the suggested mode for the busy GPU boards.

---

## 5. Filtering

### Principles

1. **Highlight rather than hide.** The safest default is to show everything and highlight what I care about. Hiding is an explicit choice, so nothing goes missing silently.
2. **Nothing is deleted.** Hidden items go into a **Filtered** view where I can see which rule hid each one.
3. **Preview before saving.** While I edit a rule, the app shows how many of the last 7 days' items it would affect, with examples.
4. **Reusable keyword sets.** For example, a "GPU tuning" set (undervolt\*, curve, "power limit", "memory OC", coil whine) can be used on both GPU boards and a subreddit.

### Simple mode (default): three boxes per subscription

| Box | Effect |
|---|---|
| **Highlight if it mentions** | Shows a badge and colour, and offers a "Highlighted only" view |
| **Only show if it mentions** | Hides everything else |
| **Hide if it mentions** | For example: "for sale", WTB, "which should I buy" |

There's also an **authors** list (always show / always hide) and **minimum replies** (for `activity` mode).

### Advanced mode: rules

A rule is *conditions → action*. Rules run in order: global rules first, then the subscription's own. The first rule that hides or shows an item decides. Highlight and tag actions add up.

- **Fields:** title, body, author, board, reply count, age, source type
- **Operators:** has word or phrase, wildcard (`undervolt*`), regex, `>=` / `<=`
- **Combine:** all of / any of
- **Actions:** hide, show, highlight, tag, set priority

Matching ignores case, matches whole words, and `"quoted phrases"` work. A word also matches its simple plurals.

The simple boxes are stored as rules too, so moving to advanced mode later loses nothing.

---

## 6. Logging in (R2)

Cookie export is out. Instead, the app **gets and refreshes the session by itself**. There are three ways, and the app tries them in this order:

### A. Username and password (automatic)
I enter my username and password once. The app logs in the way the browser would: it loads the login form, sends the hidden security token along with my details, and ticks "stay logged in".
- **Re-logs in automatically** when the session expires, so I never have to think about it.
- Fails if the site shows a captcha or asks for a two-factor code. Then the app falls back to B and tells me.

### B. Built-in login browser (for captchas and 2FA)
I tap **Log in** in Settings. The app opens a real Chromium browser on the server and shows it to me **inside the app's web page**, on my phone or my desktop, over the same port. I log in normally: captcha, 2FA code, "stay logged in". When the app sees I'm logged in, it saves the session and closes the browser.
- Works for any site, including Reddit if needed.
- The browser only runs during login, using ~300–500 MB of RAM for a minute.
- How it works: Playwright drives Chromium; screenshots are streamed to the page and my clicks and typing are sent back, all through the app's own port. No VNC and no extra ports.

### C. Paste cookies (advanced, last resort)
Kept for odd cases. Never required.

### For all three
- My passwords and sessions are **encrypted at rest** with a key from an environment variable (`FA_SECRET_KEY`).
- Before each poll, the app checks that it's still logged in. If it isn't, it tries A, and if that fails it marks the site **"needs login"** and shows a banner. It never keeps fetching while logged out without telling me.
- Request rates stay low and human-like (§7) to protect my accounts.
- The app identifies itself honestly as `ForumAggregator/<version> (personal feed reader)` and,
  when reading forum pages, follows each site's robots.txt rules for general clients (`*`).
  Feeds I explicitly subscribe to are fetched like in any feed reader (§9, D-045). It never disguises itself
  or tries to get past bot checks. See [SITE-ACCESS.md](SITE-ACCESS.md) for what that means
  for each forum.

### What if a forum adds 2FA later?
Nothing in the design changes. Logins go through a pluggable *login strategy* per site:
- If a site later asks for a code from an **authenticator app**, I can store that 2FA
  secret (encrypted) and the app generates the code itself. Re-login stays fully automatic.
- If it sends codes by **email or SMS**, or shows a captcha, the app uses method B: one
  manual login in the built-in browser, then the session lasts as long as the site allows
  (usually months with "stay logged in"). The app only asks again when that session ends.
- Because no account uses 2FA today, M1 ships method A first and B right after it.

### Logging in to the app itself (built in M0)
- **First run:** the app has no account and prints a one-time **setup code** to the container log. Creating the account needs that code, so nobody else can claim a freshly started instance.
- One user. Password at least 12 characters, hashed with Argon2id. Optional TOTP 2FA (authenticator app, QR code enrolment), and a used code can't be replayed.
- Sessions: random token in an HttpOnly, SameSite=Lax cookie, marked Secure behind HTTPS. Only a hash of the token is stored. 30-day sliding expiry. Changing the password signs out other devices.
- Login, setup and 2FA endpoints are limited to 10 attempts per 15 minutes per client IP. Unknown usernames take as long to check as real ones.
- CSRF: every state-changing API call needs an `x-fa-request: 1` header, which a cross-site page can't send.
- Security headers (CSP, nosniff, frame-ancestors none). HSTS is left to the proxy.
- Works behind Nginx Proxy Manager: `X-Forwarded-*` headers are trusted only from private/loopback addresses by default.
- `AUTH_MODE=local|proxy|both`: optionally trust a username header from an SSO proxy (Authelia/Authentik), accepted only from configured proxy IPs. See [DEPLOY.md §5](DEPLOY.md#5-later-single-sign-on-with-authelia-or-authentik).

---

## 7. Politeness, rate limits and blocking (R7)

All settings are configurable globally, per site and per subscription:

| Setting | Default (proposed) |
|---|---|
| `poll_interval` | 30 min for a site or board, 15 min for a followed thread |
| `min_delay_between_requests` (per host) | 5 s, plus 0–3 s random jitter |
| `max_concurrent_requests` (per host) | 1 |
| `max_pages_per_poll` | 3 |
| Backoff | On 429/503: wait ×2 each time, up to 6 h. Honours `Retry-After` |
| Circuit breaker | 5 failures in a row → pause the site and show it in the UI |

- Fetching is **incremental**: the app remembers the newest post it has seen in each thread and board. For a thread, it starts at the last page and works backward until it reaches posts it already has.
- If a site has an RSS feed, the app uses it first because it's cheaper. It falls back to reading the HTML page when it needs the full post.
- A **Health page** shows each site's last success, error rate, login state and next poll.

---

## 8. Board discovery and corrections (R4)

1. **Discover:** the site adapter reads the forum index and builds the board tree.
2. **Review:** Settings shows the tree. For each board I can:
   - follow it (choose the level and mode)
   - **rename** it, **hide** it, or **move** it under a different parent
   - mark it as "not a board" (link-only nodes)
   - **add a board manually** by pasting its URL, if discovery missed it
   - press **Test**, which fetches one page and shows what was parsed (threads, authors, dates), so I can confirm it reads correctly
3. **Re-discovery** runs weekly. My corrections are stored separately from what was discovered, so re-discovery never overwrites them. New boards are flagged as "new". Boards that disappear are flagged as "missing", not deleted.
4. **Parsing profiles:** the page parsing for each type of forum software uses CSS selector profiles. A site can override individual selectors if its theme differs. When **Test** shows a broken result, I fix that site's selectors in config instead of waiting for a code change.

**Checked 2026-10-11** (details in [SITE-ACCESS.md](SITE-ACCESS.md)): The Hot Pepper is XenForo (confirmed from its cookies). Overclock.net serves XenForo RSS and `xf_` cookies, so it's XenForo too. BikeForums was hidden behind a Cloudflare challenge, so it's still unconfirmed. Two of the three serve bot challenges to data-centre IPs, so *how* the app reads each site is an open decision (SITE-ACCESS.md options A–D).

---

## 9. Feeds, YouTube and Reddit

**RSS/Atom (built in M1).** On the Sources page I paste one of:
- a **feed address**, which is used as-is (RSS 2.0, RSS 1.0/RDF and Atom are all supported);
- a **website**, whose feed is found from the page's `<link rel="alternate">`;
- a **YouTube** channel link or `@handle` (below).

The app fetches and validates it immediately, then stores its items. Items older than 7 days
start out read, so a new source doesn't flood the feed (D-047). After that, the scheduler
checks it every `intervalMinutes` (default 30, ±10 % jitter), using ETag / Last-Modified, so an
unchanged feed costs one tiny 304 response.

When a check fails, it backs off 30 min → 1 h → 2 h → 4 h (capped at 6 h, and longer if the
site sends Retry-After). After 5 failures in a row the source is paused, with the reason
shown, until I press Resume. A source that starts serving a bot check is marked
**challenged** and is never worked around. Nothing from a feed is rendered as HTML: titles and
summaries are stored as plain text, and links and images must be http(s).

**robots.txt and feeds (D-045):** robots.txt is about *crawling*, a program discovering and
walking pages on its own. Fetching a specific feed I subscribed to isn't crawling; it's what
every feed reader does (Google's own feed fetcher works the same way). So subscribed feeds are
fetched even where robots.txt lists them; YouTube's robots.txt lists `/feeds/videos.xml`, for
example. Forum page reading (M2) is crawling, and does follow robots.txt.

- **YouTube, specific creators (built in M1):** I paste a channel URL, `@handle`, `/user/…` or playlist link. The app finds the channel ID (from the channel page for handles) and follows the channel's public feed (`/feeds/videos.xml?channel_id=…`). No login or API key needed. Cards show the video thumbnail. The feed only lists a channel's ~15 newest videos, which is fine when checking every 30–60 minutes. *Hiding Shorts is not built yet.*
- **Reddit:** Phase 2, after YouTube. Reddit's API now appears to need approval even for personal use (not confirmed). Fallbacks: subreddit RSS feeds, or a logged-in session using login method B.

---

## 10. Hardware: i3 server vs Raspberry Pi

The app runs on both from **the same multi-arch image**. Differences:

| | i3-10105 server (+GTX 1060 6 GB) | Raspberry Pi 4/5 |
|---|---|---|
| Normal polling and UI | Plenty of headroom | Fine. The workload is light (~100–150 MB RAM) |
| Built-in login browser (§6B) | Instant | Works on arm64 but takes a few seconds to start. Needs ~0.5 GB of free RAM while open, so a **4 GB+ Pi is recommended** |
| Storage | SSD | **Use an SSD over USB, not the SD card**: constant database writes wear out SD cards and slow SQLite down |
| Search | Fast | Fine for a single user's data (hundreds of thousands of items) |
| Local AI (§11) | The 1060 can run small (~3–8B) quantized models with Ollama for scoring and short summaries. **To verify:** current NVIDIA drivers and CUDA releases are dropping Pascal (GTX 10-series), so the driver and Ollama versions need checking | Not practical. It would have to call a hosted API or the i3 server |
| Postgres option | Easy | Works, but uses more RAM. SQLite is the better fit |

AI never runs inside this container. The app calls an AI endpoint over HTTP (local Ollama or a hosted API), so the container stays small and identical on both machines.

---

## 11. AI proposal (not in the first version)

AI would be a plug-in stage that is **off by default**: `fetch → store → filter → [AI enrich] → feed`.

| Feature | What it does | When it runs | Cost control |
|---|---|---|---|
| **Catch me up** | Summarizes new replies in a big thread | Only when I press the button | Cached |
| **Relevance scoring** | Scores items 0–100 against a short interest profile, which becomes a filter field (§5) | Per subscription, when I turn it on | Small model, titles and excerpts only, daily cap |
| **Natural-language filters** | e.g. "hide buying-advice threads" | With scoring | Same |
| **Daily digest** | One briefing across all sources | Once a day | One call |
| **Cross-source de-duplication** | Groups the same story across sources | Later | Local embeddings |

- Providers are pluggable: a hosted API (e.g. Claude) or local Ollama (the 1060 server, see §10). There's a monthly spend cap.
- **Privacy:** forum content, some of it from members-only boards, would be sent to the provider. The UI makes that explicit for each subscription.

---

## 12. Milestones

Milestones, progress and blockers are tracked in **[ROADMAP.md](ROADMAP.md)**, the only
copy, so it can't drift from this document. Short version (reordered 2026-10-11): M0
foundation ✅ → M1 first usable reader (RSS/Atom, YouTube, feed screen) → M2 forums →
M3 filters and search → M4 settings screen and PWA → M5 Reddit → M6 AI.

---

## 13. Open questions

See the bottom of [DECISIONS.md](DECISIONS.md#open-questions).
