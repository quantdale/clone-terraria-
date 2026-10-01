# Player Identity Lifecycle Specification

## Purpose

Defines the ownership and coherence of the authoritative player identity
registry across every world transition — world creation, save continuation,
hosting session start, session teardown, and return to title — so that no
player entity can outlive the world it belongs to and every consumer of
player identity agrees on the same live set.

## ADDED Requirements

### Requirement: A player identity SHALL NOT outlive the world it belongs to

When a new world is created or a saved world is continued, the player identity
registry SHALL contain no entry whose player entity belongs to a different
world, and every live local player in the new world SHALL be registered in the
registry.

#### Scenario: Starting a new world after a hosting session

- **GIVEN** a session that hosted a local multiplayer session and returned to
  the title screen
- **WHEN** a new world is started
- **THEN** the registry SHALL contain exactly one entry
- **AND** that entry's player SHALL be the same object as the active player
- **AND** no entry SHALL reference a player from the previous world
- **AND** the active player SHALL be the registry's designated primary.

#### Scenario: Continuing a saved world after a hosting session

- **GIVEN** a session that hosted a local multiplayer session and returned to
  the title screen
- **WHEN** a saved world is continued
- **THEN** the registry SHALL contain exactly one entry
- **AND** that entry's player SHALL be the same object as the active player
- **AND** no entry SHALL reference a player from the previous world.

#### Scenario: Creating a world through the headless entry point

- **GIVEN** any prior session state
- **WHEN** a world is created through the headless world-creation entry point
- **THEN** the registry SHALL be reset before the new player is constructed
- **AND** the resulting world SHALL have exactly one registered local player
  that is the active player.

### Requirement: The active player SHALL be simulated, and only registered players SHALL be simulated

Each simulation step SHALL advance every player the registry reports, and a
player that is not the active player object SHALL NOT be advanced in a session
that owns its own world.

#### Scenario: The active player responds to gravity in a solo world

- **GIVEN** a newly started single-player world
- **WHEN** the simulation is advanced for several fixed steps
- **THEN** the active player's position SHALL change under normal physics
- **AND** no other player entity SHALL be advanced.

#### Scenario: No discarded player from a previous world is advanced

- **GIVEN** a session that hosted, returned to title, and started a new world
- **WHEN** the simulation is advanced
- **THEN** the player that belonged to the previous world SHALL NOT be
  advanced.

### Requirement: Targeting SHALL resolve to the live local player in a solo session

The canonical target-selection policy SHALL resolve to the active player in a
session that owns its own world, and SHALL never resolve to a player from a
different world.

#### Scenario: Enemies target the live player after a session teardown

- **GIVEN** a session that hosted, returned to title, and started a new world
- **WHEN** the targeting policy resolves its anchor or nearest target
- **THEN** the resolved entity SHALL be the active player of the new world.

#### Scenario: Item pickup considers the live player

- **GIVEN** a session that hosted, returned to title, and started a new world
- **WHEN** item drops are magnetized toward players
- **THEN** only the active player of the new world SHALL attract drops.

### Requirement: Session teardown SHALL release identities for that session only

Tearing down a hosting session SHALL remove every identity created by that
session, and SHALL leave the registry in a state that a subsequent world
transition can safely reset or re-seat.

#### Scenario: All clients leave before the host quits

- **GIVEN** a hosting session whose only remote client has left
- **WHEN** the host tears the session down
- **THEN** the registry SHALL contain no remote entries
- **AND** the host's local primary SHALL be released with the session's world
  rather than retained for reuse in another world.

#### Scenario: A parked reconnect identity is released at teardown

- **GIVEN** a hosting session with a detached identity awaiting reconnect
- **WHEN** the session is torn down
- **THEN** that identity SHALL be removed
- **AND** its private region-consumer resources SHALL be released.

### Requirement: A transition entered with a foreign registry SHALL be diagnosable

If a world transition is entered while the registry still references a player
from a different world, the game SHALL restore coherence AND SHALL record a
diagnostic that the transition occurred, so the condition is observable rather
than silently corrected.

#### Scenario: Coherence restored and the repair is observable

- **GIVEN** a registry that still references a player from a different world
- **WHEN** a new world is started
- **THEN** the resulting world SHALL be fully coherent as specified above
- **AND** a diagnostic counter or event SHALL record that a stale-registry
  transition was repaired.
