# Site access: findings and options

Status: **decision needed** (2026-10-11). This blocks how milestone M1 reads forums.

## What we found

Checked from the cloud build environment on 2026-10-11 with a few one-off requests.
Results from *your* server may differ, because bot checks depend heavily on the
visitor's IP address (a cloud data-centre IP is treated with more suspicion than a home one).

| Site | Home page | RSS | Bot protection seen | robots.txt |
|---|---|---|---|---|
| thehotpepper.com | ✅ readable, XenForo confirmed (`xf_csrf` cookie) | ❌ Cloudflare challenge on `/forums/-/index.rss`, possibly triggered by our earlier requests | Cloudflare | Blocks AI agents (ClaudeBot, Anthropic-AI, ChatGPT-User…) entirely. For everyone else (`*`): forums and threads allowed; `/login/`, `/whats-new/`, `/find-new/`, `/members/`, `/posts/`, `/search/` disallowed |
| overclock.net | ❌ JavaScript proof-of-work challenge (`POW_CHALLENGE_DATA`, flags headless browsers; we were marked `xf_is_suspected_bot`) | ✅ site-wide feed `/forums/-/index.rss` served real RSS. Threads have no RSS ("cannot be represented in this format") | VerticalScope bot check | Blocks AI agents (ClaudeBot, anthropic-ai, Claude-Web, ChatGPT-User…) entirely. For `*`: everything allowed except `/login/`, `/account/`, `/search/`, `/goto/` and a few others |
| bikeforums.net | ❌ Cloudflare "Just a moment…" | ❌ Cloudflare | Cloudflare | Not readable (behind the challenge) |

### From your home server (2026-10-19, v1.1.0)

| Site | Board page | Board RSS | Result |
|---|---|---|---|
| thehotpepper.com (`/forums/hot-pepper-growing.4/`) | ❌ Cloudflare "Just a moment…" [HTTP 403] | ❌ same [HTTP 403] | **Not readable directly**, even from a home IP. Logging in can't help: Cloudflare checks the visitor before XenForo (or its login page) sees the request. Needs email (C) or the admins letting feed readers through to their RSS |
| overclock.net | not yet checked from your server | | |
| bikeforums.net | not yet checked from your server | | |

### What this means

1. **The build environment (Claude) must not fetch these forums.** Two sites explicitly
   disallow AI agents, so I stopped after those first requests. To develop page parsers I
   need **sample pages saved from your browser** (see "What I need from you").
2. **Your app is a different visitor.** It runs on your server, identifies itself honestly as
   `ForumAggregator/x.y (personal feed reader)`, falls under the `*` rules, fetches a handful
   of pages every 15–30 minutes, and reads only what your own account can see.
3. **Login pages are disallowed for automated clients on both sites that publish rules.**
   Automated password login (method A in DESIGN §6) posts to `/login/login`. That's a gray
   area: it's you logging in through your own tool, not crawling, but the site has asked
   automated clients not to. Option B (you log in once in a real browser and the app keeps
   that session) avoids it.
4. **Bot checks are the real blocker.** A plain program can't pass a JavaScript challenge.
   Making automation *look* like a human browser to get past these checks (stealth plugins,
   faking browser fingerprints) is exactly what the sites are trying to prevent, so this
   project won't do that.

## Options

### A. Direct reading from your server (where it works)
Plain HTTP with your session cookie, plus RSS where offered. It costs nothing to try: run the
site check (below) on your server. If a site serves pages to your home IP, this is the
simplest and fullest route (all levels, full post text).

### B. Login browser and session reuse (DESIGN §6 B)
You log in once through a real browser on your server, shown in the app's page. If the
site's browser check passes for a real browser there, the app reuses those cookies for plain
requests until they expire. It works only if the site accepts the cookies for plain requests
afterwards (Cloudflare `cf_clearance` is tied to IP and user agent, and the Overclock.net
check cookie lasts 1 hour). It also needs the app to use the same user agent as that browser,
which is less honest. Uncertain; needs testing on your server.

### C. Email notifications (sanctioned by the forums)
In each forum, "Watch" the boards and threads you care about with **email** ticked. The app
reads a mailbox you give it (IMAP, e.g. a dedicated Gmail with an app password) and turns
the emails into feed items with links.
- ✅ No scraping and no bot checks; works for members-only content; the site sends it to you
  by design.
- ⚠️ XenForo reportedly sends one notification per watched thread and then pauses until you
  visit the thread, so you get "there are new replies" rather than every post. That suits the
  `activity` mode. Board watches can notify about new threads. (From community reports, not
  verified; test on your account.)
- ⚠️ Excerpts only; needs a mailbox.

### D. Overclock.net board RSS
Its RSS works even for us. Board-level "new threads" for the RTX 5070 Ti and 3080 boards could
come from `<board>/index.rss` with no scraping at all. Replies in the owners' club thread would
still need A, B or C.

## Recommendation

1. Run the site check on your server (below). It takes about 30 seconds.
2. Then, per site: **A** where it works, **D** for Overclock.net boards, and **C** for anything
   still blocked. Skip B unless A and C both fall short.

## What I need from you

1. **Site check output** from your server:
   ```bash
   docker compose pull && docker compose up -d   # or re-run the docker run command
   docker exec forumaggregator node packages/server/dist/tools/check-sites.js
   ```
   (Or pass specific board URLs as arguments.) It makes at most 3 requests per site, 5 s
   apart, skips anything robots.txt disallows, and never touches login pages.
2. **Saved pages** for the parser (logged in, in your browser: *Save Page As → Webpage, HTML
   only*), for each forum:
   - one **board** page (e.g. Tandem Cycling, the RTX 5070 Ti board)
   - one **thread** page (e.g. a page of the 5070 Ti owners' club)
   - the **forum list** page (`/forums/`)

   **Attach them in this chat. Don't commit them:** the repo is public and the pages contain
   your username and session tokens. I'll strip anything personal before turning them into
   test fixtures.
3. **Your choice on email (C):** worth setting up?
