# Pack Resource Accounting Specification

## Purpose

Defines how pack manifest and installed-store resource limits are measured and
reported, so that a stated byte cap is the cap that is actually enforced,
independent of the character repertoire used in a manifest.

## ADDED Requirements

### Requirement: Manifest size limits SHALL be measured in exact UTF-8 bytes

A manifest's size SHALL be measured as the number of UTF-8 bytes required to
represent it, and a manifest exceeding the per-manifest limit SHALL be rejected
on that measurement, independent of which characters it contains.

#### Scenario: An ASCII manifest at the limit is accepted

- **GIVEN** a manifest whose UTF-8 byte length is within the per-manifest limit
- **WHEN** it is provided
- **THEN** it SHALL pass the size check
- **AND** it SHALL proceed to structural and semantic validation.

#### Scenario: A non-ASCII manifest at the character-count limit is rejected

- **GIVEN** a manifest whose UTF-16 code-unit count is within the limit but
  whose UTF-8 byte length exceeds the limit
- **WHEN** it is provided
- **THEN** it SHALL be rejected as too large
- **AND** the rejection SHALL NOT depend on the manifest being ASCII.

#### Scenario: Multi-byte characters are counted at their true cost

- **GIVEN** two manifests of equal UTF-16 code-unit length, one ASCII and one
  using multi-byte characters
- **WHEN** each is measured
- **THEN** the multi-byte manifest SHALL measure strictly larger
- **AND** the difference SHALL equal the true UTF-8 size difference.

#### Scenario: A manifest at exactly the limit is accepted

- **GIVEN** a manifest whose UTF-8 byte length is exactly the limit
- **WHEN** it is provided
- **THEN** it SHALL be accepted.

### Requirement: Installed-store accounting SHALL be measured in exact UTF-8 bytes

The installed-manifest store SHALL account for per-manifest size and total size
in exact UTF-8 bytes, and SHALL reject an install or a load that would exceed
either limit on that measurement.

#### Scenario: An install that would exceed the total cap is rejected

- **GIVEN** an installed store close to the total byte cap
- **WHEN** a manifest is installed whose UTF-8 byte length would push the total
  over the cap
- **THEN** the install SHALL be rejected with a capacity reason
- **AND** the existing store SHALL remain unchanged.

#### Scenario: A single oversized manifest is rejected

- **GIVEN** a manifest whose UTF-8 byte length exceeds the per-manifest cap
- **WHEN** it is installed
- **THEN** the install SHALL be rejected with a size reason
- **AND** the existing store SHALL remain unchanged.

#### Scenario: A persisted store is re-evaluated consistently

- **GIVEN** a store that was persisted before this accounting rule
- **WHEN** it is loaded
- **THEN** its manifests SHALL be evaluated against the same UTF-8 byte measure
  used at install time
- **AND** the load SHALL degrade safely (bounded diagnostics) rather than
  throwing if the store is over budget.

### Requirement: Limits SHALL be reported truthfully

A size-limit rejection SHALL state the limit and the measured size in the same
unit, and any user-facing message about a limit SHALL state bytes.

#### Scenario: The rejection message uses bytes

- **GIVEN** a manifest rejected for exceeding the size limit
- **WHEN** the rejection is reported
- **THEN** the message SHALL state the limit in bytes
- **AND** the message SHALL state the measured size in bytes
- **AND** the message SHALL NOT describe the measurement as characters or as an
  approximate figure.

#### Scenario: A user-facing capacity message states the unit

- **GIVEN** a user-facing message reporting that a pack could not be installed
  because a storage limit was reached
- **WHEN** the message is rendered
- **THEN** it SHALL state the limit in bytes.

### Requirement: The limit values SHALL NOT change as a side effect of this correction

The per-manifest cap, the total-store cap, and the maximum installed-manifest
count SHALL retain their current values, so that the change corrects the
measurement rather than the policy.

#### Scenario: Existing documented caps still hold

- **WHEN** the corrected accounting is in place
- **THEN** the per-manifest cap SHALL remain 256 KiB
- **AND** the total-store cap SHALL remain 4 MiB
- **AND** the maximum installed-manifest count SHALL remain 64.
