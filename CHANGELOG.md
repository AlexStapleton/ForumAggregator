# Changelog

All notable changes to ForumAggregator. Versions follow [Semantic Versioning](https://semver.org/).
Docker images: `alexstapo/forumaggregator:<version>` and `ghcr.io/alexstapleton/forumaggregator:<version>`
(amd64 + arm64).

## [Unreleased]

## [1.13.0] - 2026-10-28

Follow Bike Forums (vBulletin) threads like XenForo ones, and vBulletin boards follow their own
feed instead of the whole forum's. Upgrade with `docker compose pull && docker compose up -d`, or
pin `alexstapo/forumaggregator:1.13.0`. No database changes.

### Added
- **Follow a vBulletin thread** (e.g. Bike Forums), like XenForo threads: paste the thread's link (any page) and it becomes a Thread source with one card that comes back with the new replies, and the whole thread page by page (D-120). Bike Forums sources added before this are not changed: to follow a thread, paste its link again.

### Fixed
- Adding a vBulletin board or thread page followed the whole forum's feed, which vBulletin lists first; the board's own feed is used now (D-121). Sources added before keep their feed.

## [1.12.0] - 2026-10-25

Reddit videos and galleries in the reader, and security updates of four libraries. Upgrade with
`docker compose pull && docker compose up -d`, or pin `alexstapo/forumaggregator:1.12.0`. No
database changes.

### Security
- Updated libraries with published advisories (D-118): zod 4.6.6 (high: memory exhaustion when validating oversized input; every API request body is validated with it), fast-uri 4.2.3 / 3.1.9 (moderate: URI scheme spoofing), ip-address 10.7.4 (moderate: slow parsing of long IPv6 zone identifiers, used by the login rate limit), fastify 5.12.6 (low: header validation bypass). `npm audit` reports none left.

### Added
- **Reddit videos and galleries play in the reader** (D-117). Opening such a post asks Reddit for that post's details once; videos play with sound, with speed buttons and fullscreen, and galleries show every picture, swipeable, with captions. If Reddit doesn't answer, a video still tries its usual stream, and a gallery shows its first picture and says why.

## [1.11.0] - 2026-10-25

Accounts for other people, and a podcast player that shows in dark mode. Upgrade with
`docker compose pull && docker compose up -d`, or pin `alexstapo/forumaggregator:1.11.0`.
Database migration 0015 runs by itself on start: your account becomes the admin and keeps its
sources, tags, and read and saved items.

### Added
- **Accounts** (D-114): invite people from Settings → Accounts with a one-time link (7 days); they choose their own username and password. Each account has its own sources, tags, and read and saved items. As the admin you can make a password reset link, turn off someone's two-factor login (lost phone), turn an account off, or delete it. You see each account's name, how many sources it follows and when it was last active, not what it follows or reads.
- A site several accounts follow is fetched once for all of them (D-115). Each follower keeps their own name for it, tags, pause switch and, for a followed thread, their own "new replies". How it's checked (interval, keep items, reader selectors, FlareSolverr) is shared: only the admin, or its only follower, can change it.

### Changed
- Settings → Checking, FlareSolverr and YouTube comments are the admin's; every account's sources use them.
- Retention never deletes an item someone has saved.
- Performance tools: the benchmark logs in with the session cookie (it broke when 1.10 added a second cookie); the seed data has an account.

### Fixed
- The podcast player's buttons were invisible in dark mode on some phone browsers, which draw their built-in audio controls with dark icons on no background. The player now has its own controls in the app's colours: play/pause, back 15 s, forward 30 s, a position slider and the time, plus a link to the audio file when it won't play (D-113).

## [1.10.0] - 2026-10-25

Stronger login protection, signed-in devices, and a new README with screenshots. Upgrade with
`docker compose pull && docker compose up -d`, or pin `alexstapo/forumaggregator:1.10.0`.
Database migrations 0013 and 0014 run by themselves on start. Devices signed in more than 90 days ago
log in again.

### Security
- Two-factor codes and passwords are now limited per account, not only per client address: after 5 wrong codes in a row, codes are refused for 15 minutes (longer if it continues); after 10 wrong passwords, each try has to wait. A device on the LAN could get around the old per-address limit by faking `X-Forwarded-For`. Checks run one at a time so parallel guesses can't slip through (database migration 0013) (D-110).
- Turning two-factor login on or off signs out your other devices; a device must log in again at least every 90 days (`SESSION_MAX_DAYS`).
- Someone spamming wrong passwords or codes can't lock you out: browsers that have logged in before count their own attempts, so only browsers the app hasn't seen have to wait. Changing your password forgets your other known devices (database migration 0014) (D-111).

### Added
- Settings → Signed-in devices: every logged-in device, with Sign out and Sign out everywhere else, and what the app sees of your connection (HTTPS, your address, whether your reverse proxy is trusted) (D-110).

### Changed
- Deployment guide: Nginx Proxy Manager settings corrected (websockets aren't used), a longer read timeout for sites added through FlareSolverr, how to check the setup, and how to narrow `TRUST_PROXY` to the proxy.

## [1.9.0] - 2026-10-25

YouTube channels keep updating when YouTube's feeds fail, an Appearance setting, Edit source fits
phones, and a second optimisation pass. Upgrade with `docker compose pull && docker compose up -d`,
or pin `alexstapo/forumaggregator:1.9.0`. Database migration 0012 (data only) runs by itself on start.

### Fixed
- YouTube channels stopped updating: YouTube's channel feeds have been answering "not found" or "error" on and off. The app now retries within a check, reads the channel through the YouTube API when you have a key (Settings → YouTube comments), and no longer pauses channels over it; channels already paused are resumed (database migration 0012) (D-105).
- Edit source no longer runs off the side of a phone screen (D-106).

### Changed
- Faster: big pages (forum threads, articles) are read on a separate thread, so the app keeps answering while a page is read, and are read about a third faster; card pictures from NASA and similar sites download at card size (about 20 × smaller); followed-thread checks and cards load less from the database. See `docs/PERFORMANCE.md` (D-107).

### Added
- Settings → This device → Appearance: Automatic, Dark or Light, so the app can stay dark whatever the phone's setting (D-106).

## [1.8.0] - 2026-10-25

Overclock.net threads fixed, context on followed-thread cards, WordPress sections (e.g. NASA Earth),
and pictures on cards. Upgrade with `docker compose pull && docker compose up -d`, or pin
`alexstapo/forumaggregator:1.8.0`. No database changes.

### Fixed
- Overclock.net threads: posts were dated by the poster's join date (so a followed thread's card looked weeks old and sank in the feed), had no page bar, and the title was the browser tab's ("| Page 22 | Overclock.net"). Post times, page counts and titles are now read correctly; followed threads are repaired at their next check (D-102).
- Forum post times are shown in your time zone from the exact time, instead of the forum's label from when the page was read ("2d ago").
- Adding a section of a WordPress site (e.g. `science.nasa.gov/earth/`) found only the whole site's feed. The app now finds the section's own feed (`/category/earth/feed/`), and removes the menus and "related" blocks some feeds wrap around the article (D-103).

### Added
- Cards show a picture from the article when the feed doesn't name one (e.g. NASA Science, the Factorio blog, NPR) (D-103).

### Changed
- A followed thread's card shows the three posts before the new replies, dimmed, for context; "Read the whole thread" opens on the newest page (D-102).

## [1.7.0] - 2026-10-23

vBulletin forums (e.g. Bike Forums) read like XenForo threads, with paging and "Load next page".
Upgrade with `docker compose pull && docker compose up -d`, or pin `alexstapo/forumaggregator:1.7.0`.
Database migration 0011 (data only) runs by itself on start.

### Fixed
- vBulletin forum threads (e.g. Bike Forums) showed each poster's member details (rank, badges, join date, post count) and little of the posts. They now read like XenForo threads: author and date above each post's text, quotes (including Bike Forums' own quote boxes) as block quotes, and a page count. Threads opened before are read again (database migration 0011) (D-098).

### Added
- Page through vBulletin threads from a vBulletin board's feed (e.g. Bike Forums) in the reader, with the same pager and "open on first/last page" setting as XenForo threads. Long opening posts now show the whole thread too (D-099).
- "Load next page" at the end of a forum thread page adds the next page's posts below, while the page bar stays for jumping around (D-100).

## [1.6.0] - 2026-10-23

Settings → Checking, and audio for NPR news stories. Upgrade with `docker compose pull && docker compose up -d`,
or pin `alexstapo/forumaggregator:1.6.0`. Database migration 0010 (data only) runs by itself on start.

### Added
- Settings → Checking: how often feeds and followed threads are checked, and how many pages a thread check may read (up to 10). Overrides `config.yaml`, which still sets the defaults (D-095).
- NPR news stories with audio (e.g. StoryCorps) get the podcast player: the reader finds the story's audio on its page, and the card shows its length. Stories already opened are read again once to find it (database migration 0010) (D-096).

### Fixed
- When a story's page couldn't be read, the reader showed the feed's one-line teaser without saying why, and never tried the page again. It now says why and tries again after a day; stories stuck this way are read again once (D-096).

### Changed
- Followed threads are checked every 15 minutes by default (the documented `threadIntervalMinutes`), instead of every 30 like other sources. Set it back to 30 in Settings → Checking if you prefer.

## [1.5.0] - 2026-10-23

Podcast episodes play in the reader, plus two fixes for blogs. Upgrade with
`docker compose pull && docker compose up -d`, or pin `alexstapo/forumaggregator:1.5.0`.
Database migrations 0008 (data only) and 0009 (two new item columns) run by themselves on start.

### Added
- Podcast episodes (e.g. NPR's podcasts) play in the reader: the audio player sits under the title and appears straight away. Speed buttons (0.75×–2×) are remembered per device; the place you stopped is remembered per episode on this device ("Resumed at 12:34 · Start over"). Cards show a headphones mark and the episode's length. Episodes already stored get their player when their feed lists them again (D-093).
- If an episode's web page can't be read, the reader shows its description without a warning, since the audio is the episode.

### Fixed
- Images and links in posts from feeds that write quotes as `&#34;` (e.g. the Factorio blog) were broken. Posts already stored are repaired at the source's next check (database migration 0008 makes that check read the feed in full) (D-091).

### Changed
- Adding a source: if the address you paste doesn't exist (404), the app looks for the feed one or two folders up. For example, `factorio.com/blog/post` now finds the Factorio blog's feed (D-090).

## [1.4.0] - 2026-10-21

Page through forum threads in the reader. Upgrade with `docker compose pull && docker compose up -d`,
or pin `alexstapo/forumaggregator:1.4.0`. No database changes.

### Added
- Page through forum threads in the reader: a pager above the bottom buttons (first, previous, page numbers, next, last, and a box to type a page). Settings → This device → "Forum threads open on" first or last page. A followed thread's card can open the whole thread.

## [1.3.1] - 2026-10-21

Performance release. Upgrade with `docker compose pull && docker compose up -d`, or pin
`alexstapo/forumaggregator:1.3.1`. Database migration 0007 (two indexes) runs automatically.

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
