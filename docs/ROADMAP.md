# Roadmap and progress

The single place to see **where the project is, what's next, and what's blocked**.
Updated every time work lands. Design detail lives in [DESIGN.md](DESIGN.md), reasoning in
[DECISIONS.md](DECISIONS.md).

_Last updated: 2026-10-19 (after first real use)_

## Status at a glance

| | |
|---|---|
| **Usable as a feed reader?** | **Partly.** Running on your Pi; regular RSS works (tested with NPR). **YouTube and Reddit links failed** in your first test. |
| **Current milestone** | M1.1 built ✅: tags, editing sources, reader view, per-source retention, Reddit/YouTube fixes. Waiting on merge + your retest |
| **Blocked on** | Merging the branch; your retry of YouTube/Reddit on the Pi |
| **Latest image** | `alexstapo/forumaggregator:latest` (amd64 + arm64), built from `main` (includes M1) |

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

### M1: First usable reader ✅ *(built and merged 2026-10-19)*
Goal: open the app on your phone and read new items from real sources.
- ✅ Data model: sources and items with read/saved state (DESIGN §3)
- ✅ Polite scheduler: per-site spacing, ETag/304, ±10 % jitter, backoff, pause after 5 failures, bot checks never worked around (DESIGN §7, §9)
- ✅ **RSS/Atom source:** RSS 2.0, RSS 1.0 and Atom; paste a website and its feed is found
- ✅ YouTube: paste a channel URL, `@handle`, `/user/` or playlist link, and the app finds its feed; cards show thumbnails
- ✅ Feed screen: Unread / All / Saved, filter by source, newest first, open = mark read, save, mark all read (only what's on screen), load older, refresh on returning to the app
- ✅ Sources screen: add, check now, pause/resume, delete, with clear errors
- ✅ Health view: status, last error, last and next check on each source (part of Sources, D-050)
- ✅ Tests: 91 automated (SQLite + Postgres) plus a browser run-through on phone and desktop widths
- ✅ First real-world test (2026-10-19): NPR RSS works on the Pi. ⛔ YouTube and Reddit failed (tracked in M1.1)
- 💤 Not in M1: renaming a source in the UI (the API supports it), hiding YouTube Shorts, per-source interval in the UI

**Done when:** you install it, add a few YouTube creators and an Overclock.net board, and
new items appear on your phone.

### M1.1: Fixes and reading features ⏳ *(requested 2026-10-19)*
Goal: YouTube and Reddit work, sources can be organised and edited, and articles can be read inside the app.
- 🔄 **Fix: YouTube links don't add.** Diagnosed with one request to your channel page (`@ImKibitz`): YouTube redirects the app to its mobile site, and the app *does* find the channel there. So the failure is fetching the channel's feed from your Pi. Done: uses the feed the page advertises, accepts a bare `UC…` ID, detects consent pages, gives a specific error, and logs failures to `docker logs`. ⏳ Needs your retry on the Pi to see YouTube's actual answer
- 🔄 **Fix: Reddit links don't add.** Cause 1 (fixed): `old.reddit.com/r/…` is a web page, not a feed, and old.reddit's robots.txt disallows all bots. Links on any Reddit host now map to `https://www.reddit.com/r/<name>/.rss`. Cause 2 (Reddit's choice): Reddit blocked this cloud server outright ("blocked due to a network policy… register or sign in with your developer credentials"). Your home IP may fare better; if not, the app now says so plainly, and Reddit via your own account stays in M5. ⏳ Needs your retry on the Pi
- ✅ **Tags on sources**, shown on every item, with a filter by tag (dropdown or tap a tag). Editing tags applies to existing items too (D-056)
- ✅ **Edit a source**: name, address (re-checked before saving, items kept), tags, check interval, keep-items (D-057)
- ✅ **Reader view**: tap an item to read it in the app (feed full text, extracted article, or the YouTube video); Next/Prev buttons, swipe, ←/→ or j/k; Back closes (D-058, D-059)
- ✅ **Retention per source** ("keep items for"; saved items never deleted; removed items not re-added) (D-055)
- ✅ Tests: 122 automated (SQLite + Postgres) and a browser run-through (phone + desktop) covering every flow above
- 💤 Not yet: per-item tags, hiding YouTube Shorts, a global retention/interval setting in the UI (it's in `config.yaml`)

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
| 1 | Merge the branch (or ask me to open the PR) | M1.1 on your Pi |
| 2 | Retry `@ImKibitz` and `old.reddit.com/r/overclocking/` on the Pi; send the red message (or `docker logs forumaggregator 2>&1 \| grep "could not add"`) if either still fails | M1.1 sign-off |
| 3 | `docker exec forumaggregator node packages/server/dist/tools/check-sites.js` output | M2 |
| 4 | Saved forum pages (forum list, board, thread) for each forum, attached in chat | M2 |
| 5 | Email notifications as a forum fallback: yes or no | M2 |

## Done log

| Date | What | Where |
|---|---|---|
| 2026-10-19 | M1.1: tags, edit source, reader view, per-source retention, Reddit/YouTube fixes | branch, unmerged |
| 2026-10-19 | First real install on the Pi (NPR RSS works; YouTube/Reddit failed) | your Pi |
| 2026-10-19 | M1: RSS/Atom + YouTube sources, scheduler, feed and sources screens | [#3](https://github.com/AlexStapleton/ForumAggregator/pull/3) |
| 2026-10-11 | ROADMAP.md progress tracker | [#3](https://github.com/AlexStapleton/ForumAggregator/pull/3) |
| 2026-10-11 | Docs default to Docker Hub image `alexstapo/forumaggregator` | [#3](https://github.com/AlexStapleton/ForumAggregator/pull/3) |
| 2026-10-11 | Zero-config install (docker run / compose), generated key, auto permissions | [#3](https://github.com/AlexStapleton/ForumAggregator/pull/3) |
| 2026-10-11 | Site-access findings, `check-sites` tool, manual CI trigger | [#2](https://github.com/AlexStapleton/ForumAggregator/pull/2) |
| 2026-10-11 | CI publishes to Docker Hub (after secrets were added) | `main` |
| 2026-10-10 | M0 foundation: app, login, Docker, CI | [#1](https://github.com/AlexStapleton/ForumAggregator/pull/1) |
| 2026-10-10 | Design document and decision log | [#1](https://github.com/AlexStapleton/ForumAggregator/pull/1) |
