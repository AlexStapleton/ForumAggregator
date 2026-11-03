# Implementation plan: tables and code blocks

Status: planned. Priority: 5; can proceed independently of engine work.
Parent: [approved roadmap](../THREAD-READING-PLAN.md). Integrate reading-position behavior
before release, because wrapping and controls can change post geometry.

## Outcome and boundaries

Benchmark tables keep their meaning, configuration/log blocks keep their formatting, and both
remain usable on a narrow screen. Copying code returns exactly its displayed text. Do not add
syntax-highlighting dependencies, execute code, or convert data tables to prose in this version.

## Existing behavior and proposed changes

`reader/sanitize.ts` already permits table, caption, row/column-span, pre, and code elements.
`styles.css` already makes pre blocks scrollable and tables `display: block` with horizontal
overflow. Improve semantics and interaction rather than treating basic support as missing.

- In `extract.ts`, distinguish layout/quote tables from real data tables before cleanup. Do not
  flatten a benchmark table just because it is inside a quote or contains few words.
- In `sanitize.ts`, preserve validated table-header semantics. Allow `scope` only for supported
  values; if `headers` references are retained, generate/rewrite safe IDs within that table
  rather than trusting arbitrary source IDs. Keep spans bounded and reject executable attributes.
- In the reader, wrap data tables in a labelled horizontal-scroll region while retaining a real
  semantic table. Provide keyboard access only where overflow actually exists. Keep captions
  associated with their table and avoid nested duplicate wrappers on rerender.
- For `pre` blocks, provide an app-generated Copy button outside the copied text. Copy
  `textContent` without trimming, decoding a second time, or collecting button labels. On failure,
  show a short notice and allow manual selection. Do not read the user's clipboard.
- Adjust reader keyboard/swipe handling so horizontal interaction with these regions does not
  change the current item. Preserve vertical reader scrolling and ordinary text selection.

## PR sequence

- [ ] **T1 — content fidelity:** reduced fixtures for benchmark tables and code/log samples;
  tests for captions, header relationships, merged cells, literal whitespace, and special
  characters. Tighten only the sanitizer attributes needed by those fixtures.
- [ ] **T2 — responsive regions:** accessible table wrapper and code overflow layout; long
  unbroken values do not widen the entire page. Keep enhancement idempotent with cleanup in
  `Reader.tsx`, or extract a dedicated content-enhancement helper when needed.
- [ ] **T3 — copy and input behavior:** copied/success/failure feedback, focus preservation,
  keyboard exclusions, and touch handling. Test reading-position stability while regions resize,
  scroll, receive focus, or load images.

## Test matrix

| Example/action | Required result |
|---|---|
| Wide benchmark with two header rows | Labels, units, merged headers, and values remain associated |
| Nested quote containing a data table | Quote normalization does not destroy table semantics |
| Long unbroken log line | Only the code region overflows horizontally |
| Tabs, blank lines, spaces, `<`, `&`, Unicode | Copied text matches the displayed block exactly |
| Clipboard unavailable/rejected | Clear feedback; manual selection remains possible |
| Arrow keys while scroll region has focus | Region scrolls; the reader does not switch threads |
| Horizontal touch inside a wide table | Table scrolls without triggering next/previous item |
| Appended page or refreshed content | One wrapper and one copy control per eligible block |
| Script/style/event-handler attempts | Sanitization guarantees remain intact |

Extend `reader-sanitize.test.ts` and add DOM tests for enhancement/copy behavior with a stubbed
clipboard. Use real-browser checks at 360px, 768px, and 1280px, including high zoom, keyboard-only
operation, touch/horizontal scrolling, and a screen-reader check of caption/header relationships.
DOM tests alone cannot establish actual overflow or accessibility behavior.

## Release gate and fallback

All fixture, interaction, and required CI checks pass; browser evidence shows no page-wide
overflow or accidental item navigation. With enhancement unavailable, ordinary tables/pre text
remain readable and selectable. No database migration or persisted UI preference is planned.
Do not rewrite stored content just to add wrappers or copy controls: apply presentation changes
when rendering so cached and newly extracted posts benefit consistently.
