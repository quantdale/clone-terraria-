# Pack Installation Specification

## ADDED Requirements

### Requirement: Installed manifest persistence is a separate authority

The application SHALL persist user-installed pack manifests in one versioned bounded store independent of `TC.Settings` and world saves.

#### Scenario: Valid install survives reload

- **GIVEN** valid JSON manifest bytes within all limits
- **WHEN** the user installs the manifest through production UX
- **THEN** the manifest SHALL be validated through the same `TC.Packs` boundary used by build-provided packs
- **AND** only validated pure-data source SHALL be persisted
- **AND** a later page reload SHALL provide the installed manifest before active-pack activation.

#### Scenario: Corrupt store cannot break boot

- **GIVEN** corrupt, truncated or unsupported installed-store data in localStorage
- **WHEN** the application boots
- **THEN** boot SHALL degrade safely without executing/providing corrupt data
- **AND** the user SHALL receive bounded diagnostics where appropriate
- **AND** built-in no-pack play SHALL remain available.

### Requirement: Installation is bounded

Installed source persistence SHALL enforce explicit count and byte limits.

#### Scenario: Oversize manifest

- **GIVEN** a manifest whose serialized bytes exceed the allowed per-manifest limit
- **WHEN** import is attempted
- **THEN** it SHALL be rejected before persistence
- **AND** the prior installed store SHALL remain unchanged.

#### Scenario: Store quota exceeded

- **GIVEN** otherwise-valid manifests whose combined persisted size would exceed the configured store cap
- **WHEN** another install/update is attempted
- **THEN** it SHALL fail atomically with an actionable quota error
- **AND** existing installed manifests SHALL remain intact.

### Requirement: Duplicate/update behavior is explicit

The installed store SHALL never silently replace different content under the same pack id.

#### Scenario: Identical re-import

- **GIVEN** an installed manifest and a logically/content-identical re-import with the same id/digest
- **WHEN** import is attempted
- **THEN** the operation SHALL be idempotent
- **AND** no duplicate entry SHALL be created.

#### Scenario: Same id, different content

- **GIVEN** an installed manifest and new valid content with the same id but a different digest/version
- **WHEN** import is attempted
- **THEN** the UI/API SHALL require an explicit update/replace action
- **AND** it SHALL NOT mutate a committed active session in place.

### Requirement: Export and removal

Users SHALL be able to export installed manifests and remove manifests that are safe to uninstall.

#### Scenario: Export roundtrip

- **GIVEN** an installed manifest
- **WHEN** it is exported and imported into a fresh store
- **THEN** the resulting validated logical manifest SHALL have the same canonical digest/identity.

#### Scenario: Remove inactive pack

- **GIVEN** an installed pack that is not part of the committed active gameplay set
- **WHEN** the user removes it
- **THEN** its installed source SHALL be deleted without changing other entries.

#### Scenario: Remove active pack

- **GIVEN** an installed pack that is part of the current committed gameplay set
- **WHEN** the user attempts removal
- **THEN** the application SHALL refuse in-session invalidation or require a fresh-session deactivation flow
- **AND** dense content identity SHALL NOT be shifted in the live world.

### Requirement: Browser-imported resource references are honest

The browser SHALL NOT pretend external resource files referenced by imported JSON are available when their bytes were not installed.

#### Scenario: Unmaterializable resource path

- **GIVEN** a browser-imported JSON manifest referencing a non-embedded resource file
- **WHEN** the import cannot materialize that file through a supported mechanism
- **THEN** import SHALL fail clearly or classify the resource form unsupported
- **AND** activation SHALL NOT proceed with silently missing assets.

### Requirement: Pack management UI is localized and production-real

The title-screen pack management flow SHALL expose install/export/remove/activate status using `TC.Localization` and real production APIs.

#### Scenario: Pseudo-locale stress

- **GIVEN** the development pseudo-locale is active
- **WHEN** the pack management panel displays W26 actions/errors
- **THEN** all W26 user-facing strings SHALL resolve through localization
- **AND** controls SHALL remain usable at supported viewport sizes.
