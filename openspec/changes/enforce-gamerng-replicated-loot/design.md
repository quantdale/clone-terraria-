# Design — enforce-gamerng-replicated-loot

## Context

`js/loot.js` is the pot/life-crystal/chest-loot module. `breakPot()` is invoked
from the canonical `TileBroken` subscription (`onTileBroken`) that the commands
layer's `completeTileBreak` and the world `applyMineDamage` tail drive. It
rolls `POT_LOOT` (a table of `[itemId, min, max, weight]` rows) and calls
`spawnDrop` for each result. Its current randomness:

```js
let rolls = 1 + ((Math.random() * 2) | 0);
while (rolls-- > 0 && pool.length) {
  let total = 0;
  for (let i = 0; i < pool.length; i++) total += pool[i][3];
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= pool[i][3];
    if (r <= 0) { ...; const n = e[1] + ((Math.random() * (e[2] - e[1] + 1)) | 0); spawnDrop(cx, cy, e[0], n); break; }
  }
}
```

The canonical authority is `TC.GameRng` (`js/gamerng.js`), which exposes named
streams (`ai`, `spawn`, `loot`, `combat`, `misc`) and is reset on `WorldLoaded`
from `TC.worldSeed`. The established consumption pattern (see
`js/lootables.js` line ~29 and `js/combat.js` line ~141) is:

```js
const rng = TC.GameRng ? TC.GameRng.stream('loot').float : Math.random;
```

`js/items.js` `spawnDrop` independently uses `TC.GameRng.stream('misc')` for
the scatter physics, so once the roll is seeded, the whole pot-break path
(seeded roll + seeded scatter) is reproducible.

The replay proof `tests/net/rng-replay.test.js` boots two independent
authoritative realms with the same seed, runs one recorded command/input trace,
and compares digests over enemies, drops, and the `TC.GameRng` digest. Its
header claims coverage of "loot rolls" but its scenario (a flat arena + a bow
trace) never breaks a pot, so the pot path is simply unexercised by the proof.

## Goals / Non-Goals

**Goals:**
- Make pot-break loot a pure function of the seeded RNG state.
- Extend the existing replay proof to actually cover pot breaks (and any other
  currently-uncovered replicated-truth draw) so the W23 claim becomes true.
- Match the existing `TC.GameRng ? … : Math.random` consumption pattern exactly.
- Correct the misleading in-code comment.

**Non-Goals:**
- Not changing the `POT_LOOT` table, weights, or the drop-scatter physics.
- Not changing chest-loot determinism (already position-hash based) or the
  `TC.LootTables` roller (already correct).
- Not adding new RNG streams or changing `js/gamerng.js` stream definitions.
- Not auditing every module for `Math.random`; this change fixes the one
  confirmed replicated-truth violation and the proof gap. (A broader static
  guard belongs to `add-repository-quality-gates`.)

## Decisions

### D1: Route pot loot through the `loot` stream with the standard fallback

Replace the three `Math.random()` calls in `breakPot` with a single locally
sourced float, following the `js/lootables.js` pattern:

```js
const rnd = TC.GameRng ? TC.GameRng.stream('loot').float : Math.random;
let rolls = 1 + ((rnd() * 2) | 0);
...
let r = rnd() * total;
...
const n = e[1] + ((rnd() * (e[2] - e[1] + 1)) | 0);
```

Rationale: identical to every other corrected call site, minimal diff, and
preserves the `Math.random` fallback so a bare embed without `js/gamerng.js`
still works (consistent with the module's optional-dependency posture).

**Alternative considered — use the `misc` stream.** Rejected: `misc` is
documented for drop/scatter physics; loot selection semantically belongs to
`loot`, which is the stream `TC.LootTables` already uses, keeping all loot
selection on one auditable stream.

### D2: Fix the misclassification comment

Replace `// gameplay roll, not worldgen` with a comment that states the actual
invariant — this is a replicated-truth draw sourced from the `loot` stream —
so a future reader (or a `Math.random` audit) does not treat it as exempt.

Rationale: the directive's anti-laziness rules treat "silently skip hard-to-
understand code" and misleading comments as defects; the comment is precisely
what let this rule violation persist.

### D3: Extend the replay proof rather than adding a separate determinism test

Add pot breaks into the `rng-replay.test.js` recorded trace (break a few placed
pots during the run) so the existing two-realm digest comparison (enemies,
drops, `TC.GameRng` digest) now exercises the pot path. Because the drop digest
and the RNG-stream digest are already compared, a single `Math.random` left in
the pot path would make the proof fail — exactly the desired regression guard.

Rationale: reuses the strongest existing determinism harness and its
already-correct digests. A digest mismatch names which compared state diverged.
It does not identify the offending source line, and the spec does not require
that attribution.

**Alternative considered — only add a focused pot unit test.** Insufficient on
its own: it would prove the roll is seeded in isolation but not that the
end-to-end replay (which includes drop scatter, physics, and the RNG digest)
converges. The proposal requires both; D3 provides the strong one and the
focused unit test is an additional cheap guard (see tasks).

## Risks / Trade-offs

- **[Replay test becomes order-sensitive]** → Pot breaks are placed
  deterministically in the trace and the RNG is already reset per world load, so
  adding a fixed number of pot breaks at fixed trace points is deterministic.
  If the proof becomes flaky, reduce to a fixed pre-trace pot break rather than
  a mid-trace one.
- **[Player-visible loot distribution unchanged]** → The table and weights are
  untouched, so expected value is identical; only the realization becomes
  seeded. A given (seed, pot) now always yields the same loot, which is the
  intended determinism property and matches chest-loot behavior.
- **[A same-seed replay of a live world changes]** → If any external tool relied
  on pot loot varying run-to-run, it now does not. Nothing in the repository
  depends on that; determinism is the project's stated goal.

## Migration Plan

1. Land the `breakPot` seeding (D1) + comment fix (D2).
2. Add the focused pot-determinism unit test.
3. Extend the replay trace with pot breaks (D3) and confirm it passes.
4. No migration: no save, protocol, or content change. Reversible by revert.

## Open Questions

None. The stream choice, fallback behavior, comment correction, and proof
strategy are all resolved from existing patterns.
