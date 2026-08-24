# Implementation Task Board

This is the seed backlog for executing the Terraria-parity roadmap. It is intentionally implementation-oriented and can be transferred into GitHub Issues/Projects later.

## Status convention

```text
TODO      not started
READY     prerequisites satisfied
ACTIVE    currently owned
BLOCKED   prerequisite/defect unresolved
VERIFY    implementation complete, proof pending
DONE      acceptance criteria proven
```

## Priority convention

- **P0** — architecture/data-loss/build/test blocker.
- **P1** — highest-value gameplay/system work.
- **P2** — depth, presentation, scale.
- **P3** — mature extensibility/long-tail work.

---

# Status snapshot (authoritative, W20 truth-sync)

Reconciled against the implementation on the W20 Localization campaign
checkpoint. Consult docs/ARCHITECTURE.md §19 (capability matrix), §24 (W20
localization contracts), §23 (W19 contracts), §22 (W18 runtime contracts) and
§21 (W17 contracts) for per-module ownership detail.

| Area | Tasks | Status |
|---|---|---|
| Baseline/build/tests | FND-001, FND-002, FND-006 | DONE |
| Framework adoption | FND-003, FND-004, FND-005 | SUPERSEDED (static build + node:test chosen; rationale above) |
| CI quality gate | FND-007 | DONE (GitHub Actions .github/workflows/ci.yml mirrors npm run validate) |
| Registry/save/commands/events/layers/stats | ARC-001..ARC-009 | DONE (ARC-008 render layers are now THE production draw pipeline; command phase drains live player intents) |
| Runtime authority convergence (W18) | scheduler/commands/render cutover + headless boundary | DONE (`TC.Runtime` canonical host; FIFO command queue; RenderLayers pipeline; pause freezes simulation; `tests/core/runtime-authority.test.js`, `tests/core/headless-sim.test.js`, browser `runtime-authority.spec.js`, `tools/bench-runtime.js`) |
| Advanced-module integration | INT-001..INT-006 | DONE |
| Tile shapes/traversal/grapple | PHY-001..PHY-005 | DONE |
| Liquids | LIQ-001..LIQ-005 | DONE (LIQ-006 pumps remains TODO) |
| Worldgen platform | WGEN-001..WGEN-005 | DONE (v3 passes incl. deep caves + micro-biomes) |
| Combat & progression | COM-001..COM-007 | DONE (canonical resolveHit, generic statuses, enemy defs/AI/spawn split, LootTables, Progression conditions+graph, Storm Jelly vertical arc, **W17 Wall of Flesh production gateway**, **W19 underworld spawn truth-sync**: depth-first `zoneOf` classification, shared `TC.Biomes.underworldTopPx/isUnderworldAt` boundary, declarative post-Wall ember_wraith entry) |
| Inventory/crafting | INV-001/002, CRF-001/002 | DONE (progression-aware recipe conditions included; craft clicks route through CraftRecipe transactions) |
| NPCs/towns | NPC-001..NPC-004 | DONE (housing, shops, context dialog; condition-gated unlocks/stock) |
| Localization | LOC-001..LOC-003 | DONE (W20: canonical `TC.Localization` runtime + `TC.Settings` preference store; English fallback catalog covers all displayable content/UI/dialogue; registry identity frozen and regression-guarded; pseudo-locale stress mode; full headless + browser coverage; see ARCHITECTURE.md §24). Actual additional-language catalogs remain TODO (LOC follow-ups below) |
| Rendering/lighting/audio depth | VIS/LGT/ART/AUD epics | LGT-002 done (dynamic lights); rest TODO/P2 |
| Performance | PERF-001 | DONE (TC.Debug instrumentation + F3 overlay); PERF-002 partially covered by `tools/bench-runtime.js` fixed-step benchmark; PERF-003..005 TODO |
| Multiplayer | NET-001..004 | TODO (P2; W18 delivered the NET-001 precondition: headless simulation via TC.Runtime — full runner/networking still TODO) |
| Extensibility/mods | MOD-001..004 | TODO |

### Newly discovered follow-ups (updated W20)

- **Localization follow-ups (LOC epic closed, translation work open):**
  authoring real secondary-language catalogs (`js/locales/<id>.js` — the
  engine, validator and tests accept them with zero code changes);
  translator workflow/export format; RTL layout pass; complex-script font
  coverage beyond the system stack. The `en-XA` pseudo locale stays the
  layout-stress tool for future surfaces.
- W19 closed both known browser-journey flakes and hardened two more
  latent observation races surfaced by full-gate reruns: `journey-i` keeps
  the fighter alive through real-time boss-damage/pickup windows and chases
  bouncing loot instead of teleporting once (then returns to the arena so
  station-adjacent crafting asserts see the anvil); `journey-j` accepts
  `enter|combat` at first observation while still proving the transition;
  `journey-b` re-acquires the minable tile underfoot mid-loop and accepts a
  drop already magnet-collected; `runtime-authority.spec.js` re-aims during
  held mining. All suites pass repeatedly under load.
- W19 fixed the last W17 defect: the spawn director classified deep players
  as `cave`, so the declared Underworld roster and post-Wall ember_wraith
  entry never spawned. Zoning is now depth-first via a single shared boundary
  query (ARCHITECTURE.md §23) with deterministic coverage in
  `tests/unit/enemyspawn-underworld.test.js`.
- UI cursor-stack drag/drop and bulk helpers (sort/quick stack/split) remain
  presentation-layer inventory rearrangements with conservation covered by Inventory
  invariants; converting them to MoveItem batches is optional future work.
- ~~Localization remains the largest untouched epic~~ Closed by W20 (see
  ARCHITECTURE.md §24); new user-visible strings MUST ship with catalog keys
  (AGENTS.md localization rules) or `npm run check:i18n` fails the gate.

---

# EPIC FND — Baseline, build, tests and CI

## FND-001 — Freeze repository capability map

**Priority:** P0  
**Effort:** Medium  
**Status:** DONE

### Scope

- inventory all runtime modules/scripts and load order;
- record owned namespaces/APIs;
- record tile/wall/item/recipe/enemy/NPC IDs;
- record advanced modules and current integration requirements;
- catalog smoke/repro scripts;
- list known save gaps and monkey patches.

### Acceptance

- one machine-readable or Markdown capability matrix exists;
- every `js/*.js` module is represented;
- unknown/unused scripts are explicitly marked rather than silently ignored.

---

## FND-002 — Capture deterministic worldgen baseline

**Priority:** P0  
**Depends on:** FND-001  
**Effort:** Medium

### Scope

Select fixed seeds representing normal, biome-edge, structure-heavy and regression cases. Record generation checksums plus structural invariants.

### Acceptance

- same seed produces same expected results across repeated runs;
- generation failures identify the pass/invariant;
- seeds are committed as fixtures, not stored only in issue text.

---

## FND-003 — Add Vite dev/build shell

**SUPERSEDED (W11 truth-sync):** No bundler/dev shell will be introduced. The project ships as plain static files; the release path is the reproducible `tools/release-build.js` assembly + `tools/verify-dist.js` Chromium launch gate (`npm run build` / `npm run verify:build`).

**Priority:** P0  
**Depends on:** FND-001  
**Effort:** Medium

### Scope

Introduce package tooling and Vite while preserving gameplay behavior.

### Acceptance

- clean checkout has documented install/dev/build commands;
- production build launches;
- current script dependencies load deterministically;
- no gameplay feature is deliberately removed as part of this task.

---

## FND-004 — Add incremental JS type checking

**SUPERSEDED (W11 truth-sync):** Incremental JS type checking is covered by `node --check` on every module (`npm run check`, also enforced per-file by the release build) plus registry schema validation at boot; a JSDoc/checkJs pass was rejected as churn without payoff for this codebase.

**Priority:** P0  
**Depends on:** FND-003  
**Effort:** Medium

Start with JSDoc/checkJs contracts for:

- content definitions;
- item stacks;
- save payloads;
- world state;
- projectile definitions;
- public system interfaces.

Do not convert the whole repository to TypeScript in one task.

---

## FND-005 — Establish unit test suite (done as node:test)

**SUPERSEDED (W11 truth-sync):** Superseded in favor of the built-in `node:test` runner (zero-dependency, deterministic VM full-boot loader in tests/helpers/load-game.js). All former smoke scripts are superseded by suites under tests/.

**Priority:** P0  
**Depends on:** FND-003  
**Effort:** Medium

Migrate useful assertions from `_smoke_worldgen.js`, `.magic-smoke.js`, `_smoke_accessories.js` and similar scripts.

### Acceptance

- canonical `npm test`-style command exists;
- deterministic test environment;
- smoke scripts are either migrated or explicitly retained with rationale.

---

## FND-006 — Establish Playwright browser smoke suite

**Priority:** P0  
**Depends on:** FND-003  
**Effort:** Medium

Minimum flows:

- boot/new world;
- move/mine/place;
- inventory/craft;
- chest transfer;
- save/quit/continue;
- enemy combat.

### Acceptance

- tests do not rely only on arbitrary coordinate sleeps;
- failures retain useful traces/screenshots/logs;
- one command runs the suite locally.

---

## FND-007 — Add GitHub Actions quality gate

**Priority:** P0  
**Depends on:** FND-004/005/006  
**Effort:** Low/Medium

PR gate:

```text
content validation
type check
Vitest
production build
Playwright Chromium smoke
```

Nightly expansion later.

---

# EPIC ARC — Architecture and persistence

## ARC-001 — Define stable namespaced content registry

**Priority:** P0  
**Depends on:** FND-005  
**Effort:** High

### Scope

Registries for tiles, walls, items, recipes, projectiles, enemies, NPCs, buffs/statuses, biomes and stations/tags.

### Acceptance

- duplicate IDs fail;
- references validate;
- runtime indices can be derived;
- registration order does not change persistent identity;
- content registry fingerprint is available.

---

## ARC-002 — Freeze legacy numeric-ID migration map

**Priority:** P0  
**Depends on:** FND-001, ARC-001  
**Effort:** Medium

### Acceptance

Current pre-registry tile/item/etc. numeric values can be translated deterministically to stable IDs for supported old saves.

---

## ARC-003 — Save format v2 envelope

**Priority:** P0  
**Depends on:** ARC-001/002  
**Effort:** High

Implement:

- format version;
- game/generation version metadata;
- world/character separation;
- system provider sections;
- registry metadata;
- validation.

---

## ARC-004 — Save migration framework and fixture matrix

**Priority:** P0  
**Depends on:** ARC-003  
**Effort:** High

### Acceptance

- v1 representative saves migrate;
- migration is deterministic;
- unsupported/corrupt data does not overwrite the last good save;
- fixtures run in CI.

---

## ARC-005 — Atomic backup/export/import persistence

**Priority:** P0  
**Depends on:** ARC-003/004  
**Effort:** Medium

### Acceptance

- failed write/migration keeps previous valid copy;
- user can export and import a portable save;
- validation occurs before commit to active save.

---

## ARC-006 — Command transaction framework

**Priority:** P0  
**Depends on:** FND-005  
**Effort:** High

Initial commands:

```text
MineTile
PlaceTile
UseItem
MoveItem
CraftRecipe
EquipItem
InteractTile
```

### Acceptance

One canonical path owns validation + mutation. Partial failure does not leave duplicated/lost state.

---

## ARC-007 — Event bus and world-change events

**Priority:** P0  
**Depends on:** ARC-006  
**Effort:** Medium

Initial events:

```text
TileChanged
EntityDamaged
EntityKilled
InventoryChanged
BuffApplied
BossDefeated
WorldProgressChanged
```

Events announce completed changes; they do not replace command authority.

---

## ARC-008 — Render-layer registration

**Priority:** P0/P1  
**Depends on:** FND-003  
**Effort:** Medium

Replace future `UI.draw`/`World.draw` wrapping with explicit layers.

---

## ARC-009 — Stat/status provider architecture

**Priority:** P1  
**Depends on:** ARC-001/007  
**Effort:** High

Needed before fully integrating accessories/magic/combat.

---

# EPIC INT — Integrate existing advanced modules

## INT-001 — Fishing persistence migration

**Priority:** P0/P1  
**Depends on:** ARC-003  
**Effort:** Medium

### Scope

Wire `TC.Fishing.serialize()/load()` through registered save provider.

### Acceptance

- quest/catch state survives save/reload;
- no fishing-specific `Save.save` wrapper;
- browser save/load test covers it.

---

## INT-002 — Promote `projectiles.js` as canonical projectile system

**Priority:** P0/P1  
**Depends on:** ARC-001/007  
**Effort:** Medium/High

Preserve existing pool/motion/pierce/bounce/homing/explosion concepts.

### Acceptance

- ranged/magic/etc. use one lifecycle;
- definitions live in registry/data;
- no duplicate arrow projectile engine remains;
- projectile lights use render/lighting contract.

---

## INT-003 — Integrate magic without wrappers

**Priority:** P1  
**Depends on:** INT-002, ARC-003, ARC-008/009  
**Effort:** High

### Acceptance

- mana persists through canonical character schema;
- magic damage uses shared combat/stat rules;
- mana HUD registers as layer;
- item content registers explicitly;
- existing runtime wrappers removed.

---

## INT-004 — Integrate accessories/buffs/prefixes

**Priority:** P1  
**Depends on:** ARC-009/003  
**Effort:** High

### Acceptance

- five accessory slots migrate into canonical equipment model;
- buffs use generic status service;
- prefixes are item-instance modifiers;
- stat contributions are explainable/debuggable;
- player/combat/UI wrappers removed.

---

## INT-005 — Fix canonical mining transaction

**Priority:** P0/P1  
**Depends on:** ARC-006  
**Effort:** Medium

`wiring.js` currently documents a shim that clears tiles after mining.

### Acceptance

- core mining break path clears tile exactly once;
- drop occurs exactly once;
- world-change event fires exactly once;
- wiring-specific fix can be deleted;
- regression test proves it.

---

## INT-006 — Integrate wiring without core patches

**Priority:** P1  
**Depends on:** INT-005, ARC-003/007/008  
**Effort:** High

Migrate signal/device behavior to explicit system APIs.

### Acceptance

- no `Save.save`, lifecycle, `Player` or `World` monkey patch remains for normal wiring behavior;
- signal graph tests pass;
- wire overlay is a render layer;
- persistence provider works.

---

# EPIC PHY — Tiles, collision and traversal

## PHY-001 — Introduce tile shape metadata

**Priority:** P1  
**Depends on:** ARC-001  
**Effort:** High

Shapes:

```text
full
platform
half
slope-ne
slope-nw
slope-se
slope-sw
```

---

## PHY-002 — One-way platforms

**Priority:** P1  
**Depends on:** PHY-001  
**Effort:** Medium

Acceptance: land from above, pass from below, deliberate drop-through, enemy behavior specified.

---

## PHY-003 — Half-block and slope collision

**Priority:** P1  
**Depends on:** PHY-001  
**Effort:** High

Acceptance: smooth walking, jump/land/fall interactions, no tunneling on expected movement speeds.

---

## PHY-004 — Tile shaping/hammer action

**Priority:** P1  
**Depends on:** PHY-001/003  
**Effort:** Medium

Use command transaction and save shape metadata.

---

## PHY-005 — Grapple/hook vertical slice

**Priority:** P1  
**Depends on:** PHY-003, INT-002  
**Effort:** High

Use canonical projectile/anchor and movement capability APIs.

---

# EPIC LIQ — Independent liquids

## LIQ-001 — Define liquid cell schema

**Priority:** P1  
**Depends on:** ARC-003/world schema  
**Effort:** Medium

Minimum: type + amount.

---

## LIQ-002 — Static liquid persistence/render migration

**Priority:** P1  
**Depends on:** LIQ-001  
**Effort:** High

Convert representation without yet requiring full flow.

---

## LIQ-003 — Player immersion/breath/buoyancy

**Priority:** P1  
**Depends on:** LIQ-002  
**Effort:** Medium

---

## LIQ-004 — Active-cell settling and flow

**Priority:** P1  
**Depends on:** LIQ-002  
**Effort:** Very High

No whole-world per-frame scan.

---

## LIQ-005 — Liquid interactions and buckets

**Priority:** P1/P2  
**Depends on:** LIQ-004  
**Effort:** High

---

## LIQ-006 — Pumps and wiring integration

**Priority:** P2  
**Depends on:** LIQ-004, INT-006  
**Effort:** High

---

# EPIC WGEN — World-generation platform

## WGEN-001 — Introduce generation context and named pass runner

**Priority:** P1  
**Depends on:** FND-002/005, ARC-001  
**Effort:** High

Preserve output before redesign where practical.

---

## WGEN-002 — Extract existing terrain/biome/structure passes

**Priority:** P1  
**Depends on:** WGEN-001  
**Effort:** High

No new feature scope until parity tests pass.

---

## WGEN-003 — Post-generation validator

**Priority:** P1  
**Depends on:** WGEN-001  
**Effort:** Medium

Validate spawn safety, landmarks, IDs, structure overlaps and key progression guarantees.

---

## WGEN-004 — Biome context service

**Priority:** P1  
**Depends on:** WGEN-001  
**Effort:** High

Runtime queries for biome/depth/environment consumed by spawns, music, fishing, NPCs and presentation.

---

## WGEN-005 — Richer strata/micro-biomes/structures

**Priority:** P1/P2  
**Depends on:** WGEN-002/003/004  
**Effort:** Very High, parallelizable by pass ownership

---

# EPIC COM — Combat and progression

## COM-001 — Damage class registry

**Priority:** P1  
**Depends on:** ARC-001/009  
**Effort:** Medium

At minimum: generic/melee/ranged/magic; summon can follow later.

---

## COM-002 — Canonical hit resolver

**Priority:** P1  
**Depends on:** COM-001  
**Effort:** High

Defense, variance, crit, knockback, immunity and status application.

---

## COM-003 — Generic status-effect engine

**Priority:** P1  
**Depends on:** ARC-009  
**Effort:** High

Migrate existing buffs/debuffs.

---

## COM-004 — Enemy definitions vs AI behaviors split

**Priority:** P1  
**Depends on:** ARC-001/007  
**Effort:** High

---

## COM-005 — Data-driven loot tables

**Priority:** P1  
**Depends on:** ARC-001, COM-004  
**Effort:** Medium

---

## COM-006 — World progression flags/gates

**Priority:** P1  
**Depends on:** ARC-003/007  
**Effort:** High

---

## COM-007 — One complete boss progression arc

**Priority:** P1  
**Depends on:** COM-002/004/005/006  
**Effort:** High

Prove unlocks, loot, persistence and world consequences through the new contracts.

---

# EPIC INV — Inventory and crafting

## INV-001 — Canonical slot categories/equipment schema

**Priority:** P1  
**Depends on:** ARC-001/003  
**Effort:** High

---

## INV-002 — Quick transfer, stack split, sort and deposit QoL

**Priority:** P1  
**Depends on:** INV-001  
**Effort:** Medium/High

All operations use transaction API and duplication/loss tests.

---

## CRF-001 — Recipe schema with tags/stations/conditions

**Priority:** P1  
**Depends on:** ARC-001  
**Effort:** High

---

## CRF-002 — Recipe indexes/search/filter

**Priority:** P1  
**Depends on:** CRF-001  
**Effort:** Medium

---

# EPIC NPC — NPCs, housing and towns

## NPC-001 — Generic NPC registry

**Priority:** P1  
**Depends on:** ARC-001/003  
**Effort:** High

---

## NPC-002 — Housing validator and assignment

**Priority:** P1  
**Depends on:** NPC-001, tile/wall APIs  
**Effort:** High

---

## NPC-003 — Shop/service provider API

**Priority:** P1  
**Depends on:** NPC-001, inventory transactions  
**Effort:** Medium/High

---

## NPC-004 — Migrate Guide to generic NPC model

**Priority:** P1  
**Depends on:** NPC-001/002/003  
**Effort:** Medium

This is the vertical proof before adding many town NPCs.

---

# EPIC LOC — Localization

## LOC-001 — Define localization key/catalog system

**Priority:** P1  
**Depends on:** FND-003  
**Effort:** Medium  
**Status:** DONE (W20)

`TC.Localization` (js/localization.js) is the single authority: additive
locale registration, English fallback with visible placeholders + warn-once
diagnostics, `{name}` interpolation, Intl.PluralRules plural selection,
catalog validation, missing-key reporting, pseudo-locale stress mode.
Preferences persist via `TC.Settings` (js/settings.js), outside world saves.

---

## LOC-002 — Migrate core UI strings

**Depends on:** LOC-001  
**Effort:** Medium  
**Status:** DONE (W20)

All normal canvas surfaces render through the catalog: menus, HUD labels,
inventory/chest/equipment/crafting panels, tooltips, shop + buy/sell
feedback, death/respawn, boss bar, NPC dialog, progression announcements,
minimap biome label. Buttons size by measureText; fixed columns ellipsize.

---

## LOC-003 — Migrate content names/descriptions/dialogue

**Depends on:** LOC-001, registries  
**Effort:** High/parallelizable  
**Status:** DONE (W20)

Every displayable tile/wall/item/enemy/npc/buff/biome/station resolves a
catalog name via `contentName(kind, ref)` through the registry; Guide and
Merchant dialogue pools hold catalog keys (deterministic cycling preserved);
player-facing feedback (summon rejection, mana/potion, fishing, life
crystals, Blood Moon, boss banners) uses parameterized templates. Registry
identity (`bdad6cfa`, 368 stable ids) proven unchanged by
`tools/check-i18n.js` + `tests/core/localization-identity.test.js`.

---

# EPIC VIS — Rendering, lighting and audio

## VIS-001 — Explicit render-layer pipeline

**Priority:** P1/P2  
**Depends on:** ARC-008  
**Effort:** Medium

---

## VIS-002 — Dirty-region/chunk render instrumentation

**Priority:** P2  
**Depends on:** VIS-001  
**Effort:** Medium

---

## LGT-001 — RGB lighting data model

**Priority:** P2  
**Depends on:** world dirty-region model  
**Effort:** High

---

## LGT-002 — Dynamic projectile/entity lights

**Priority:** P2  
**Depends on:** LGT-001, INT-002  
**Effort:** Medium

---

## ART-001 — Original authored asset manifest/export pipeline

**Priority:** P2  
**Depends on:** registries  
**Effort:** Medium

---

## ART-002 — Sprite animation controller

**Priority:** P2  
**Depends on:** ART-001, render layers  
**Effort:** High

---

## AUD-001 — Semantic SFX mixer API

**Priority:** P2  
**Effort:** Medium

---

## AUD-002 — Biome/event/boss music state machine

**Priority:** P2  
**Depends on:** biome/progression events  
**Effort:** Medium

---

# EPIC PERF — Performance and observability

## PERF-001 — Frame timing and subsystem instrumentation

**Priority:** P0/P1  
**Effort:** Medium

Track update/render/lighting/liquid/AI/projectile timings and counts.

---

## PERF-002 — Stable benchmark scenes

**Priority:** P1  
**Depends on:** PERF-001  
**Effort:** Medium

Exploration, dense combat, lighting stress, liquid stress, construction, worldgen.

---

## PERF-003 — Spatial entity broad phase

**Priority:** P2  
**Depends on:** measurement showing need  
**Effort:** High

---

## PERF-004 — Chunk dirty tracking

**Priority:** P1/P2  
**Depends on:** world architecture  
**Effort:** High

Benefits renderer, lighting, liquid, minimap, save and future networking.

---

## PERF-005 — Renderer technology decision benchmark

**Priority:** P2  
**Depends on:** PERF-001/002/004  
**Effort:** Medium research/prototype

Compare optimized Canvas 2D against a narrow PixiJS/WebGL prototype before approving any migration.

---

# EPIC NET — Multiplayer

## NET-001 — Headless simulation runner

**Priority:** P2  
**Depends on:** architecture stabilization  
**Effort:** High

Simulation starts/updates without Canvas or DOM.

---

## NET-002 — Authoritative command protocol

**Priority:** P2  
**Depends on:** NET-001, ARC-006  
**Effort:** High

---

## NET-003 — Two-client vertical slice

**Priority:** P2  
**Depends on:** NET-002  
**Effort:** Very High

Scope only movement, mining/placement, one enemy/combat interaction, inventory/save and reconnect.

---

## NET-004 — Interest management/chunk replication

**Priority:** P3  
**Depends on:** NET-003, chunk model  
**Effort:** Very High

---

# EPIC MOD — Extensibility

## MOD-001 — Resource-pack manifest/loader

**Priority:** P2  
**Depends on:** asset registry  
**Effort:** Medium/High

No code execution.

---

## MOD-002 — Declarative data-pack schemas

**Priority:** P2  
**Depends on:** stable content schemas  
**Effort:** High

---

## MOD-003 — Missing-pack save diagnostics

**Priority:** P2  
**Depends on:** MOD-002, save registry metadata  
**Effort:** Medium

---

## MOD-004 — Sandboxed/capability mod API research

**Priority:** P3  
**Depends on:** stable APIs + security design  
**Effort:** Very High

Do not expose arbitrary raw `window.TC` mutation as the supported API.

---

# Recommended first execution wave

Do **not** start with visual content expansion. First wave:

```text
FND-001 capability map
FND-002 worldgen baselines
FND-003 Vite
FND-005 Vitest
FND-006 Playwright
PERF-001 instrumentation
```

Second wave after those land:

```text
ARC-001 stable registry
ARC-002 legacy mapping
ARC-003 save v2
ARC-006 commands
ARC-007 events
ARC-008 render layers
```

Third wave proves architecture with real features:

```text
INT-001 fishing persistence
INT-002 canonical projectiles
INT-005 mining transaction fix
INT-003/004 magic/accessories
INT-006 wiring
```

Only after this should large gameplay expansion begin.

---

# Parallel-agent ownership guidance

Large waves can use multiple agents, but assign disjoint write ownership.

Example after architecture contracts freeze:

- **World agent:** tile shapes/collision/worldgen.
- **Liquid agent:** liquid schema/simulation/persistence.
- **Combat agent:** stat/damage/status/projectiles.
- **Town/content agent:** inventory/crafting/NPC/housing/localization.
- **Presentation agent:** render layers/lighting/assets/audio.
- **Quality agent:** tests/benchmarks/save fixtures/CI.

A designated integration owner controls shared schemas (`content registry`, `save envelope`, `commands/events`, `world cell/chunk layout`) and resolves cross-stream changes.

---

# Task completion template

Every completed task should record:

```text
Task ID:
Branch / commit:
Files changed:
Behavior added/changed:
Public contracts changed:
Save/migration impact:
Tests added:
Tests run + result:
Performance measurement:
Known limitations:
Follow-up task IDs:
```

This keeps the roadmap usable by autonomous agents across long-running development rather than turning into stale prose.