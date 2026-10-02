# Design — fix-ui-chest-quick-move-crash

## Context

`js/ui.js` is a `'use strict'` IIFE of ~2,400 lines that owns every screen-space
surface (title, pause, packs panel, inventory, chest panel, equipment, crafting,
shop, HUD, death overlay) plus mouse hit-testing and click dispatch.

Two container branches call `joinedActive()`:

- `slotClick(inv, i, rightClick)` — Shift-click on a filled inventory/hotbar
  slot while a chest is open, routing into the inventory→chest direction.
- the chest-grid branch of the click handler — Shift-click (or plain left-click
  with no held cursor stack) on a filled chest slot, routing chest→inventory.

Neither name is declared in `js/ui.js` or anywhere else in the repository
(verified: `grep -rn "joinedActive" js/ tests/ tools/` matches only the two
call sites). Under `'use strict'` this throws `ReferenceError`.

The click dispatch path is `UI.draw` → `processInput(L)` → `onClick(L, mx, my,
rightClick)`. `UI.draw` is invoked from the registered `core.ui` render layer
(`js/main.js`), and `TC.RenderLayers.drawLayer` wraps every drawer call in
`try/catch` that increments a per-drawer error counter and logs only the first
three failures. The result is a *silent* functional loss: the user sees no
feedback, the transfer never happens, and CI stays green because no test
presses Shift.

A joined client must not write local inventory truth. Command routing already
uses a narrower gate than tick ownership:

- `drivesTick()` is true from `connecting` through `playing`.
- `isActive()` is true only for `syncing` and `playing`.
- `NetClient.intent()` returns null unless `isActive()`, and `txSubmit` then
  falls through to `Commands.submit`, which mutates local state.

`drivesTick()` is the right gate for the frame loop and autosave skip. It is
the wrong gate for this click. The joined branch must not call `txSubmit`
unless it has first proven `intent()` will route; otherwise it submits the
intent directly and returns without a local write.

## Goals / Non-Goals

**Goals:**
- Make both Shift-click container directions work as designed in every session
  type (solo, browser host, joined client).
- Use the existing authoritative-transaction seam; add no new command, no new
  protocol field, no new state.
- Guarantee a missing `TC.NetClient` degrades to local editing instead of
  throwing.
- Add regression tests that would have caught this and that fail loudly.

**Non-Goals:**
- Not re-architecting inventory/cursor-stack handling.
- Not changing the `ContainerMove` protocol schema, the server-side session
  binding, or the local `quickMoveRange` merge/empty algorithm (that algorithm
  is already covered by Inventory invariants per the task board).
- Not adding a general UI error-reporting overhaul (see
  `add-repository-quality-gates`, which owns the systemic swallow-and-count
  concern).

## Decisions

### D1: Define `joinedActive()` over `active().isActive()`

```js
// True only when this session is a joined client that can route intents.
// drivesTick() is broader (it includes connecting) and must not be used here.
function joinedActive() {
  try {
    const client = TC.NetClient && typeof TC.NetClient.active === 'function'
      ? TC.NetClient.active() : null;
    return !!(client && typeof client.isActive === 'function' && client.isActive());
  } catch (e) {
    return !!(TC.NetClient && typeof TC.NetClient.active === 'function');
  }
}
```

Absent `TC.NetClient` returns false and the local quick-move runs. A throw
while a client authority exists returns true so the click cannot fail open
into a local mirror write. The joined branch then submits `ContainerMove`
through `TC.NetClient.intent` and returns even if that result is null. It must
not call `txSubmit`, because `txSubmit` local-submits when `intent()` returns
null.

**Rejected — `drivesTick()`.** True during `connecting`, where `intent()` does
not route.

**Rejected — `TC.__netClient`.** It is not cleared on every teardown path.

**Rejected — inline the check at both call sites.** The two directions would
drift again.

### D2: Fail closed when a client authority exists

A missing network client is local editing. A present but unevaluable client
authority is not permission to edit the mirror. The predicate itself must not
throw out of the click handler.

### D3: Assert zero UI-layer errors in the regression tests, not just state

The headless regression test asserts the *transfer result* (stack conservation
and source/destination contents). A second assertion inspects the UI drawer
error counter exposed by `TC.RenderLayers.list()` after the interaction and
requires it to be zero. This makes the test fail on any future throw in the
click path even if the thrown function is not the one we fixed — the systemic
counter that hid this defect becomes an assertion instead of a log line.

## Risks / Trade-offs

- **[The predicate is wrong for some session type]** → `isActive()` is the
  command-routing gate. `connecting` must stay on the local/no-route side
  rather than be treated as joined. Validate against the existing multiplayer
  journeys, and add the connecting negative case from the tasks.
- **[The fix makes a previously-dead path live and it has latent bugs]** →
  Expected and desired: `quickMoveRange` is a small, already-reviewed merge/empty
  routine; the new tests specify its exact expected outcome, so any latent bug
  surfaces immediately during implementation and is fixed in the same change.
- **[Two local helpers named similarly (`joinedActive` vs `txSubmit` callers)]**
  → Naming matches the codebase's existing `*Active` vocabulary
  (`NetClient.active()`); documented in a comment at the definition.
- **[Strict-mode throw removal changes the observable error stream]** →
  Improvement by definition; `verify-dist` already treats any browser console
  error as a release failure, so this cannot mask a new one.

## Migration Plan

1. Land the predicate + two call-site usages.
2. Land the headless regression tests (solo + joined-client paths).
3. Extend the existing browser inventory/container journey to press Shift so
   the real browser path is covered.
4. No data migration, no save-format change, no protocol change, no config
   change. Fully reversible by reverting the commit.

## Open Questions

None. The predicate semantics, the failure direction, and the test strategy are
all resolved from existing code and existing tests.
