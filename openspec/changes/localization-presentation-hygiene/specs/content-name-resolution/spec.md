# Content-Name Resolution Specification

## Purpose

Establishes that every user-visible content name resolves through the
localization catalog, that frozen identity metadata is never used as display
text, and that display metadata is never used as runtime identity — so that
localization is complete, correct, and robust to content whose names collide.

## ADDED Requirements

### Requirement: User-visible content names SHALL resolve through the catalog

Any user-visible name for a tile, wall, item, enemy, NPC, buff, biome, or
station SHALL be resolved through the canonical content-name resolution path,
never read directly from the content definition's frozen name field.

#### Scenario: Debug overlays show resolved names

- **GIVEN** a debug overlay that reports the tile under the cursor
- **WHEN** it is rendered
- **THEN** the tile name SHALL be resolved through the catalog
- **AND** the name SHALL reflect the active locale.

#### Scenario: Item floaters show resolved names

- **GIVEN** a floater that reports a caught or granted item
- **WHEN** it is rendered
- **THEN** the item name SHALL be resolved through the catalog
- **AND** the quantity SHALL be presented as a formatted message rather than
      assembled by concatenating a label with a value.

#### Scenario: A missing catalog entry degrades to the stable id

- **GIVEN** content whose catalog entry is missing
- **WHEN** its name is resolved for display
- **THEN** the resolution SHALL fall back to the content's stable identity
- **AND** the missing entry SHALL be reported through the localization
      diagnostics
- **AND** the display SHALL NOT read the definition's frozen name field.

### Requirement: Player-facing messages SHALL NOT be assembled by concatenation

A user-facing message SHALL be rendered from a catalog template with named
interpolation, not by concatenating fragments and values, and not by appending a
literal English sentence to a content name.

#### Scenario: Boss-defeat announcements are templated

- **GIVEN** a boss is defeated
- **WHEN** the announcement is shown
- **THEN** the message SHALL be produced from a catalog template with named
      variables
- **AND** the boss name SHALL be substituted as a variable
- **AND** the message SHALL follow the active locale.

#### Scenario: The no-catalog path is explicit

- **GIVEN** an environment where the catalog runtime is unavailable
- **WHEN** the boss-defeat announcement is produced
- **THEN** the behavior SHALL be an explicitly documented degraded path
- **AND** it SHALL NOT produce a half-translated sentence built by
      concatenating a content name with a literal English clause.

### Requirement: Display metadata SHALL NOT be used as runtime identity

Any system that must distinguish one entity, shot, or record from another SHALL
use a stable identity — the entity reference or a stable type id — and SHALL NOT
use a display name to establish or match that identity.

#### Scenario: Two same-named entities do not share identity

- **GIVEN** two distinct entities that share the same display name
- **WHEN** one entity's tracked projectiles are cleared
- **THEN** the other entity's tracked projectiles SHALL NOT be cleared
- **AND** the clearing SHALL be determined solely by stable identity.

#### Scenario: A same-named collision with built-in content does not leak

- **GIVEN** an entity whose display name equals a built-in entity's display name
- **WHEN** the pack-provided entity fires a tracked projectile
- **THEN** that projectile SHALL NOT be attributed to the built-in entity
- **AND** clearing the built-in entity's projectiles SHALL NOT remove the
      pack-provided entity's projectile.

#### Scenario: Hostile-shot attribution survives identifier recycling

- **GIVEN** a tracked projectile whose underlying pool slot is later recycled
  and reused for a different projectile
- **WHEN** the tracking bookkeeping is evaluated
- **THEN** the recycled slot SHALL be distinguished from the originally tracked
      projectile using stable identity
- **AND** stale tracking entries SHALL be discarded.

### Requirement: The rule SHALL be enforced automatically

A repository check SHALL fail when a presentation path reads a content
definition's frozen name field, or when user-facing text is assembled by
concatenation, outside the sanctioned content-name resolution helpers.

#### Scenario: A new raw name read fails the check

- **GIVEN** a change that adds a direct read of a content definition's name
      field in a presentation path
- **WHEN** the localization check runs
- **THEN** the check SHALL fail
- **AND** the report SHALL name the file and location.

#### Scenario: The sanctioned helpers are not flagged

- **GIVEN** the content-name resolution helpers themselves
- **WHEN** the localization check runs
- **THEN** their last-resort fallback SHALL NOT be flagged
- **AND** the rest of the codebase SHALL produce no finding.

#### Scenario: Registry identity remains unchanged

- **WHEN** this work is complete
- **THEN** the registry fingerprint SHALL be unchanged
- **AND** the existing localization identity guards SHALL still pass
- **AND** the existing catalog content names SHALL still resolve.
