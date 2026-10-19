# Roadmap and progress

The single place to see **where the project is, what's next, and what's blocked**.
Updated every time work lands. Design detail lives in [DESIGN.md](DESIGN.md), reasoning in
[DECISIONS.md](DECISIONS.md).

_Last updated: 2026-10-19_

## Status at a glance

| | |
|---|---|
| **Usable as a feed reader?** | **Yes, for RSS/Atom feeds and YouTube channels** (M1, on branch `claude/gifted-gauss-3lnq4v` until merged). Forums aren't readable directly yet. |
| **Current milestone** | M1 built ✅, waiting on your real-world test. Next: M2 forums |
| **Blocked on** | Merging the branch; your test on the server/Pi; inputs for M2 (see "Waiting on you") |
| **Latest image** | `alexstapo/forumaggregator:latest` (amd64 + arm64), built from `main`. M1 lands in it once merged |

Legend: ✅ done · 🔄 in progress · ⏳ next · ⛔ blocked · 💤 later

## Milestones

The order changed on 2026-10-11 and was approved on 2026-10-19 (see "Why the order changed" below). The old order
put forum reading first, and that is stuck on bot checks.

### M0: Foundation ✅
Goal: a secure app you can install in one command.
- ✅ Monorepo: shared API types, Fastify server, React web UI
- ✅ Database: SQLite by default, Postgres optional (one set of migrations)
- ✅ App login: setup code on first run, Argon2 passwords, optional 2FA, rate limiting, CSRF protection
- ✅ Works behind Nginx Proxy Manager; optional SSO header (Authelia/Authentik)
- ✅ Docker image for x86 + Pi, published to Docker Hub and GHCR by CI
- ✅ Zero-config install (`docker run` or `docker compose`), generated key, automatic permissions
- ✅ `check-sites` diagnostic for forum access
- ⛔ Tested on a real Raspberry Pi: *waiting on you* (can't be emulated in the build environment)

### M1: First usable reader ✅ *(built 2026-10-19, awaiting your test)*
Goal: open the app on your phone and read new items from real sources.
- ✅ Data model: sources and items with read/saved state (DESIGN §3)
- ✅ Polite scheduler: per-site spacing, ETag/304, ±10 % jitter, backoff, pause after 5 failures, bot checks never worked around (DESIGN §7, §9)
- ✅ **RSS/Atom source:** RSS 2.0, RSS 1.0 and Atom; paste a website and its feed is found
- ✅ YouTube: paste a channel URL, `@handle`, `/user/` or playlist link, and the app finds its feed; cards show thumbnails
- ✅ Feed screen: Unread / All / Saved, filter by source, newest first, open = mark read, save, mark all read (only what's on screen), load older, refresh on returning to the app
- ✅ Sources screen: add, check now, pause/resume, delete, with clear errors
- ✅ Health view: status, last error, last and next check on each source (part of Sources, D-050)
- ✅ Tests: 91 automated (SQLite + Postgres) plus a browser run-through on phone and desktop widths
- ⏳ **Your real-world test**: YouTube creators and an Overclock.net board RSS on your server (I can't fetch those from the build environment, D-045)
- 💤 Not in M1: renaming a source in the UI (the API supports it), hiding YouTube Shorts, per-source interval in the UI

**Done when:** you install it, add a few YouTube creators and an Overclock.net board, and
new items appear on your phone.

### M2: Forums 💤 *(needs your input first)*
Goal: follow forum boards and threads, including members-only content.
- ⛔ `check-sites` output from your server/Pi (what the forums allow from your IP)
- ⛔ Saved example pages (forum list, board, thread) from each forum, attached in chat
- ⛔ Decision: forum email notifications as a fallback (SITE-ACCESS.md option C)?
- 💤 XenForo reader: board discovery + your corrections, `new_threads` / `activity` / `all_posts`
- 💤 Forum login (session reuse), "needs login" banner
- 💤 Follow/mute a thread from a feed card

**Done when:** BikeForums Tandem and the 5070 Ti owners' thread show up in the feed, or
we've documented why a site can't and what we use instead.

### M3: Filters and search 💤
- 💤 Highlight / only show / hide boxes per subscription, keyword sets (DESIGN §5)
- 💤 "Filtered" view showing which rule hid each item, plus a preview while editing
- 💤 Full-text search across everything collected

### M4: Settings screen and polish 💤
- 💤 All settings in the UI (sources, polling, retention); config file becomes import/export
- 💤 Installable on your phone's home screen (PWA)
- 💤 Retention clean-up job

### M5: Reddit (full) 💤
- 💤 Beyond subreddit RSS: home feed / saved posts, depending on Reddit's API terms

### M6: AI (optional) 💤
- 💤 "Catch me up" thread summaries, relevance scoring, daily digest (DESIGN §11)

### Later 💤
- 💤 Notifications · Android app wrapper · advanced rule builder

## Why the order changed (2026-10-11)

The original plan read forums first (M1) and put the feed UI in M2. In testing, two of the
three forums served bot checks, and two ask AI agents not to read them
([SITE-ACCESS.md](SITE-ACCESS.md)). Forum work now needs input from you, and that stalled
everything after it. RSS/Atom covers YouTube, Overclock.net boards, subreddits and most
sites today, so building the reader around it first gives you a working app while the
forum questions get answered. Nothing from the design is dropped; it's only reordered.

## Waiting on you

| # | What | Unblocks |
|---|---|---|
| 1 | Merge (or ask me to open a PR for) branch `claude/gifted-gauss-3lnq4v` | M1 in the Docker image |
| 2 | Try M1: add a few YouTube creators and an Overclock.net board RSS; tell me what breaks | M1 sign-off |
| 3 | `docker exec forumaggregator node packages/server/dist/tools/check-sites.js` output (server and Pi) | M2, Pi test |
| 4 | Saved forum pages (forum list, board, thread) for each forum, attached in chat | M2 |
| 5 | Email notifications as a forum fallback: yes or no | M2 |

## Done log

| Date | What | Where |
|---|---|---|
| 2026-10-19 | M1: RSS/Atom + YouTube sources, scheduler, feed and sources screens | branch, unmerged |
| 2026-10-11 | ROADMAP.md progress tracker | branch, unmerged |
| 2026-10-11 | Docs default to Docker Hub image `alexstapo/forumaggregator` | branch, unmerged |
| 2026-10-11 | Zero-config install (docker run / compose), generated key, auto permissions | branch, unmerged |
| 2026-10-11 | Site-access findings, `check-sites` tool, manual CI trigger | [#2](https://github.com/AlexStapleton/ForumAggregator/pull/2) |
| 2026-10-11 | CI publishes to Docker Hub (after secrets were added) | `main` |
| 2026-10-10 | M0 foundation: app, login, Docker, CI | [#1](https://github.com/AlexStapleton/ForumAggregator/pull/1) |
| 2026-10-10 | Design document and decision log | [#1](https://github.com/AlexStapleton/ForumAggregator/pull/1) |
