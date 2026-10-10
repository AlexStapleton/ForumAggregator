# Decision log

Each entry records what was decided, who decided it, and why. Newest first within each date.

## 2026-10-10 (round 2)

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-017 | The app discovers forum structure. I can correct it (rename, hide, move, add manually, override selectors). Corrections are stored separately and survive re-discovery | User + Claude | User wants auto-discovery with manual correction |
| D-018 | Filtering: highlight rather than hide by default, nothing deleted (Filtered view), preview before saving, reusable keyword sets. Simple 3-box mode on top of an ordered rule engine | Claude (proposed); user was open to suggestions | Reduces the risk of missing posts silently. Simple to start, powerful when needed |
| D-019 | No cookie export. Login order: A) username and password with automatic re-login, B) built-in login browser streamed into the app page for captchas and 2FA, C) cookie paste as a hidden last resort | User (cookie export too difficult) + Claude | Easy for the user and survives expired sessions |
| D-020 | Public behind the user's reverse proxy at `forumaggregator.<domain>`. The app has its own login (Argon2 password, optional TOTP, rate-limited) and trusts forwarded headers from the proxy | User + Claude | It's reachable from the internet, so it must be locked down |
| D-021 | Language: **TypeScript / Node** (Fastify, Drizzle, React + Vite PWA, Playwright). Rust, C++ and Go were rejected | Claude (recommended); user asked for a recommendation, **awaiting OK** | Playwright is native to Node; code can be shared with an Android app later; database layer handles both SQLite and Postgres. The app waits on the network, so Rust/C++ speed buys nothing |
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

Resolved: Q-LOGIN (D-019), Q-ACCESS (D-020), Q-STACK (D-021, awaiting OK), Q-PI (D-023), Q-RETENTION (D-022), Q-YOUTUBE (D-024), Q-NOTIFY (D-025).

- **Q-STACK-OK**: Confirm TypeScript (D-021).
- **Q-2FA**: Do any of the forum accounts use 2FA? (Decides whether login method B is needed in M1 or can wait.)
- **Q-PROXY**: Which reverse proxy (Nginx Proxy Manager, Traefik, Caddy, plain Nginx)? Does it already do single sign-on (Authelia or Authentik)?
- **Q-REDDIT**: Subreddits only, or also your home feed and saved posts? Deferred until after YouTube.
