# Tasks — repository-truth-reconciliation

## 1. Mark the stale planning document set as historical

- [x] 1.1 Prepend a supersession banner to `docs/terraria-parity/README.md`
      stating the snapshot date (2026-08-29), that it is superseded, and that
      current truth lives in `AGENTS.md`, `docs/ARCHITECTURE.md`, and
      `docs/TASK_BOARD.md`.
- [x] 1.2 Add a one-paragraph supersession header to each of the other
      `docs/terraria-parity/*.md` documents.
- [x] 1.3 Add a "what changed since this snapshot" section to
      `docs/terraria-parity/feature-gap-analysis.md` correcting the four
      now-false ratings: stable content IDs, save/versioning, automated testing,
      and module integration (design D1).

## 2. Repair structural documentation defects

- [x] 2.1 Fix the `README.md` fenced code block so the closing fence sits below
      the `npm run test:net` and `npm run test:packs` lines (design D2).
- [x] 2.2 Remove the spliced `checkpoint. Consult …` fragment from the
      `docs/TASK_BOARD.md` status-snapshot preamble, restoring one well-formed
      paragraph.
- [x] 2.3 Verify both files render correctly as Markdown.

## 3. Exclude the test fixture from the production artifact

- [x] 3.1 Teach `tools/release-build.js` not to copy `packs/testpack.js`, and
      to remove that script reference from the copied `dist/index.html`
      (design D3). Do not remove the tag from the repository `index.html`.
- [x] 3.2 Update the build header, which currently claims the artifact is
      exactly what `index.html` references, to document the exclusion and the
      HTML rewrite.
- [x] 3.3 Assert that `dist/packs/testpack.js` is absent, that
      `dist/index.html` does not reference it, and that the source fixture
      still exists.
- [x] 3.4 Confirm the fixture remains loaded for the headless loader: the
      script order is derived from `index.html`, so the `<script>` tag MUST stay.
      Verify `tests/packs/*` and browser journey P still pass.
- [x] 3.5 Confirm `tools/verify-dist.js` (which boots the production tree) does
      not require the fixture.
- [x] 3.6 Run `npm run build` and `npm run verify:build`. Confirm the
      production page does not request the missing fixture and that every other
      shipped file is unchanged.

## 4. Reconcile the OpenSpec change ledger

- [x] 4.1 Review the remaining follow-ups listed in
      `openspec/changes/w26-pack-ecosystem-productionization` and in
      `docs/HANDOFF-W26-pack-ecosystem-productionization.md`, and disposition
      each one (done / still-open / superseded by another change).
- [x] 4.2 Update the change's recorded task state so the machine-readable count
      matches reality, or archive the change if all follow-ups are complete
      (design D4). Do NOT mark implementation tasks complete for work that has
      not actually been implemented.
- [x] 4.3 Re-run `openspec validate --changes --strict` after the update.

## 5. Sweep for remaining stale labels

- [x] 5.1 Grep the documentation set for stale campaign labels, superseded
      version references, and broken cross-references; correct the ones that
      assert something false.
- [x] 5.2 Confirm `AGENTS.md` module contract table still matches the actual
      exported namespaces of every `js/*.js` module (a spot check is
      sufficient; record any drift found rather than silently fixing it here).

## 6. Verification

- [x] 6.1 Run `npm run build` and `npm run verify:build`.
- [ ] 6.2 Run `npm test` and `npm run test:browser` and confirm all pass,
      including the pack suites and journey P.
- [ ] 6.3 Run `npm run validate` end to end and record the result.
- [ ] 6.4 Confirm `git status` shows no unintended changes and that the
      production artifact contains no test fixture.
