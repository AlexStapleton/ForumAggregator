# Changelog

All notable changes to ForumAggregator. Versions follow [Semantic Versioning](https://semver.org/).
Docker images: `alexstapo/forumaggregator:<version>` and `ghcr.io/alexstapleton/forumaggregator:<version>`
(amd64 + arm64).

## [Unreleased]

### Changed
- Faster everywhere (details in docs/PERFORMANCE.md): the feed's source and tag lists ~15–60× faster with a large history, tag filters ~18× faster, opening an article ~5× faster, the app's files and lists sent compressed (first visit on a phone ~1 s quicker), and the feed list reacts ~3× faster with many cards. Database migration 0007 adds two indexes (runs automatically).

## [1.3.0] - 2026-10-19

Follow forum threads with one updating card, and a fix for threads read through FlareSolverr.
Upgrade with `docker compose pull && docker compose up -d`, or pin
`alexstapo/forumaggregator:1.3.0`. Database migration 0006 runs automatically.

### Added
- Follow a forum thread: paste a thread link (e.g. an owners' club) and get one card that says how many new replies there are; opening it shows just those replies. Works through FlareSolverr for sites that need it.

### Fixed
- Forum threads through FlareSolverr showed only the feed's first post ("the site still refused the app's follow-up request"): pages that passed Cloudflare's check were mistaken for the check itself. Sites that refuse the app's own requests now go straight to FlareSolverr.

## [1.2.0] - 2026-10-19

Forums behind Cloudflare through your own FlareSolverr, and forum threads shown as posts.
Upgrade with `docker compose pull && docker compose up -d`, or pin
`alexstapo/forumaggregator:1.2.0`. Database migration 0005 runs automatically.

### Added
- Forums behind a Cloudflare check, through your own FlareSolverr (Settings → FlareSolverr; opt-in per source, turned on by itself when adding such a site). See docs/DEPLOY.md §7.
- Forum threads in the reader show the posts (author, time, quotes, images), re-read for new replies.

### Fixed
- `check-sites`: a feed address is checked as given (it used to add a second `/index.rss`).

## [1.1.0] - 2026-10-19

Reddit pictures, source checkboxes and tap-to-open cards. Upgrade with
`docker compose pull && docker compose up -d`, or pin `alexstapo/forumaggregator:1.1.0`.
This release reports its version correctly (1.1.0).

### Added
- Source checkboxes in the feed: show any mix of sources (remembered per device).
- Tap anywhere on a feed card to open it in the reader.

### Changed
- Reddit posts in the reader: pictures are shown full width (image posts show the full image; screenshots linked in the text appear as pictures; the thumbnail table is gone). Gallery and video posts say to open Reddit.

### Fixed
- Posts fetched by v1.0.0 that showed "Open the original" get their text when the feed lists them again.

## [1.0.1] - 2026-10-19

Note: the 1.0.1 image still reports version 1.0.0 (in `/api/version` and its user agent); the
package versions weren't bumped before tagging.

### Added
- Side-by-side layout on wide screens: the list on the left, the reader on the right. Choose Automatic, Side by side or Full-screen reader in Settings → This device (saved per device).
- Timeline: the feed is grouped under day headings (Today, Yesterday, dates), with a Newest first / Oldest first order (saved per device).
- Reader selectors per source (Edit source → "Reader: article selectors"): choose the article and elements to remove with CSS selectors, with a preview, for sites where the reader picks the wrong part of the page.
- OPML import and export of sources (Sources → Import and export). Folders and categories become tags.
- YouTube top comments under videos in the reader, using your own free YouTube Data API key (Settings → YouTube comments).
- Reddit comments in the reader ("Show comments"; loaded on request, cached).
- Forum board links (`…/forums/name.12/`) use the board's RSS directly, even when the board page shows a bot check.

### Fixed
- "Mark all read" with a tag selected now only marks that tag's sources.
- Reader: embed-code snippets (e.g. NPR's "Embed <iframe…>"), media/share toolbars and a repeated headline are removed from articles, including ones opened before this fix.

### Changed
- Reddit posts in the reader come from the feed and never fetch Reddit's pages (no more "needs JavaScript"); the "submitted by … [link] [comments]" clutter is removed; link posts show the linked article.
- Reddit requests are spaced at least 10 s apart to stay under Reddit's limit.
- Forum thread links explain why they can't be followed yet and what to add instead.

## [1.0.0] - 2026-10-19

First release: a self-hosted, single-user feed reader for RSS/Atom feeds, YouTube channels and
forum board RSS, with an in-app reader.

### Install
```bash
curl -fsSLO https://raw.githubusercontent.com/AlexStapleton/ForumAggregator/v1.0.0/docker-compose.yml
docker compose up -d
docker logs forumaggregator   # first-run setup code
```
Or pin the image: `alexstapo/forumaggregator:1.0.0`. See [docs/DEPLOY.md](docs/DEPLOY.md).

### Features
- **Sources:** add a feed URL, a website (its feed is discovered), a YouTube channel link /
  `@handle` / channel ID / playlist, or a Reddit link (mapped to its `.rss` feed). RSS 2.0,
  RSS 1.0 and Atom.
- **Feed:** Unread / All / Saved, filter by source or tag, newest first, mark read, save,
  "mark all read" (only what's on screen), paging.
- **Reader:** tap an item to read it in the app: YouTube video, the feed's full text, or the
  article extracted from the page; Next/Prev via buttons, swipe or keys; summary + reason when a
  site blocks it or it's paywalled.
- **Tags** on sources, applied to their items (edits apply retroactively).
- **Edit sources:** name, address (re-checked, items kept), tags, check interval, keep-items.
- **Retention** per source ("keep items for" N days or forever); saved items never deleted.
- **Polite fetching:** honest User-Agent, ETag/304, per-site spacing, backoff, pause after 5
  failures; bot checks are never worked around.
- **Security:** first-run setup code, Argon2id passwords, optional TOTP 2FA, rate-limited login,
  CSRF protection, CSP, server-side HTML sanitising for the reader, optional SSO header
  (Authelia/Authentik).
- **Deployment:** one container, one port, zero configuration (generated key, automatic data
  folder permissions); SQLite by default, Postgres optional; x86-64 and Raspberry Pi (arm64).
- **Diagnostics:** `check-sites` tool for what each forum allows from your server; failed
  source additions are logged.

### Known limitations
- **YouTube and Reddit** are untested on a real install. The first attempts failed; fixes are
  included but await a retest. Reddit may refuse unregistered apps (Reddit-account support is
  planned).
- **Forums** are readable only through their board RSS feeds; reading threads and pages
  directly (M2) is not in 1.0.
- **Not yet in the UI:** per-item tags, hiding YouTube Shorts, global interval and retention
  defaults (set them in `config.yaml`), installing as a phone app (PWA).
- Tested end to end on amd64. First real install confirmed RSS works (NPR); the arm64 (Raspberry Pi) image is built by CI but not yet confirmed on a Pi.

### Upgrading from pre-release builds
Installs that used a `.env` with `FA_SECRET_KEY` must keep it, or move the key into the data
folder first (see the upgrade note in [docs/DEPLOY.md](docs/DEPLOY.md)).
