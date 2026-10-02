# Repository Quality Gates Specification

## Purpose

Defines the automated static-analysis and security/stability checks that must
pass before a change is considered releasable, and their integration into the
local validation pipeline and continuous-integration workflow, so that classes
of defect such as undefined identifiers, duplicate members, and unseeded
replicated randomness are caught by the gate rather than by manual review.

## ADDED Requirements

### Requirement: Undefined identifiers SHALL be a gate failure

Static analysis over the shipped source SHALL fail when a source file
references an identifier that is neither declared locally, provided by the host
environment, nor an intentional member of the project's global namespace.

#### Scenario: An undefined function call fails the gate

- **GIVEN** a source file that calls a function which is not declared anywhere
  in the project and is not a host or built-in global
- **WHEN** the static-analysis gate runs
- **THEN** the gate SHALL fail
- **AND** the report SHALL name the file and the offending location.

#### Scenario: The project's global namespace does not produce false positives

- **GIVEN** a source file that assigns to or reads from the project's global
  namespace, or attaches an API to it
- **WHEN** the static-analysis gate runs
- **THEN** the global namespace usage SHALL NOT be reported as an undefined
  identifier.

#### Scenario: Intentional host globals do not produce false positives

- **GIVEN** a source file that uses standard host environment globals such as
  `window`, `document`, `console`, `performance`, or standard built-in objects
- **WHEN** the static-analysis gate runs
- **THEN** those usages SHALL NOT be reported as undefined identifiers.

### Requirement: Duplicate members with divergent bodies SHALL be a gate failure

Static analysis SHALL fail when a class or object literal declares the same
member name more than once, because the later declaration silently overrides
the earlier one and the earlier body becomes unreachable.

#### Scenario: A duplicate class method fails the gate

- **GIVEN** a class that declares the same method name in two separate method
  definitions with differing bodies
- **WHEN** the static-analysis gate runs
- **THEN** the gate SHALL fail
- **AND** the report SHALL name the file and both declaration locations.

#### Scenario: A legitimate repeated-shape declaration does not fail the gate

- **GIVEN** a source file that defines two distinct functions sharing a name in
  disjoint, non-overriding scopes, or a repeated property assignment with
  intentional override semantics
- **WHEN** the static-analysis gate runs
- **THEN** the gate SHALL NOT fail, provided the duplication is not a silent
  class/object member override.

### Requirement: Unseeded randomness in replicated-truth modules SHALL be a gate failure

The static gate SHALL fail when a module documented as producing replicated
world state draws ambient randomness instead of routing through the project's
seeded RNG authority, so the documented gameplay-randomness rule is machine
enforced rather than convention.

#### Scenario: Ambient randomness in a replicated-truth module fails the gate

- **GIVEN** a module that creates world state (loot, spawns, drops, AI
  decisions) and that draws ambient randomness on a path that affects that
  state
- **WHEN** the static-analysis gate runs
- **THEN** the gate SHALL fail and SHALL identify the module and location.

#### Scenario: Presentation-only randomness does not fail the gate

- **GIVEN** a call site that uses ambient randomness solely for presentation,
  such as particles, visual blink timers, or visual trails
- **WHEN** the static-analysis gate runs
- **THEN** that call site SHALL NOT fail the gate.

#### Scenario: A gameplay draw in a mixed file fails the gate

- **GIVEN** a file that contains both an allowed presentation or seed-selection
  call and another ambient draw that affects world state
- **WHEN** the static-analysis gate runs
- **THEN** the world-state draw SHALL fail the gate
- **AND** the allowed call site SHALL NOT exempt the rest of the file.

#### Scenario: Ambient randomness in a seed-selection entry point is allowed

- **GIVEN** a call site whose sole purpose is to choose a brand-new random seed
  or cosmetic variation that is not part of replicated truth
- **WHEN** the static-analysis gate runs
- **THEN** that call site SHALL NOT fail the gate.

### Requirement: The pack security fuzz harness SHALL run in the release gate

The deterministic adversarial fuzzing of the pack security boundary SHALL be
part of the local validation pipeline and the continuous-integration workflow,
with a bounded default round count so the gate remains practical.

#### Scenario: The fuzz harness runs as part of validation

- **WHEN** the validation pipeline runs
- **THEN** the pack security fuzz harness SHALL execute
- **AND** a non-zero exit or an escape report SHALL fail the pipeline.

#### Scenario: A regression in the pack security boundary is caught

- **GIVEN** a change that would let a malformed or malicious pack manifest be
  accepted, or that would let a rejected manifest mutate live tables
- **WHEN** the fuzz harness runs
- **THEN** the harness SHALL report the escape and the pipeline SHALL fail.

### Requirement: The multiplayer soak harness SHALL run in the release gate

The multiplayer soak harness SHALL be part of the validation pipeline and
continuous integration, with bounded duration, so long-session identity,
replication, and teardown regressions are detected automatically.

#### Scenario: The soak runs as part of validation

- **WHEN** the validation pipeline runs
- **THEN** the multiplayer soak harness SHALL execute
- **AND** a failure or leak report SHALL fail the pipeline.

#### Scenario: A teardown leak is caught

- **GIVEN** a run that finishes with a registered player identity, a detached
  reconnect record, or an open connection after session teardown
- **WHEN** the soak gate runs
- **THEN** the gate SHALL exit non-zero
- **AND** a summary printed with a successful exit SHALL NOT count as a pass.

### Requirement: The gate SHALL be trustworthy and documented

Every gate SHALL be runnable locally with a documented command, SHALL have a
demonstrated near-zero false-positive rate on the current codebase, and SHALL
document how to interpret and triage its output. A gate that produces
unactionable noise SHALL be fixed or removed rather than tolerated.

#### Scenario: The current codebase passes the static gate cleanly

- **GIVEN** the repository at the point the gate is enabled
- **WHEN** the static-analysis gate runs
- **THEN** it SHALL report no undefined identifiers
- **AND** it SHALL report no duplicate class or object members
- **AND** the known true positives discovered during enablement (such as any
  remaining duplicate method) SHALL have been fixed, not suppressed.

#### Scenario: The gate is documented

- **WHEN** a contributor reads the contributor documentation
- **THEN** each gate SHALL be listed with the exact local command
- **AND** common failure causes and their fixes SHALL be documented.
