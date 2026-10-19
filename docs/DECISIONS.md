# Decision log

Each entry records what was decided, who decided it, and why. Newest first within each date.

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
- **Q-REDDIT**: Subreddits only, or also your home feed and saved posts? Deferred until after YouTube.
