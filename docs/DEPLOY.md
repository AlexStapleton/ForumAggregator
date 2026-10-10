# Deploying ForumAggregator

Target setup: one Docker container on a Linux server or Raspberry Pi, published at
`https://forumaggregator.<your-domain>` through **Nginx Proxy Manager (NPM)**.

## 1. Requirements

- Docker with the Compose plugin.
- x86-64 or **arm64** (Raspberry Pi 4/5 running a 64-bit OS). 32-bit Raspberry Pi OS is not supported.
- On a Pi: keep `./data` on an SSD rather than the SD card (DESIGN.md §10).

## 2. Start the container

```bash
mkdir forumaggregator && cd forumaggregator
# Get docker-compose.yml and .env.example from the repo, then:
cp .env.example .env
echo "FA_SECRET_KEY=$(openssl rand -base64 48)" >> .env   # keep a backup of this value
mkdir -p data && sudo chown 1000:1000 data                # the app runs as uid 1000, not root
docker compose up -d
docker compose logs forumaggregator | grep "FIRST RUN"
```

The log shows a line like:

```
FIRST RUN: open the app in your browser and create your account with setup code ABCDE-FGHJK
```

Open the app and enter that code with your new username and password. The code stops
working once the account exists. It changes on every restart until then.

> **Do the first-run setup before exposing the app publicly**, or soon after. Without the
> code nobody can claim the account, but there's no reason to leave it waiting.

### Where the image comes from

CI builds the image for amd64 and arm64 on every push to `main` and publishes it to:

- **GitHub Container Registry:** `ghcr.io/alexstapleton/forumaggregator:latest`. GitHub makes a
  new package private at first. Make it public once: GitHub → your profile → Packages →
  forumaggregator → Package settings → Change visibility → Public.
- **Docker Hub:** `<your-dockerhub-user>/forumaggregator:latest`. One-time setup:
  1. Docker Hub → Account settings → Personal access tokens → generate one with **Read & Write**.
  2. GitHub repo → Settings → Secrets and variables → Actions → New repository secret:
     `DOCKERHUB_USERNAME` (your Docker Hub username) and `DOCKERHUB_TOKEN` (the token).
  3. The next push to `main` creates `docker.io/<user>/forumaggregator`. Docker Hub repos are public by default.

  Until those secrets exist, CI simply skips Docker Hub.

Every build is also tagged with its short commit SHA (e.g. `:sha-0243689`) so you can pin or
roll back. To use Docker Hub, change `image:` in `docker-compose.yml`. To build locally
instead, run `docker compose build` (a few minutes on a Pi).

### Raspberry Pi check (first install)

1. 64-bit OS: `uname -m` must print `aarch64`.
2. Data on an SSD if possible: put the `forumaggregator` folder on it.
3. Follow the steps above, then confirm:
   - `docker compose ps` shows `(healthy)` after ~30 s
   - `docker stats --no-stream forumaggregator` shows roughly 60–120 MB memory
   - the setup page loads at `http://<pi-ip>:8080`, and logging in takes under ~1 s
4. If the container keeps restarting, `docker compose logs forumaggregator` shows why.

## 3. Nginx Proxy Manager

**Hosts → Proxy Hosts → Add Proxy Host**

| Tab | Setting | Value |
|---|---|---|
| Details | Domain Names | `forumaggregator.<your-domain>` |
| | Scheme | `http` |
| | Forward Hostname / IP | The server's LAN IP, or `forumaggregator` if NPM shares a Docker network with it (see below) |
| | Forward Port | `8080` |
| | Cache Assets | Off (the app sets its own cache headers) |
| | Block Common Exploits | On |
| | **Websockets Support** | **On.** Not used yet, but the built-in login browser (milestone M1) streams over a websocket |
| SSL | SSL Certificate | Request a new Let's Encrypt certificate |
| | Force SSL | On |
| | HTTP/2 Support | On |
| | HSTS Enabled | On (the app leaves HSTS to the proxy) |

NPM already sends `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. The default
`TRUST_PROXY=loopback,uniquelocal` trusts those headers from private addresses (LAN and
Docker), so the app sees the real client IP for its login rate limit and marks its
session cookie `Secure`. No extra configuration is needed.

### Optional: share a Docker network instead of publishing port 8080

If NPM runs in Docker on the same host, you can keep the app off the LAN entirely:

```yaml
services:
  forumaggregator:
    # ...as in docker-compose.yml, but delete the `ports:` section
    networks: [npm]
networks:
  npm:
    external: true
    name: <npm's network, e.g. nginxproxymanager_default>
```

Then use `forumaggregator` / `8080` as the forward host and port in NPM. This is **required**
if you later turn on SSO (§5).

## 4. On your phone

Open `https://forumaggregator.<your-domain>` and log in. Under **Settings → Two-factor
login**, turn on an authenticator code. It's recommended because the app is reachable from
the internet. Installing it to the home screen (PWA) arrives with milestone M2.

## 5. Later: single sign-on with Authelia or Authentik

The app can trust a logged-in username from your SSO proxy instead of, or as well as, its
own login:

```dotenv
AUTH_MODE=both                 # both = SSO header OR the app's own login
AUTH_PROXY_HEADER=Remote-User  # header Authelia/Authentik set after login
AUTH_PROXY_TRUSTED=172.20.0.5  # NPM's container IP, and nothing broader
```

- The header value must match your app username. Create the account first (§2).
- **Security:** whoever can reach the app *directly* from a trusted IP can claim to be
  anyone. So when SSO is on:
  - don't publish port 8080 (use the shared network from §3), and
  - set `AUTH_PROXY_TRUSTED` to NPM's exact container IP. Give NPM a fixed IP in its compose
    file. Don't trust the whole Docker subnet or the Docker gateway (`172.x.0.1`): with port
    8080 published, every LAN device arrives from that gateway address.
- In NPM, forward auth goes in the proxy host's **Advanced** tab (`auth_request` snippets
  from the Authelia/Authentik docs), plus
  `proxy_set_header Remote-User $user;` after `auth_request_set $user $upstream_http_remote_user;`.
- **Recommendation: `AUTH_MODE=both`, not `proxy`.** SSO redirects work in a browser, but a
  future Android app calls the API directly and needs the app's own login (or API tokens,
  planned).

## 6. Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `FA_SECRET_KEY` | required | Encrypts stored secrets. 32+ characters. Never change it after setup |
| `PORT` | `8080` | Listen port inside the container |
| `DATA_DIR` | `/data` | Database, `config.yaml` |
| `DATABASE_URL` | SQLite in `DATA_DIR` | `postgres://user:pass@host:5432/db` to use Postgres |
| `TRUST_PROXY` | `loopback,uniquelocal` | Who may set `X-Forwarded-*`: IPs, CIDRs or presets. `false` disables |
| `COOKIE_SECURE` | `auto` | `auto` = Secure when the request came in over HTTPS |
| `SESSION_TTL_DAYS` | `30` | Sliding login lifetime per device |
| `AUTH_MODE` | `local` | `local`, `proxy` or `both` (§5) |
| `AUTH_PROXY_HEADER` | `Remote-User` | Username header from the SSO proxy |
| `AUTH_PROXY_TRUSTED` | — | Required for `proxy`/`both`: direct-peer IPs allowed to send that header |
| `FA_SETUP_CODE` | random | Fixes the first-run setup code instead of printing a random one |
| `LOG_LEVEL` | `info` | `debug` for troubleshooting |

What to follow and how politely to fetch it lives in `data/config.yaml`; see
`config.example.yaml`.

## 7. Backups and upgrades

- Back up `./data` and your `.env` (it holds `FA_SECRET_KEY`). For a consistent SQLite
  copy while the app runs: `sqlite3 data/forumaggregator.db ".backup backup.db"`.
- Upgrade: `docker compose pull && docker compose up -d`. Database migrations run
  automatically on start.
