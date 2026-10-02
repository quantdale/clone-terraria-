# Tasks — harden-pack-utf8-byte-accounting

## 1. Exact UTF-8 measurement

- [x] 1.1 Add a single UTF-8 byte-length helper (design D1) in the pack
      authority, and reuse it from `js/packstore.js` so both modules measure
      identically.
- [x] 1.2 Add `TextEncoder` to the headless sandbox in
      `tests/helpers/load-game.js`. It is not in that sandbox today. Do not
      hand-roll a byte counter.
- [x] 1.3 Replace the string-length comparison in `provideJSON` (`js/packs.js`)
      with the exact UTF-8 byte measurement.
- [x] 1.4 Replace the string-length comparison in `validateJSON`
      (`js/packs.js`) with the same measurement.
- [x] 1.5 Replace the per-manifest and total comparisons in `js/packstore.js`:
      the load-degrade path, the `install` pre-check, and both quota checks.

## 2. Consistent accounting through the store lifecycle

- [x] 2.1 Measure each incoming manifest once and reuse the value for the
      check, the digest, and the stored record (design D2).
- [x] 2.2 Sum cached per-manifest byte counts in `totalBytes()` instead of
      re-encoding on every call.
- [x] 2.3 Ensure a store persisted under the previous string-length accounting
      is re-evaluated with the UTF-8 measure on load, and degrades safely with
      bounded diagnostics if it is now over budget.
- [x] 2.4 Confirm the load path still tolerates a corrupt or wrong-version
      envelope (existing degrade tests must keep passing).

## 3. Truthful reporting

- [x] 3.1 Update the `js/packs.js` rejection text to state the measured UTF-8
      size and the limit.
- [x] 3.2 Keep the machine-readable error codes (`too-large`, `quota`,
      `max-installed`) unchanged. Include `measured` and `limit` on the
      PackStore result so the UI can format them.
- [x] 3.3 Update the localized user-facing capacity template to interpolate
      `{measured}` and `{limit}` in bytes. A code-only toast that does not
      state both is not sufficient.

## 4. Tests

- [x] 4.1 Add a test that an ASCII manifest at the limit is accepted and one
      byte over is rejected.
- [x] 4.2 Add a non-ASCII test: a manifest whose UTF-16 length is within the
      limit but whose UTF-8 length exceeds it SHALL be rejected.
- [x] 4.3 Add a measurement test proving two equal-length manifests (one ASCII,
      one multi-byte) measure differently by exactly their true UTF-8 difference.
- [x] 4.4 Add a store test: an install that would exceed the total cap is
      rejected and the existing store is unchanged.
- [x] 4.5 Add a store test for a single oversized non-ASCII manifest.
- [x] 4.6 Add a load test for a store persisted under the old accounting,
      asserting consistent re-evaluation and safe degrade.
- [x] 4.7 Add a non-ASCII size case to `tools/fuzz-packs.js` and confirm it
      still reports zero escapes.

## 5. Documentation

- [x] 5.1 Update the `README.md` pack section to state the caps in bytes
      (already says "256 KiB each, 4 MiB total" — confirm it remains accurate
      and is now literally true).
- [x] 5.2 Update `docs/HANDOFF-W26-pack-ecosystem-productionization.md` to
      record the UTF-8 accounting correction (the "conservative for ASCII JSON"
      note at line 84 and the follow-up at line 152).
- [x] 5.3 Update the W26 row / follow-ups in `docs/TASK_BOARD.md`.

## 6. Verification

- [x] 6.1 Run `node --check js/packs.js js/packstore.js`.
- [x] 6.2 Run `npm run test:packs` and `npm run test:save`.
- [x] 6.3 Run `node tools/fuzz-packs.js` and confirm zero escapes.
- [x] 6.4 Run `npm run check:i18n` to confirm the catalog is unaffected.
- [ ] 6.5 Run `npm run validate` end to end and record the result.
- [ ] 6.6 Manually verify: install a CJK-heavy pack near the cap and confirm it
      is rejected as too large rather than accepted and later failing to
      persist.
