# Change Proposal: menu-keyboard-accessibility

- **ID**: menu-keyboard-accessibility
- **Status**: PROPOSED
- **Schema**: spec-driven
- **Priority**: P2 (confirmed accessibility gap, WCAG 2.1.1)

## Why

Every interactive surface in the game is rendered on a `<canvas>` and driven by
a hand-rolled immediate-mode mouse hit-tester. Auditing the input surface:

- `js/ui.js` builds a `layout()` of rectangles each frame (`L.buttons`,
  `L.bag`, `L.hotbar`, `L.chestRects`, `L.craftRects`, `L.packsRows`, …) and
  dispatches clicks by testing the pointer against those rects (`hitHotbar`,
  `hitBag`, `inRect`).
- The **only** keyboard handling in `js/ui.js` is a handful of single-key
  toggles: `Escape` (pause/close), `KeyE` (inventory), and modifiers read for
  mouse gestures (`shiftHeld`, `ctrlHeld`).
- Grepping the entire UI module for menu navigation concepts (focus, selected
  row, arrow-key movement, Enter-to-activate) returns **nothing**.

Consequence: **the title screen cannot be operated without a mouse.** The
"New World" / "Custom Seed" / "Continue World" / "Host Multiplayer" / "Join
Server" / "Content Packs" buttons, the pause menu, the packs panel (including
Install/Export/Remove per row), the shop rows, and the crafting list are all
mouse-only. A player using a keyboard, a switch, a trackball with no click
button, or any input remapping/assistive stack cannot start the game at all.

This is a direct WCAG 2.1.1 (Keyboard) failure and it blocks the "operable
without a pointing device" criterion. It is also an obvious playability gap on
platforms where mouse precision is poor.

Scope is the title menu, pause menu, packs panel, shop buy rows, and crafting
column. Inventory slot grids, chest grids, equipment slots, and shop sell
(right-click `sellFromSlot`) are out of scope. Screen-reader DOM mirroring is
also out of scope.

Arrow keys and Space already drive movement through `Input.axis()`, and an
open inventory does not pause simulation. Those keys must not become craft or
shop navigation. Title, pause, and packs may use arrows because simulation is
not running there. Shop and craft use Tab, Shift+Tab, and Enter.

## What Changes

- Introduce a focus model for the in-scope surfaces: title, pause, packs,
  shop buy rows, and crafting. One index per surface, reset on open and on
  world/state transition.
- On title, pause, and packs, move focus with arrow keys and activate with
  Enter or Space. On shop and craft, move focus with Tab and Shift+Tab and
  activate with Enter. Do not bind Arrow or Space as navigation while
  simulation can still be running. Every keyboard activation calls the same
  action the primary pointer gesture calls. Shop sell stays pointer-only in
  this change.
- Render a visible focus indicator on the focused item.
- Ensure the focused item is always visible in its scrollable region (craft
  list, pack rows) by scrolling the view to keep it on screen.
- Add a headless test driving the keyboard path and asserting the same actions
  fire as the equivalent mouse click, plus a browser journey for the title →
  new-world path.

**Not breaking**: the mouse path is unchanged and remains the default. No
existing keybinding changes; new bindings use keys not currently bound in menu
context.

## Capabilities

### New Capabilities
- `menu-keyboard-navigation`: keyboard operability, focus movement, activation,
  and focus visibility for the game's menu and panel surfaces.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this change introduces the capability
  baseline)

## Impact

- **Code**: `js/ui.js` (focus state, key handling in `processInput`, focus
  rendering, scroll-to-visible), `js/input.js` (possibly a small "menu
  navigation" intent accessor), `js/locales/en.js` only if any new user-visible
  strings appear (none expected — focus is graphical).
- **Tests**: new headless suite in `tests/core/`; one browser journey.
- **Dependencies**: none functionally. Benefits from
  `add-repository-quality-gates` being green first (it adds no new code paths
  here, but the gate keeps the change honest).
- **Risk**: medium. `js/ui.js` is the largest file in the project (~2,400
  lines) and `processInput` sits on the critical input path for the whole game;
  the risk is mitigated by routing navigation through existing action functions
  rather than reimplementing them, and by gating on the existing 33 browser
  journeys.
