# Pack Dependency Semantics Delta Specification

## Context

W25 accepts `optional.packs` metadata and normalizes it into `optionalDeps`, but the audited implementation does not currently give that metadata an explicit activation/resolution contract. W26 MUST remove this semantic ambiguity rather than carrying accepted control metadata whose effect is unclear.

This delta is intentionally narrow and supplements the existing W26 proposal/design/tasks. It does not require optional dependencies to auto-activate.

## ADDED Requirements

### Requirement: Optional pack dependencies SHALL have explicit deterministic semantics

The pack runtime SHALL define, document, and test the meaning of `optional.packs` before W26 is complete.

Unless implementation evidence demonstrates a safer/better contract, use the following semantics:

1. Required dependencies continue to join the requested active closure automatically according to the existing W25 contract.
2. An optional dependency SHALL NOT auto-activate merely because its source is installed or provided.
3. If an optional dependency is already present in the requested/required active closure, its declared version range SHALL be validated.
4. An active optional dependency SHALL participate in deterministic dependency ordering before its depender where dependency-sensitive compilation/reference resolution requires that order.
5. If the optional dependency is absent from the active closure, absence SHALL be valid and SHALL NOT alter activation order, gameplay digest, content digest, stable IDs, dense indices, save compatibility, or multiplayer identity.
6. A pack content reference that resolves only through an inactive optional dependency SHALL fail semantic/reference validation rather than silently activating that dependency or degrading to a missing/default definition.
7. Optional dependency semantics SHALL be identical in browser activation, headless tests, dedicated-host activation, save classification, and multiplayer identity.

If the executor chooses a different contract, it MUST be documented in the W26 design/handoff and MUST preserve fail-closed validation, deterministic identity, installed-vs-active separation, and explicit author intent.

#### Scenario: Optional dependency is installed/provided but not selected

- **GIVEN** pack `alpha` declares optional dependency `beta`
- **AND** both source manifests are installed/provided
- **AND** only `alpha` is requested and no required dependency pulls `beta` into the active closure
- **WHEN** W26 resolves the active graph
- **THEN** `beta` does not auto-activate
- **AND** `beta` contributes no gameplay content, Registry entries, dense indices, spawn rules, loot tables, wall definitions, localization activation, save identity, or network gameplay identity.

#### Scenario: Optional dependency is already active and compatible

- **GIVEN** `alpha` declares `optional.packs.beta = ">=1.2 <2"`
- **AND** `beta@1.5.0` is independently part of the requested/required active closure
- **WHEN** activation resolves
- **THEN** the optional version range is validated successfully
- **AND** dependency-sensitive ordering is deterministic
- **AND** equivalent request/provide/install orders produce the same active order and digests.

#### Scenario: Optional dependency is active but version-incompatible

- **GIVEN** `alpha` declares an optional range for `beta`
- **AND** `beta` is active but its version falls outside that range
- **WHEN** activation resolves
- **THEN** activation fails before live mutation
- **AND** the previous committed pack/runtime state remains unchanged.

#### Scenario: Optional dependency is absent

- **GIVEN** `alpha` declares optional `beta`
- **AND** `beta` is absent from the active closure
- **WHEN** `alpha` does not reference any content that requires `beta`
- **THEN** `alpha` may activate normally
- **AND** absence of `beta` is not itself an error.

#### Scenario: Content references inactive optional dependency

- **GIVEN** `alpha` declares optional `beta`
- **AND** `beta` is not active
- **AND** an `alpha` wall/item/enemy/recipe/loot/spawn declaration references `beta:some_id`
- **WHEN** semantic/reference validation runs
- **THEN** activation fails before commit
- **AND** the resolver does not auto-enable `beta`
- **AND** the reference does not degrade to a fallback or unknown runtime ID.

### Requirement: Optional metadata schema SHALL fail closed

`optional` and `optional.packs` SHALL use explicit field allowlists for the applicable manifest schema version.

Unknown control fields SHALL NOT be silently accepted or ignored. Prototype-pollution keys and malformed version ranges SHALL continue to be rejected before mutation.

#### Scenario: Unknown optional field

- **GIVEN** a manifest includes `optional: { packs: {}, magicMode: true }`
- **WHEN** structural validation runs
- **THEN** the manifest is rejected for an unknown `optional` field
- **AND** no runtime/store state is mutated.

#### Scenario: Prototype-pollution key under optional dependencies

- **GIVEN** imported JSON attempts `__proto__`, `prototype`, or `constructor` pollution inside the optional dependency structure
- **WHEN** pack safety validation runs
- **THEN** the manifest is rejected before normalization/activation.

### Requirement: Optional-dependency behavior SHALL be covered by identity and rollback tests

W26 tests SHALL prove that optional dependency presence/absence cannot create order-dependent identity and that an optional-dependency validation failure rolls back atomically.

#### Scenario: Equivalent graph order invariance

- **GIVEN** the same semantic active graph containing `alpha` and compatible optional `beta`
- **WHEN** manifests are provided/installed/requested in different equivalent orders
- **THEN** resolved active order, Registry fingerprint, gameplay/content digests, wall/loot/spawn compiled state, and save/network pack metadata are identical.

#### Scenario: Failure leaves no partial optional content

- **GIVEN** an activation stages new W26 content
- **AND** optional dependency validation/reference resolution fails before final commit
- **WHEN** rollback completes
- **THEN** all gameplay tables, Registry entries/aliases, localization fragments, compiled spawn indexes, loot-table state, and pack active identity match the pre-attempt state exactly.

## Completion evidence

The W26 handoff SHALL record:

- the chosen optional dependency contract;
- tests covering absent/present/compatible/incompatible/reference/order cases;
- whether any manifest schema version changed;
- proof that installed-but-inactive optional sources do not affect gameplay identity;
- exact rollback/determinism evidence for this requirement.
