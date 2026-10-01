# Replicated-Truth Determinism Specification

## Purpose

Establishes the rule, and the proofs, that every runtime draw which can affect
replicated world state originates from the canonical seeded RNG authority
rather than from ambient nondeterminism, so that two independent authoritative
realms replaying the same seed and command trace converge to the same world.

## ADDED Requirements

### Requirement: Loot draws that create world state SHALL use the seeded RNG authority

Any runtime decision whose outcome becomes persistent or replicated world state
— including the number of rolls, the entry selected, and the stack count
produced — SHALL draw from the canonical seeded RNG authority. Presentation-only
randomness MAY use ambient nondeterminism.

#### Scenario: Pot-break loot is drawn from the seeded authority

- **GIVEN** a world with a breakable pot tile and a seeded RNG authority
- **WHEN** the pot is broken through the canonical break path
- **THEN** the number of rolls, the selected loot entries, and the stack counts
  SHALL each be drawn from the canonical seeded RNG authority
- **AND** the spawned drops SHALL enter the world through the canonical drop
  authority with seeded scatter physics.

#### Scenario: The draw is reproducible from the stream state

- **GIVEN** a seeded RNG authority restored to a known stream state
- **WHEN** the same pot-break roll is executed twice from that identical state
- **THEN** both executions SHALL select the same entries and produce the same
  stack counts.

#### Scenario: A missing RNG authority degrades without throwing

- **GIVEN** an environment where the canonical seeded RNG authority is
  unavailable
- **WHEN** a pot is broken
- **THEN** the roll SHALL complete using a non-replicated fallback source
- **AND** no error SHALL be raised and the normal loot distribution SHALL still
  be produced.

### Requirement: Replay convergence SHALL cover loot that creates world state

The authoritative replay proof SHALL include every replicated-truth draw it
claims to cover, and SHALL fail if any covered draw diverges between two
independent realms replaying the same seed and trace.

#### Scenario: Two realms converge across pot breaks

- **GIVEN** two independent authoritative realms created with the same seed
- **WHEN** both realms execute the same recorded trace that includes combat
  kills, loot rolls, and pot breaks
- **THEN** the two realms SHALL agree on the resulting enemy state
- **AND** the two realms SHALL agree on the resulting item-drop state
- **AND** the two realms' seeded RNG authority digests SHALL match.

#### Scenario: A diverging draw fails the proof

- **GIVEN** a covered draw that is not sourced from the seeded authority
- **WHEN** the replay proof runs
- **THEN** the proof SHALL fail
- **AND** the failure SHALL identify the diverging state.

### Requirement: Randomness classification SHALL be accurate in source

Code comments that classify a draw as worldgen-only, presentation-only, or
replicated truth SHALL match the actual classification of that draw, so a future
reader is not misled about which invariant a call site upholds.

#### Scenario: A replicated-truth draw is not labelled worldgen-only

- **GIVEN** a draw that affects replicated world state
- **WHEN** its source is annotated
- **THEN** the annotation SHALL identify it as a gameplay/replicated-truth draw
- **AND** it SHALL NOT claim the draw is exempt because it is not worldgen.
