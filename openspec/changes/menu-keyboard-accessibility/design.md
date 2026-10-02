# Design — menu-keyboard-accessibility

## Context

`js/ui.js` is an immediate-mode canvas UI. Each frame `layout(ctx, w, h)` builds
a plain object of rectangles and `processInput(L)` dispatches from it:

```js
function layout(ctx, w, h) {
  const L = { hotbar: [], bag: [], invButtons: [], chestRects: [], craftRects: [],
              shop: null, buttons: [], uiRects: [], ... };
  ...
  L.buttons.push({ id, label, act, rect });   // title + pause menu
  ...
  return L;
}
```

Every current input interaction is a *pointer* interaction: `m.clicked` /
`m.rightClicked` latches in `js/input.js` are matched against rects by
`onClick(L, mx, my, rightClick)`. The only keyboard consumption in the whole UI
module is:

```js
if (pressed('KeyE') && !dead && getInv(true)) UI.invOpen = true;
else if (pressed('Escape')) UI.paused = true;
```

plus `Escape` to close, and `shiftHeld()` / `ctrlHeld()` as *modifiers* for
mouse gestures.

Critically, the `act` functions are already separated from hit-testing:

```js
const defs = [
  { id: 'new',   label: t('ui.menu.new_world'),       act: actNewWorld },
  { id: 'seed',  label: t('ui.menu.custom_seed'),     act: actCustomSeed },
  { id: 'continue', label: t('ui.menu.continue_world'), act: actContinue },
  { id: 'hostmp', label: t('ui.menu.host_multiplayer'), act: actHostMultiplayer },
  { id: 'joinmp', label: t('ui.menu.join_server'),    act: actJoinServer },
  { id: 'packs',  label: ...,                          act: actTogglePacks },
];
```

This is the key structural fact: **the action seam already exists and is
modality-independent.** The pointer path calls `def.act()`; a keyboard path can
call the identical `def.act()`. No action needs reimplementing, and no behavior
can diverge between input modalities — which is the primary correctness risk in
any "add keyboard support" change.

The same shape exists for the pause menu (`L.buttons` with
`actSaveQuit`/`actToggleSound`/…), the packs panel (`L.packsRows` +
`L.packsApplyRect`/`L.packsInstallRect`/`L.packsCloseRect`), the shop
(`L.shop.rows[i].entry` → `buyItem`), and the crafting column
(`L.craftRects` aligned to `L.craftList`).

Input availability: `TC.Input.pressed(code)` gives a one-frame edge set
(`justPressed`, cleared in `endFrame`), and `TC.Input.down(code)` gives held
state. `js/ui.js` already wraps these in `pressed()`/`shiftHeld()`/`ctrlHeld()`
helpers that swallow errors — the new navigation code should follow the same
convention.

## Goals / Non-Goals

**Goals:**
- Title, pause, packs, shop, and crafting surfaces fully operable by keyboard.
- Exactly one implementation of each action (reuse `act`).
- A visible, singular, resettable focus with a visible-item guarantee.
- Zero interference with gameplay keybindings.

**Non-Goals:**
- Not building a DOM accessibility mirror for screen readers. That is a much
  larger effort with a different design (and would fight the canvas
  architecture); it is called out as a follow-up in the master plan.
- Not adding remappable keybindings (a settings surface) — out of scope, though
  the focus model should not preclude it later.
- Not changing any menu's item set, order, or labels.
- Not changing gameplay movement/jump binding semantics.

## Decisions

### D1: One focus index per surface, stored in a small focus state object

Add a module-level focus state in `js/ui.js`:

```js
const focus = { surface: null, index: 0 };
```

Keyed by a surface id (`'title'`, `'pause'`, `'packs'`, `'shop'`, `'craft'`)
so opening a different surface cannot inherit another's index, and so focus
resets naturally when a surface closes. `surface` is set when the surface opens
and cleared when it closes.

Rationale: minimal state, trivially resettable, satisfies the "exactly one
focused item / no leak across transitions" requirement by construction. The
alternative — storing focus on the layout object — would be rebuilt every frame
and lose the index immediately.

### D2: Use different keys for playing and non-playing surfaces

Title, pause, and packs: ArrowUp/ArrowDown move focus, Enter and Space
activate, Escape closes. Simulation is not running, so those keys do not also
move a player.

Shop buy rows and the crafting column: Tab and Shift+Tab move focus, Enter
activates, Escape closes. Do not read Arrow or Space there. `Input.axis()`
uses those keys for movement, `pressed()` does not consume them, and
`simGate` does not treat an open inventory as paused.

Shop sell remains the existing right-click `sellFromSlot` path. This change
does not add a keyboard sell binding.

**Alternative considered — handle keys in `js/input.js`.** Rejected: `input.js`
is a raw state module with no knowledge of UI surfaces; putting navigation there
would invert the dependency and require input to know about `UI`.

### D3: Navigate by item index, including inert rows

Navigation moves a single index through the surface's ordered visible items,
wrapping at the ends. Unavailable shop or craft rows remain focusable.
Activating one calls the same action as a primary click and that action is a
no-op when the row cannot be used. Do not require the default focus to be
activatable.

**Alternative considered — spatial navigation (nearest item by direction).**
Rejected: more code, more edge cases, and unpredictable for a vertical list.
Ordered index navigation matches the visual list exactly.

### D4: Reuse the pointer activation function for keyboard activation

`onClick` already resolves a hit to an action. Add a small
`activateItem(surface, index, L)` that performs the same dispatch the pointer
hit performs for that item, and have BOTH the pointer hit path and the keyboard
path call it. Where the pointer path needs right-click semantics (sell),
keyboard activation maps to the primary (left-click) action only.

Rationale: guarantees the spec's "activation is equivalent to the pointer
gesture" requirement structurally, not by convention. This is the single most
important decision in the change.

### D5: Render a focus indicator in the item's own draw call

Each draw function for a navigable item already renders its rect; add a focus
outline / background tint when `focus.surface === <this surface> &&
focus.index === i`. No new overlay pass, no z-order concerns.

Rationale: minimal diff per surface and visually unambiguous. Make it
theme-consistent with existing UI colors and readable at the existing zoom.

### D6: Scroll-to-visible by adjusting the existing view offset

`L.craftMaxRows` already caps visible craft rows and the packs panel already has
a row window. Add a per-surface scroll offset that is adjusted when the focused
index moves outside `[offset, offset + visibleCount)`. No new scrolling UI; the
existing cap is the window.

### D7: Do not read movement keys while simulation can run

Reading `pressed('ArrowDown')` does not consume it, so an open crafting column
that navigates with arrows would move focus and the player. That is why shop
and craft do not use those keys. Add a regression test that arrows still move
the player while crafting is open and that Tab does not move the player.

## Risks / Trade-offs

- **[Touching the largest file in the project on the critical input path]**
  → Mitigated by D4 (no new action logic), by landing after the P0 fixes, and
  by the existing 33 browser journeys as a regression net.
- **[Arrow keys conflict with player movement while a panel is open]** →
  Inventory does not pause simulation, and `pressed()` does not consume keys.
  Shop and craft therefore do not bind Arrow or Space. The regression test
  asserts arrows still move the player while crafting is open.
- **[Focus indicator regressing visual quality]** → Use existing UI palette;
  review a rendered frame in a browser journey screenshot.
- **[Immediate-mode layout means "current item list" can change between
  keypress and render]** → Derive navigation from the same `L` passed into
  `processInput`, and clamp the index to the current list length each frame.

## Migration Plan

1. Add focus state + navigation branch + `activateItem` dispatch (D1–D4) for
   the title menu; make title fully keyboard-operable and add the headless test.
2. Extend to the pause menu.
3. Extend to the packs panel (including per-row Export/Remove and the
   Apply/Install/Close buttons).
4. Extend to the shop dialog and the crafting column, with scroll-to-visible
   (D6).
5. Add focus rendering (D5) and the browser journey.
6. No save/protocol/content change. Fully reversible per surface, so a partial
   rollout is safe.

## Open Questions

None blocking. One deferrable item: whether to also expose focus to assistive
technology via a visually-hidden live region in the DOM. That is part of the
larger screen-reader mirror follow-up, not this change.
