# Risk Register and Documentation Plan

## Purpose

This project is now complex enough that engineering risk comes less from any single missing feature and more from interactions among world state, save compatibility, runtime patching, content identity, performance, and future scope. This document makes those risks explicit and defines the durable documentation expected as the game evolves.

---

# 1. Risk register

| Risk | Likelihood | Impact | Priority | Primary mitigation |
|---|---:|---:|---:|---|
| Save corruption or incompatible content IDs | High | Critical | P0 | stable IDs, versioned schema, migrations, backups, fixtures |
| Runtime monkey-patch ordering breaks features | High | High/Critical | P0 | commands/events/providers, explicit bootstrap, wrapper removal |
| Worldgen loses determinism | Medium | Critical | P0 | injected RNG, generation version, seed regression suite |
| Module/load-order coupling produces hidden boot failures | High | High | P0 | Vite/module graph, startup validation |
| Numeric registry order changes persisted content meaning | High | Critical | P0 | namespaced IDs + explicit old-ID mapping |
| Advanced modules remain partially integrated | High | High | P0/P1 | migrate fishing/magic/accessories/wiring through standard contracts |
| Content expansion outpaces architecture | High | High | P0/P1 | schema-first content, milestone gates |
| Tile/liquid model blocks later mechanics | Medium/High | High | P1 | shape metadata + independent liquid layer |
| Combat systems diverge by class/module | High | High | P1 | shared stat/damage/status/projectile architecture |
| NPC/town logic becomes another monolith | Medium | High | P1 | NPC definitions, housing/town services, shops as providers |
| Performance degrades as content/entity counts increase | High | High | P1/P2 | instrumentation, budgets, dirty regions/spatial indexing |
| Renderer rewrite consumes effort without solving bottleneck | Medium | High | P2 | profile first; Canvas 2D retained until evidence |
| Multiplayer begins before deterministic simulation boundaries | Medium | Critical | P2 | authoritative-server work deferred until architecture gate |
| Asset/IP infringement | Medium | Critical/legal | P0/release | original assets, provenance, no copied code/text/art/audio |
| Mod scripting opens security/compatibility problems | Medium | High | P3 | resource/data packs first; capability-limited scripting late |
| Localization added too late | High | Medium/High | P1 | keys/catalog before mass content expansion |
| Huge refactor makes game unplayable for long periods | Medium | High | P0 | incremental vertical migrations, compatibility adapters |
| Automated tests become brittle pixel scripts | Medium | Medium | P1 | simulation tests + semantic test hooks; screenshots selective |
| Agent parallelism causes schema conflicts | High | High | continuous | ownership boundaries and architecture-decision control |
| Balance/content work masks architectural regressions | High | Medium/High | continuous | separate structural and tuning acceptance criteria |

---

# 2. Critical risk: persistence and content identity

## Failure mode

Current definitions can be appended by multiple modules. If runtime numerical index order becomes part of saved identity, changing load order or adding/removing a module can cause an old number to resolve to the wrong item/tile/entity.

## Required controls

- stable namespaced IDs;
- one-time mapping for legacy numerical IDs;
- save format version;
- content registry fingerprint/version metadata;
- provider-owned schema sections;
- migrations covered by fixtures;
- backup before migration;
- explicit missing-content handling;
- export/import.

## Release blocker

No release should knowingly ship a save-format mutation that lacks migration behavior and tests.

---

# 3. Critical risk: hidden integration order

## Failure mode

Two modules both wrap the same method. The final behavior depends on evaluation order, and later code may replace a wrapper entirely.

This is not theoretical: the headers of `magic.js`, `accessories.js`, and `wiring.js` explicitly document runtime wrapping/patching across core systems.

## Required controls

- one explicit bootstrap;
- update phases;
- command bus for mutations;
- event bus for observation;
- stat provider aggregation;
- render-layer registration;
- serializer providers;
- startup diagnostics listing installed systems/content.

## Exit criterion

By the end of architecture stabilization, a new feature should not need to replace `Player.prototype.update`, `UI.draw`, `Save.save`, or `World.draw` to participate normally.

---

# 4. Critical risk: world determinism

## Failure mode

A generation pass begins using `Math.random()`, wall-clock time, DOM state or non-stable iteration ordering. Same seed starts producing unexplained divergent worlds, breaking compact diff saves, regression tests and future network synchronization.

## Required controls

- deterministic RNG object passed to generation;
- named passes;
- generation version;
- regression seeds/checksums/invariants;
- deterministic collection ordering where it affects output;
- no gameplay RNG shared with generation;
- generation metadata recorded in save.

---

# 5. High risk: liquid redesign

## Failure mode

Liquid is migrated away from normal tile identity but save, collision, rendering, fishing, worldgen and wiring are changed simultaneously in one uncontrolled rewrite.

## Mitigation sequence

1. introduce liquid data layer alongside legacy representation;
2. convert static read/render paths;
3. persist it;
4. convert player immersion/breath;
5. migrate generation;
6. implement active-cell settling/flow;
7. migrate fishing context;
8. add buckets/interactions;
9. integrate pumps/wiring;
10. delete legacy liquid tile semantics after fixtures prove equivalence.

This should be treated as multiple mergeable stages rather than one giant branch.

---

# 6. High risk: worldgen feature creep

## Failure mode

More structures/biomes are appended directly to a centralized generator, increasing special-case ordering bugs.

## Mitigation

Before another large worldgen expansion:

- extract named passes;
- generation context/metadata;
- deterministic pass RNG;
- pass timing;
- per-pass invariants;
- post-generation validator;
- biome context representation.

Then new generation work becomes an additive pass with explicit prerequisites.

---

# 7. High risk: combat fragmentation

## Failure mode

Melee, ranged, magic, buffs/accessories and future summon systems each calculate damage differently and attach separate update/render/projectile loops.

## Mitigation

- canonical `ProjectileSystem` based on existing `projectiles.js`;
- stat resolver;
- damage classes;
- structured hit transaction;
- status-effect service;
- equipment/accessory providers;
- deterministic combat-test RNG injection.

Balance remains class-specific data; correctness remains shared infrastructure.

---

# 8. High risk: premature renderer migration

## Failure mode

A WebGL/Pixi rewrite is started because it sounds more modern, while actual bottlenecks are world scans, lighting, collision or garbage collection.

## Mitigation

- preserve Canvas 2D initially;
- instrument update and render separately;
- benchmark dense tile/entity/light scenes;
- optimize culling/dirty regions/pools first;
- build a narrow renderer prototype if Canvas remains the measured constraint;
- migrate only if the prototype demonstrates meaningful value.

---

# 9. Multiplayer risk

## Failure mode

The browser client is networked by sending current mutable global state. This creates cheating, desync, save ownership and bandwidth problems.

## Preconditions before multiplayer

- simulation can run without Canvas/DOM;
- world mutation uses commands;
- persistent IDs are stable;
- entity identities are explicit;
- deterministic/fixed tick rules are documented;
- save authority is clear;
- content version negotiation exists;
- combat and inventory transactions are centralized.

Then implement a narrow authoritative vertical slice.

Colyseus may be evaluated as an implementation tool, but architecture should not depend on the library before requirements are proven: https://colyseus.io/

---

# 10. IP/legal risk

This project should avoid a false sense that “fan tribute” automatically eliminates copyright/trademark concerns.

## Policy

The implementation may research public behavior and independently reproduce broad mechanics, but project-owned release artifacts should be original or properly licensed.

### Prohibited production inputs

- decompiled Terraria code;
- extracted sprite/audio assets;
- copied wiki tables used as wholesale game data;
- copied NPC/item text;
- branding likely to imply official affiliation.

### Required release docs

- project license;
- third-party notices if any;
- asset provenance manifest;
- clear independent/unaffiliated statement;
- contributor rules preventing copied proprietary content.

This roadmap is engineering guidance, not legal advice; consult qualified counsel before commercial/public distribution when material risk exists.

---

# 11. Agent-development risk

The project is well suited to parallel agents, but shared global files/schemas can create merge and conceptual conflicts.

## Ownership rules

Before a multi-agent wave, assign one owner for each shared contract:

```text
content registry/schema owner
save/migration owner
command/event owner
world/tile schema owner
combat/stat schema owner
UI/render-layer owner
CI/test harness owner
```

Workers may consume these contracts but should not independently redefine them.

## Required worker handoff

Every substantial agent task should report:

- branch/commit;
- files changed;
- contracts changed;
- migration/save impact;
- tests run and results;
- known limitations;
- follow-on tasks;
- performance measurements when relevant.

---

# 12. Documentation hierarchy

Maintain documentation at several levels.

## Root/product docs

### `README.md`

Audience: players/new contributors.

Should eventually contain:

- original project identity;
- screenshots/features;
- run/build instructions;
- controls;
- browser requirements;
- save location/export notes;
- project status;
- legal/unaffiliated note;
- links to contributor/architecture docs.

### `CONTRIBUTING.md`

Rules for code, tests, content IDs, saves, assets, commits and review.

### `CHANGELOG.md`

Release-visible changes, especially save/migration behavior.

### `SECURITY.md`

Relevant once external content packs, hosted multiplayer or mod scripting exist.

### `LICENSE`

Must be deliberately selected before broader release/contributions.

### `THIRD_PARTY_NOTICES.md`

Required when third-party licensed material is shipped.

---

# 13. Architecture documentation

### `docs/ARCHITECTURE.md`

The concise living contract: layers, dependency direction, startup, commands/events, save ownership, registry identity and update order.

### Architecture Decision Records

Recommended directory:

```text
docs/adr/
  0001-stable-content-ids.md
  0002-save-schema-and-migrations.md
  0003-command-event-boundary.md
  0004-liquid-storage-model.md
  0005-canvas-vs-pixi-decision.md
  0006-multiplayer-authority.md
```

An ADR should include context, decision, alternatives and consequences. Use ADRs for decisions costly to reverse, not every refactor.

---

# 14. System design docs to add as implementation begins

```text
docs/systems/world-generation.md
docs/systems/world-storage.md
docs/systems/tile-shapes-and-collision.md
docs/systems/liquids.md
docs/systems/items-inventory-equipment.md
docs/systems/crafting.md
docs/systems/combat.md
docs/systems/projectiles.md
docs/systems/status-effects.md
docs/systems/enemy-ai.md
docs/systems/progression.md
docs/systems/npcs-housing-towns.md
docs/systems/fishing.md
docs/systems/wiring.md
docs/systems/lighting-rendering.md
docs/systems/audio-music.md
docs/systems/save-format.md
docs/systems/localization.md
docs/systems/networking.md
docs/systems/modding.md
```

Each system doc should specify:

1. purpose/non-goals;
2. data model;
3. public API/contracts;
4. update ordering;
5. persistence;
6. deterministic/random behavior;
7. events/commands;
8. performance constraints;
9. test strategy;
10. migration/backward compatibility;
11. extension points;
12. known limitations.

---

# 15. Content documentation

Once content grows, generate rather than manually maintain catalogs where possible.

Potential generated docs:

- content registry index;
- item schema examples;
- recipe tags/stations;
- enemy AI behavior IDs;
- biome IDs/context fields;
- status effects;
- localization coverage;
- resource/data-pack schema reference.

Generated docs should come from validated source definitions so they do not silently drift.

---

# 16. Save-format documentation

This deserves its own durable document before format v2 is implemented.

Must include:

- envelope fields;
- world vs character ownership;
- generation version;
- namespaced content IDs;
- subsystem sections;
- migrations;
- backup semantics;
- missing-content behavior;
- export/import format;
- maximum/validated value constraints;
- corruption/recovery rules.

Any schema change should update both code and save-format documentation in the same change.

---

# 17. Performance documentation

Maintain a benchmark table by release/major milestone:

```text
reference hardware/browser
commit
world size/seed
scenario
median update ms
p95 update ms
median render ms
p95 render ms
worldgen time
save size/time
```

This prevents “optimization” claims that cannot be reproduced.

---

# 18. Definition of documented completion

A major system is not complete merely because the game appears to work.

It is complete when:

- contract/API is documented;
- persistence semantics are documented;
- deterministic/random behavior is documented;
- test coverage and fixtures exist;
- performance implications are understood;
- content IDs/schema are validated;
- migration/compatibility impact is recorded;
- no temporary wrapper/shim remains without an explicit removal task.

The documentation should function as durable memory for both human contributors and autonomous coding agents.