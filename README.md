# ForumAggregator

A self-hosted reader for the forums, blogs, news sites, podcasts, YouTube channels and subreddits
you follow, in one feed, on your phone or your desktop. It runs on your own server (a Raspberry Pi
is enough) in one Docker container, with no account anywhere else.

![The feed beside the reader, on a desktop in dark mode](docs/screenshots/feed-and-reader.png)

Current release: **1.12.0** ([changelog](CHANGELOG.md)).

## What it does

**Follows**
- **Blogs, news sites and any RSS/Atom feed.** Paste a website and its feed is found; for a
  section of a WordPress site (e.g. `science.nasa.gov/earth/`) the section's own feed.
- **Forums:** XenForo and vBulletin boards (e.g. a board's RSS), and **followed threads**: one card
  per thread that comes back with just the new replies, the posts before them for context.
- **Podcasts:** episodes play in the reader, with speed control and resume where you stopped.
- **YouTube channels** (link or `@handle`), with top comments if you add your own free API key.
- **Subreddits**, through Reddit's public feeds (Reddit sometimes refuses them); videos and
  galleries play in the reader.
- **Sites behind a Cloudflare check**, through your own
  [FlareSolverr](docs/DEPLOY.md#forums-behind-a-cloudflare-check-flaresolverr-optional) if you run one.

**Share it**
- **Accounts for family and friends:** invite someone with a one-time link; they get their own
  sources, tags, and read and saved items. A site several of you follow is checked once.
  [More](docs/DEPLOY.md#accounts-for-other-people).

**Reading**
- A built-in reader shows the full article, not just the feed's teaser, without the site's menus
  and sidebars.
- Forum threads read as posts (author, date, quotes), with a page bar and **Load next page**.
- Side by side on a wide screen, full screen on a phone; swipe or press Next to go through the feed.
- Unread / all / saved, by source (tick the ones you want) or by tag, newest or oldest first.

**Yours to control**
- How often sources are checked, how long items are kept, and per-device layout and
  light/dark appearance.
- OPML import and export, to move your subscriptions from or to other readers.
- Polite by design: one request at a time per site, "only if changed" requests, backing off when
  a site asks, and an honest User-Agent.

| | | |
|---|---|---|
| ![The feed on a phone](docs/screenshots/phone-feed.png) | ![A followed thread's card: earlier posts dimmed, then the new replies](docs/screenshots/phone-followed-thread.png) | ![A podcast episode resumed where it was stopped, at 1.25×](docs/screenshots/phone-podcast.png) |
| The feed on a phone | A followed thread: context, then new replies | A podcast, resumed where you stopped |

![A forum thread in the reader, with the page bar](docs/screenshots/forum-thread.png)

<sub>Screenshots use made-up demo content (`tools/screenshots/demo.mjs`).</sub>

## Install

No configuration needed. Either:

```bash
docker run -d --name forumaggregator --restart unless-stopped \
  -p 8080:8080 -v forumaggregator-data:/data \
  alexstapo/forumaggregator:latest
```

or with Docker Compose:

```bash
curl -fsSLO https://raw.githubusercontent.com/AlexStapleton/ForumAggregator/main/docker-compose.yml
docker compose up -d
```

Then run `docker logs forumaggregator` to get the first-run setup code, open
`http://<server-ip>:8080`, create your account, and go to **Sources** to add what you follow: a
website, a feed, a forum board or thread, a podcast feed, a YouTube channel link or `@handle`, or
a subreddit. Runs on x86-64 and Raspberry Pi (arm64).

HTTPS via Nginx Proxy Manager, Postgres instead of SQLite, single sign-on (Authelia/Authentik),
two-factor login, FlareSolverr and backups are covered in [DEPLOY.md](docs/DEPLOY.md). To
update: `docker compose pull && docker compose up -d`.

## Documentation

- [Changelog](CHANGELOG.md): what's in each release; how to cut one: [RELEASING.md](docs/RELEASING.md)
- [Roadmap and progress](docs/ROADMAP.md): what's done, what's next
- [Deployment](docs/DEPLOY.md): Docker, Nginx Proxy Manager, first-run setup, SSO, FlareSolverr, backups
- [Design](docs/DESIGN.md): requirements, architecture, how each part works
- [Decision log](docs/DECISIONS.md): what was decided and why
- [Performance](docs/PERFORMANCE.md): how fast it is, how it was measured
- [Site access](docs/SITE-ACCESS.md): what each forum allows, and the options for reading it
- [FreshRSS comparison](docs/FRESHRSS-COMPARISON.md): how another reader pulls content

## Development

Requires Node.js 22+.

```bash
npm install
npm run build        # shared types → server → web UI
npm test             # server tests (SQLite)
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/db npm test   # also run them on Postgres
npm run typecheck

# Live reload: API on :8080, UI on :5173 (proxies /api to the API)
DATA_DIR=./data FA_SECRET_KEY=dev-only-secret-key-at-least-32-chars npm run dev -w @fa/server
npm run dev -w @fa/web

# README screenshots (needs Playwright with Chromium installed globally)
node tools/screenshots/demo.mjs
```

Layout:

```
packages/shared   API types and request schemas shared by server, UI (and a future Android app)
packages/server   Fastify API, auth, feeds and forums, reader, database (Kysely: SQLite or Postgres)
packages/web      React + Vite UI, served by the server as static files
tools/            benchmarks (perf/) and the screenshot demo (screenshots/)
```

## License

See [LICENSE](LICENSE).
