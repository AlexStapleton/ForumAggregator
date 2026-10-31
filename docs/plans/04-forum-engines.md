# Implementation plan: additional forum engines

Status: planned; a real target site must be selected before adapter implementation. Priority: 4.
Parent: [approved roadmap](../THREAD-READING-PLAN.md). Dependency: extraction-quality contract;
integrate quote, catch-up, and reading-position behavior before declaring following supported.

## Selection step

- [ ] Inventory the user's desired sources and identify which fail because of unsupported
  markup rather than access restrictions. Ask for site URLs when that information is unavailable.
- [ ] Select one site/engine with the highest practical value. Discourse, phpBB, and Invision
  remain candidates; none is preselected or claimed supported by this plan.
- [ ] Check the selected engine's primary documentation and the actual site for feed/API options,
  canonical URLs, pagination, identifiers, and access requirements. Record evidence in the PR.
- [ ] Obtain representative public or user-supplied pages. Commit synthetic reduced fixtures,
  never the original browser save with account/session metadata.

Selection deliverable: one named site, an access route, example thread/board URLs, an identifier
and ordering model, and a fixture list. This gate is required for an honest implementation scope.

## Adapter contract and code map

Keep the current XenForo/vBulletin behavior behind a small common interface before adding a
third engine. Avoid a general plugin framework unless the concrete adapter needs it.

| Capability | Proposed responsibility |
|---|---|
| Detect and canonicalize | Identify a thread from evidence and normalize page/post URLs to one source |
| Parse | Title, stable post identity, order, author/time, sanitized body, references, edit hints, quality |
| Navigate | First/next/previous/latest where available; retain legitimate cursor/query state |
| Compare progress | Explain ordering separately from post identity; support a stable resume boundary |
| Fetch | Reuse existing URL validation, host limiter, error handling, and configured FlareSolverr |

Main locations: `reader/extract.ts`, `feeds/thread.ts`, `reader/pageParser.ts`, `feeds/service.ts`,
`reader/service.ts`, shared reader types, and new engine-specific parser tests. Board discovery
belongs in `feeds/board.ts` only if included in the selected site's scope.

The current `postNumber`, numeric sorting, catch-up floor, and reading-position assumptions must
be audited explicitly. If the engine lacks increasing numeric IDs, add a separate stable order
key/cursor with a migration and backward-compatible defaults. Never coerce opaque IDs to zero
or assign order from the current page's array index alone. If a reliable progress boundary cannot
be established, ship read-only extraction with the limitation stated, not broken thread following.

## PR sequence

- [ ] **F1 — evidence and adapter seam:** selection deliverable, fixture matrix, common contract,
  and existing-engine parity tests. No user-visible support claim yet.
- [ ] **F2 — read-only extraction/navigation:** parse the selected site, render posts and references,
  preserve attachments, and navigate real pages/cursors. Test canonicalization and article false
  positives before recognizing pasted links as this engine.
- [ ] **F3 — following and state:** wire ingestion, new-reply detection, catch-up continuation,
  account-specific resume, edit hints, and deduplication. Add ordering migration if needed.
- [ ] **F4 — documented support:** browser validation, supported-layout/access notes, known limits,
  and regression fixtures. Board support is a separate slice unless F1 explicitly includes it.

## Required fixture and test matrix

First/middle/last pages; a single-post thread; nested quotes; image-only replies; modified posts;
missing/deleted posts; repeated pinned/original posts; hidden duplicates; alternate/mobile markup;
login/challenge/error pages; a non-thread article with a similar URL; relative and query-based links.

Test duplicate source detection, pagination termination, bounded catch-up after ten pages of
activity, restart recovery, access failures, and independent follower positions. For opaque IDs,
include values that would fail numeric conversion and reordered/deleted posts. Run all existing
engine fixtures and SQLite/PostgreSQL tests; verify requests use the existing fetching safeguards.

## Release gate

Name precisely what is supported: site/theme, thread reading, following, and board discovery
are separate claims. Required CI and real-layout checks pass, and ambiguous/unsupported pages
produce an actionable notice. Detection must fall back cleanly to existing behavior rather than
claiming unrelated pages. New adapters must not require disabling FlareSolverr or weakening
outbound destination validation.
