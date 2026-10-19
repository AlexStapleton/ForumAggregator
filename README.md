# ForumAggregator

A self-hosted personal news feed. It follows the forum boards and threads, subreddits and
YouTube creators you choose, logs in to forums as you, filters by keywords, and lets you
read everything in one place on desktop or phone.

**Status: usable for RSS/Atom feeds (M1, M1.1); YouTube and Reddit fixes are awaiting a real-world retest.** Add YouTube creators, blogs,
news sites or forum board RSS feeds on the Sources page, tag them, and read everything in one
feed (unread / all / saved, by source or tag) or in the built-in reader: tap an item, then swipe
or press Next to go through your feed. Each source can keep items forever or for N days. Reading forum pages and threads
directly is next (M2). Subreddit RSS may work but is untested. See the [roadmap](docs/ROADMAP.md).

- [Changelog](CHANGELOG.md): what's in each release (current: **1.0.0**)
- [Roadmap and progress](docs/ROADMAP.md): what's done, what's next, what's blocked
- [Design](docs/DESIGN.md): requirements, architecture, how each part works
- [Decision log](docs/DECISIONS.md): what was decided and why, plus open questions
- [Deployment](docs/DEPLOY.md): Docker, Nginx Proxy Manager, first-run setup, SSO
- [Site access](docs/SITE-ACCESS.md): what each forum allows, and the options for reading it
- [FreshRSS comparison](docs/FRESHRSS-COMPARISON.md): how another reader pulls content, and what to adopt

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
`http://<server-ip>:8080`, create your account, and go to **Sources** to add what you follow:
a YouTube channel link or `@handle`, a website, or a feed address. Runs on x86-64 and Raspberry Pi (arm64). HTTPS via Nginx Proxy
Manager, Postgres, single sign-on and backups are covered in [DEPLOY.md](docs/DEPLOY.md).

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
```

Layout:

```
packages/shared   API types and request schemas shared by server, UI (and a future Android app)
packages/server   Fastify API, auth, database (Kysely: SQLite or Postgres), config loading
packages/web      React + Vite UI, served by the server as static files
```
