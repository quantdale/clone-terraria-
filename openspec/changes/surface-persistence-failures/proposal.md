# Change Proposal: surface-persistence-failures

- **ID**: surface-persistence-failures
- **Status**: PROPOSED
- **Schema**: spec-driven
- **Priority**: P2 (data-loss risk that is currently invisible to the player)

## Why

The persistence stack is well built — `TC.SaveCore.saveNow` is atomic
(tmp → verify → bak → main), `TC.Save.autosave` is correctly skipped for joined
network mirrors, and `TC.PackStore` degrades safely. But **when a write fails,
the automated path tells nobody**, and the failure mode is data loss.

Confirmed by probe against a localStorage stub with a byte ceiling:

```
Save.save() returned: false
stored keys: []
after autosave, save unchanged? true
SaveCore.saveNow: false
```

Three concrete gaps:

1. **Autosave failure is silent.** `TC.Save.autosave` calls `TC.Save.save()`
   and discards the boolean (`js/save.js`). A player whose storage is full
   loses up to `AUTOSAVE_INTERVAL` (30 s) of progress on every cycle, forever,
   with no message, no counter, and no event. The failure only becomes visible
   when the player later tries a manual save — by which point the gap may be
   minutes of play.
2. **No observability surface exists.** `js/savecore.js` has no stats or
   counters at all (verified: no counter symbols in the module), so the F3
   debug overlay and `TC.Debug` cannot report persistence health. Compare
   `TC.PackStore`, which *does* maintain `lastLoadErrors` and returns
   localized `quota` / `too-large` / `max-installed` errors, and `TC.WorldRegions`
   / `TC.Lighting`, which both expose `counters()` / `stats()`.
3. **Failure is not actionable.** A `QuotaExceededError` and a provider
   exception both surface as the generic `ui.toast.save_failed` string. The
   player's only remedies are invisible: deleting other localStorage data for
   the origin, or reducing world modification. Nothing states that.

This matters more than a typical "better error message" item because the
failure is *silent, repeating, and destructive*.

## What Changes

- Record persistence outcomes: a bounded counter set on the save layer covering
  attempts, successes, failures, and the last failure reason.
- Surface **autosave** failure to the player through a rate-limited,
  actionable notice (distinct from the manual-save toast), and expose the same
  signal on the debug overlay.
- Distinguish a storage-capacity failure from a data/provider failure in both
  the user-facing message and the machine-readable error, so the notice can
  tell the player what to do.
- Provide a recovery path: when storage is the constraint, the save layer
  SHALL release reclaimable space it owns (the temporary write artifact, and
  the retained backup when the main write cannot land) before giving up.
- Add tests for the failure and recovery paths, which have none today.

**Not breaking**: successful-save behavior, envelope format, and the atomic
write contract are unchanged. No save data is reformatted.

## Capabilities

### New Capabilities
- `persistence-reliability`: save-write outcome accounting, player-visible
  failure reporting, failure classification, and reclaim-before-fail recovery
  for local-storage-backed persistence.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this change introduces the capability
  baseline)

## Impact

- **Code**: `js/save.js` (`autosave`, `save`), `js/savecore.js` (stats +
  capacity-aware retry), `js/ui.js` (rate-limited autosave-failure notice),
  `js/debug.js` (overlay counters), `js/locales/en.js` (new catalog keys).
- **Tests**: new save-failure suite in `tests/save/` (storage-throws, capacity
  exhaustion, recovery, autosave notification rate limit).
- **Dependencies**: none functionally. Sequenced after the P0 fixes so the
  gate is green when the new checks land.
- **Risk**: low. Additive counters and UI notice. The reclaim-before-fail step
  touches the atomic write sequence and must preserve the "previous main/bak
  untouched on failure" invariant asserted by `tests/save/atomicity.test.js`.
