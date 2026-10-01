# Change Proposal: repository-truth-reconciliation

- **ID**: repository-truth-reconciliation
- **Status**: PROPOSED
- **Schema**: spec-driven
- **Priority**: P3 (documentation accuracy and release hygiene)

## Why

The project is unusually disciplined about *code* truth and correspondingly
weak about *document and artifact* truth. The audit found four concrete classes
of drift, each with hard evidence.

**1. A parallel, stale planning document set contradicts current reality.**
`docs/terraria-parity/` holds eight documents (repository audit, feature-gap
analysis, architecture debt plan, roadmap, testing/CI/release strategy,
assets/localization/modding, risk plan, and a root-README update proposal) last
touched **2026-08-29**. Their headline ratings are now false:

| `docs/terraria-parity/feature-gap-analysis.md` claims | Reality today |
|---|---|
| "Stable content IDs — **Partial**" | `TC.Registry` namespaced stable ids + fingerprint, frozen by a CI gate (`check-i18n` asserts `1b1d7c15` against a baseline) |
| "Save/versioning — **Functional**" | `TC.SaveCore` v2 envelope, migrations, atomic writes, backups, export/import, per-system providers |
| "Automated testing — **Partial**" | 667 node:test cases + 33 Playwright journeys + a CI gate |
| "Module integration — **Partial**" | `TC.Systems` scheduler, `TC.RenderLayers`, `TC.Commands` |

Nothing marks them as historical, so a new contributor or a future agent reads
them as current guidance and plans already-completed work. The repository's own
W25 note (`docs/W25-PLAN.md`) even says "requirement pre-satisfied" about work
this doc set lists as TODO.

**2. Structural/text defects in otherwise-current docs.**
- `README.md`: the fenced command block closes *before* two of its lines —
  `npm run test:net` and `npm run test:packs` render as body text instead of
  code, so the README does not display the commands it intends to.
- `docs/TASK_BOARD.md`: the "Status snapshot" preamble contains a
  **duplicated, garbled paragraph** — a sentence fragment (`checkpoint.
  Consult docs/ARCHITECTURE.md §19 …`) is spliced into the middle of the first
  paragraph.

**3. A test fixture ships inside the production build.**
`packs/testpack.js` is loaded by `index.html`, so `tools/release-build.js`
copies it into `dist/packs/testpack.js` (verified: `dist/packs/testpack.js`
exists after `npm run build`). The build's own contract is *"a release is a
verified assembly of exactly what index.html references"*, so this is
self-consistent — but it means the shipped release artifact contains a fixture
pack whose content (`testpack:tempest_*`, a "Storm Frontier" test chain) is
activated by any user who enables it. It is inert unless activated, so this is
hygiene rather than a vulnerability; still, a production artifact should not
carry a test fixture, and the build gate should be able to prove it.

**4. The OpenSpec change ledger is stale relative to its own implementation.**
`openspec/changes/w26-pack-ecosystem-productionization` reports `0/119 tasks`
complete while its proposal status reads "IMPLEMENTED + HARDENED", and its
`tasks.md` opens with a note that the checkboxes are "the historical execution
order, not a live completion ledger". The artifacts are honest, but the machine
readable count that `openspec status` reports is misleading to anyone reading
the board, and the change has never been archived.

This change is documentation/artifact-only. It changes no product behavior, so
it is the one change that legitimately opts out of behavioral specs via
`skip_specs`.

## What Changes

- Mark `docs/terraria-parity/` explicitly as a historical, superseded snapshot
  with a prominent header stating its date and pointing to the current sources
  of truth (`AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/TASK_BOARD.md`), and
  correct or annotate the individual ratings that are now false.
- Repair the `README.md` code fence and the `docs/TASK_BOARD.md` duplicated
  paragraph.
- Keep the fixture pack out of the production artifact while keeping it
  exercised by the browser journey, and make the release build assert the
  production output contains no test fixture.
- Reconcile the W26 OpenSpec change's recorded completion with reality, and
  archive it once its own remaining follow-ups are dispositioned, so the
  change board reflects true state.
- Sweep for other stale campaign/version labels and dead doc cross-references.

**Not breaking**: no product code, no save format, no protocol change. The
build output file set changes (the fixture is no longer shipped), which is the
intended, asserted effect.

## Capabilities

### New Capabilities
- (none — this change alters no externally observable system behavior)

`.openspec.yaml` sets `skip_specs: true`: the work is documentation accuracy,
build-hygiene assertion, and ledger reconciliation, so per the OpenSpec schema
no behavioral requirement is fabricated for it.

## Impact

- **Code/docs**: `docs/terraria-parity/*` (headers/annotations),
  `README.md` (fence), `docs/TASK_BOARD.md` (paragraph), `index.html` +
  `tools/release-build.js` (fixture exclusion + assertion), the W26 OpenSpec
  change (completion reconciliation / archive).
- **Tests**: the release-build assertion; the browser journey that installs the
  fixture must be confirmed still green under the new loading strategy.
- **Dependencies**: none. Independent of every other change; do it first or last
  as convenient.
- **Risk**: low, with one real risk — **removing `packs/testpack.js` from
  `index.html` could break the headless test loader**, which derives its script
  order from `index.html` (`tests/helpers/load-game.js`
  `scriptOrderFromIndex()`), and several pack tests rely on the fixture being
  present. The fixture must remain *loadable* for tests while being *excluded
  from the production artifact*, so this needs a deliberate mechanism (see
  design) rather than simply deleting the script tag.
