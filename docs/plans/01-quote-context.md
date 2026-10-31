# Implementation plan: quote and reply context

Status: implemented in [PR #29](https://github.com/AlexStapleton/ForumAggregator/pull/29), awaiting merge after #27. Priority: 1. Parent: [approved roadmap](../THREAD-READING-PLAN.md).

## Outcome and boundaries

A reader can identify the author of each quote, expand long quoted material, jump to a loaded
referenced post, and return to the reply. Missing references remain useful links to the forum.
Start with XenForo and vBulletin. Do not fetch an entire thread to resolve one quote, infer a
reply relationship from an @mention alone, or remove quoted content as "duplicate" text.

## Existing code and proposed design

- `packages/server/src/reader/extract.ts`: extend `parseForumThread` and `vbulletinQuotes`;
  the latter already converts several quote-box layouts to blockquotes.
- `packages/server/src/reader/sanitize.ts`: keep source markup untrusted. Extract attribution
  and reference URLs before sanitization, validate them, then render normalized quote markup.
- `packages/shared/src/index.ts`: add optional quote-reference metadata if a URL alone cannot
  express the target. Keep quote IDs local to a post, with target thread URL and post ID separate.
- `packages/web/src/pages/Reader.tsx` and `styles.css`: attach controls to normalized quotes,
  with idempotent setup/cleanup when content or appended pages change.
- Integrate `threadPosition.ts` and generated post anchors from PR #27 before shipping controls.

Normalize author text, optional referenced post ID, optional validated original URL, and the
sanitized quote body. Keep nesting intact. Prefer a real source permalink; construct one only
where an engine adapter defines the format. Never resolve an ID against another thread merely
because the number matches. Version or invalidate affected extracted-page caches so old cached
markup does not permanently miss the improvement. Existing stored posts acquire normalization
when fetched again; do not pretend stripped historical metadata can be reconstructed.

Proposed initial collapse rule: quotes taller than roughly 12 rendered lines become collapsible.
Validate that threshold on narrow and wide layouts. Short quotes stay open. Use native
`details`/`summary` or equivalent accessible controls; ensure a readable expanded fallback.
Images and tables can make a quote long even when its text is short.

## PR sequence

- [x] **Q1 — normalization and fixtures:** add nested/long/missing-author examples for both
  engines; normalize authors and references; retain images, code, and table content. Test
  generated identifiers and URL validation independently of the source's classes/IDs.
- [x] **Q2 — reader controls:** implement collapse/expand, local-reference lookup, target
  highlighting, return-to-reply, and external-link fallback. Scope lookups to the current
  thread and loaded pages. Preserve the scroll anchor when expanding content above it.
- [x] **Q3 — reading-position integration:** distinguish quote jumps and layout changes from
  normal reading progression. A jump must not mark intervening replies read; collapsing a
  quote must not advance progress just because later post ends moved into view. Preserve
  expansion state while appending a page, with bounded state cleared when leaving the thread.

## Regression and interaction matrix

| Case | Required result |
|---|---|
| Two quotes from different people | Each attribution remains attached to the correct body |
| Nested quote with a table/image | All content remains available in the correct nesting order |
| Loaded same-thread target | Jump and return work without fetching or advancing progress |
| Unloaded/deleted/cross-thread target | Verified original link or clear unavailable fallback |
| Missing author or malformed reference | Render quote text; do not invent attribution |
| Spoofed IDs, handlers, script URLs | No executable content or false internal target |
| Expand/collapse after appending pages | No duplicate controls, lost focus, or false progress save |

Extend `reader-sanitize.test.ts`, `overclock-reader.test.ts`, and the reading-position tests;
add DOM interaction coverage. Check keyboard focus, Enter/Space activation, and a real browser
at approximately 360px and 1280px widths. Confirm text selection remains usable.

## Release gate

Q1–Q3 pass focused tests and required CI, both engines retain their current extracted content,
and browser checks show no reading-position regressions. No database migration is required
unless implementation chooses to persist structured quote metadata; document that decision
before adding schema. If controls fail, plain readable quotes and original links must remain.

## Implementation record

PR #29 implements Q1–Q3 without a database migration. Quote metadata uses sanitized `cite`
URLs and visible attribution. Post-only redirects resolve locally only when their target is
verified in the fetched page; otherwise the original link remains external. Previously stored
posts gain metadata on refetch. Long quotes use native details controls; DOM state survives
appended pages. Quote excursions and layout changes pause position sampling to avoid false progress.

Validation: 50 focused tests passed, plus typecheck and production build. Browser checks in the
actual reader at 360px and 1280px covered Enter/Space activation, collapse/expand, highlighting,
and return focus. Full SQLite/PostgreSQL CI results are linked from the PR. Merge #27 first.
