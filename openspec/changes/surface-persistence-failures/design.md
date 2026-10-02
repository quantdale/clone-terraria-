# Design — surface-persistence-failures

## Context

Persistence is layered:

- `js/savecore.js` — versioned envelope, provider registry, migrations,
  validation, and the atomic write sequence in `saveNow(key)`:
  `storageGet(key)` → write `<key>.tmp` → re-read + verify → copy previous good
  main to `<key>.bak` → write main → remove tmp. Every storage call is wrapped
  in a `try/catch` returning `false` on failure, so a `QuotaExceededError`
  becomes `saveNow → false` with no reason attached.
- `js/save.js` — the facade: `TC.Save.save()` delegates to
  `TC.SaveCore.saveNow(V2_KEY)` and returns its boolean; `TC.Save.autosave(dt)`
  accumulates `dt` and, on interval, calls `TC.Save.save()` **discarding the
  result**.
- `js/ui.js` — manual save (`actSave`) toasts `ui.toast.saved` /
  `ui.toast.save_failed` based on the returned boolean.
- `js/packstore.js` — a model for doing this well: it returns typed errors
  (`'quota'`, `'too-large'`, `'max-installed'`, `'storage'`), keeps
  `lastLoadErrors` for bounded diagnostics, and the UI maps them to localized
  keys (`ui.packs.quota_error`, …).
- `js/debug.js` — the F3 overlay, which already renders liquids, projectiles,
  flags, tick/phase/command stats, and wof encounter fields.

Audit observations:

- `js/savecore.js` contains no counters or stats object at all.
- `TC.Save.autosave` discards the boolean (confirmed by probe: `save()` returns
  `false`, storage stays empty, autosave leaves the stored save unchanged, and
  no error surfaces).
- Atomicity itself is correct and is covered by `tests/save/atomicity.test.js`;
  the gap is purely reporting, classification, and recovery.

Note on capacity: `saveNow` holds three copies at peak (tmp, bak, main), so a
save needs roughly 3× its serialized size in free space at the moment of
writing. That makes reclaim-before-fail genuinely useful rather than
theoretical.

## Goals / Non-Goals

**Goals:**
- Every write attempt is counted; the last failure reason is classified and
  readable from the debug surface.
- An autosave failure becomes visible to the player, rate-limited and
  actionable.
- Storage-capacity failures reclaim what the save layer owns before giving up,
  without ever weakening the atomic-write invariant.

**Non-Goals:**
- Not migrating persistence off `localStorage` to IndexedDB. That is the
  durable fix for capacity, but it is a large architectural change with its own
  migration/compat concerns; this change makes the current backend honest and
  recoverable. (Recorded as a follow-up in the master plan.)
- Not changing the envelope format, provider set, or migration chain.
- Not changing the autosave interval or the mirror skip.
- Not adding a settings screen for storage management.

## Decisions

### D1: Add a bounded stats object to SaveCore and classify every failure site

Give `js/savecore.js` a `stats()` accessor and a small counters object
(`attempts`, `successes`, `failures`, `lastFailure`), mirroring the existing
`counters()` / `stats()` convention. Classification cannot live only inside
`storageSet`. `buildEnvelope` throws on a provider serialize failure before
any storage call, and `saveNow` currently catches that and returns false with
no reason. Classify that path as a data/provider failure in the `saveNow`
catch. Classify storage failures separately, from the error object caught in
`storageSet`.

Rationale: the codebase already has a strong, consistent observability
convention; the save layer is the outlier. Following the convention makes the
addition feel native and makes the F3 integration trivial.

**Alternative considered — return a reason string from `saveNow` instead of a
boolean.** Rejected: `saveNow` returning a boolean is part of the documented
contract in `AGENTS.md` and is consumed by `TC.Save.save()` and the tests.
Change the shape to an object only if the maintainer prefers a cleaner API;
the counters path works without breaking it.

### D2: Classify capacity failure by error name, not by message

Detect capacity via `error.name`: `QuotaExceededError`,
`NS_ERROR_DOM_QUOTA_REACHED`, or `QUOTA_EXCEEDED_ERR`. A generic
`Error` whose message is `QuotaExceededError` is not capacity.
`tests/save/atomicity.test.js` throws exactly that generic error, so those
tests must remain non-capacity failures and must not trigger reclaim.

Rationale: message sniffing is locale- and browser-dependent, and it would
also change the existing atomicity tests.

### D3: Reclaim before failing, inside `saveNow`

On a capacity-classified failure:

1. remove `<key>.tmp` if present (it is never a valid save);
2. if the main write is the failure and a `<key>.bak` exists, remove the backup
   and retry the main write once;
3. on a second failure, leave main untouched and report failure.

Rationale: both artifacts are owned entirely by the save layer, and both are
reconstructible (tmp is transient; bak is a copy of a *previous* good save
whose loss is strictly better than losing all progress). This is the only step
that touches the write sequence, so the atomicity test is the guard.

**Alternative considered — surface the failure and let the player delete
saves.** Rejected as the only remedy: a one-time reclaim is a strictly better
first attempt and is invisible to the player when it succeeds.

### D4: Rate-limited autosave notice driven by the failure state

Have `TC.Save.autosave` (or a thin listener on the new state) raise a
rate-limited notice the first time an automated write fails after a successful
one, and re-raise only after a cooldown (for example once every 60 s) while the
failure persists. Recovery clears the state.

Rationale: the notice must be visible (the current silence is the defect) but
must not become a per-30-second toast storm when storage is permanently full.

**Alternative considered — toast on every failure.** Rejected: a full disk
would produce a toast every 30 seconds indefinitely.

### D5: Add the counters to the F3 overlay

Render attempts/successes/failures and the last failure reason in the existing
`TC.Debug.drawHud` block, using the same format as the other counters.

Rationale: makes the state inspectable without spamming, satisfying the
"observable at any time without a new message" scenario.

## Risks / Trade-offs

- **[Reclaim removes the backup and a later write still fails]** → The player
  is left with the last good main save, which is the best available state; the
  counters and notice make the situation legible. Explicitly covered by a
  spec scenario.
- **[Reclaim breaks `tests/save/atomicity.test.js`]** → Those tests throw
  `new Error('QuotaExceededError')`, whose name is `Error`. D2 must not
  classify them as capacity. New capacity tests must throw an error whose
  `name` is one of the D2 names. Run the atomicity suite explicitly.
- **[`stats()` on SaveCore adds a public API surface]** → Additive only; no
  existing signature changes.
- **[New localized strings trip the i18n gate]** → All new UI strings must be
  added to `js/locales/en.js`; `npm run check:i18n` enforces coverage.
- **[Duplicate notice systems with PackStore's localized errors]** → Different
  domains (pack store vs save); reuse the same key style and reason vocabulary
  so the UI mapping code is shared where practical.

## Migration Plan

1. Add SaveCore `stats()` + classified last-failure reason (D1/D2).
2. Add reclaim-before-fail to `saveNow` (D3); run the save suites.
3. Add the rate-limited autosave notice + localized keys (D4); add F3 counters
   (D5).
4. Add failure/recovery tests.
5. No data migration: existing saves load unchanged. Fully reversible.

## Open Questions

One deferrable item, recorded rather than resolved here: whether to keep the
existing `saveNow` boolean return or migrate to a richer result object. Both
are compatible with the specs as written; boolean is the lower-risk default.
