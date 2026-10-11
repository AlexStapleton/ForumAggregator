# Roadmap and progress

The single place to see **where the project is, what's next, and what's blocked**.
Updated every time work lands. Design detail lives in [DESIGN.md](DESIGN.md), reasoning in
[DECISIONS.md](DECISIONS.md).

_Last updated: 2026-10-11_

## Status at a glance

| | |
|---|---|
| **Usable as a feed reader?** | **No.** It installs, you can create an account and log in, but it can't follow anything yet. |
| **Current milestone** | M1 (first usable reader), *proposed order, awaiting your OK* |
| **Blocked on** | Your go-ahead for the new order; first sources to test with (YouTube creators, subreddits, sites) |
| **Latest image** | `alexstapo/forumaggregator:latest` (amd64 + arm64), built from `main` |

Legend: ✅ done · 🔄 in progress · ⏳ next · ⛔ blocked · 💤 later

## Milestones

The order changed on 2026-10-11 (proposed, see "Why the order changed" below). The old order
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

### M1: First usable reader ⏳ *(proposed)*
Goal: open the app on your phone and read new items from real sources.
- ⏳ Data model: sources, subscriptions, items, read/saved state (DESIGN §3)
- ⏳ Polite fetcher: per-site rate limits, backoff, circuit breaker (DESIGN §7)
- ⏳ **RSS/Atom source:** YouTube channels, Overclock.net boards, subreddits, blogs
- ⏳ YouTube: paste a channel URL or @handle, and the app finds its feed
- ⏳ Feed screen: newest first, unread/read, save, mark all read, mobile layout
- ⏳ "Add a source" screen (so the config file isn't needed for this)
- ⏳ Health view: last check, errors, next check per source

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
| 1 | OK to the new order above | M1 |
| 2 | A few YouTube creators, subreddits or sites to test with | M1 testing |
| 3 | `docker exec forumaggregator node packages/server/dist/tools/check-sites.js` output (server and Pi) | M2, Pi test |
| 4 | Saved forum pages (forum list, board, thread) for each forum, attached in chat | M2 |
| 5 | Email notifications as a forum fallback: yes or no | M2 |
| 6 | Merge (or ask me to open a PR for) branch `claude/gifted-gauss-3lnq4v` | Easier install on `main` |

## Done log

| Date | What | Where |
|---|---|---|
| 2026-10-11 | Docs default to Docker Hub image `alexstapo/forumaggregator` | branch, unmerged |
| 2026-10-11 | Zero-config install (docker run / compose), generated key, auto permissions | branch, unmerged |
| 2026-10-11 | Site-access findings, `check-sites` tool, manual CI trigger | [#2](https://github.com/AlexStapleton/ForumAggregator/pull/2) |
| 2026-10-11 | CI publishes to Docker Hub (after secrets were added) | `main` |
| 2026-10-10 | M0 foundation: app, login, Docker, CI | [#1](https://github.com/AlexStapleton/ForumAggregator/pull/1) |
| 2026-10-10 | Design document and decision log | [#1](https://github.com/AlexStapleton/ForumAggregator/pull/1) |
