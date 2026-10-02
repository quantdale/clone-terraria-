# Menu Keyboard Navigation Specification

## Purpose

Makes the game's menu and panel surfaces operable without a pointing device by
providing focus movement, activation, cancellation, and a visible focus
indicator that reuse the same actions the pointer path already performs.

## ADDED Requirements

### Requirement: The in-scope menu surfaces SHALL be operable by keyboard alone

The title menu, pause menu, packs panel, shop buy rows, and crafting column
SHALL be operable by keyboard. Keyboard activation SHALL call the same action
as the primary pointer gesture on that item. Inventory slot grids, chest
grids, equipment slots, and shop sell are outside this requirement.

#### Scenario: The title menu can be started without a mouse

- **GIVEN** the title screen
- **WHEN** the user moves focus with the keyboard and activates an item
- **THEN** the corresponding menu action SHALL be performed
- **AND** the game SHALL be able to reach a playing state without any pointer
  input.

#### Scenario: The pause menu is operable by keyboard

- **GIVEN** the pause menu is open
- **WHEN** the user moves focus with the keyboard and activates an item
- **THEN** the corresponding action SHALL be performed
- **AND** the menu SHALL be dismissible with the keyboard.

#### Scenario: Activation is equivalent to the pointer gesture

- **GIVEN** a focused menu item
- **WHEN** it is activated with the keyboard
- **THEN** the same action the pointer gesture on that item performs SHALL be
  performed
- **AND** no separate or divergent implementation of that action SHALL exist.

### Requirement: Focus SHALL be explicit, singular, and resettable

Each open menu-like surface SHALL have exactly one focused item, and focus
SHALL be reset deterministically when a surface opens or when the game state
transitions.

#### Scenario: Opening a surface establishes a valid focus

- **GIVEN** an in-scope surface that has just opened and has at least one item
- **WHEN** it is displayed
- **THEN** exactly one of its visible items SHALL be focused
- **AND** activating an inert focused item SHALL perform no action and SHALL
  NOT raise an error.

#### Scenario: An empty surface has no focus and no activation target

- **GIVEN** a menu-like surface with no items
- **WHEN** it is displayed
- **THEN** no item SHALL be focused
- **AND** a keyboard activation SHALL perform no action
- **AND** no error SHALL be raised.

#### Scenario: Focus does not leak across state transitions

- **GIVEN** a focused item on one surface
- **WHEN** the game transitions to a different state or world
- **THEN** the stale focus SHALL NOT apply to the new surface
- **AND** the new surface SHALL establish its own focus on open.

#### Scenario: Focus wraps at the ends of a list

- **GIVEN** a menu-like surface with at least two items
- **WHEN** focus is moved backwards from the first item
- **THEN** focus SHALL move to the last item
- **AND** moving forwards from the last item SHALL move to the first item.

### Requirement: Focus SHALL be visible and kept on screen

The focused item SHALL be visually distinguishable, and scrolling or paginated
regions SHALL scroll so the focused item remains visible.

#### Scenario: The focused item is visually distinguishable

- **GIVEN** a menu-like surface with a focused item
- **WHEN** it is rendered
- **THEN** the focused item SHALL be rendered with a distinguishing visual
      treatment relative to unfocused items
- **AND** the treatment SHALL be observable in a rendered frame.

#### Scenario: Focus moves the view of a scrollable region

- **GIVEN** a scrollable or capped-height region such as a long crafting list
  or a packs list
- **WHEN** focus moves to an item outside the currently visible portion
- **THEN** the region SHALL scroll or paginate so that item becomes visible
- **AND** the item SHALL remain visible on the following frames.

### Requirement: Keyboard navigation SHALL NOT steal gameplay bindings

Arrow keys and Space SHALL remain gameplay bindings while simulation can run.
Shop and craft navigation SHALL use Tab, Shift+Tab, and Enter, and SHALL NOT
move focus in response to Arrow or Space. Title, pause, and packs MAY use
arrow keys and Space because simulation is not running on those surfaces.

#### Scenario: Arrow keys still move and jump during play

- **GIVEN** the game is playing, including while the inventory, shop, or
  crafting column is open
- **WHEN** the user presses movement or jump keys
- **THEN** the existing gameplay behavior SHALL occur
- **AND** shop or craft focus SHALL NOT move.

#### Scenario: Panel-open modifiers keep their meaning

- **GIVEN** the game is in a playing state
- **WHEN** the user presses the inventory or pause toggles
- **THEN** the existing open/close behavior SHALL occur
- **AND** navigation state SHALL be established only for the opened surface.

### Requirement: Navigation SHALL be independent of pointer position

A pointer that merely hovers over a surface SHALL NOT change which item is
focused, and keyboard focus SHALL NOT change in response to pointer movement,
so that the two input modalities remain independent and predictable.

#### Scenario: Hovering does not steal focus

- **GIVEN** a focused item on a surface
- **WHEN** the pointer moves over a different item
- **THEN** the focused item SHALL remain focused
- **AND** no activation SHALL occur.

#### Scenario: Keyboard focus is preserved across pointer activity

- **GIVEN** a keyboard-focused item
- **WHEN** the pointer is used elsewhere in the same surface
- **THEN** the keyboard-focused item SHALL remain the focused item until
      keyboard navigation moves it again.
