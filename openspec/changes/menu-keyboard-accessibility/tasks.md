# Tasks — menu-keyboard-accessibility

## 1. Focus state and shared activation

- [ ] 1.1 Add a module-level focus state to `js/ui.js` keyed by surface id
      (`title`, `pause`, `packs`, `shop`, `craft`) with a single index, set on
      open and cleared on close (design D1).
- [ ] 1.2 Add an `activateItem(surface, index, L)` dispatcher that performs the
      same action the pointer hit on that item performs.
- [ ] 1.3 Route the EXISTING pointer hit path for every navigable surface
      through `activateItem` so pointer and keyboard share one implementation
      (design D4) — this is the key correctness step; keyboard activation
      maps to the primary (left-click) action only.
- [ ] 1.4 Clamp the focus index to the current item count every frame so a
      layout change between keypress and render cannot produce an out-of-range
      focus.

## 2. Title menu keyboard operation

- [ ] 2.1 Add a navigation branch in `processInput` (after the existing
      Escape/KeyE toggles) that moves focus with arrow keys and activates with
      Enter/Space (design D2).
- [ ] 2.2 Make focus wrap at the first and last title menu item.
- [ ] 2.3 Ensure the title screen reaches a playing state via keyboard alone.
- [ ] 2.4 Establish a valid default focus when the title surface opens; handle
      the no-items case without error.

## 3. Pause menu

- [ ] 3.1 Enable focus movement, activation, and Escape dismissal on the pause
      menu.
- [ ] 3.2 Verify focus does not leak between the title surface and the pause
      surface (independent surface ids).

## 4. Packs panel

- [ ] 4.1 Enable keyboard navigation over the packs rows.
- [ ] 4.2 Enable keyboard access to the Apply/Install/Close buttons and the
      per-row Export/Remove actions.
- [ ] 4.3 Handle the panel's open/close transitions (including the install
      file-input flow, which remains pointer-invoked if a hidden file input
      cannot be driven by keyboard — document the limitation if it cannot).

## 5. Shop and crafting

- [ ] 5.1 Enable keyboard navigation over shop rows; activation performs the
      same purchase action as a row click.
- [ ] 5.2 Enable keyboard navigation over the crafting column; activation
      submits the same craft transaction as a row click.
- [ ] 5.3 Implement scroll-to-visible for the capped craft list and the packs
      list (design D6) so a focused item outside the visible window scrolls
      into view and stays visible.

## 6. Focus rendering

- [ ] 6.1 Render a visible focus indicator on the focused item in every
      navigable surface, using the existing UI palette (design D5).
- [ ] 6.2 Confirm the indicator is visually unambiguous against the unfocused
      items in a rendered frame.

## 7. Non-interference with gameplay input

- [ ] 7.1 Confirm navigation is inert when no navigable surface is open, so
      movement, jump, and hotbar keys behave exactly as before.
- [ ] 7.2 Confirm opening the inventory or pause menu does not steal or
      suppress movement input.
- [ ] 7.3 Confirm hovering with the pointer does not change the keyboard-focused
      item, and pointer use does not move keyboard focus.

## 8. Tests

- [ ] 8.1 Headless test: title menu is navigable and activatable by keyboard,
      and reaches a playing state with no pointer input.
- [ ] 8.2 Headless test: focus wraps at both ends; an empty surface has no
      focus and activation is inert without error.
- [ ] 8.3 Headless test: keyboard activation on a pause-menu item performs the
      same observable action as the equivalent pointer click.
- [ ] 8.4 Headless test: focus does not leak across a state transition.
- [ ] 8.5 Headless test: movement keys still move the player when no surface is
      open, and opening a panel does not suppress movement.
- [ ] 8.6 Headless test: focusing an off-screen item in a capped list scrolls it
      into view and keeps it visible.
- [ ] 8.7 Browser journey: start a new world using only the keyboard, and
      capture a screenshot showing the focus indicator.

## 9. Verification

- [ ] 9.1 Run `node --check js/ui.js`.
- [ ] 9.2 Run `npm test` and confirm the full node:test suite passes.
- [ ] 9.3 Run `npm run test:browser` and confirm all journeys pass.
- [ ] 9.4 Run `npm run validate` end to end and record the result.
- [ ] 9.5 Manually verify each surface is fully operable with the mouse
      unplugged, and that no gameplay keybinding regressed.
