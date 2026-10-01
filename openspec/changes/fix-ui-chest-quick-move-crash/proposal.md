# Change Proposal: fix-ui-chest-quick-move-crash

- **ID**: fix-ui-chest-quick-move-crash
- **Status**: PROPOSED
- **Schema**: spec-driven
- **Priority**: P0 (confirmed user-facing defect; single-player reachable)

## Why

`js/ui.js` calls a function named `joinedActive()` in two container-transfer
branches, but **no function with that name exists anywhere in the repository**.
Because `js/ui.js` is a `'use strict'` IIFE, the call is a hard
`ReferenceError`, not a silent `undefined is not a function`.

Consequence: the entire click handler for that frame aborts. For an ordinary
single-player user the only visible effect is that **Shift-click quick-move
between the inventory and an open chest silently does nothing** — no error
message, no transfer, no state change. For a joined multiplayer client the
same throw also destroys the authoritative `ContainerMove` intent, so the
W23 networked container transaction is unreachable from the UI.

This is invisible to the existing gate: the 667 node:test cases and 33
Playwright journeys never press Shift anywhere (`grep -rn "Shift" tests/`
returns nothing), and the exception is swallowed by the per-drawer error
counter in `TC.RenderLayers.drawLayer` (`js/systems.js`), which logs only the
first three occurrences per drawer.

## What Changes

- Define the missing `joinedActive()` predicate in `js/ui.js` with the
  intended semantics: true only when the local session is a *joined network
  client* whose presentation is a mirror (i.e. `TC.NetClient.drivesTick()`
  reports the client owns the tick), so container transfers must be routed
  through the authoritative `ContainerMove` command instead of mutating a
  local mirror in place.
- Route both call sites through the shared predicate so the two container
  branches (inventory→chest and chest→inventory) cannot drift apart again.
- Add a defensive fallback so a missing/unavailable `TC.NetClient` can never
  re-introduce a throw on this path (fail *closed to local* editing, never to
  a crash).
- Add regression coverage that exercises both Shift-click branches with a
  real chest open, in single-player (local path) and joined-client
  (authoritative path) modes.
- Add a CI-visible assertion that a UI draw pass completes with zero
  render-layer errors for these interactions, so a future throw in the
  click path fails a test rather than being swallowed by the drawer counter.

**Not breaking**: the intended observable behavior of Shift-click quick-move
in single player is the pre-existing documented behavior; the network path
is the W23 contract that the dead call site was written for. This change makes
both behave as designed.

## Capabilities

### New Capabilities
- `inventory-container-transfer`: Shift-click and container-bound item
  movement between a player's inventory and an open chest, including the
  split between local in-place editing and the authoritative multiplayer
  `ContainerMove` transaction.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this change introduces the capability
  baseline rather than amending an archived one)

## Impact

- **Code**: `js/ui.js` (define predicate; two call sites inside `slotClick`
  and the chest-grid branch of the click handler).
- **Tests**: new headless suite covering both branches; extend the existing
  browser inventory/container journey to press Shift.
- **Behavior**: single-player Shift-click quick-move becomes functional for
  the first time since it was written; joined clients regain the W23
  authoritative chest-transfer path.
- **Dependencies**: none. This is a prerequisite-free fix and should land
  first.
- **Risk**: low. The predicate is a one-line read of an existing public API
  (`TC.NetClient.drivesTick`), which is already used as the authoritative
  "am I a joined mirror" gate in `js/main.js` (frame loop) and `js/save.js`
  (autosave skip). No new state, no save-format change, no protocol change.
