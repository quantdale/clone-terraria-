# Design — repository-truth-reconciliation

## Context

This change touches documentation and the release-build contract only. It
deliberately carries `skip_specs: true` in `.openspec.yaml`: per the OpenSpec
schema, a change that alters no externally observable system behavior must not
fabricate behavioral requirements to satisfy validation.

The one non-document artifact is the production build's file set, and that IS
externally observable (the released artifact contents change), so the build gate
is where the behavior is asserted — in the build tooling and its test, not in a
behavioral spec.

**Why the fixture-pack change needs care.** `packs/testpack.js` is loaded by
`index.html` and the headless test loader derives its script order *from
`index.html`*:

```js
// tests/helpers/load-game.js
function scriptOrderFromIndex() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  ... /^[a-z0-9_][a-z0-9_.\/-]*\.js$/i.test(src) → names.push(src);  // repo-relative
}
```

Pack tests (`tests/packs/*`) and browser journey P rely on the fixture being
provided at boot. Simply removing the `<script src="packs/testpack.js">` tag
would drop it from the headless loader too and break those suites. So the
mechanism must keep the fixture loadable for test/headless consumers while
excluding it from the *production artifact* — the exclusion belongs in the build,
not in `index.html`.

`tools/release-build.js` currently assembles strictly "everything index.html
references":

```js
const refs = referencedAssets(html);   // every relative src/href
... for (const r of refs) copyFile(r);
```

So the natural, contract-preserving change is to teach the build a small
**exclusion set** for test-only assets, and then *assert* the exclusion worked
(so a future re-add is caught).

**Why the W26 ledger is misleading.** `openspec status` reports `0/119 tasks`
because the executor left checkboxes unchecked; the proposal's own status line
and the `tasks.md` preamble both explain this, but a machine-readable count of
zero is what a reader sees first. Archiving the change (`openspec archive`)
is the OpenSpec-native way to record it as complete, but only once its own
remaining follow-ups are dispositioned — and per the campaign rules of this
planning session, that archiving is an implementation-time action, not a
planning-time one.

## Goals / Non-Goals

**Goals:**
- No document in the repository asserts something false about the current code.
- The production artifact provably contains no test fixture.
- The OpenSpec change board reflects true state.

**Non-Goals:**
- Not rewriting the `docs/terraria-parity/` documents into current form — they
  are a historical snapshot; annotating them honestly is the correct, cheap fix.
  Rewriting eight documents would be a large, low-value diff that also erases the
  audit history.
- Not removing the fixture pack from the repository or from the test path.
- Not marking OpenSpec implementation tasks complete as part of *this planning
  campaign* — that is explicitly out of bounds for planning; it is listed as an
  implementation-time task here.

## Decisions

### D1: Annotate, do not rewrite, `docs/terraria-parity/`

Add a prominent banner to the directory (a `README.md` at
`docs/terraria-parity/README.md` already exists — prepend the notice there) and
to each document's top, stating: snapshot date 2026-08-29, superseded, and
pointing to `AGENTS.md` / `docs/ARCHITECTURE.md` / `docs/TASK_BOARD.md` for
current truth. Add a short "what changed since" note to
`feature-gap-analysis.md` listing the four now-false ratings with their current
status.

Rationale: preserves the audit as a historical record (useful for the *next*
audit to see how the repo was assessed and what changed), while making it
impossible to mistake for current guidance. Rewriting would be a much larger diff
with no correctness benefit.

### D2: Fix the two structural doc defects surgically

- `README.md`: move the closing fence below the two `npm run test:net` /
  `test:packs` lines.
- `docs/TASK_BOARD.md`: remove the spliced `checkpoint. Consult …` fragment and
  restore a single well-formed preamble paragraph.

Rationale: two-line fixes with zero risk and real reader impact.

### D3: Exclude the fixture from the production artifact in the build, not in `index.html`

Add an explicit test-fixture exclusion to `tools/release-build.js` and assert the
result:

```js
const TEST_ONLY_ASSETS = ['packs/testpack.js'];   // not shipped in dist/
```

and after assembly, assert that no shipped file is in the set (and that
`packs/testpack.js` is present in the repo, so the exclusion can't silently
become "the file is gone"). Update the build's own header comment, which
currently claims the artifact is "exactly what index.html references", to
describe the exclusion.

**Alternative considered — remove the script tag from `index.html`.** Rejected:
it would also remove the fixture from the headless loader (which reads
`index.html`), breaking `tests/packs/*` and journey P. The build is the correct
layer because the build is what defines the *release* artifact.

**Alternative considered — move the fixture out of the repo entirely and have
tests provide it programmatically.** Rejected as a larger change to the test
harness for no release benefit; the exclusion list is a two-line build change.

### D4: Reconcile the W26 OpenSpec change at implementation time

Record the true completion state of `w26-pack-ecosystem-productionization`
(its own proposal already says IMPLEMENTED + HARDENED with named remaining
follow-ups), and archive it once those follow-ups are dispositioned, so
`openspec list` and `openspec status` no longer report a false `0/119`.

Rationale: the archive step is the OpenSpec-native "this is done" signal. Doing
it during *planning* would falsely mark unimplemented work complete, which the
campaign rules forbid; it is therefore an implementation-time task in
`tasks.md`, not a planning-time action.

### D5: Sweep for remaining stale labels

Grep the docs for stale campaign/version labels and dead cross-references
(e.g. the W25 "requirement pre-satisfied" note, references to removed epics, and
the duplicated TASK_BOARD preamble class of defect) and correct them.

## Risks / Trade-offs

- **[Excluding the fixture breaks a test]** → The exclusion is in the *build*,
  not in `index.html`; the headless loader and the dev server are untouched, so
  `tests/packs/*` and journey P (which run against the repo/dev tree) are
  unaffected. The only consumer of `dist/` is `verify-dist.js`, which boots the
  production tree and does not require the fixture — verify that.
- **[A future edit re-adds the fixture to `index.html` expecting it to ship]**
  → The build assertion and the exclusion set are documented in the build
  header; the exclusion is explicit and greppable.
- **[Annotating eight stale docs is busywork]** → It is a one-paragraph banner
  per file, and the alternative (leaving false statements in the tree) is worse
  for the next agent. The banner states the supersession; it does not attempt
  to re-derive current truth per document.

## Migration Plan

1. Add the banner/notice to `docs/terraria-parity/` and the "what changed
   since" note to `feature-gap-analysis.md` (D1).
2. Fix the README fence and TASK_BOARD paragraph (D2).
3. Add the build exclusion + assertion and update the build header (D3); run
   `npm run build` and `npm run verify:build`; confirm `dist/packs/` is gone and
   `dist/` is otherwise byte-identical for the remaining files.
4. Run the full `npm run validate` to confirm journey P and the pack tests still
   pass.
5. At implementation time, reconcile and (if follow-ups are dispositioned)
   archive the W26 change (D4); do the D5 sweep.
6. Fully reversible; no product behavior change.

## Open Questions

None blocking. One implementation-time judgement: whether to archive the W26
change or to leave it active with a corrected status — both are recorded in the
tasks and the choice depends on whether its remaining follow-ups are complete at
that time.
