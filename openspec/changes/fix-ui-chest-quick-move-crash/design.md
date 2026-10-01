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

The intended semantics are already encoded elsewhere in the codebase: a joined
network client presents a mirror and must not write local world/inventory
truth, so its container transfers must go through the authoritative
`ContainerMove` command. The canonical "is this session a joined mirror?"
predicate is `TC.NetClient.drivesTick()` — the same function already gates the
fixed-step tick in `js/main.js` (`if (TC.NetClient.drivesTick()) TC.NetClient.frame(STEP);`)
and the autosave skip in `js/save.js`
(`if (TC.NetClient.drivesTick && TC.NetClient.drivesTick()) { acc = 0; return; }`).

Both call sites already funnel through `txSubmit('ContainerMove', {...})`
(`js/ui.js` `txSubmit` at line ~1885), which is the existing command-submission
seam. So the fix is to supply the missing predicate, not to invent a mechanism.

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

### D1: Define `joinedActive()` as a local helper over `TC.NetClient.drivesTick()`

Add a file-local function in `js/ui.js` alongside the existing input helpers
(`shiftHeld()`, `ctrlHeld()`, `pressed()`), all of which already use the same
`try/catch`-guarded, capability-checked access style:

```js
// True when this session is a joined network client presenting a mirror:
// container moves must then go through the authoritative ContainerMove
// command instead of editing the local mirror in place.
function joinedActive() {
  try {
    return !!(TC.NetClient && typeof TC.NetClient.drivesTick === 'function' &&
      TC.NetClient.drivesTick());
  } catch (e) { return false; }
}
```

Rationale: matches the established local-helper convention in the file
(`shiftHeld`/`ctrlHeld` both return `false` on any error, so the click path can
never be aborted by the predicate), and reuses the one authority the rest of
the codebase treats as canonical for this question.

**Alternative considered — inline `TC.NetClient.drivesTick()` at both call
sites.** Rejected: it duplicates the capability check and the try/catch twice
and makes the two container directions free to drift, which is the exact class
of defect being fixed here.

**Alternative considered — read `TC.__netClient` / `TC.NetClient.active()`.**
Rejected: `TC.__netClient` is set by the title-screen join action but is not
cleared on every teardown path, so it can be stale; `drivesTick()` is the gate
the simulation itself already trusts.

### D2: Keep the try/catch-return-false failure mode

A predicate that can throw is the same defect class as the one being fixed, so
the helper is total: any throw, missing authority, or malformed authority
resolves to `false` (local editing). The failure direction is deliberate —
failing *open to local* is safe here because the alternative (crashing the
click handler) is strictly worse, and a session that cannot report its own
mirror status is a session with no server to disagree with.

### D3: Assert zero UI-layer errors in the regression tests, not just state

The headless regression test asserts the *transfer result* (stack conservation
and source/destination contents). A second assertion inspects the UI drawer
error counter exposed by `TC.RenderLayers.list()` after the interaction and
requires it to be zero. This makes the test fail on any future throw in the
click path even if the thrown function is not the one we fixed — the systemic
counter that hid this defect becomes an assertion instead of a log line.

## Risks / Trade-offs

- **[The predicate is wrong for some session type]** → The two session classes
  are exhaustive: `drivesTick()` is true exactly when a joined client owns
  presentation and there is no local authority to write to. Validate against
  the existing multiplayer journeys (`journey-n`, `journey-o`) which already
  exercise joined-client container transfers through the same code path.
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
