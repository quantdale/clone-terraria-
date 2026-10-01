# Persistence Reliability Specification

## Purpose

Defines how persistence write outcomes are recorded, classified, and reported to
the player so that a failing or full storage backend produces an actionable,
visible signal rather than silent, repeating progress loss.

## ADDED Requirements

### Requirement: Persistence outcomes SHALL be recorded

The save layer SHALL maintain bounded counters covering attempted writes,
successful writes, failed writes, and the most recent failure reason, and SHALL
expose them through an observability surface consistent with the rest of the
project's subsystems.

#### Scenario: A successful write is recorded

- **GIVEN** a live world
- **WHEN** a save write succeeds
- **THEN** the attempted-write counter SHALL increase by one
- **AND** the successful-write counter SHALL increase by one
- **AND** the failed-write counter SHALL not change.

#### Scenario: A failed write is recorded with a reason

- **GIVEN** a live world
- **WHEN** a save write fails
- **THEN** the attempted-write counter SHALL increase by one
- **AND** the failed-write counter SHALL increase by one
- **AND** the most-recent failure reason SHALL be set to a classified reason
- **AND** the counters SHALL be readable through the observability surface.

#### Scenario: Counters are bounded and do not grow without limit

- **GIVEN** an arbitrarily long session
- **WHEN** many writes are attempted
- **THEN** the recorded counters SHALL remain bounded in size
- **AND** no per-write history SHALL be accumulated.

### Requirement: Failures SHALL be classified

A write failure SHALL be classified so the player-facing message and the
machine-readable reason distinguish a storage-capacity failure from a
data/provider failure.

#### Scenario: A storage-capacity failure is classified as such

- **GIVEN** a storage backend that rejects a write because its capacity is
  exhausted
- **WHEN** a save write fails
- **THEN** the recorded failure reason SHALL indicate storage capacity
- **AND** the player-facing message SHALL direct the player toward freeing
  storage or reducing world modification.

#### Scenario: A provider failure is classified as a data failure

- **GIVEN** a registered persistence provider whose serializer throws
- **WHEN** a save write fails
- **THEN** the recorded failure reason SHALL indicate a data or provider
  failure
- **AND** the player-facing message SHALL NOT claim that storage is full.

### Requirement: An automated save failure SHALL be visible to the player

A failure of an AUTOMATED save (autosave) SHALL be reported to the player
through a visible notice, rate-limited so that a persistently failing storage
backend does not produce an unbounded stream of messages.

#### Scenario: An autosave failure produces a visible notice

- **GIVEN** a live world in single-player
- **WHEN** an autosave interval elapses and the write fails
- **THEN** the player SHALL be shown a notice describing the failure
- **AND** the notice SHALL indicate that recent progress may not be saved.

#### Scenario: Repeated failures do not spam the player

- **GIVEN** a storage backend that keeps failing
- **WHEN** many autosave intervals elapse
- **THEN** the visible notice SHALL be rate-limited to a bounded frequency
- **AND** the player SHALL still be able to observe the current failure state
  at any time (for example on the debug overlay) without a new message.

#### Scenario: A network mirror does not report save failures

- **GIVEN** a session that is a joined network client presenting a mirror
- **WHEN** an autosave interval elapses
- **THEN** autosave SHALL remain skipped
- **AND** no save-failure notice SHALL be shown for the skipped write.

#### Scenario: Recovery clears the failure state

- **GIVEN** a prior autosave failure has been reported
- **WHEN** a subsequent write succeeds
- **THEN** the failure state SHALL clear
- **AND** the next reported failure, if any, SHALL be shown normally.

### Requirement: Reclaimable space SHALL be released before giving up

When a write fails because of storage capacity, the save layer SHALL release
the reclaimable artifacts it owns — the temporary write artifact, and the
retained backup copy when the main write cannot land — before reporting
failure.

#### Scenario: The temporary artifact is released on capacity failure

- **GIVEN** a write whose temporary artifact cannot be stored
- **WHEN** the write is attempted
- **THEN** the temporary artifact SHALL be released
- **AND** the previous good main copy and backup SHALL remain intact.

#### Scenario: The backup is released to make room for the main write

- **GIVEN** a previous good save and a retained backup
- **WHEN** the main write fails solely because of storage capacity
- **AND** releasing the retained backup would allow the write to succeed
- **THEN** the retained backup SHALL be released
- **AND** the main write SHALL be attempted again
- **AND** the outcome SHALL be reported accurately.

#### Scenario: Atomicity is preserved when reclaim is insufficient

- **GIVEN** a write that still fails after reclaiming reclaimable artifacts
- **WHEN** the write completes
- **THEN** the previous good main copy SHALL remain intact
- **AND** the failure SHALL be reported
- **AND** the counters SHALL reflect the failure.
