# Roadmap and progress

The single place to see **where the project is, what's next, and what's blocked**.
Updated every time work lands. Design detail lives in [DESIGN.md](DESIGN.md), reasoning in
[DECISIONS.md](DECISIONS.md).

_Last updated: 2026-10-25 (v1.10.0; the milestone sections below are the history up to M1.2)_

## Status at a glance

| | |
|---|---|
| **Usable?** | **Yes**, daily: RSS/Atom feeds and websites (incl. WordPress sections), podcasts, YouTube (with an API-key fallback when YouTube's feeds fail), Reddit (public feeds, rate-limited), XenForo and vBulletin forums (boards, followed threads, paging), sites behind Cloudflare via FlareSolverr |
| **Current release** | **v1.10.0** (2026-10-25), images `alexstapo/forumaggregator:1.10.0`. What each release added: [CHANGELOG](../CHANGELOG.md) |
| **Next** | Driven by use: new sites as they come up. Ideas noted: following vBulletin threads with a reply card, a Reddit minimum interval and a requests-per-hour note in Settings → Checking |
| **Blocked on** | Nothing |

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
- ✅ First real-world install (2026-10-19): NPR RSS works. ⛔ YouTube and Reddit failed (fixes in M1.1, awaiting retest)
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

### M1.2: Feedback after v1.0.0 🔄 *(2026-10-19)*
- ✅ Reddit in the reader: post body from the feed, no page fetches, footer clutter removed, link posts show the article (D-064)
- ✅ Reddit comments in the reader, on demand (D-065); Reddit requests ≥ 10 s apart (D-066)
- ✅ Forum thread links explained; board links read the board RSS directly (D-068)
- ✅ Reader clean-up: NPR's embed snippet, toolbars, repeated headline (D-069). ⏳ Needs your check on the NPR item
- ✅ **Wide-screen layout:** list on the left, reader on the right; Automatic / Side by side / Full-screen reader, per device (D-070)
- ✅ **Timeline view:** day headings, Newest/Oldest first per device (D-071); "Mark all read" now respects the tag filter (D-072)
- ✅ **Compared with FreshRSS** ([FRESHRSS-COMPARISON.md](FRESHRSS-COMPARISON.md)); you picked: OPML + reader selectors now, web-page sources with XenForo presets in M2, WebSub and a Google Reader API later
- ✅ **OPML import/export** (D-073)
- ✅ **Reader selectors per source**, with preview (D-074)
- ✅ **YouTube top comments** with your own free API key (D-075). ⏳ Needs a real key to confirm against YouTube (tested against a fake API only)
- ✅ Tests: 162 automated (SQLite + Postgres), plus browser run-throughs at phone and desktop widths

### M1.3: Feedback on v1.0.1 🔄 *(2026-10-19)*
- ✅ Reddit pictures full width: image posts show the full image, screenshots linked in the text appear as pictures, no thumbnail table; galleries/videos say to open Reddit (D-076). ⏳ Needs your check on real posts
- ✅ Posts stored by v1.0.0 without their text get it on the next poll (D-076)
- ✅ Source checkboxes in the feed, per device (D-077)
- ✅ Tap anywhere on a card to open it (D-078)
- ✅ Tests: 171 automated (SQLite + Postgres), plus a browser run-through at phone and desktop widths

### M2: Forums 🔄 *(started 2026-10-19)*
Goal: follow forum boards and threads, including members-only content.
- ✅ thehotpepper.com checked from your server: Cloudflare blocks page and RSS
- ✅ **FlareSolverr route**, opt-in per source, retried automatically on a Cloudflare check (D-080). ⏳ Needs your test against thehotpepper.com with your FlareSolverr
- ✅ **Threads in the reader show the posts** (author, time, quotes, images; re-read for new replies) (D-081). ⏳ Needs a real thread to confirm the markup
- ✅ FlareSolverr fix: pages that passed Cloudflare's check were mistaken for the check (D-083)
- ✅ **Follow a thread** with one updating card ("N new replies") (D-084). ⏳ Needs your test on the 5070 Ti owners' club (Overclock.net's own bot check is not Cloudflare's; FlareSolverr may or may not pass it)
- ⏳ **Board activity:** older threads in a board with new replies (board RSS only announces new threads)
- ⛔ `check-sites` output from your server/Pi (what the forums allow from your IP)
- ⛔ Saved example pages (forum list, board, thread) from each forum, attached in chat
- ⛔ Decision: forum email notifications as a fallback (SITE-ACCESS.md option C)?
- 💤 **"Web page" source type** with CSS selectors (item, title, link, date, author, content) and built-in **XenForo board/thread presets** (from the FreshRSS comparison)
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
- 💤 WebSub for YouTube (new videos within seconds, fewer polls) · Google Reader-compatible API (use existing Android feed apps)
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
| 1 | Merge the v1.1.0 PR, then create the `v1.1.0` release ([RELEASING.md](RELEASING.md)); update with `docker compose pull && docker compose up -d` | Trying M1.3 |
| 2 | Check the NPR item that showed the broken iframe, and the new layout on your desktop and phone | M1.2 sign-off |
| 2a | Optional: add a YouTube Data API key in Settings and open a video (confirms D-075 against the real API) | M1.2 sign-off |
| 3 | `docker exec forumaggregator node packages/server/dist/tools/check-sites.js` output | M2 |
| 4 | Saved forum pages (forum list, board, thread) for each forum, attached in chat | M2 |
| 5 | Email notifications as a forum fallback: yes or no | M2 |

## Done log

| Date | What | Where |
|---|---|---|
| 2026-10-21 | Thread pages in the reader (pager, first/last page setting); version 1.4.0 | PR |
| 2026-10-21 | **v1.3.1** merged (performance pass) | [#9](https://github.com/AlexStapleton/ForumAggregator/pull/9) |
| 2026-10-19 | **v1.3.0 released** (follow a thread; FlareSolverr fix) | [#8](https://github.com/AlexStapleton/ForumAggregator/pull/8) |
| 2026-10-19 | **v1.2.0 released** (M2 start: FlareSolverr route, forum threads in the reader) | [#7](https://github.com/AlexStapleton/ForumAggregator/pull/7), tag `v1.2.0` |
| 2026-10-19 | **v1.1.0 released** (M1.3: Reddit pictures, source checkboxes, whole-card tap) | [#6](https://github.com/AlexStapleton/ForumAggregator/pull/6), tag `v1.1.0` |
| 2026-10-19 | **v1.0.1 released** (M1.2: layout, timeline, OPML, reader selectors, YouTube and Reddit comments) | [#5](https://github.com/AlexStapleton/ForumAggregator/pull/5), tag `v1.0.1` |
| 2026-10-19 | YouTube (`@ImKibitz`) and Reddit confirmed working on a real install | your server |
| 2026-10-19 | **v1.0.0 released** | tag `v1.0.0` |
| 2026-10-19 | M1.1: tags, edit source, reader view, per-source retention, Reddit/YouTube fixes | [#4](https://github.com/AlexStapleton/ForumAggregator/pull/4) |
| 2026-10-19 | First real install (NPR RSS works; YouTube/Reddit failed) | your server |
| 2026-10-19 | M1: RSS/Atom + YouTube sources, scheduler, feed and sources screens | [#3](https://github.com/AlexStapleton/ForumAggregator/pull/3) |
| 2026-10-11 | ROADMAP.md progress tracker | [#3](https://github.com/AlexStapleton/ForumAggregator/pull/3) |
| 2026-10-11 | Docs default to Docker Hub image `alexstapo/forumaggregator` | [#3](https://github.com/AlexStapleton/ForumAggregator/pull/3) |
| 2026-10-11 | Zero-config install (docker run / compose), generated key, auto permissions | [#3](https://github.com/AlexStapleton/ForumAggregator/pull/3) |
| 2026-10-11 | Site-access findings, `check-sites` tool, manual CI trigger | [#2](https://github.com/AlexStapleton/ForumAggregator/pull/2) |
| 2026-10-11 | CI publishes to Docker Hub (after secrets were added) | `main` |
| 2026-10-10 | M0 foundation: app, login, Docker, CI | [#1](https://github.com/AlexStapleton/ForumAggregator/pull/1) |
| 2026-10-10 | Design document and decision log | [#1](https://github.com/AlexStapleton/ForumAggregator/pull/1) |
