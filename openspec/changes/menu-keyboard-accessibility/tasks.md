# Tasks — menu-keyboard-accessibility

## 1. Focus state and shared activation

- [x] 1.1 Add a module-level focus state to `js/ui.js` keyed by surface id
      (`title`, `pause`, `packs`, `shop`, `craft`) with a single index, set on
      open and cleared on close (design D1).
- [x] 1.2 Add an `activateItem(surface, index, L)` dispatcher that performs the
      same action the pointer hit on that item performs.
- [x] 1.3 Route the EXISTING pointer hit path for every navigable surface
      through `activateItem` so pointer and keyboard share one implementation
      (design D4) — this is the key correctness step; keyboard activation
      maps to the primary (left-click) action only.
- [x] 1.4 Clamp the focus index to the current item count every frame so a
      layout change between keypress and render cannot produce an out-of-range
      focus.

## 2. Title menu keyboard operation

- [x] 2.1 Add title, pause, and packs navigation with arrow keys, Enter, and
      Space. Do not use those movement keys for shop or craft (design D2).
- [x] 2.2 Make focus wrap at the first and last title menu item.
- [x] 2.3 Ensure the title screen reaches a playing state via keyboard alone.
- [x] 2.4 Establish a valid default focus when the title surface opens; handle
      the no-items case without error.

## 3. Pause menu

- [x] 3.1 Enable focus movement, activation, and Escape dismissal on the pause
      menu.
- [x] 3.2 Verify focus does not leak between the title surface and the pause
      surface (independent surface ids).

## 4. Packs panel

- [x] 4.1 Enable keyboard navigation over the packs rows.
- [x] 4.2 Enable keyboard access to the Apply/Install/Close buttons and the
      per-row Export/Remove actions.
- [x] 4.3 Handle the panel's open/close transitions (including the install
      file-input flow, which remains pointer-invoked if a hidden file input
      cannot be driven by keyboard — document the limitation if it cannot).

## 5. Shop and crafting

- [x] 5.1 Enable Tab / Shift+Tab / Enter navigation over shop buy rows.
      Activation calls the same purchase action as a primary row click. Do not
      add a keyboard sell binding.
- [x] 5.2 Enable the same keys over the crafting column. Activation submits
      the same craft transaction as a primary row click. An unavailable row
      may be focused; activation is inert and does not throw.
- [x] 5.3 Implement scroll-to-visible for the capped craft list and the packs
      list (design D6) so a focused item outside the visible window scrolls
      into view and stays visible.

## 6. Focus rendering

- [x] 6.1 Render a visible focus indicator on the focused item in every
      navigable surface, using the existing UI palette (design D5).
- [x] 6.2 Confirm the indicator is visually unambiguous against the unfocused
      items in a rendered frame.

## 7. Non-interference with gameplay input

- [x] 7.1 Confirm shop and craft navigation does not read Arrow or Space, so
      movement and jump behave as before while those surfaces are open.
- [x] 7.2 Confirm opening the inventory or pause menu does not consume
      movement keys. Pause may use arrows because simulation is gated off.
- [x] 7.3 Confirm hovering with the pointer does not change the keyboard-focused
      item, and pointer use does not move keyboard focus.

## 8. Tests

- [x] 8.1 Headless test: title menu is navigable and activatable by keyboard,
      and reaches a playing state with no pointer input.
- [x] 8.2 Headless test: focus wraps at both ends; an empty surface has no
      focus and activation is inert without error.
- [x] 8.3 Headless test: keyboard activation on a pause-menu item performs the
      same observable action as the equivalent pointer click.
- [x] 8.4 Headless test: focus does not leak across a state transition.
- [x] 8.5 Headless test: arrow keys still move the player while the crafting
      column is open, and Tab moves craft focus without moving the player.
- [x] 8.6 Headless test: focusing an off-screen item in a capped list scrolls it
      into view and keeps it visible.
- [x] 8.7 Browser journey: start a new world using only the keyboard, and
      capture a screenshot showing the focus indicator.

## 9. Verification

- [x] 9.1 Run `node --check js/ui.js`.
- [x] 9.2 Run `npm test` and confirm the full node:test suite passes.
- [x] 9.3 Run `npm run test:browser` and confirm all journeys pass.
- [x] 9.4 Run `npm run validate` end to end and record the result.
- [ ] 9.5 Manually verify each surface is fully operable with the mouse
      unplugged, and that no gameplay keybinding regressed.
