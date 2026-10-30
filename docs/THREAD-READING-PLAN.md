# Thread reading and extraction improvement plan

Approved direction: 2026-10-30. All five ideas below are wanted. This document preserves
the work queue; approval of the direction does not mean the features are implemented.

Goal: extract complete, useful discussions and make long threads easy to follow on desktop
and mobile. Build on the existing image extraction, catch-up, and reading-position work.

## Priorities and progress

The recommended order balances visible improvements with extraction reliability. Forum-engine
selection depends on actual sources the user follows; table/code work can proceed independently.

| Order | Work | Status | Result |
|---|---|---|---|
| 1 | Quote and reply context | Planned | Understand who is answering whom without rereading long quotes |
| 2 | Incomplete-extraction detection | Planned | Know when content is missing instead of treating parser failure as no activity |
| 3 | Edited-post handling | Planned | See corrections and updated attachments without resetting the whole discussion |
| 4 | More forum engines | Planned; choose sites first | Read more of the user's actual sources reliably |
| 5 | Tables and code blocks | Planned | Read benchmarks, configurations, and logs comfortably on a phone |

For each item, record its PR, fixtures, validation results, and remaining limitations here as
work proceeds. Mark it complete only when the acceptance criteria have been checked.

## 1. Quote and reply context

**Work**

- Preserve quoted authors, nested quote boundaries, and post references during extraction.
- Collapse long quotes with accessible expand/collapse controls; keep the actual reply visible.
- Link to the referenced post inside the reader when it is available. Otherwise preserve a
  verified original-forum link and explain when the referenced post is unavailable.
- Keep quote expansion and reference navigation compatible with the saved reading position.

**Acceptance criteria**

- A reply containing multiple or nested quotes shows the correct author for each quote.
- Collapsing quotes does not remove text, tables, images, or the reply itself.
- Deleted posts and references outside the loaded pages have a usable fallback.
- Controls work with keyboard navigation and at mobile widths.
- Reading-position tests confirm expanding a quote does not falsely advance progress.

**Validation:** reduced XenForo and vBulletin fixtures containing short, long, nested, and
missing-target quotes; extraction tests plus reader interaction tests.

## 2. Incomplete-extraction detection

**Work**

- Distinguish a genuinely quiet/empty thread from a login page, challenge, changed layout,
  or a page from which only some posts could be extracted.
- Start with observable signals: recognizable post containers without usable bodies,
  inconsistent pagination, unexpected redirects, and known error/login markup.
- Show an actionable notice and retain a previously usable copy when available.
- Do not advance catch-up checkpoints or reading positions based on an extraction failure.
- Log enough parser detail to diagnose failures without storing credentials or session data.

**Acceptance criteria**

- A changed layout cannot silently become a successful "no new replies" check.
- Valid image-only posts, short replies, and actual empty pages are not rejected just for
  having little text.
- The reader distinguishes cached content from a successfully refreshed page.
- A temporary failure can recover on a later check without skipping replies or losing progress.

**Validation:** fixtures for normal, partial, login/challenge, wrong-page, and malformed responses;
integration tests covering polling, cached fallback, and subsequent recovery. Avoid relying on
a single text-length threshold as proof of completeness.

## 3. Edited-post handling

**Work**

- Audit and extend the existing repair of stored posts encountered during checks.
- Recheck a bounded recent portion of a thread for corrections, changed benchmark results,
  and replaced attachments while respecting polling and per-host request limits.
- Compare meaningful sanitized content; ignore changing relative dates and site furniture.
- Refresh affected cached reader content and distinguish edits from genuinely new replies.
- Add a small edited indicator where useful. Decide notification behavior before implementation;
  the default aim is to avoid marking the entire thread unread for every edit.

**Acceptance criteria**

- Changed text and attachments appear after the relevant post is rechecked.
- An edit does not create a duplicate post or inflate the new-reply count.
- Saved state and reading position survive edits; unrelated replies retain their read state.
- The recheck window and request budget are documented and tested.

**Validation:** successive snapshots of the same post with text/image edits, unchanged content,
and incidental markup changes; tests for cache refresh, account state, and request limits.

## 4. More forum engines

**Work**

- Choose the next engine from sites the user actually follows; do not commit to an engine
  based solely on popularity. Discourse, phpBB, or Invision are candidates, not selections.
- Collect representative board/thread pages, including first, middle, and last pages where
  applicable. Reduce them to fixtures with synthetic content and no session metadata.
- Add detection and parsing for post IDs, bodies, authors, dates, quotes, attachments, and
  navigation. Prefer an available documented feed/API when it provides the needed content.
- Verify how the engine exposes new replies before enabling followed-thread support.

**Acceptance criteria**

- Ordinary articles are not misclassified as threads.
- Posts appear once, in order, without member sidebars, signatures, or unrelated widgets.
- Engine-appropriate navigation works, including missing/deleted-page behavior.
- Catch-up and reading-position semantics work with that engine's identifiers; do not assume
  every engine uses increasing numeric post IDs.
- Existing XenForo/vBulletin fixtures continue to pass.

**Validation:** fixture matrix for the chosen site's actual layouts and integration tests for
following, pagination, catch-up, and resume. Keep configured FlareSolverr support available;
access failures and parsing failures should remain distinguishable.

## 5. Tables and code blocks

**Work**

- Preserve table captions, headers, row/column spans, and code whitespace through extraction.
- Make wide tables and code blocks scroll within their own area instead of widening the reader.
- Add a copy action for code/configuration/log blocks, preserving literal text.
- Keep links and images inside table cells usable, and preserve sanitization protections.

**Acceptance criteria**

- Benchmark headers remain associated with their values; merged cells stay intelligible.
- Narrow screens can access every column without horizontal scrolling of the entire app.
- Copying code preserves indentation, line breaks, and special characters.
- Scroll/copy controls are keyboard accessible and do not trigger thread navigation shortcuts.

**Validation:** realistic benchmark tables, merged headers, long configuration/log samples,
and special-character cases; extraction tests and desktop/mobile layout checks.

## Delivery approach

- Start each item with a representative failing example and an observable expected result.
- Implement small, reviewable PRs; split backend extraction from larger reader interaction work
  when that makes review clearer.
- Keep raw saved pages private; commit only reduced fixtures without cookies, tokens, or
  personally identifying account details.
- Run focused regression tests and the repository's required CI. For visible reader changes,
  check desktop/mobile behavior and keyboard interaction as well as extraction output.
- Update this plan with evidence and follow-ups. No release dates or effort estimates are
  committed yet; refine scope from the examples before scheduling each item.
