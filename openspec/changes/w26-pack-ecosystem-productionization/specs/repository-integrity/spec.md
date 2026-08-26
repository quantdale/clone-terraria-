# Repository Integrity Specification

## ADDED Requirements

### Requirement: Exhaustive audit precedes W26 implementation

The executor SHALL reconcile and inspect the complete tracked repository before making architectural changes.

#### Scenario: Every tracked text/code/config path accounted for

- **GIVEN** the repository at the actual W26 starting HEAD
- **WHEN** WS0 completes
- **THEN** every tracked text/source/test/tool/config file SHALL be represented in a durable audit coverage ledger
- **AND** binary assets SHALL be inventoried/referenced without being misrepresented as source logic
- **AND** all discovered Critical/High findings SHALL have an explicit disposition.

#### Scenario: Baseline contradicts planner assumptions

- **GIVEN** a fresh local `npm run validate` fails before W26 edits
- **WHEN** the failure is reproduced
- **THEN** the executor SHALL classify whether the defect is pre-existing/environmental/current-head drift
- **AND** SHALL update the evidence ledger before proceeding
- **AND** SHALL NOT falsely attribute it to W26 or hide it by skipping the gate.

### Requirement: Zero-pack compatibility remains pinned

W26 SHALL preserve the W25 no-pack identity and behavior.

#### Scenario: Registry fingerprint

- **GIVEN** a fresh no-pack boot
- **WHEN** all built-in modules, late table extensions and registry validation finish
- **THEN** `TC.Registry.fingerprint()` SHALL equal `1b1d7c15`.

#### Scenario: Existing saves

- **GIVEN** a pre-W26 no-pack or W25-compatible save
- **WHEN** it is loaded under W26 with the matching required pack set
- **THEN** load SHALL retain existing format/provider semantics
- **AND** no W26 installed-manifest feature SHALL mutate the save payload merely by being present.

### Requirement: Script/boot order remains deterministic across hosts

The browser, headless loader, build verifier and dedicated server SHALL agree on production script order and active-content finalization.

#### Scenario: New module added

- **GIVEN** W26 introduces a new production module such as a pack store
- **WHEN** it is added to the application
- **THEN** `index.html` SHALL remain the authoritative local script order used by derived loaders/build tooling where that repository contract applies
- **AND** syntax/build verification SHALL fail if the module is missing from production distribution
- **AND** activation SHALL not run before late built-in content extensions are visible.

### Requirement: Version semantics are explicit and tested

The repository SHALL define which version identifies the application release, pack compatibility, save metadata and network wire format.

#### Scenario: User-visible application version

- **GIVEN** the title UI renders the application version
- **WHEN** W26 completes
- **THEN** the displayed value SHALL intentionally correspond to the documented application/release version source
- **AND** it SHALL not remain an unexplained stale `0.1.0` while package metadata reports `0.9.0`.

#### Scenario: Pack compatibility version

- **GIVEN** an existing valid W25 pack using `requires.game`
- **WHEN** W26 reconciles version constants
- **THEN** the pack SHALL remain compatible unless an intentional compatibility break is documented and tested
- **AND** version cleanup SHALL not silently change range semantics.

#### Scenario: Protocol independence

- **GIVEN** application/release version changes without a wire-incompatible protocol change
- **WHEN** W26 completes
- **THEN** `TC.NetProto.VERSION` SHALL remain independently governed.

### Requirement: CI-equivalent validation is terminal

W26 SHALL not be considered complete until the full current repository validation gate succeeds at final HEAD.

#### Scenario: Narrow suites pass but browser fails

- **GIVEN** unit/Node suites are green and a browser journey fails
- **WHEN** terminal validation is evaluated
- **THEN** W26 SHALL remain incomplete
- **AND** the browser failure SHALL be root-caused or explicitly blocked rather than ignored.

#### Scenario: Flaky retry

- **GIVEN** a test passes only after retry
- **WHEN** the executor considers campaign completion
- **THEN** the retry SHALL be documented and the source of flakiness investigated
- **AND** a clean proof run SHALL be required for completion.

### Requirement: 12-hour campaign time is productive, not artificial

The executor SHALL use the requested long campaign budget for implementation and hardening rather than idle delay.

#### Scenario: Mandatory work finishes early

- **GIVEN** all mandatory W26 capabilities are green before the 12-hour productive budget is exhausted
- **WHEN** remaining budget exists
- **THEN** the executor SHALL proceed through the ordered hardening queue (fuzz, store stress, reconnect/soak, save recovery, pseudo-locale, documentation integrity, optional NPC/shop investigation)
- **AND** SHALL NOT insert sleeps or meaningless loops merely to extend elapsed time.

#### Scenario: Harness session limit interrupts work

- **GIVEN** the active agent/harness cannot sustain one continuous 12-hour process
- **WHEN** interruption/session rollover is required
- **THEN** the executor SHALL persist an exact ledger, commit/push coherent progress and resume from the first incomplete task on the next `goal` continuation
- **AND** SHALL NOT redo completed work.
