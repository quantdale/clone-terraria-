# Change Proposal: fix-player-registry-world-transition

- **ID**: fix-player-registry-world-transition
- **Status**: PROPOSED
- **Schema**: spec-driven
- **Priority**: P0 (confirmed simulation-freeze defect; reachable from the title menu)

## Why

`TC.Players` is the multi-player identity authority added in W22
(`js/players.js`). The single-player path is its degenerate case: in ordinary
play the registry is **empty** and `js/main.js` falls back to `[TC.player]`
when driving the movement system.

That fallback silently breaks as soon as the registry is non-empty but stale.

`NetServer.stop()` (`js/netserver.js`) ends a hosting session with
`TC.Players.retainOnly([this.localPid])`, which **keeps** the local primary
entry — and that entry still points at the `Player` object belonging to the
world that is being torn down. No world-creation path ever clears or re-seats
the registry:

- `TC.newGame` and `TC.continueGame` (`js/main.js`) assign
  `TC.player = new TC.Player(...)` and never touch `TC.Players`;
- `TC.Runtime.createWorld` (`js/runtime.js`, the headless + dedicated-host
  entry point) does the same;
- `TC.Players.resetForNewWorld()` exists, is documented, is unit-tested in
  `tests/net/players.test.js`, and is **never called by production code**.

Reproduced headlessly through the real UI-equivalent flow
(title → host session → quit to title → new world):

```
after host:      players=1 primary=p1
after join:      players=2 ids=p1,p2
after client bye:players=1 ids=p1
after quit:      players=1 primary=p1   state=title
after newGame:   players=1 primary=p1   primaryIsNewPlayer=false
new player simulated? false
Targets.anchor is new player? false
```

Because the movement system iterates `TC.Players.all()` whenever the registry
is non-empty (`js/main.js` `registerSystems`), the **new** player is never
simulated (no gravity, no movement, no collision, no mining) while the
**discarded** player of the previous world keeps simulating invisibly. Enemy
AI and despawn logic route targeting through `TC.Targets`, which also resolves
from the registry, so enemies converge on a ghost the player cannot see, and
item pickup (`js/items.js`) scans the same registry.

Impact: a player who hosts a local multiplayer session, returns to the title,
and starts a new single-player game gets an unplayable, soft-locked world with
no error and no warning. This is the most common multiplayer-to-solo flow in
the product's own documented UI.

## What Changes

- Make every world transition reset the player identity registry before the new
  world is built, so no `Player` object can survive its world.
- Re-seat the local primary in the single-player and host-adopted cases so
  `TC.player` and the registry agree by construction, not by convention.
- Make `TC.Targets`, the movement system, and item pickup provably agree on
  the set of live authoritative players in a solo session (exactly one entry,
  and it is `TC.player`).
- Add a transition-order contract test that walks the real lifecycle
  (host → client join → client leave → quit → new world → continue) and asserts
  the registry, the singleton alias, and the targeting anchor stay coherent at
  every step.
- Surface a diagnostic instead of failing silently if a transition is ever
  entered with a registry that still references a foreign world.

**Not breaking**: the multiplayer session lifecycle is unchanged — remotes
still die with the session, and the local host primary is still retained for
the *same* world while the session runs. Only the *across-world* case changes,
where retention is currently a defect.

## Capabilities

### New Capabilities
- `player-identity-lifecycle`: ownership and coherence of the authoritative
  player identity registry across world creation, continuation, hosting,
  teardown, and return to title.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this change introduces the capability
  baseline)

## Impact

- **Code**: `js/main.js` (`newGame`, `continueGame`, `quitToTitle`),
  `js/runtime.js` (`createWorld`, `reset`), `js/netserver.js` (`stop`),
  possibly `js/players.js` (idempotence/assertion helper).
- **Tests**: new lifecycle suite in `tests/net/` (or `tests/core/`) driving
  the real host/client helpers in `tests/net/helpers.js`.
- **Behavior**: solo play after any session teardown becomes correct; enemy
  targeting, item pickup, and the movement system agree on one player.
- **Dependencies**: none. Independent of
  `fix-ui-chest-quick-move-crash`; both are P0 and can land in either order.
- **Risk**: medium-low. The fix is a reset at a well-defined seam, but the
  ordering relative to `attachLocal` and to save-then-teardown in
  `quitToTitle` must be exact, or a hosting session could lose its primary
  mid-teardown. The lifecycle test in this change is the guard for that.
