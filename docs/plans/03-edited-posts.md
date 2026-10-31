# Implementation plan: edited-post handling

Status: implemented in [PR #32](https://github.com/AlexStapleton/ForumAggregator/pull/32); SQLite/PostgreSQL CI passed, awaiting merge. Priority: 3. Parent: [approved roadmap](../THREAD-READING-PLAN.md).
Dependency: extraction-quality gating before enabling additional audit fetches.

## Outcome and initial policy

Recent corrections and replacement attachments become visible without creating duplicate
replies or resetting the whole thread. Existing `FeedService.ingestThread` already repairs
stored posts found on pages being read. Extend that behavior rather than creating a second
ingestion path.

Proposed default: edits update content silently and show an Edited indicator. They do not
increase new-reply counts, make the card unread, move the thread to the top, or reset saved
state/reading position. A later opt-in edit notification policy is outside this first version.
If no trustworthy forum edit time exists, label the timestamp "Update detected" rather than
claiming it is the author's edit time. A first fetch has no prior version to compare.

## Code and data changes

- `feeds/service.ts`: split content-change detection from metadata repair, then plan bounded
  recent-page audits alongside normal polling and catch-up.
- `db/schema.ts` and a new migration: proposed nullable semantic fingerprint, first detected
  update timestamp, and a content revision on stored posts. Add a persisted audit cursor/time
  only after the scheduling test defines the fields it needs. Do not store full revision history.
- `reader/service.ts`: invalidate/version affected thread-page and rendered-content caches;
  edits must appear even when the new-reply count and publication date are unchanged.
- `shared/src/index.ts` and reader rendering: carry edit status without changing post identity.
  Keep each account's progress outside shared content caches.

Fingerprint sanitized semantic content: preserve words, code whitespace, quote bodies, table
cells, and attachment/image URLs. Exclude known site chrome, relative time labels, and UI-only
attributes. Do not strip arbitrary URL query parameters: they can identify a different asset.
Backfill missing fingerprints without announcing every old stored post as newly edited.
Equal fingerprints do not replace the stored timestamp or invalidate caches repeatedly.

## PR sequence

- [ ] **P1 — edit classification:** fixtures with successive post versions; establish fingerprint
  semantics and distinguish genuine content changes from author/date parser repairs. Add the
  migration and idempotent updates through the existing ingestion transaction.
- [ ] **P2 — bounded audits:** proposed starting window is the newest three pages, rotating one
  page every six successful polls. Reuse pages already fetched and count all requests against
  the configured budget. Catch-up takes priority. With a one-page budget, dedicate at most one
  poll in six to the audit; document the possible one-interval delay in detecting new replies.
  Persist rotation so restarts do not keep auditing the same page. Validate these defaults with
  actual request-count tests before shipping; never silently raise the request budget.
- [ ] **P3 — cache freshness and indicator:** content revision participates in cache freshness;
  preserve post/scroll anchors when content changes. Add the indicator and a useful detected-time
  label. Unchanged polls should not trigger unnecessary reader rerenders or downloads.

## Regression matrix

| Change | Expected result |
|---|---|
| Text correction or replaced attachment | One updated post, one revision change, visible on next read |
| Relative date/chrome/attribute-order change | No edit notification or revision churn |
| Actual new reply plus an edit | Count only the new reply; retain the edited post's ID |
| Partial extraction | Keep the good stored body and audit position; retry later |
| Repeated identical check or retry after restart | No duplicate revisions or indicators |
| Two followers with different reading positions | Both see current content; neither position is reset |
| Paused source, catch-up, low request budget | Audit respects pause, priority, backoff, and limit |

Extend thread-following and multi-user tests; add cached-reader and audit-scheduling tests for
both databases. Check that long edited images/tables do not accidentally advance reading position.

## Release gate and limits

Required CI passes with migrations, account state, and cache invalidation covered. Document
the window and cadence: edits outside the audited/visited pages are not guaranteed to be found.
Missing posts alone are not deletion evidence; deletion synchronization and a full edit-history
viewer are separate work. If auditing must be disabled, normal polling and repair of encountered
posts should continue to work without rolling back the additive schema.

## Implementation record

PR #32 implements the bounded audit policy and migration, semantic edit detection, update labels, and page-cache invalidation. Typecheck and production build passed. Local full suite: 357 passed, with the existing Windows POSIX file-mode assertion failing; Linux CI passed. Tests cover two followers with different positions, saved/read state, edits alongside new replies, silent baseline backfill, restart/failure recovery, and one-page budgets. See `docs/EDITED-POSTS.md` on the implementation branch for behavior and limits. Open readers retain their current content until reopened or a page is requested, preserving scroll position instead of replacing content during reading.
