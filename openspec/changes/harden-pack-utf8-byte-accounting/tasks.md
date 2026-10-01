# Tasks — harden-pack-utf8-byte-accounting

## 1. Exact UTF-8 measurement

- [ ] 1.1 Add a single UTF-8 byte-length helper (design D1) in the pack
      authority, and reuse it from `js/packstore.js` so both modules measure
      identically.
- [ ] 1.2 Verify `TextEncoder` is available in the target environments; if it
      is absent from the headless test sandbox (`tests/helpers/load-game.js`),
      add it there rather than hand-rolling a byte counter.
- [ ] 1.3 Replace the string-length comparison in `provideJSON` (`js/packs.js`)
      with the exact UTF-8 byte measurement.
- [ ] 1.4 Replace the string-length comparison in `validateJSON`
      (`js/packs.js`) with the same measurement.
- [ ] 1.5 Replace the per-manifest and total comparisons in `js/packstore.js`:
      the load-degrade path, the `install` pre-check, and both quota checks.

## 2. Consistent accounting through the store lifecycle

- [ ] 2.1 Measure each incoming manifest once and reuse the value for the
      check, the digest, and the stored record (design D2).
- [ ] 2.2 Sum cached per-manifest byte counts in `totalBytes()` instead of
      re-encoding on every call.
- [ ] 2.3 Ensure a store persisted under the previous string-length accounting
      is re-evaluated with the UTF-8 measure on load, and degrades safely with
      bounded diagnostics if it is now over budget.
- [ ] 2.4 Confirm the load path still tolerates a corrupt or wrong-version
      envelope (existing degrade tests must keep passing).

## 3. Truthful reporting

- [ ] 3.1 Update the size-rejection message in `js/packs.js` to state the
      measured byte size as well as the limit.
- [ ] 3.2 Keep the machine-readable error codes (`too-large`, `quota`,
      `max-installed`) unchanged so the existing `js/ui.js` → localized-key
      mapping continues to work.
- [ ] 3.3 Confirm the user-facing capacity message states the limit in bytes.

## 4. Tests

- [ ] 4.1 Add a test that an ASCII manifest at the limit is accepted and one
      byte over is rejected.
- [ ] 4.2 Add a non-ASCII test: a manifest whose UTF-16 length is within the
      limit but whose UTF-8 length exceeds it SHALL be rejected.
- [ ] 4.3 Add a measurement test proving two equal-length manifests (one ASCII,
      one multi-byte) measure differently by exactly their true UTF-8 difference.
- [ ] 4.4 Add a store test: an install that would exceed the total cap is
      rejected and the existing store is unchanged.
- [ ] 4.5 Add a store test for a single oversized non-ASCII manifest.
- [ ] 4.6 Add a load test for a store persisted under the old accounting,
      asserting consistent re-evaluation and safe degrade.
- [ ] 4.7 Add a non-ASCII size case to `tools/fuzz-packs.js` and confirm it
      still reports zero escapes.

## 5. Documentation

- [ ] 5.1 Update the `README.md` pack section to state the caps in bytes
      (already says "256 KiB each, 4 MiB total" — confirm it remains accurate
      and is now literally true).
- [ ] 5.2 Update `docs/HANDOFF-W26-pack-ecosystem-productionization.md` to
      record the UTF-8 accounting correction (the "conservative for ASCII JSON"
      note at line 84 and the follow-up at line 152).
- [ ] 5.3 Update the W26 row / follow-ups in `docs/TASK_BOARD.md`.

## 6. Verification

- [ ] 6.1 Run `node --check js/packs.js js/packstore.js`.
- [ ] 6.2 Run `npm run test:packs` and `npm run test:save`.
- [ ] 6.3 Run `node tools/fuzz-packs.js` and confirm zero escapes.
- [ ] 6.4 Run `npm run check:i18n` to confirm the catalog is unaffected.
- [ ] 6.5 Run `npm run validate` end to end and record the result.
- [ ] 6.6 Manually verify: install a CJK-heavy pack near the cap and confirm it
      is rejected as too large rather than accepted and later failing to
      persist.
