# Pack Content Specification

## ADDED Requirements

### Requirement: Declarative wall family

The pack manifest SHALL support a bounded pure-data wall family using stable namespaced identity and deterministic append-only runtime indices.

#### Scenario: Valid wall pack activates

- **GIVEN** a valid data pack declaring one wall with supported painter/color/drop metadata
- **WHEN** the pack set is staged and activated on a fresh session
- **THEN** the wall SHALL receive stable id `<packid>:<key>`
- **AND** its runtime wall index SHALL append after existing wall definitions
- **AND** all built-in wall indices SHALL remain unchanged
- **AND** registry validation SHALL pass.

#### Scenario: Wall gameplay uses canonical paths

- **GIVEN** an active pack wall and a valid associated wall item/recipe
- **WHEN** a player crafts, places and mines the wall
- **THEN** the operation SHALL use the existing crafting/PlaceWall/mining authorities
- **AND** world-region invalidation, save persistence and multiplayer replication SHALL occur through existing wall/world paths
- **AND** no pack-specific world mutation channel SHALL exist.

#### Scenario: Unsafe wall definition is rejected atomically

- **GIVEN** a multi-pack activation in which one wall uses an unknown painter, invalid reference, forbidden field or out-of-bound value
- **WHEN** activation is attempted
- **THEN** staging SHALL fail before partial live mutation
- **AND** the previously coherent active pack set, registry fingerprint and definition tables SHALL remain unchanged.

### Requirement: Standalone pack loot tables

The pack system SHALL support bounded standalone pure-data loot tables with canonical stable identity and evaluation through `TC.LootTables`.

#### Scenario: Loot table resolves pack items

- **GIVEN** a pack loot table referencing a valid item from the same pack or a declared dependency
- **WHEN** the pack activates
- **THEN** every item reference SHALL resolve during staging
- **AND** the table SHALL receive deterministic stable identity
- **AND** runtime rolls SHALL use `TC.LootTables` and `TC.GameRng`'s loot stream.

#### Scenario: Enemy references standalone table

- **GIVEN** a supported pack enemy referencing a valid standalone loot table
- **WHEN** the enemy dies through canonical combat
- **THEN** the referenced table SHALL be rolled exactly once for that death
- **AND** resulting items/currency SHALL enter the world through existing item/economy authorities.

#### Scenario: Existing inline drops remain compatible

- **GIVEN** a W25 manifest or built-in enemy using inline `drops`
- **WHEN** W26 code loads/activates it
- **THEN** behavior SHALL remain compatible
- **AND** W26 SHALL NOT require mass conversion to standalone tables.

#### Scenario: Cross-pack loot reference without dependency fails

- **GIVEN** pack A references a loot table or item owned by pack B but does not declare B as a dependency
- **WHEN** activation is staged
- **THEN** activation SHALL fail with a bounded actionable reference/dependency error
- **AND** no partial state SHALL commit.

### Requirement: Pack content remains non-executable

All W26 content families SHALL remain pure data.

#### Scenario: Function/hook injection attempt

- **GIVEN** a manifest containing a function-valued wall/loot field, callback, hook or executable payload
- **WHEN** it is provided or activated
- **THEN** it SHALL be rejected by the existing fail-closed security boundary
- **AND** no evaluator, script loader or dynamic execution path SHALL run it.

### Requirement: Zero-pack equivalence

Adding W26 family support SHALL NOT alter built-in identity or behavior when no packs are active.

#### Scenario: Empty W26-capable boot

- **GIVEN** a fresh boot with no active packs
- **WHEN** registry sync/validation completes
- **THEN** the registry fingerprint SHALL remain `1b1d7c15`
- **AND** built-in dense ids and gameplay SHALL remain W25-equivalent.
