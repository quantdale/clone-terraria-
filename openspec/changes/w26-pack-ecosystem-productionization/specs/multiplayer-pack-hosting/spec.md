# Multiplayer Pack Hosting Specification

## ADDED Requirements

### Requirement: Dedicated hosts explicitly select the active pack set

`tools/mp-server.js` SHALL support deterministic pack configuration before authoritative world creation.

#### Scenario: Build-provided pack ids

- **GIVEN** a host command specifying `--packs` with valid provided pack ids
- **WHEN** the dedicated server boots
- **THEN** those ids and required dependencies SHALL be resolved/activated before `NetServer.start()` creates/adopts a world
- **AND** the resulting gameplay pack digest SHALL be final before clients are admitted.

#### Scenario: Local JSON pack file

- **GIVEN** a repeatable host-local pack-file option pointing to valid bounded JSON manifests
- **WHEN** the server boots
- **THEN** each file SHALL be byte-bounded, parsed/provided through the same `TC.Packs` security path and activated before world creation
- **AND** host-local file access SHALL NOT become a network-delivered executable mod channel.

#### Scenario: Malformed host pack

- **GIVEN** an unreadable, oversize, malformed or semantically invalid pack file
- **WHEN** the server is started
- **THEN** startup SHALL fail with a non-zero/actionable error before the authoritative world/listener is considered ready
- **AND** no partially activated pack state SHALL be used for a live session.

### Requirement: Pack identity gates admission before world state

Existing protocol pack identity semantics SHALL apply equally to dedicated hosts.

#### Scenario: Exact gameplay identity

- **GIVEN** a dedicated host and browser/client with the same gameplay pack digest
- **WHEN** the protocol-v4 hello/welcome handshake completes
- **THEN** the client MAY enter syncing/play according to existing admission rules.

#### Scenario: Gameplay identity mismatch

- **GIVEN** host and client with different gameplay pack digests
- **WHEN** the client attempts to join
- **THEN** the mismatch SHALL be rejected before authoritative snapshot/world state is applied to the client
- **AND** the server SHALL not trust client-declared content to alter its own active set.

#### Scenario: Resource-only difference

- **GIVEN** host/client whose gameplay pack digest matches but resource-only content identity differs in a manner W25 already permits
- **WHEN** admission is evaluated
- **THEN** W25 gameplay-vs-content identity policy SHALL remain unchanged unless W26 documents and tests an intentional policy change.

### Requirement: Reconnect/resync retains content gate

A reconnecting identity SHALL NOT bypass pack compatibility.

#### Scenario: Compatible reconnect

- **GIVEN** a previously admitted client that reconnects with the same active gameplay pack identity
- **WHEN** the reconnect/resync flow runs
- **THEN** existing sequence floors, identity rebinding and resync semantics SHALL operate normally.

#### Scenario: Changed pack set on reconnect

- **GIVEN** a client whose local gameplay pack identity changed after disconnect
- **WHEN** it attempts rejoin
- **THEN** the session SHALL reject the mismatch before resync snapshot application.

### Requirement: Dedicated-host pack loading uses a canonical pre-world lifecycle

The headless loader/tooling SHALL NOT rely on post-world table mutation.

#### Scenario: Provision before boot/activation

- **GIVEN** host-local JSON manifests that are not statically listed in `index.html`
- **WHEN** the headless game is prepared
- **THEN** the implementation SHALL expose/use a deterministic pre-world provision lifecycle
- **AND** late built-in table extenders and registry synchronization SHALL still complete before active pack commit/final validation
- **AND** browser/test/release script-order assumptions SHALL remain coherent.

### Requirement: Protocol version changes only for wire incompatibility

CLI/tool changes SHALL NOT automatically change `TC.NetProto.VERSION`.

#### Scenario: No wire schema change

- **GIVEN** W26 adds host pack CLI and uses existing protocol-v4 pack metadata unchanged
- **WHEN** the campaign completes
- **THEN** protocol version SHALL remain 4.

#### Scenario: Wire schema must change

- **GIVEN** implementation evidence proves a new incompatible wire field/semantic is required
- **WHEN** protocol is revised
- **THEN** the version bump SHALL include hostile decoder tests, compatibility rationale and server/client updates in one atomic campaign.
