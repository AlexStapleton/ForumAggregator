# Decision log

Each entry records what was decided, who decided it, and why. Newest first within each date.

## 2026-10-19 (round 11: layout, timeline, FreshRSS follow-ups)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-070 | **Reading layout is a per-device setting** (Settings → This device; stored in the browser's localStorage, not on the server): *Automatic* (default: list and reader side by side at ≥ 1100 px, full-screen reader below), *Side by side* (whenever the window is ≥ 760 px), *Full-screen reader* (always). Side by side keeps the list usable, highlights the open item, keeps it in view while stepping with j/k, and doesn't add browser history entries; the full-screen reader is unchanged (Back closes it) | User ("yes, per device") | The phone and the desktop want different layouts; 760 px is the narrowest width where both columns stay readable |
| D-071 | **Timeline:** the feed groups items under day headings (Today, Yesterday, then weekday and date, in the browser's time zone) and has a Newest first / Oldest first order, remembered per device. The API takes `order=newest\|oldest` with keyset paging in either direction | User (option a) | Date headings answer "when was this published" at a glance without a separate view |
| D-072 | "Mark all read" honours the tag filter (it used to mark every source when a tag was selected), and marks up to the newest item on screen whichever end of the list that is | Claude (bug found while adding the oldest-first order) | Matches what the user is looking at |
| D-073 | **OPML import/export** (Sources → Import and export; `GET`/`POST /api/sources/opml`). Export: OPML 2.0, one folder per source's first tag, all tags in `category`, so other readers see folders and re-importing loses nothing. Import: any outline with an `xmlUrl`; folder names and `category` values become tags; already-followed feeds and non-http(s) addresses are skipped and listed. Imported sources are created as "pending" without fetching anything, and the scheduler checks them with the usual per-site spacing; Reddit links move to www, YouTube feeds get the YouTube kind. Limits: 1,000 feeds, 2 MB, no entity declarations | User (accepted FreshRSS recommendation 1) | Moving subscriptions in and out is standard for feed readers; not fetching at import time keeps a large import from hammering sites |
| D-074 | **Per-source reader selectors** (Edit source → "Reader: article selectors (advanced)", feed sources only): an *article selector* (every outermost match, in page order) and a *remove these elements* selector, applied to the original page before cleaning (cleaning strips classes, so they can't run later). When either is set, the reader always reads the original page for that source, like FreshRSS. **Preview** runs them on the source's newest item and saves nothing. Saving a change discards that source's articles read from pages, so they're re-read with the new selectors. If the article selector matches nothing, the reader shows the feed's own text with a notice and tries again next time. Invalid selectors are rejected with a field error. Known limit: after a page has been read with selectors, clearing them goes back to automatic page extraction, not to the feed's text (the reader keeps one cached version per item) | User (accepted FreshRSS recommendation 2) | Exact control for sites Readability gets wrong (forums especially), with no change for sources that don't use it |
| D-075 | **YouTube top comments with the user's own YouTube Data API key** (Settings → YouTube comments). The key is checked with one request (`videos.list`, 1 unit) before saving, stored encrypted with the SecretBox in the `settings` table, and only its last 4 characters are ever sent to the browser. In the reader, a YouTube item loads up to 30 top comments (`commentThreads.list`, relevance order, 1 unit) automatically, cached 15 min; without a key, a one-line hint links to Settings and no request is made. Failures say why (invalid key, comments turned off, quota used up, API not enabled, key restricted). URLs carrying the key are never logged or shown | User ("Yeah") | YouTube has no comments feed; the API's free quota (10,000 units a day) covers a single user many times over |

## 2026-10-19 (round 10: after v1.0.0, first feedback)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-064 | **Reddit in the reader uses the feed's post body (any length) and never fetches Reddit pages.** The "submitted by … [link] [comments]" footer is removed from summaries and bodies; for link posts, the linked article is kept as "Linked: host". Old items without a stored body show the summary and "open the original" | User saw "needs JavaScript" in the reader and Reddit rate limits | Reddit pages need JavaScript and each fetch spends Reddit's small request allowance |
| D-065 | **Reddit comments in the reader**, from the post's public comments feed (`…/comments/<id>/.rss`): up to 30, loaded only when "Show comments" is tapped, cached 15 min (failures 1 min), sanitised like articles | User request | On demand, so reading posts costs no extra Reddit requests |
| D-066 | **Per-host minimum spacing:** Reddit hosts get ≥ 10 s between requests (scheduled and interactive alike); others keep 5 s + jitter | User hit Reddit's request limit | About 6 requests a minute stays under Reddit's allowance for unregistered clients |
| D-067 | Feeds' dedicated content fields (`content:encoded`, Atom `<content>`) are kept at any length; the reader treats a short body as a teaser for non-Reddit sources (tries the page, and falls back to the short body before the one-line summary) | Claude | Needed for D-064 without making other feeds worse |
| D-069 | **Article polishing at display time:** after sanitising, the reader removes code blocks that are exactly one embed tag (`<iframe>`, `<script>`, …; e.g. NPR's "Embed" snippet), lists made only of media/share toolbar entries (Download, Transcript, Embed, Share, Email, …), and a first heading that repeats the title (h1–h4, any wrapper). It runs when an article is shown, so earlier cached articles benefit too. Built from the user's NPR screenshot: NPR's robots.txt disallows Claude agents (incl. Claude-User), so Claude didn't fetch the page | User's NPR report + Claude | Generic page-furniture clean-up; respects NPR's opt-out |
| D-068 | **Forum links:** a XenForo thread link (`/threads/name.123/`) is explained without contacting the site (threads have no RSS; following threads is M2; suggests the board or the forum-wide feed). A board link (`/forums/name.12/`) tries the board's `index.rss` first | User's Overclock.net thread link failed | Clear next step; board RSS works even where the board page shows a bot check |

## 2026-10-19 (round 9: v1.0.0 release)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-063 | Release **v1.0.0**: versions bumped to 1.0.0; `CHANGELOG.md` added; CI publishes `1.0.0` / `1.0` / `1` images when a `v*` tag is pushed (`latest` still tracks `main`). Release notes list YouTube/Reddit as awaiting retest and forum pages (M2) as not included | User asked to merge and release v1.0 | Lets the Pi pin a known version; known limitations stated rather than hidden |

## 2026-10-19 (round 8: tags, editing, reader, retention)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-055 | **Retention per source.** "Keep items for": Default / Forever / 7 / 30 / 90 / 365 days. Default follows `config.yaml` `retention.keepDays` (0 = forever). Saved items are never deleted; read and unread unsaved items older than the limit are. Removed items are remembered (tombstones, kept ~13 months) and items older than the limit are skipped at ingest, so they're not re-added. Runs 5 min after start, then hourly, and immediately when a source's setting changes; the UI confirms before shrinking | User asked for per-source retention + Claude | A news source may only be worth a week; a forum board forever. Without tombstones, feeds that still list old items would re-add them as unread |
| D-056 | **Tags on sources** (several per source, normalised: lower case, dashes for spaces, max 30 chars, max 12). Items show their source's tags, looked up when listed, so editing tags applies to existing items. Filter by tag in the feed; tapping a tag chip filters. No per-item tags for now | User + defaults accepted | Says what a story is about and where it's from; retroactive by design |
| D-057 | **Edit a source:** name, address, tags, check interval, keep-items. A new address is resolved and checked before saving; existing items are kept and new ones join them; a feed already followed elsewhere is refused | User + defaults accepted | Feeds move; losing history would be worse |
| D-058 | **Reader:** tapping an item opens it in-app. Order = the current list, including read items. Next/Prev by buttons, horizontal swipe (> 70 px, mostly sideways), ←/→ or j/k; Esc or Back closes; `s` saves. Opening marks read. Content priority: YouTube embed → the feed's own full text (≥ 500 chars) → the article page extracted with Mozilla Readability (fetched once on open, cached) → summary + a notice saying why. Failed pages aren't retried for 24 h | User + defaults accepted | One place to read; respectful of sites (no prefetching of pages, failures not hammered) |
| D-059 | **Reader security:** article/feed HTML is sanitised on the server with DOMPurify and an allow-list (formatting, tables, figures; no scripts, styles, iframes, forms, event handlers, data-attributes); links are http(s) only and open in a new tab with `noopener noreferrer nofollow`; images must be https and load with `no-referrer`. The page CSP still blocks inline scripts. CSP `frame-src` allows only `www.youtube-nocookie.com`; the embed iframe sends `strict-origin-when-cross-origin` because YouTube's player needs the embedding origin | Claude | Showing other sites' HTML is the main new risk; defence in depth |
| D-060 | Fetching an article page when the user opens it is user-initiated (like a browser), not crawling (consistent with D-045). Bot checks are still never worked around; the reader falls back to the summary | Claude | Same line as feeds |
| D-061 | New dependencies: `jsdom` 29 (pinned below 30, which needs Node ≥ 22.22.2), `@mozilla/readability`, `dompurify`. Idle memory in the container ~128 MB (was ~70–100 MB) | Claude | Proven libraries for the riskiest part; fine on a 4 GB Pi |
| D-062 | Form fields get unique IDs (`useId`). The end-to-end test found the add and edit forms sharing `f-tags`, which sent the "Tags" label to the wrong box | Claude | Accessibility and correctness |

## 2026-10-19 (round 7: first real use)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-052 | Reddit links on any host (`www.`, `old.`, `new.`, `np.`, `m.`) map to `https://www.reddit.com/r/<name>/.rss` (or `/user/<name>/.rss`), shown with a "Reddit" badge. If Reddit refuses, say so plainly instead of retrying around it | User's failed `old.reddit.com` link + Claude | A subreddit page isn't a feed. old.reddit's robots.txt disallows all bots. Reddit's block page asks scripts to register, which stays the M5 route |
| D-053 | To diagnose the failures, Claude made exactly one request each from the build environment: `www.reddit.com/robots.txt` (blocked: "network policy") and the `@ImKibitz` channel page (allowed by YouTube's robots.txt). Claude did **not** fetch the YouTube feed itself (D-045); the user's retry on the Pi provides that | Claude | Minimal, rule-respecting diagnosis; the feed step can only be judged from the user's own IP anyway |
| D-054 | Every failed "add source" is logged (`could not add source`, with the input and reason), so `docker logs` shows the cause without the UI | Claude | First real use showed the error text is the key diagnostic |

## 2026-10-19 (round 6: M1, the first usable reader)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-045 | robots.txt governs **crawling** (forum page reading, discovery). A feed the user explicitly subscribes to is fetched like in any feed reader, even where robots.txt lists it (YouTube lists `/feeds/videos.xml`). Bot checks are still never worked around. Claude doesn't fetch these feeds from the build environment; YouTube support is tested against a sample in YouTube's format | Claude | Standard feed-reader practice (Google's feed fetcher works the same way); YouTube publishes these feeds for readers. Refines D-037, which said "follows robots.txt" without that distinction |
| D-046 | Sources are added and managed in the UI and stored in the database, not in config.yaml. config.yaml keeps the polling/retention defaults | Claude | Pasting a URL is easier than editing YAML; D-012's "settings screen later" happens first for sources |
| D-047 | On a source's first fetch, items older than 7 days start as read | Claude | A new YouTube channel or blog would otherwise drop up to 15–50 old items into Unread |
| D-048 | `read` / `saved` live on the item row; no separate ItemState table yet | Claude | Single user (D-013); simpler queries. A per-user table can come if multi-user ever happens |
| D-049 | CSP allows `https:` images so YouTube thumbnails and feed images show. Only http(s) image URLs are stored, and they're loaded with `no-referrer`. Summaries are plain text; nothing from a feed is rendered as HTML | Claude | Thumbnails make YouTube usable; plain text removes the XSS risk from untrusted feeds |
| D-050 | The "health view" is part of the Sources page (status, last error, last and next check per source) rather than a separate page | Claude | One place to see and fix a source |
| D-051 | Scheduler: in-process, checks due sources one at a time every 15 s; per-host spacing via HostLimiter (5 s + jitter for scheduled checks, 1 s when adding interactively); ±10 % interval jitter; backoff 2× per failure up to 6 h; pause after 5 failures; ETag / Last-Modified | Claude | DESIGN §7, applied to feeds |

## 2026-10-11 (round 5: easier install)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-040 | Zero-config install: `docker run` one-liner **and** a standalone `docker-compose.yml` (curl + `up -d`), both using a fixed-name volume `forumaggregator-data`. Optional `docker-compose.postgres.yml` | User ("much easier to set up", "compose as an option") + Claude | No `.env`, folders or keys before first start; options A and B share the same data |
| D-041 | `FA_SECRET_KEY` becomes optional: if unset, a key is generated once into `/data/secret.key` (0600, created with an exclusive write so it's never overwritten). A truncated key file is an error, not silently replaced | Claude | Removes the only required setting. The key sits next to the data it protects, so volume backups include it |
| D-042 | Entrypoint starts as root only to `chown` `/data` to `PUID:PGID` (default 1000:1000) when needed, then `setpriv` drops to that user with no capabilities and `no_new_privs`. With `user:`/`--user` it skips straight to the app | Claude | Bind mounts work without a manual chown; same PUID/PGID convention as linuxserver.io images. Supersedes "runs as uid 1000" in D-033 |
| D-044 | **Accepted 2026-10-19.** Reorder: M1 = first usable reader on RSS/Atom (YouTube, Overclock.net boards, subreddits, sites) with the feed screen; forums move to M2. Progress tracked in ROADMAP.md, the single source of truth for milestones | Claude, after the user asked whether the app is usable and where the plan and tracker are | Forum work is blocked on user input; RSS gives a working app now without losing any planned scope |
| D-043 | First-run setup code also printed as a plain-text banner; tool and backup commands use `docker exec`/`docker stop`, which work for both install options. CI no longer publishes a `:main` tag | Claude | Easier to find in `docker logs`; fewer tags to confuse |

## 2026-10-11 (round 4: site access)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-036 | Claude does not fetch the forums from the build environment. Parser fixtures come from pages the user saves in their own browser and attaches in chat (never committed; the repo is public) | Claude | thehotpepper.com and overclock.net robots.txt explicitly disallow AI agents (ClaudeBot, anthropic-ai, ChatGPT-User…) |
| D-037 | The app identifies itself honestly (`ForumAggregator/<ver> (personal feed reader)`), follows the `*` robots.txt rules, and never disguises automation or circumvents bot challenges. This replaces DESIGN v0.2's "realistic browser user agent" | Claude | Bot checks are the site owners' explicit wishes. A personal reader can be polite without pretending to be a browser |
| D-038 | Added a `check-sites` diagnostic, run on the user's server, to learn what each forum serves to that IP (page, RSS, challenge, robots) before choosing a reading method per site | Claude | Challenges seen from the data-centre IP may not apply to a home IP; only the user's server can tell |
| D-039 | CI gets a manual "Run workflow" trigger. `latest` is published only from `main`; manual runs on other branches publish a branch-name tag plus `sha-…` | Claude | Re-publish after fixing Docker Hub secrets without a code push; test images without moving `latest` |

## 2026-10-10 (round 3: M0 build)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-026 | Forum accounts have no 2FA today. M1 builds password login (A) first and the built-in login browser (B) right after. Later 2FA is handled per site: authenticator-app 2FA by storing its secret (stays automatic), email/SMS codes or captchas via B | User + Claude | User asked what changes if 2FA is added later: nothing structural |
| D-027 | Kysely instead of Drizzle | Claude | Drizzle needs a separate schema per database (sqlite-core vs pg-core); Kysely runs one set of migrations and queries on both. Timestamps are epoch-ms integers and booleans 0/1 for portability |
| D-028 | First-run setup code printed to the container log, required to create the account | Claude | App is internet-facing; stops anyone else claiming a fresh instance |
| D-029 | App login: Argon2id, 12+ character passwords, optional TOTP with replay protection, HttpOnly SameSite=Lax cookies storing only a token hash, 30-day sliding sessions, 10 attempts per 15 min per IP, CSRF header on all mutating calls | Claude | Internet-facing single-user app |
| D-030 | Nginx Proxy Manager is the reverse proxy. Default `TRUST_PROXY=loopback,uniquelocal`. HSTS left to NPM. Websockets enabled in NPM ahead of M1 | User + Claude | Works out of the box behind NPM on the LAN or a Docker network |
| D-031 | Authelia/Authentik supported later via `AUTH_MODE=both`. The header is trusted only from the proxy's exact IP; don't publish port 8080 when using it | User (considering SSO) + Claude | Forward auth can be spoofed by anything reaching the app directly |
| D-032 | Node 22 LTS for now (what the build and tests ran on); move to Node 24 LTS in a later milestone | Claude | Tested parity over novelty. Node 22 is supported until April 2027 |
| D-033 | Docker: Debian slim base (prebuilt native binaries need glibc), `npm ci --ignore-scripts`, runs as uid 1000, healthcheck on `/healthz`. CI builds amd64+arm64 to GHCR on push to `main` | Claude | Small attack surface, no compiler needed, Pi-ready |
| D-035 | Images are public: GHCR (made public once by hand) **and** the user's Docker Hub. Docker Hub push runs only when the `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets exist. Every build is tagged `latest` + `sha-<commit>` | User + Claude | Easy pulls on the server and Pi; SHA tags allow pinning and rollback |
| D-034 | npm workspaces monorepo: `packages/shared` (API types, zod schemas on a separate subpath so the UI bundle stays small), `packages/server`, `packages/web` | Claude | Shared contract for UI, server and a future Android app |

## 2026-10-10 (round 2)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-017 | The app discovers forum structure. I can correct it (rename, hide, move, add manually, override selectors). Corrections are stored separately and survive re-discovery | User + Claude | User wants auto-discovery with manual correction |
| D-018 | Filtering: highlight rather than hide by default, nothing deleted (Filtered view), preview before saving, reusable keyword sets. Simple 3-box mode on top of an ordered rule engine | Claude (proposed); user was open to suggestions | Reduces the risk of missing posts silently. Simple to start, powerful when needed |
| D-019 | No cookie export. Login order: A) username and password with automatic re-login, B) built-in login browser streamed into the app page for captchas and 2FA, C) cookie paste as a hidden last resort | User (cookie export too difficult) + Claude | Easy for the user and survives expired sessions |
| D-020 | Public behind the user's reverse proxy at `forumaggregator.<domain>`. The app has its own login (Argon2 password, optional TOTP, rate-limited) and trusts forwarded headers from the proxy | User + Claude | It's reachable from the internet, so it must be locked down |
| D-021 | Language: **TypeScript / Node** (Fastify, ~~Drizzle~~ Kysely per D-027, React + Vite PWA, Playwright). Rust, C++ and Go were rejected | Claude (recommended), **user confirmed** | Playwright is native to Node; code can be shared with an Android app later; database layer handles both SQLite and Postgres. The app waits on the network, so Rust/C++ speed buys nothing |
| D-022 | SQLite by default; Postgres optional via `DATABASE_URL`. Search sits behind an interface (FTS5 or tsvector). Retention is configurable, default keep everything, saved items never deleted | User + Claude | User is fine with SQLite; others may want a more robust database |
| D-023 | Same multi-arch image on the i3 server and on a Pi. Pi: 4 GB+ RAM and an SSD recommended. AI is never inside the container; it's called over HTTP | User + Claude | User wants it to run on both |
| D-024 | YouTube: specific creators via the channel's public feed, no API key | User | |
| D-025 | No notifications for now | User | |

## 2026-10-10 (round 1)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-001 | Deploy as a single Docker container on a Linux server or Raspberry Pi, with everything on one port | User | Runs on my own server |
| D-002 | Logging in to every forum is required | User | I'm logged in on every site, and members-only content matters |
| D-003 | Sources in scope: thehotpepper.com (whole site at first), overclock.net (RTX 5070 Ti and 3080 boards, 5070 Ti Owners Club thread), bikeforums.net Tandem. Later: Reddit, YouTube creators | User | |
| D-004 | "Level" means where I follow in the tree: site / board / thread / post | User | Each forum has a different structure |
| D-005 | The app discovers each forum's board structure. I pick what to follow from that tree | Claude (proposed), answering the user's question | Whole-site follow is fine for THP but too noisy for overclock.net. Discovery deals with differences between forums without me typing URLs |
| D-006 | Add an `activity` item mode: one card per thread showing its new-reply count | Claude (proposed) | Answers "a way to see recent activity" for busy GPU boards |
| D-007 | Keywords are **filters** on the feed. **Search** is a separate local full-text feature | Claude (proposed), answering the user's question | The two were mixed together in the original questions |
| D-008 | No AI in the first version. Design a pluggable, off-by-default AI stage (DESIGN §11) | User / Claude | User asked for a proposal only |
| D-009 | Read in this app's web UI, mobile-friendly. Possibly an Android app later, so the UI is built on a JSON API | User | |
| D-010 | Polling rates, delays and limits are configurable at global, site and subscription level, with backoff and a circuit breaker | User | Expect blocking and API limits |
| D-011 | Read/unread, save and mute are in scope | User | |
| D-012 | Settings live in a config file at first, then move to a UI settings screen | User | |
| D-013 | Single user | User | |
| D-014 | Claude drives the implementation | User | |
| D-015 | ~~Default login method is cookie import~~ **Superseded by D-019** | Claude (proposed) | Captchas and 2FA make automated logins brittle |
| D-016 | ~~Stack: Python 3.12, FastAPI, HTMX…~~ **Superseded by D-021** | Claude (proposed) | One process, Pi-friendly, no JS build step |

## Open questions

Resolved: Q-LOGIN (D-019), Q-ACCESS (D-020), Q-STACK (D-021), Q-PI (D-023), Q-RETENTION (D-022), Q-YOUTUBE (D-024), Q-NOTIFY (D-025), Q-2FA (D-026), Q-PROXY (D-030, D-031).

Resolved: Q-GHCR (D-035), Q-PI-TEST (user has a Pi; checklist in DEPLOY.md).

- **Q-FORUM-ACCESS**: How should the app read each forum? Options A–D in [SITE-ACCESS.md](SITE-ACCESS.md). Needs the `check-sites` output from the user's server, plus saved sample pages.
- **Q-EMAIL**: Is reading forum email notifications from a mailbox (option C) acceptable?
- **Q-DOCKERHUB**: Docker Hub push was skipped on the 2026-10-11 run (`DOCKERHUB_USERNAME` empty at run time). Check the secret names and location, then re-run.
- **Q-YT-COMMENTS**: Resolved by D-075.
- **Q-REDDIT**: Subreddits only, or also your home feed and saved posts? Deferred until after YouTube.
