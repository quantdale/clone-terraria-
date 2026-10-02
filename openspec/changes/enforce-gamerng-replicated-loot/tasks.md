# Tasks — enforce-gamerng-replicated-loot

## 1. Route pot-break loot through the seeded authority

- [x] 1.1 In `js/loot.js` `breakPot()`, source a local float from
      `TC.GameRng.stream('loot').float` with a `Math.random` fallback, matching
      the `js/lootables.js` consumption pattern.
- [x] 1.2 Replace all three ambient-random calls in the roll (roll count,
      weighted entry selection, stack count) with the seeded float.
- [x] 1.3 Keep the `POT_LOOT` table, weights, and the `spawnDrop` call sites
      unchanged; do not alter the drop-scatter authority (already seeded in
      `js/items.js`).
- [x] 1.4 Replace the misleading `// gameplay roll, not worldgen` comment with
      one that states this is a replicated-truth draw sourced from the `loot`
      stream (design D2).

## 2. Determinism proof

- [x] 2.1 Add a focused unit test that pot-break loot is a pure function of the
      seeded stream state: restore identical `TC.GameRng` stream state, break
      the same pot twice, and assert the same entries and counts result.
- [x] 2.2 Add a fallback test: with `TC.GameRng` absent, a pot break still
      completes, produces drops, and raises nothing.
- [x] 2.3 Extend `tests/net/rng-replay.test.js`: place a small, fixed set of
      pots in the deterministic arena and break them at fixed points in the
      recorded trace (design D3).
- [x] 2.4 Assert the extended trace still converges on the enemy digest, the
      item-drop digest, and the `TC.GameRng` stream digest across the two realms.
- [x] 2.5 Verify the proof actually fails if the pot roll is reverted to
      ambient randomness (temporary negative control), then restore the fix.

## 3. Verification

- [x] 3.1 Run `node --check js/loot.js`.
- [x] 3.2 Run the focused determinism tests and `npm run test:net`.
- [ ] 3.3 Run `npm test` and confirm the full node:test suite passes.
- [ ] 3.4 Run `npm run validate` end to end and record the result.
- [x] 3.5 Confirm no other replicated-truth call site in `js/loot.js` still uses
      ambient randomness (only presentation/dust effects may).
