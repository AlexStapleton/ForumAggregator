# Deploying ForumAggregator

Target setup: one Docker container on a Linux server or Raspberry Pi, published at
`https://forumaggregator.<your-domain>` through **Nginx Proxy Manager (NPM)**.

## 1. Requirements

- Docker (with the Compose plugin if you use option B).
- x86-64 or **arm64** (Raspberry Pi 4/5 running a 64-bit OS). 32-bit Raspberry Pi OS is not supported.
- On a Pi: keep Docker's data on an SSD rather than the SD card (DESIGN.md §10).

## 2. Install

Nothing to configure first: no `.env` file, no folders, no keys. Pick either option.

### Option A: one `docker run` command

```bash
docker run -d --name forumaggregator --restart unless-stopped \
  -p 8080:8080 -v forumaggregator-data:/data \
  alexstapo/forumaggregator:latest
docker logs forumaggregator          # shows the first-run setup code
```

### Option B: Docker Compose

```bash
mkdir forumaggregator && cd forumaggregator
curl -fsSLO https://raw.githubusercontent.com/AlexStapleton/ForumAggregator/main/docker-compose.yml
docker compose up -d
docker compose logs forumaggregator  # shows the first-run setup code
```

Prefer Postgres to the built-in SQLite? Use `docker-compose.postgres.yml` instead (instructions
at the top of that file). For one user, SQLite is simpler and lighter, especially on a Pi.

### First run

The log shows:

```
  ┌──────────────────────────────────────────────────────────┐
  │  ForumAggregator first-run setup                         │
  │  Setup code: ABCDE-FGHJK                                 │
  │  Open the app in your browser and enter this code.       │
  └──────────────────────────────────────────────────────────┘
```

Open `http://<server-ip>:8080`, enter the code, and choose your username and password. The
code stops working once the account exists; until then it changes on every restart.

> **Do the first-run setup before exposing the app publicly**, or soon after. Without the
> code nobody can claim the account, but there's no reason to leave it waiting.

### What happens automatically

- **Encryption key:** on first start the app generates the key that protects stored
  passwords and 2FA secrets, and saves it as `secret.key` in the data volume (readable only by
  the app). Backing up the volume backs up the key. To manage the key yourself, set
  `FA_SECRET_KEY` instead.
- **Permissions:** the container starts as root only to make `/data` owned by `PUID:PGID`
  (default `1000:1000`), then drops to that user with no privileges before starting the app.
  So a host folder (`-v ./data:/data`) works as well as a Docker volume, with no `chown`.
  If you run the container with a fixed `user:` / `--user`, this step is skipped and the
  folder must already be writable by that user.

### Updating

```bash
docker compose pull && docker compose up -d          # Option B
docker pull alexstapo/forumaggregator:latest && \
  docker rm -f forumaggregator && <the docker run command again>   # Option A
```

Database migrations run automatically on start. Your data lives in the
`forumaggregator-data` volume, so it survives updates and switching between options A and B.

> **Installed before October 11, 2026 (with a `.env` file and a `./data` folder)?** Your key is
> `FA_SECRET_KEY` in `.env`. Either keep using that `.env` (add `env_file: .env` and
> `./data:/data` to the new compose file), or move the key into the data folder once:
> `grep '^FA_SECRET_KEY=' .env | cut -d= -f2- > data/secret.key && chmod 600 data/secret.key`.
> Starting without it would generate a *new* key, and the app couldn't read secrets saved
> under the old one.

### Where the image comes from

CI builds the image for amd64 and arm64 on every push to `main` and publishes it to:

- **GitHub Container Registry:** `ghcr.io/alexstapleton/forumaggregator:latest`. GitHub makes a
  new package private at first. Make it public once: GitHub → your profile → Packages →
  forumaggregator → Package settings → Change visibility → Public.
- **Docker Hub (default in the docs):** `alexstapo/forumaggregator:latest`
  ([hub.docker.com/r/alexstapo/forumaggregator](https://hub.docker.com/r/alexstapo/forumaggregator)). How CI publishes there:
  1. Docker Hub → Account settings → Personal access tokens → generate one with **Read & Write**.
  2. GitHub repo → Settings → Secrets and variables → Actions → New repository secret:
     `DOCKERHUB_USERNAME` (your Docker Hub username) and `DOCKERHUB_TOKEN` (the token).
  3. The next push to `main` creates `docker.io/<user>/forumaggregator`. Docker Hub repos are public by default.

  Until those secrets exist, CI simply skips Docker Hub.

Every build is also tagged with its short commit SHA (e.g. `:sha-0243689`) so you can pin or
roll back. To pull from GitHub instead, use `ghcr.io/alexstapleton/forumaggregator` in place of
`alexstapo/forumaggregator`. To build the image yourself
from a clone of the repo: `docker build -t alexstapo/forumaggregator:latest .`
(a few minutes on a Pi).

### Raspberry Pi check (first install)

1. 64-bit OS: `uname -m` must print `aarch64`.
2. Data on an SSD if possible: Docker's data directory, or a host folder on the SSD
   (`-v /mnt/ssd/forumaggregator:/data`).
3. Follow the steps above, then confirm:
   - `docker ps` shows `(healthy)` after ~30 s
   - `docker stats --no-stream forumaggregator` shows roughly 60–120 MB memory
   - the setup page loads at `http://<pi-ip>:8080`, and logging in takes under ~1 s
4. If the container keeps restarting, `docker logs forumaggregator` shows why.

## 3. Nginx Proxy Manager

**Hosts → Proxy Hosts → Add Proxy Host**

| Tab | Setting | Value |
|---|---|---|
| Details | Domain Names | `forumaggregator.<your-domain>` |
| | Scheme | `http` |
| | Forward Hostname / IP | The server's LAN IP, or `forumaggregator` if NPM shares a Docker network with it (see below) |
| | Forward Port | `8080` |
| | Cache Assets | Off (the app sets its own cache headers) |
| | Block Common Exploits | On (the app never puts addresses in query strings, so it isn't affected) |
| | Websockets Support | Off (the app doesn't use websockets) |
| SSL | SSL Certificate | Request a new Let's Encrypt certificate |
| | Force SSL | On |
| | HTTP/2 Support | On |
| | HSTS Enabled | On (the app leaves HSTS to the proxy) |

NPM already sends `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. The default
`TRUST_PROXY=loopback,uniquelocal` trusts those headers from private addresses (LAN and
Docker), so the app sees the real client IP and HTTPS, and marks its session cookie `Secure`.
No extra configuration is needed to make it work.

**Advanced tab** (recommended): adding a site through FlareSolverr can take over a minute, longer
than nginx's default 60 s wait for an answer. Paste:

```nginx
proxy_read_timeout 180s;
```

**Check it:** log in through your domain and open **Settings → Signed-in devices**. The line
"This connection" should read *HTTPS, from &lt;your public IP&gt;, through your reverse proxy;
login cookie marked Secure*. If it says *through a proxy the app doesn't trust*, NPM's address
isn't covered by `TRUST_PROXY`: set it to NPM's address (below).

**Tighten it** (recommended): `TRUST_PROXY` lets anything at a trusted address claim to be any
client. The default trusts your whole LAN, so a device on it could pretend to be many clients.
The login limits that matter can't be dodged this way, since they count per account (wrong
passwords and wrong two-factor codes, D-110), but the addresses shown under Signed-in devices
and in the logs could be faked. Trusting only NPM closes that:

```yaml
environment:
  TRUST_PROXY: 172.18.0.5     # NPM's address as the app sees it (e.g. its container IP on a shared
                              # Docker network, or the LAN IP of the machine NPM runs on)
```

The app logs the connecting address of every failed login (`peer` in the log line); after one
failed login through your domain, that's NPM's address.

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

How login is protected (D-110):

- **Wrong two-factor codes:** after 5 in a row, codes are refused for 15 minutes (then 30, 60…,
  at most a day), whatever address they come from. A code can only be used once.
- **Wrong passwords:** after 10 in a row, each try has to wait (1 minute, doubling, at most an
  hour). Devices that are already logged in aren't affected. There is also a limit of 10 tries
  per 15 minutes per client address.
- **Turning two-factor on or off signs out every other device**, so a session from before can't
  outlive it.
- **Settings → Signed-in devices** lists every logged-in device (browser, address, last use),
  with **Sign out** for each and **Sign out everywhere else**. Each device must log in again at
  least every 90 days (`SESSION_MAX_DAYS`).

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
| `PUID` / `PGID` | `1000` / `1000` | User and group the app runs as; the data folder is made theirs |
| `FA_SECRET_KEY` | generated | Encrypts stored secrets (32+ characters). Unset: generated once and kept in `/data/secret.key`. Never change it after setup |
| `PORT` | `8080` | Listen port inside the container |
| `DATA_DIR` | `/data` | Database, `config.yaml` |
| `DATABASE_URL` | SQLite in `DATA_DIR` | `postgres://user:pass@host:5432/db` to use Postgres |
| `TRUST_PROXY` | `loopback,uniquelocal` | Who may set `X-Forwarded-*`: IPs, CIDRs or presets. `false` disables |
| `COOKIE_SECURE` | `auto` | `auto` = Secure when the request came in over HTTPS |
| `SESSION_TTL_DAYS` | `30` | Sliding login lifetime per device |
| `SESSION_MAX_DAYS` | `90` | A device must log in again (with its two-factor code) after this long, even if in use |
| `AUTH_MODE` | `local` | `local`, `proxy` or `both` (§5) |
| `AUTH_PROXY_HEADER` | `Remote-User` | Username header from the SSO proxy |
| `AUTH_PROXY_TRUSTED` | — | Required for `proxy`/`both`: direct-peer IPs allowed to send that header |
| `FA_SETUP_CODE` | random | Fixes the first-run setup code instead of printing a random one |
| `LOG_LEVEL` | `info` | `debug` for troubleshooting |

What to follow and how politely to fetch it lives in `data/config.yaml`; see
`config.example.yaml`.

## 7. Checking what the forums allow from your server

```bash
docker exec forumaggregator node packages/server/dist/tools/check-sites.js [url ...]
```

For each forum it reports whether pages and RSS are readable from this server or hit a bot
check, which forum software it runs, and what robots.txt allows. It makes at most 3 requests
per site, 5 s apart. See [SITE-ACCESS.md](SITE-ACCESS.md) for what to do with the results.

If your server reaches the internet through an outbound proxy, give the container
`NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY=…` environment variables.

### Forums behind a Cloudflare check: FlareSolverr (optional)

If the check above shows a Cloudflare browser check ("Just a moment…") for a forum you want to
follow, and you run [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr), the app can
use it for that forum (D-080):

1. **Settings → FlareSolverr:** enter its address, e.g. `http://192.168.1.50:8191`, or
   `http://flaresolverr:8191` if both containers share a Docker network. **Save and test**
   checks that it answers.
2. **Add the board** as usual (e.g. `https://thehotpepper.com/forums/hot-pepper-growing.4/`).
   When the site answers with a Cloudflare check, the app retries through FlareSolverr and marks
   the source "Fetched through FlareSolverr". You can switch it per source in **Edit**.

How it behaves:
- FlareSolverr opens the page once; the app then reuses the pass it got (cookie plus that
  browser's identity) for plain requests until Cloudflare asks again, so most checks cost one
  ordinary request. The usual per-site spacing and check interval still apply.
- The pass only works from the **same public IP** as FlareSolverr. Run both on the same home
  network, without a VPN in front of only one of them. Otherwise every request has to go through
  FlareSolverr (it still works, just slower and heavier).
- Opening a forum thread shows its posts (first page). Threads are read again after 30 minutes
  for new replies.
- To follow one thread for new replies, paste the thread's link in Sources (D-084).
- Nothing logs in; you see what a guest sees.

## 8. Backups

Everything lives in the `forumaggregator-data` volume: the database, `secret.key` and
`config.yaml`. Stop the app briefly so the SQLite files are consistent:

```bash
docker stop forumaggregator
docker run --rm -v forumaggregator-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/forumaggregator-$(date +%F).tgz -C /data .
docker start forumaggregator
```

Restore by extracting the archive into an empty `forumaggregator-data` volume the same way
(`tar xzf … -C /data`). With Postgres, also back up the database (`pg_dump`). With your own
`FA_SECRET_KEY`, keep a copy of it too.
