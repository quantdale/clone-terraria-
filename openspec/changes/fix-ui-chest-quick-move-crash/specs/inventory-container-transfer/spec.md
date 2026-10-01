# Inventory Container Transfer Specification

## Purpose

Defines how items move between a player's inventory and an open chest when the
player uses the Shift-click quick-move gesture, and how that gesture routes
through the authoritative container transaction when the local session is a
joined network client presenting a mirror rather than owning simulation truth.

## ADDED Requirements

### Requirement: Shift-click quick-move transfers stacks between inventory and open chest

When a chest panel is open, the inventory is open, no cursor stack is held, and
the player holds Shift while clicking a filled inventory or hotbar slot, the
game SHALL move the entire stack for that slot into the open chest: merging into
an existing matching stack first, otherwise into the first empty chest slot, and
clearing the source slot only when the whole stack moved. Merging SHALL respect
the destination stack-size cap for the item, so a move into a full stack MAY be
partial.

#### Scenario: Local single-player quick-move merges into a matching chest stack

- **GIVEN** a single-player session with a chest panel open
- **AND** a chest slot at index 0 holds 3 `stone` and the player's inventory
  slot 4 holds 20 `stone`
- **WHEN** the player holds Shift and left-clicks inventory slot 4
- **THEN** the chest slot at index 0 SHALL hold 23 `stone`
- **AND** the inventory slot 4 SHALL be empty
- **AND** the chest slot count SHALL increase by exactly 20 and the player
  inventory count SHALL decrease by exactly 20
- **AND** no error SHALL be raised and the click SHALL be fully processed.

#### Scenario: Local single-player quick-move fills the first empty chest slot

- **GIVEN** a single-player session with a chest panel open containing no
  matching stack for the clicked item
- **AND** the player's inventory slot 4 holds 7 `arrow`
- **WHEN** the player holds Shift and left-clicks inventory slot 4
- **THEN** the first empty chest slot SHALL hold 7 `arrow`
- **AND** the inventory slot 4 SHALL be empty
- **AND** no error SHALL be raised.

#### Scenario: Quick-move from the chest grid to the inventory

- **GIVEN** a single-player session with a chest panel open
- **AND** chest slot 3 holds 5 `copper_bar` and inventory slot 0 is empty
- **WHEN** the player holds Shift and left-clicks chest slot 3
- **THEN** the stack SHALL move into the player's inventory
- **AND** the chest slot 3 SHALL be empty
- **AND** no error SHALL be raised.

#### Scenario: Quick-move is inert without the modifier or with an empty source

- **GIVEN** a chest panel is open
- **WHEN** the player left-clicks a filled slot without holding Shift
- **THEN** the ordinary cursor-stack transfer SHALL apply instead of quick-move
- **AND** when the player holds Shift and clicks an EMPTY slot, no transfer and
  no error SHALL occur.

#### Scenario: A move into a full destination stack is partial

- **GIVEN** a chest slot already holding the maximum stack for the item
- **AND** the player's inventory slot holds more of the same item
- **WHEN** the player holds Shift and left-clicks that inventory slot
- **THEN** the full destination stack SHALL remain at its cap
- **AND** the remainder SHALL move into the next available chest slot
- **AND** the source slot SHALL be cleared once nothing remains.

### Requirement: A missing session predicate SHALL never break the click path

The container quick-move decision SHALL be computed by a single shared
predicate, and a session where the network-client authority is absent or
unavailable SHALL be treated as a local (non-mirror) session rather than
raising an error.

#### Scenario: Local session without a network client performs quick-move

- **GIVEN** a session where the network-client authority is absent
- **AND** a chest panel is open with a filled inventory slot under the cursor
- **WHEN** the player Shift-clicks that slot
- **THEN** the local quick-move SHALL execute
- **AND** no error SHALL be raised.

#### Scenario: The decision is shared by both container directions

- **GIVEN** a joined network client session with a chest panel open
- **WHEN** the player Shift-clicks either an inventory slot or a chest-grid slot
- **THEN** both directions SHALL consult the same predicate
- **AND** both directions SHALL submit the authoritative container transfer
  intent rather than editing a local mirror in place.

### Requirement: Joined clients transfer through the authoritative container transaction

When the local session is a joined network client whose world is a
presentation mirror, a container quick-move SHALL submit the authoritative
container transfer command for the acting player and SHALL NOT mutate the
local inventory or chest mirror in place.

#### Scenario: Joined client shift-click submits an authoritative transfer

- **GIVEN** a joined network client session with a chest panel open
- **AND** the player holds Shift and left-clicks a filled inventory slot
- **THEN** the game SHALL submit the authoritative container transfer command
  for the open chest with the acting player as the source endpoint
- **AND** the local inventory and chest mirror SHALL NOT be mutated
  optimistically before the authority responds.

#### Scenario: Joined client chest-grid click submits an authoritative transfer

- **GIVEN** a joined network client session with a chest panel open
- **WHEN** the player Shift-clicks (or left-clicks without a held cursor
  stack) a filled chest-grid slot
- **THEN** the game SHALL submit the authoritative container transfer command
  with the chest as the source endpoint
- **AND** the local mirror SHALL NOT be mutated in place.

### Requirement: Container click handling SHALL complete without error

No user gesture within a container panel SHALL abort the remainder of the
input-processing pass, and a completed interaction SHALL leave the UI's
recorded error state empty.

#### Scenario: A container gesture is fully processed

- **GIVEN** any of the container quick-move scenarios above
- **WHEN** the interaction is processed
- **THEN** the click handling pass SHALL run to completion
- **AND** the UI layer SHALL record no error for that pass
- **AND** the render pipeline SHALL report zero errors for the UI drawer
  during the interaction.
