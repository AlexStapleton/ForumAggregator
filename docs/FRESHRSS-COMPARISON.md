# ForumAggregator vs FreshRSS: how content is pulled in

Written 2026-10-19 at the user's request. FreshRSS is a mature, self-hosted PHP feed reader.
Sources are listed at the bottom. Where something comes only from community posts or mirrors
of FreshRSS's docs rather than its official site, that's noted.

## Side by side

| Area | FreshRSS | ForumAggregator (v1.0 + current branch) | Verdict |
|---|---|---|---|
| **Feed parsing** | SimplePie (PHP library) | Own parser on `fast-xml-parser`: RSS 2.0, RSS 1.0, Atom; plain-text summaries; entity-bomb guard | Equivalent for our needs |
| **When feeds are checked** | A cron job (`actualize_script.php`, e.g. hourly) refreshes feeds | In-process scheduler per source: interval + jitter, ETag/304, backoff, pause after 5 failures, per-site spacing (Reddit ≥ 10 s) | Ours is finer-grained and more polite by default |
| **Push updates (WebSub)** | Supported: compatible sources (WordPress, Mastodon, …) push new items instantly | Not supported | **Worth adopting** for YouTube, which offers WebSub. Needs the app reachable from the internet (you have this via Nginx Proxy Manager) |
| **Full article text** | Per-feed **CSS selector** for the article on the original page, plus a "elements to remove" selector, with a preview. Fetched when the feed refreshes | Automatic: Mozilla Readability extracts the article when you open it; cached; no configuration | Different trade-off. Ours needs no setup and only fetches what you open. Theirs is exact when you know the page. **Adopt as an optional per-source override** for sites where Readability fails (forums!) |
| **Sites without a feed** | **Web scraping source types**: "HTML + XPath" (since 1.20), later also JSON with dotted paths: you describe where items, titles, links and dates are on a page | Not supported (forum page reading is M2) | **The biggest gap.** A generic "web page" source type, plus ready-made presets for XenForo boards and threads, is the natural shape for M2 |
| **Per-feed HTTP options** | Advanced options include a custom user agent and proxy (`CURLOPT_USERAGENT`, `CURLOPT_PROXYTYPE` per feed; community posts suggest changing the user agent or sending a fake referer when a site blocks the feed) | Honest, fixed user agent; never disguises itself or works around bot checks (D-037) | **Deliberately different.** We won't spoof user agents or referers. Per-source HTTP auth or a session cookie for *your own* logins is legitimate and fits the M2 forum-login work |
| **Filtering** | Filter actions (e.g. auto mark-as-read by search), labels, saved user queries | Tags and source/tag filters; keyword rules planned (M3) | M3 covers it; their "saved query" idea is worth copying |
| **Extensions** | Plugin system (e.g. YouTube video embeds, Reddit image handling) | YouTube embeds and Reddit handling are built in | Fine for one user; no plugin system needed yet |
| **Mobile apps** | Implements the Google Reader and Fever **APIs**, so existing Android/iOS feed apps can connect | Own web UI only; our API is private | **Worth considering** for "an Android app later": a Google Reader-compatible API would make existing Android apps work without us building one |
| **Import/export** | OPML import/export | None | **Easy win:** OPML lets you move subscriptions in and out |
| **Users** | Multi-user | Single user | Fine as designed (D-013) |

## Recommendations

**Adopt now (small, high value)**
1. **OPML import/export** of sources (with tags as categories).
2. **Per-source "article selector" for the reader**, plus "remove these elements" and a preview,
   used instead of Readability when set.

**Shape M2 (forums) like FreshRSS's scraping, with presets**
3. A **"web page" source type** with CSS selectors (item, title, link, date, author, content),
   plus built-in **XenForo board/thread presets**, so forums work with no setup where the
   site lets your server read its pages. This still respects robots.txt and bot checks.

**Later**
4. **WebSub** for YouTube channels: new videos arrive within seconds and polling drops.
5. **Google Reader-compatible API**, so existing Android feed apps can be used.

**Won't do**
- Custom user agents or fake referers to get past blocks (D-037).

## Sources
- [XPath Scraping with FreshRSS (Dan Q, 2022)](https://danq.me/2022/09/27/freshrss-xpath): scraping arrived in 1.20.0
- [FreshRSS "website scraping" docs, mirrored (1.24.2)](https://git.rdnlsmith.com/fresh-rss-custom/plain/docs/en/users/11_website_scraping.md?h=1.24.2): mirror, not the official site
- [Using CSS selectors in FreshRSS to retrieve full text (Neil Brown, 2024)](https://neilzone.co.uk/2024/05/using-css-selectors-in-freshrss-to-automatically-retrieve-the-full-text-of-partial-text-rss-feeds/)
- [FreshRSS OPML extension docs, mirrored](https://git.rdnlsmith.com/fresh-rss-custom/tree/docs/en/developers/OPML.md?h=1.26.0): per-feed `CURLOPT_*`, `cssFullContent`
- [FreshRSS power users thread (Level1Techs)](https://forum.level1techs.com/t/freshrss-power-users-thread/250247): community advice on user agents and referers
- [FreshRSS README, mirrored](https://git.rdnlsmith.com/fresh-rss-custom/plain/README.md?h=1.14.0): WebSub, cron `actualize_script.php`
