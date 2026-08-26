# Pack Spawning Specification

## ADDED Requirements

### Requirement: Pack natural spawning is declarative

The pack system SHALL expose a bounded pure-data spawn-rule grammar. Packs SHALL NOT provide spawn callbacks, AI callbacks or arbitrary predicates.

#### Scenario: Valid rule stages

- **GIVEN** a rule referencing a supported non-boss enemy, built-in zone vocabulary, finite positive weight and valid optional biome/depth/time/progression constraints
- **WHEN** the owning pack set is staged
- **THEN** the rule SHALL be normalized into a deterministic compiled representation
- **AND** it SHALL become visible to the canonical `TC.EnemySpawn` authority only after atomic activation succeeds.

#### Scenario: Invalid vocabulary fails closed

- **GIVEN** a spawn rule containing an unknown zone, biome, time value, malformed depth, non-finite/negative weight, forbidden field or unsupported condition
- **WHEN** activation is staged
- **THEN** activation SHALL fail before live mutation
- **AND** no partial spawn rule SHALL remain registered.

### Requirement: Enemy references obey pack dependency policy

A spawn rule SHALL resolve enemy references during staging and SHALL NOT smuggle undeclared cross-pack dependencies.

#### Scenario: Same-pack enemy

- **GIVEN** a rule referencing an enemy declared by the same pack
- **WHEN** activation succeeds
- **THEN** the compiled rule SHALL point to the canonical committed runtime enemy identity.

#### Scenario: Dependency enemy

- **GIVEN** pack A declares pack B as a compatible dependency and references B's supported enemy
- **WHEN** both activate in resolved topological order
- **THEN** the reference MAY resolve according to documented policy.

#### Scenario: Undeclared cross-pack enemy

- **GIVEN** pack A references pack B's enemy without a declared dependency
- **WHEN** activation is staged
- **THEN** activation SHALL fail with a reference/dependency error.

#### Scenario: Boss machinery requested

- **GIVEN** a rule references an enemy whose AI/definition is classified as boss/privileged encounter machinery
- **WHEN** activation is staged
- **THEN** the rule SHALL be rejected unless a future explicit capability allows it
- **AND** W26 SHALL NOT widen boss lifecycle authority implicitly.

### Requirement: Spawn evaluation is deterministic

Pack natural spawning SHALL preserve authoritative replay for the same seed and command/input trace.

#### Scenario: Same seed and trace

- **GIVEN** two fresh realms with logically identical active packs, world seed and input/command trace
- **WHEN** natural spawning executes for the same number of fixed ticks
- **THEN** the selected pack/core spawn sequence and gameplay digest SHALL be identical.

#### Scenario: Rule ordering

- **GIVEN** multiple active packs with valid rules
- **WHEN** activation resolves dependencies and compiles spawn buckets
- **THEN** rule ordering SHALL be explicitly stable (for example topological pack order then manifest order)
- **AND** runtime SHALL NOT depend on incidental JavaScript object/Set insertion from unrelated operations.

### Requirement: Canonical spawn ecology remains authoritative

`TC.EnemySpawn` SHALL remain the owner of zone classification, placement and weighted selection.

#### Scenario: Underworld precedence

- **GIVEN** a player below the canonical underworld boundary with active pack rules
- **WHEN** `zoneOf`/spawn selection runs
- **THEN** existing underworld depth-first precedence SHALL remain intact.

#### Scenario: Blood Moon

- **GIVEN** a Blood Moon surface night
- **WHEN** spawn selection runs
- **THEN** existing Blood Moon replacement/rate semantics SHALL remain intact unless the declared W26 rule grammar explicitly defines compatible participation
- **AND** no pack callback may override the event lifecycle.

#### Scenario: Multiplayer anchor

- **GIVEN** multiple eligible server-authoritative players
- **WHEN** a spawn attempt chooses its anchor
- **THEN** the existing deterministic `TC.Targets`/`GameRng.spawn` multi-player policy SHALL remain in force
- **AND** joined clients SHALL not run their own spawn director.

### Requirement: Spawn-rule runtime cost is bounded

Spawn attempts SHALL NOT scan the entire pack registry or all manifest content per tick.

#### Scenario: Large valid rule set

- **GIVEN** a pack set near configured spawn-rule limits
- **WHEN** activation completes
- **THEN** rules SHALL be precompiled/indexed by relevant runtime classification
- **AND** each spawn attempt SHALL inspect only the applicable bounded bucket(s)
- **AND** benchmark evidence SHALL show no material unrelated fixed-tick regression.
