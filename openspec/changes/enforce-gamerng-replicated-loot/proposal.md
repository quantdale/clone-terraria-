# Change Proposal: enforce-gamerng-replicated-loot

- **ID**: enforce-gamerng-replicated-loot
- **Status**: PROPOSED
- **Schema**: spec-driven
- **Priority**: P1 (confirmed determinism gap in replicated truth)

## Why

`AGENTS.md` states the project rule for W23:

> **W23 gameplay randomness rule:** runtime decisions that affect replicated
> truth (enemy AI, spawns, loot, crits/variance, drop physics) MUST draw from
> `TC.GameRng` named streams — never `Math.random()`. Presentation-only
> randomness (particles, blink timers, trails) stays on `Math.random` by design.

`js/loot.js` `breakPot()` violates this rule. The pot-break loot roll uses
`Math.random()` directly, with an in-code comment that misclassifies the
concern as "gameplay roll, not worldgen":

```js
let rolls = 1 + ((Math.random() * 2) | 0);   // gameplay roll, not worldgen
while (rolls-- > 0 && pool.length) {
  let total = 0;
  for (let i = 0; i < pool.length; i++) total += pool[i][3];
  let r = Math.random() * total;
  ...
  const n = e[1] + ((Math.random() * (e[2] - e[1] + 1)) | 0);
```

Every other replicated-truth draw in the codebase already routes correctly:
`js/items.js` `spawnDrop` uses `TC.GameRng.stream('misc')` for scatter physics
with an explicit comment ("Scatter physics is authoritative ... ride the seeded
'misc' stream so replays converge"), `js/lootables.js` uses
`TC.GameRng.stream('loot')`, and enemy AI, spawns, and combat all use named
streams. `js/loot.js` is the outlier.

Consequences:

- **Authoritative replay determinism is broken for pot loot.** A pot break
  produces real world drops whose contents are not reproducible from
  (seed, command trace). Same seed + same inputs ≠ same world, which is the
  property `tests/net/rng-replay.test.js` exists to prove.
- **The determinism proof has a hole.** `rng-replay.test.js` explicitly claims
  it converges "including enemy AI behavior, spawn-director placements, **loot
  rolls** and the GameRng stream state itself", but its scenario never breaks a
  pot, so the claim is untested for this path.
- **Netcode is not directly broken** (drops are replicated as entities, so
  clients mirror the host's result rather than recomputing it), but the
  seeded-authority invariant the project claims for W23 does not hold.

This change routes pot loot through `TC.GameRng` and closes the proof gap by
extending the replay test to actually break pots.

## What Changes

- Route all pot-break loot randomness in `js/loot.js` `breakPot()` through the
  canonical loot stream of `TC.GameRng`, with a safe fallback to
  `Math.random()` when `TC.GameRng` is unavailable (mirroring the established
  pattern in `js/lootables.js` and `js/combat.js`).
- Extend the W23 replay determinism proof so it breaks pots as part of the
  recorded trace and asserts that two independent realms converge, including
  the `TC.GameRng` stream digest.
- Correct the misleading in-code comment so it names the actual invariant
  (replicated truth) rather than worldgen.
- Add a direct unit test that a pot break's rolled output is a pure function of
  the seeded stream state.

**Not breaking**: no save-format change, no protocol change, no content change
(the `POT_LOOT` table and its weights are untouched). Pots are not currently
part of any recorded replay fixture, so no recorded determinism proof changes.

## Capabilities

### New Capabilities
- `replicated-truth-determinism`: the rule and its enforcement that every
  runtime draw affecting replicated world state originates from the canonical
  seeded RNG authority, and the proofs that establish it.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this change introduces the capability
  baseline)

## Impact

- **Code**: `js/loot.js` (`breakPot`), comment correction.
- **Tests**: `tests/net/rng-replay.test.js` (add pot breaks to the trace and
  assert convergence + stream digest), plus a focused unit test for pot
  determinism.
- **Dependencies**: none. Independent of the two P0 fixes.
- **Risk**: low. Behavior for players is statistically identical; only the
  source of randomness changes, plus a strictly stronger determinism guarantee.
  The one behavioral nuance is that a given (seed, pot-cell) now yields the
  same loot every session, which is the intended property.
