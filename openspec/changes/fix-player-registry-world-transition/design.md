# Design — fix-player-registry-world-transition

## Context

Three modules share responsibility for player identity, and their contract is
currently enforced only by convention:

| Module | Role today |
|---|---|
| `js/players.js` | Owns the registry (`entries` Map, `primaryId`, `nextOrdinal`), the `TC.player` alias, and `resetForNewWorld` / `retainOnly` / `remove`. |
| `js/main.js` | Owns browser world transitions (`newGame`, `continueGame`, `quitToTitle`) and drives the movement system from `TC.Players.all()` when the registry is non-empty. |
| `js/runtime.js` | Owns headless world creation (`createWorld`) and full teardown (`reset`), and emits `WorldLoaded`. |
| `js/netserver.js` | Owns session membership: `attachLocal` seats the host primary (`p1`), `stop` retains the local primary and drops remotes. |

Two facts create the defect:

1. `js/players.js` documents the intended rule — *"World swap: entities die
   with the old world object graph. The host re-registers whoever survives the
   transition."* — and ships `resetForNewWorld()` to implement it. That function
   is exercised only by `tests/net/players.test.js`; no production path calls
   it.
2. `js/main.js` and `js/runtime.js` construct a new `Player` and assign it to
   `TC.player` directly, with no registry participation at all. In a session
   that never hosted, the registry stays empty and the `[TC.player]` fallback in
   the movement system masks the omission. After `NetServer.stop()` retains
   `p1`, the registry is non-empty and the fallback no longer applies.

The consumers that inherit the inconsistency are all registry-driven, which is
why the symptom is broad rather than cosmetic:

- `js/main.js` movement system → iterates `TC.Players.all()`;
- `js/targeting.js` (`TC.Targets`) → prefers registry entries, and is the
  mandated authority for enemy AI, despawn and spawn anchoring;
- `js/items.js` pickup → scans `TC.Players.all()`;
- `js/enemies.js` contact damage and hostile-shot victims → `TC.Players.all()`.

The save path is a separate concern and is already correct: `quitToTitle`
saves *before* clearing state, and the host world is the save.

## Goals / Non-Goals

**Goals:**
- Enforce one invariant: **a `Player` entity never outlives its world.**
- Make the invariant hold at the seams that create worlds, not in each
  consumer.
- Keep the multiplayer session lifecycle byte-for-byte unchanged while a
  session is running.
- Make any repair observable.

**Non-Goals:**
- Not changing how remotes are spawned, replicated, despawned, or garbage
  collected (netserver/netclient replication is untouched).
- Not changing `TC.Targets` selection policy (nearest-by-d2 with 20%
  challenger stickiness and stable-id tie-break) — it is correct; it is being
  fed a wrong population.
- Not making solo play eagerly populate the registry. An empty registry in a
  never-hosted session is a supported, cheap degenerate case and the
  `[TC.player]` fallback is legitimate.
- Not touching `TC.Players.MAX` limits or the reconnect grace policy.

## Decisions

### D1: Reset the registry when world construction proceeds, not on every function entry

Call `TC.Players.resetForNewWorld()` (guarded for optional dependency) only
once world construction is actually going to proceed:

- `TC.newGame`: before the new `Player` is constructed.
- `TC.continueGame`: after pack classification succeeds and before the
  deserialized player is installed. A refused continue returns before the reset.
- `TC.Runtime.createWorld`: before the new `Player` is used by later systems.

Rationale: world construction is the moment the old player object graph dies.
Resetting earlier, on a refused continue, is unnecessary and would couple a
failed load to registry mutation.

**Alternative considered — reset as the first line of `continueGame`.** Rejected:
the function returns without building a world when the save is missing or pack
classification refuses the load.

**Alternative considered — reset only in `quitToTitle`.** Rejected: headless
`createWorld` and any future direct world start would still inherit a stale
registry.

### D2: Re-seat only the browser local player, and make same-player registration idempotent first

`Players.create` does **not** return an existing id today. At `js/players.js`
the requested id is discarded when `entries.has(id)` and a new id is allocated.
That fact blocks a naive re-seat.

Before browser re-seat:

1. Change `Players.create` so that registering the same player object again
   returns the existing record and id. A requested id that belongs to a
   *different* player remains a conflict and must not silently allocate a
   second entry for the same object.
2. After `TC.newGame` and a successful `TC.continueGame` construct the local
   player, register that object once with `{ primary: true }`.
3. Do **not** re-seat inside `TC.Runtime.createWorld`. Dedicated and soak hosts
   call `start()` without `adoptWorld`, which calls `createWorld` and then
   attaches remotes with `Players.create` and no explicit id. Pre-registering
   the constructed `TC.player` would consume `p1` and shift the first remote.
   Tests that call `createWorld` then `attachLocal` must still get `p1`.

`actHostMultiplayer` calls `newGame` and then `attachLocal(TC.player, { id:
'p1' })`. After D2, `attachLocal` must observe the existing entry and return
it. It must not allocate `p2` or cause the movement system to step the same
object twice.

**Alternative considered — leave every solo session with an empty registry.**
Rejected for the browser path: after `stop()` the registry is non-empty, so the
`[TC.player]` fallback is not the path that runs. A correct single entry is the
invariant the browser scenarios require. It remains rejected for headless
`createWorld` because that entry point is also the dedicated-server world
factory.

**Alternative considered — re-seat in `createWorld` too.** Rejected: it changes
dedicated-server identity assignment.

### D3: Do not release the local primary inside `NetServer.stop()`

Leave `retainOnly([localPid])` in place. `quitToTitle` calls `stop()` and then
`TC.Save.save()` (`js/main.js`). `Players.remove` of the primary sets
`TC.player = null` (`js/players.js`). Releasing the primary during `stop()`
would save a null player.

The cross-world release is the D1 reset, which runs on the next world
construction, after the quit save. `stop()` must still drop remotes, parked
reconnect identities, and their private region consumers.

**Rejected alternative — remove the local primary in `stop()` and rely on the
next reset.** That nulls the player before the host save. Also rejected:
reordering save ahead of `stop()` only to make an unnecessary release safe.

### D4: Emit an observable repair diagnostic

Have the world-construction reset report whether it found a non-empty registry.
Prefer the existing `TC.Debug` / `TC.Events` conventions. The diagnostic is
especially expected on the host-quit-then-new-world path, because D3
intentionally leaves the saved world's primary registered until that reset.

## Risks / Trade-offs

- **[Resetting or removing the primary before the host save]** → Forbidden by
  D3. The lifecycle test must save after `stop()` and assert the character is
  the host player, not null.
- **[Re-seat before idempotent create double-registers the host]** → D2 step 1
  lands before any browser re-seat. The host lifecycle asserts one entry and
  one simulation step per tick.
- **[Headless re-seat shifts dedicated-server ids]** → `createWorld` resets and
  does not register. A dedicated-start test asserts the first remote id is
  unchanged.
- **[A refused continue resets the registry anyway]** → Reset is after
  classification success only.
- **[Behaviour change is "the game now works"]** → Intentional for the stale
  solo-after-host path. Live hosting, remote simulation, and dedicated-server
  id assignment stay as they are.

## Migration Plan

1. Land idempotent same-player `Players.create` (D2 step 1) with a unit test.
2. Land the construction reset (D1) and the browser re-seat (D2 steps 2–3).
   Do not edit `NetServer.stop()` to drop the local primary.
3. Land the repair diagnostic (D4).
4. No save-format change and no protocol change. Fully reversible per step.

## Open Questions

None. The earlier option to release the primary inside `stop()`, and the claim
that `Players.create` already returns an existing id, are withdrawn.
