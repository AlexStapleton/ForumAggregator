# Implementation plan: incomplete-extraction detection

Status: planned. Priority: 2. Parent: [approved roadmap](../THREAD-READING-PLAN.md).

## Outcome and boundaries

Treat incomplete parsing differently from a successful check with no new replies. Preserve
usable content and progress while giving the user a short, actionable reason. Start with
thread parsing; extend the same diagnostic vocabulary to articles after thread behavior is
tested. Do not use a text-length score alone or assume visible post-number gaps prove failure.

## Existing code and proposed contract

`extract.ts` and `feeds/thread.ts` currently return parsed thread data or null. `pageParser.ts`
and `pageWorker.ts` transport it; `feeds/service.ts` already rejects some wrong-page responses,
and `reader/service.ts` can fall back to earlier content. Extend these paths consistently.

Propose a serializable result envelope containing the parsed value, a status, and diagnostic
codes/counts. Keep internal evidence separate from the short notice exposed through shared
reader types. Counts should describe candidate containers, usable bodies, stable IDs, and
deduplicated posts; measure the same recognized layout instead of unrelated page widgets.

| Status | Meaning | Polling/reader behavior |
|---|---|---|
| Complete | Recognized usable page, with consistent evidence | Ingest and advance normally |
| Confirmed empty | Explicit recognized empty/deleted state | Display that state; do not infer unseen posts were read |
| Partial | Recognized page but some expected bodies/metadata are missing | Preserve snapshot and checkpoint; expose a warning |
| Access blocked | Login/challenge or known access response | Use existing access/backoff behavior and configured FlareSolverr path |
| Unrecognized | Insufficient evidence for a supported layout | Report layout failure; do not record "no activity" |

An unknown total or absent optional author is not automatically partial. Signal rules must
be explained by a fixture. A changed layout may still be a valid article for generic article
reading, but a followed-thread poll must not silently switch to article parsing and advance.

## PR sequence

- [ ] **E1 — diagnostics without behavior change:** add result types and adapter evidence,
  preserving current call sites through a small compatibility layer. Test worker and in-process
  outputs for parity. Keep raw page HTML, cookies, tokens, and query credentials out of logs.
- [ ] **E2 — ingestion and fallback policy:** reject unsafe advancement for partial/unrecognized
  pages before the catch-up transaction. Do not replace good post bodies with missing fragments.
  Reuse existing failure scheduling. Show usable partial content only as an explicitly labelled,
  non-progress-tracking reader preview when there is no complete cached copy.
- [ ] **E3 — user-facing diagnostics:** distinguish stale cached content from fresh extraction;
  offer existing retry/original actions and a concise source status. Ensure preview/selectors
  tools show useful matched/removed counts without exposing internal implementation jargon.

## Required regression cases

- [ ] Normal text, image-only, emoji-only, and very short replies remain valid.
- [ ] A page with ten recognized posts and one missing body is not accepted as complete.
- [ ] Duplicate hidden copies and nested Overclock posts do not inflate expected counts.
- [ ] Login pages, challenge pages, and a valid-looking wrong page receive distinct diagnostics.
- [ ] Confirmed empty/deleted states differ from a selector that suddenly matches nothing.
- [ ] After partial parsing, stored bodies, unread state, catch-up floor, and reading position
  remain intact; a later good response fills the gap once without duplicates.
- [ ] A cached complete page remains readable with a clear stale notice after fetch/parse failure.
- [ ] Worker timeout/error and direct parsing produce compatible user-facing outcomes.

Use `thread-follow.test.ts`, `reader-selectors.test.ts`, `overclock-reader.test.ts`, and fixtures
in `test/fixtures/pages`; add focused diagnostic tests rather than asserting only log text.

## Release gate and rollout

Land evidence collection first, then enable conservative failure rules proven by fixtures.
Keep missing optional fields as diagnostics rather than blockers. Verify SQLite/PostgreSQL
state transitions, worker execution, configured FlareSolverr integration, and required CI.
No new permanent diagnostics table is planned initially; use bounded structured logs and
existing source error state. If false positives appear, relax the specific rule with a fixture,
without broadly accepting incomplete pages or deleting the previous good snapshot.
