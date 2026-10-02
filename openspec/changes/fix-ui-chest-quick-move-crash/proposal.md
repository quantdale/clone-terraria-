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

- Define the missing `joinedActive()` predicate in `js/ui.js`. It is true
  only when `TC.NetClient.active()` is a client whose `isActive()` is true
  (`syncing` or `playing`). Do not use `drivesTick()`: that is also true
  during `connecting`, while `NetClient.intent()` returns null and
  `txSubmit` would fall through to a local `Commands.submit`.
- Route both call sites through that shared predicate so the two container
  branches cannot drift apart again.
- A missing `TC.NetClient` uses the local quick-move path and must not throw.
  If a client authority exists but the predicate cannot be evaluated, do not
  mutate the local mirror. The joined branch must call the network intent
  path directly and must not use `txSubmit`'s local fallback.
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
- **Risk**: low for the single-player crash. The joined path must use
  `isActive()`, not `drivesTick()`, and must not fail open into local
  mutation. No new state, save-format change, or protocol change.
