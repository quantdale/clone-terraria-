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

- Reset the player identity registry when world construction proceeds, so no
  `Player` object is simulated in a later world. A refused continue does not
  reset and does not mutate the stored save.
- Make `Players.create` idempotent for the same player object before any
  browser re-seat. Today a requested id that already exists is discarded and a
  new id is allocated (`js/players.js`).
- Re-seat the local primary only on the browser `newGame` / successful
  `continueGame` paths. Do not re-seat inside `Runtime.createWorld`: that
  entry point is also the dedicated-server world factory, and pre-registering
  its constructed player would shift the first remote off `p1`.
- Do not remove the local primary inside `NetServer.stop()`. `quitToTitle`
  saves after `stop()`, and removing the primary nulls `TC.player` before that
  save. The next world-construction reset is the cross-world release.
- Add a lifecycle test for host → join → leave → quit → save → new world →
  continue, plus dedicated-server first-remote identity and idempotent
  `attachLocal`.
- Surface a diagnostic when world construction repairs a non-empty registry.

**Not breaking**: remotes and parked reconnect identities still die with the
session. The host player object remains saveable across quit. Dedicated-server
identity assignment does not change.

## Capabilities

### New Capabilities
- `player-identity-lifecycle`: ownership and coherence of the authoritative
  player identity registry across world creation, continuation, hosting,
  teardown, and return to title.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this change introduces the capability
  baseline)

## Impact

- **Code**: `js/players.js` (same-player idempotence), `js/main.js`
  (`newGame`, `continueGame`), `js/runtime.js` (`createWorld` reset only).
  `js/netserver.js` `stop()` is not the release point.
- **Tests**: lifecycle suite in `tests/net/` using `tests/net/helpers.js`.
- **Behavior**: solo play after a host quit simulates the new player. Live
  hosting and dedicated-server ids stay as they are.
- **Dependencies**: none. Independent of `fix-ui-chest-quick-move-crash`.
- **Risk**: medium. Idempotence must land before browser re-seat, and
  `createWorld` must not register a local primary. The lifecycle tests are the
  guard, not an optional follow-up.
