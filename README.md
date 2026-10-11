# ForumAggregator

A self-hosted personal news feed. It follows the forum boards and threads, subreddits and
YouTube creators you choose, logs in to forums as you, filters by keywords, and lets you
read everything in one place on desktop or phone.

**Status: milestone M0 done.** The app runs in Docker with its own secure login (password +
optional authenticator-app 2FA) behind a reverse proxy. Reading forums (M1) is waiting on a
decision about how to read each site: see [Site access](docs/SITE-ACCESS.md).

- [Design](docs/DESIGN.md): requirements, architecture, milestones
- [Decision log](docs/DECISIONS.md): what was decided and why, plus open questions
- [Deployment](docs/DEPLOY.md): Docker, Nginx Proxy Manager, first-run setup, SSO
- [Site access](docs/SITE-ACCESS.md): what each forum allows, and the options for reading it

## Quick start (Docker)

```bash
cp .env.example .env && echo "FA_SECRET_KEY=$(openssl rand -base64 48)" >> .env
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build
docker compose logs forumaggregator | grep "FIRST RUN"   # setup code for creating your account
```

Then open http://<server>:8080. See [DEPLOY.md](docs/DEPLOY.md) for the HTTPS / reverse-proxy setup.

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
