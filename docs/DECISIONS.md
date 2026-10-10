# Decision log

Each entry records what was decided, who decided it, and why. Newest first within each date.

## 2026-10-10

| ID | Decision | Source | Rationale |
|---|---|---|---|
| D-001 | Deploy as a single Docker container on a Linux server or Raspberry Pi, with everything on one port | User | Runs on my own server |
| D-002 | Logging in to every forum is required | User | I'm logged in on every site, and members-only content matters |
| D-003 | Sources in scope: thehotpepper.com (whole site at first), overclock.net (RTX 5070 Ti and 3080 boards, 5070 Ti Owners Club thread), bikeforums.net Tandem. Later: Reddit, YouTube creators | User | |
| D-004 | "Level" means where I follow in the tree: site / board / thread / post | User | Each forum has a different structure |
| D-005 | The app discovers each forum's board structure. I pick what to follow from that tree | Claude (proposed), answering the user's question | Whole-site follow is fine for THP but too noisy for overclock.net. Discovery deals with differences between forums without me typing URLs |
| D-006 | Add an `activity` item mode: one card per thread showing its new-reply count | Claude (proposed) | Answers "a way to see recent activity" for busy GPU boards |
| D-007 | Keywords are **filters** on the feed. **Search** is a separate local full-text feature | Claude (proposed), answering the user's question | The two were mixed together in the original questions |
| D-008 | No AI in the first version. Design a pluggable, off-by-default AI stage (DESIGN §9) | User / Claude | User asked for a proposal only |
| D-009 | Read in this app's web UI, mobile-friendly. Possibly an Android app later, so the UI is built on a JSON API | User | |
| D-010 | Polling rates, delays and limits are configurable at global, site and subscription level, with backoff and a circuit breaker | User | Expect blocking and API limits |
| D-011 | Read/unread, save and mute are in scope | User | |
| D-012 | Settings live in a config file at first, then move to a UI settings screen | User | |
| D-013 | Single user | User | |
| D-014 | Claude drives the implementation | User | |
| D-015 | Default login method is cookie import, with optional username/password. Secrets are encrypted at rest | Claude (proposed), **needs confirmation** | Captchas and 2FA make automated logins brittle |
| D-016 | Stack: Python 3.12, FastAPI, HTMX, SQLite (FTS5), httpx, APScheduler. Playwright is optional | Claude (proposed), **needs confirmation** | One process, Pi-friendly, no JS build step |

## Open questions

- **Q-LOGIN**: Is cookie import acceptable as the main login method? Do any of these sites use 2FA on your account?
- **Q-ACCESS**: How will you reach the app from your phone: home network only, a VPN like Tailscale or WireGuard, or a public reverse proxy with HTTPS? This decides how strong the app's own login has to be.
- **Q-STACK**: Is the Python stack in D-016 OK?
- **Q-PI**: Which hardware: a Pi 4 or 5 (arm64), and how much RAM? This decides whether optional Playwright is practical.
- **Q-RETENTION**: How long should items be kept: forever, or e.g. 6 months, with saved items kept for good?
- **Q-REDDIT**: Subreddits only, or also your home feed and saved posts? Do you already have a Reddit API app?
- **Q-YOUTUBE**: Is new uploads per creator enough? Is a one-time Google Takeout import of your subscriptions OK?
- **Q-NOTIFY**: Do you want phone notifications (web push or ntfy), or is checking the app enough for now?
