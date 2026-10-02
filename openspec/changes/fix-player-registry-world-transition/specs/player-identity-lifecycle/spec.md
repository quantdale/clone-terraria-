# Player Identity Lifecycle Specification

## Purpose

Defines the ownership and coherence of the authoritative player identity
registry across world creation, save continuation, hosting, teardown, and
return to title, so that no player entity is simulated after its world is
gone and every consumer agrees on the live set.

## ADDED Requirements

### Requirement: A player identity SHALL NOT outlive the world it belongs to

When world construction proceeds, the player identity registry SHALL be reset
before the new player object is used, so no entry from another world remains.
A continue that is refused before world construction SHALL NOT reset the
registry and SHALL NOT mutate the stored save.

Browser world creation and a successful continue SHALL then register exactly
one local primary, and that entry's player SHALL be the active player.
Headless world creation SHALL reset stale identities and SHALL NOT register a
local primary merely because it constructed a player object. Dedicated-server
first-remote identity assignment SHALL remain unchanged unless a local primary
is explicitly attached.

Registering the same player object again SHALL be idempotent: the existing
entry and id SHALL be returned, and a second entry SHALL NOT be created.

#### Scenario: Starting a new world after a hosting session

- **GIVEN** a session that hosted a local multiplayer session and returned to
  the title screen
- **WHEN** a new world is started through the browser new-world path
- **THEN** the registry SHALL contain exactly one entry
- **AND** that entry's player SHALL be the same object as the active player
- **AND** no entry SHALL reference a player from the previous world
- **AND** the active player SHALL be the registry's designated primary.

#### Scenario: Continuing a saved world after a hosting session

- **GIVEN** a session that hosted a local multiplayer session and returned to
  the title screen
- **WHEN** a saved world is continued and pack classification allows the load
- **THEN** the registry SHALL contain exactly one entry
- **AND** that entry's player SHALL be the same object as the active player
- **AND** no entry SHALL reference a player from the previous world.

#### Scenario: A refused continue does not destroy the current title state

- **GIVEN** a stored save that pack classification refuses
- **WHEN** continue is attempted
- **THEN** world construction SHALL NOT proceed
- **AND** the stored save SHALL remain untouched
- **AND** the registry reset for the new world SHALL NOT run.

#### Scenario: Headless world creation does not invent a local primary

- **GIVEN** any prior session state
- **WHEN** a world is created through the headless world-creation entry point
  without an explicit local-primary attachment
- **THEN** the registry SHALL be reset before the new player object is used
- **AND** the registry SHALL NOT contain a local primary created only by that
  construction
- **AND** the first subsequently attached remote SHALL still receive the first
  remote identity it receives today.

#### Scenario: Attaching the already-registered host player is idempotent

- **GIVEN** a browser new world whose active player is already the sole local
  primary
- **WHEN** the host session attaches that same player object as its local
  primary
- **THEN** the registry SHALL still contain exactly one entry
- **AND** that entry SHALL keep its existing id
- **AND** the player SHALL NOT be registered a second time.

### Requirement: The active solo player SHALL be simulated, and a discarded player SHALL NOT be simulated

In a solo session that owns its world, each simulation step SHALL advance the
active player. A player object from a previous world SHALL NOT be advanced.
This requirement SHALL NOT forbid a live hosting session from simulating its
remotely attached players.

#### Scenario: The active player responds to gravity in a solo world

- **GIVEN** a newly started single-player world
- **WHEN** the simulation is advanced for several fixed steps
- **THEN** the active player's position SHALL change under normal physics
- **AND** no player object from a previous world SHALL be advanced.

#### Scenario: No discarded player from a previous world is advanced

- **GIVEN** a session that hosted, returned to title, and started a new world
- **WHEN** the simulation is advanced
- **THEN** the player that belonged to the previous world SHALL NOT be
  advanced.

### Requirement: Targeting SHALL resolve to the live local player in a solo session

The canonical target-selection policy SHALL resolve to the active player in a
solo session that owns its world, and SHALL never resolve to a player from a
different world.

#### Scenario: Enemies target the live player after a session teardown

- **GIVEN** a session that hosted, returned to title, and started a new world
- **WHEN** the targeting policy resolves its anchor or nearest target
- **THEN** the resolved entity SHALL be the active player of the new world.

#### Scenario: Item pickup considers the live player

- **GIVEN** a session that hosted, returned to title, and started a new world
- **WHEN** item drops are magnetized toward players
- **THEN** only the active player of the new world SHALL attract drops.

### Requirement: Session teardown SHALL NOT discard the player before the host save

Tearing down a hosting session SHALL remove every remote identity and every
parked reconnect identity created by that session, including their private
region-consumer resources. It SHALL NOT clear, replace, or null the active
player object before the host quit path saves. The local primary registry
entry SHALL NOT be reused as the player of a subsequent world; the next
world-construction reset removes it after that save.

#### Scenario: Host quit still saves the host player

- **GIVEN** a hosting session whose host player has unsaved progress
- **WHEN** the host quits to the title screen
- **THEN** the save SHALL run while the active player object still represents
  that host player
- **AND** the saved character SHALL NOT be empty because teardown nulled the
  player.

#### Scenario: Remotes and parked identities die with the session

- **GIVEN** a hosting session with a remote client or a detached identity
  awaiting reconnect
- **WHEN** the host tears the session down
- **THEN** the registry SHALL contain no remote entries
- **AND** the parked identity SHALL be removed
- **AND** its private region-consumer resources SHALL be released.

#### Scenario: A retained same-world primary is not reused in the next world

- **GIVEN** a host quit that left the local primary registered for the world
  just saved
- **WHEN** a new world is subsequently started
- **THEN** that retained entry SHALL be removed by the world-construction reset
- **AND** it SHALL NOT be the simulated player of the new world.

### Requirement: A transition entered with a foreign registry SHALL be diagnosable

If world construction finds a registry that still references a player from a
different world, the game SHALL restore coherence AND SHALL record a
diagnostic that the stale registry was repaired.

#### Scenario: Coherence restored and the repair is observable

- **GIVEN** a registry that still references a player from a different world
- **WHEN** a new world is started
- **THEN** the resulting world SHALL be coherent as specified above
- **AND** a diagnostic counter or event SHALL record that a stale-registry
  transition was repaired.
