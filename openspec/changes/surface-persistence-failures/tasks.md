# Tasks — surface-persistence-failures

## 1. Outcome accounting and classification

- [ ] 1.1 Add a bounded stats object to `js/savecore.js` covering write
      attempts, successes, failures, and the most recent classified failure
      reason; expose it through a `stats()` accessor matching the convention
      used by `TC.WorldRegions`, `TC.Lighting`, `TC.MiniMap`, `TC.PackStore`.
- [ ] 1.2 Classify storage failures from the caught error's `name`
      (`QuotaExceededError`, `NS_ERROR_DOM_QUOTA_REACHED`,
      `QUOTA_EXCEEDED_ERR`). Do not classify by message text. A generic
      `Error` whose message mentions quota is not capacity (design D2).
- [ ] 1.3 Classify a provider serialize or envelope-stringify failure in the
      `saveNow` catch around `buildEnvelope`, before `storageSet`. That reason
      SHALL be data/provider, never capacity.
- [ ] 1.4 Increment attempts on every write and successes/failures on the
      matching terminal outcome; keep the counters bounded (no history array).
- [ ] 1.5 Expose the counters from `TC.Save` as well as `TC.SaveCore` so the
      UI/debug surfaces have one access point.

## 2. Reclaim before failing

- [ ] 2.1 In `saveNow`, on a capacity-classified failure, remove the
      `<key>.tmp` artifact if present (it is never a valid save).
- [ ] 2.2 If the main write is the failing step and a `<key>.bak` exists,
      release the backup and retry the main write exactly once.
- [ ] 2.3 On a second failure, leave the previous good main copy intact and
      report the failure.
- [ ] 2.4 Verify success paths and non-capacity failures are byte-for-byte
      unchanged: run `tests/save/atomicity.test.js` and the corruption suite.

## 3. Player-visible reporting

- [ ] 3.1 Stop discarding the boolean in `TC.Save.autosave`; track the failure
      state so an automated write failure is observable.
- [ ] 3.2 Raise a rate-limited notice the first time an automated write fails
      after a successful one, and re-raise only after a cooldown while the
      failure persists; clear the state on recovery (design D4).
- [ ] 3.3 Add localized catalog entries to `js/locales/en.js` for the
      autosave-failure notice and the capacity-specific guidance; run
      `npm run check:i18n` to confirm coverage.
- [ ] 3.4 Make the capacity-classified message direct the player toward
      freeing storage or reducing world modification, distinct from a generic
      save-failure message.
- [ ] 3.5 Confirm joined network mirrors still skip autosave and raise no
      save-failure notice.

## 4. Debug overlay

- [ ] 4.1 Render attempts, successes, failures, and the last failure reason in
      the existing `TC.Debug.drawHud` counter block, matching the format of
      the other counters (design D5).

## 5. Tests

- [ ] 5.1 Add a storage-that-throws test: a write fails, counters increment,
      the last failure reason is set, and nothing is left half-written.
- [ ] 5.2 Add a capacity-exhaustion test whose thrown error name is
      `QuotaExceededError`: assert the capacity classification, temp reclaim,
      one backup release and retry, and the preserved previous good main copy.
      Keep the existing atomicity tests, which throw `new Error('QuotaExceededError')`,
      on the generic-failure path with no reclaim.
- [ ] 5.3 Add a recovery test: fail, then succeed; assert the failure state
      clears and the next failure is reported normally.
- [ ] 5.4 Add an autosave-notification test: one notice on first failure,
      bounded notices while failing, and none for a joined mirror.
- [ ] 5.5 Add a test asserting the counters are bounded after many writes.

## 6. Verification

- [ ] 6.1 Run `node --check js/save.js js/savecore.js js/ui.js js/debug.js`.
- [ ] 6.2 Run `npm run test:save` and confirm the save suites pass.
- [ ] 6.3 Run `npm run check:i18n` and confirm the catalog is valid.
- [ ] 6.4 Run `npm test` and `npm run test:browser` and confirm all pass.
- [ ] 6.5 Run `npm run validate` end to end and record the result.
- [ ] 6.6 Manually verify: fill localStorage for the origin, play, and confirm
      the player is warned (once, then rate-limited) and the F3 overlay shows
      the failure counters.
