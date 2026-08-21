# Architecture Contract

This document is the concise, living architecture target for `clone-terraria-`. The detailed rationale lives in `docs/terraria-parity/architecture-and-technical-debt.md`.

## 1. Core rule

**Simulation state must be understandable and testable without depending on Canvas rendering, DOM layout, or ad-hoc runtime monkey patches.**

Target dependency direction:

```text
Presentation
  renderer • camera • HUD • menus • particles • audio
        │
        ▼
Application
  session • state machine • commands • orchestration
        │
        ▼
Simulation
  world • entities • physics • combat • crafting • biomes
  liquids • NPCs • progression • fishing • wiring
        │
        ▼
Adapters
  browser input • persistence • assets • future networking
```

Dependencies should point downward. Presentation observes simulation/application state; simulation does not call UI drawing functions.

---

## 2. Current-to-target migration

The current `window.TC` namespace remains a compatibility surface during migration. It is not the desired permanent dependency mechanism.

New/refactored systems should prefer:

- explicit construction/registration;
- stable content registries;
- commands for authoritative mutations;
- events for observation;
- registered save providers;
- render layers;
- stat/status providers;
- explicit update ordering.

Avoid adding new self-installing wrappers around unrelated prototypes/functions.

---

## 3. Content identity

Every persistable definition gets a stable namespaced ID:

```text
core:dirt
core:iron_bar
core:green_slime
core:guide
```

Runtime integer indexes may be generated for speed, but persistent data must use stable IDs or an explicitly versioned mapping.

Registry rules:

1. duplicate IDs fail startup/validation;
2. invalid references fail validation;
3. content source/namespace is tracked;
4. renames require aliases/migrations;
5. registry fingerprint/version can be recorded in saves and future network handshakes.

---

## 4. Commands

Commands represent player/system intent that may mutate authoritative state.

Initial command vocabulary:

```text
MineTile
PlaceTile
ShapeTile
PlaceWall
UseItem
MoveItem
EquipItem
CraftRecipe
InteractTile
OpenContainer
CastFishingLine
TalkToNpc
BuyItem
TriggerMechanism
```

A command validates once and either commits a coherent transaction or fails without partial mutation.

Example mining invariant:

```text
successful break = tile mutation + drop calculation + events exactly once
```

Feature modules must not patch the mining path to finish missing parts of the transaction.

---

## 5. Events

Events announce completed state changes:

```text
TileChanged
LiquidChanged
EntityDamaged
EntityKilled
ItemPickedUp
InventoryChanged
BuffApplied
BuffExpired
CraftCompleted
BossDefeated
WorldProgressChanged
NpcMovedIn
WirePulse
DayChanged
```

Events are not a substitute for ordered simulation phases. If two systems must execute in a defined order every tick, encode that order in the game loop/system scheduler.

---

## 6. Update phases

Target conceptual order:

```text
1 collect input intents
2 process commands
3 player/entity movement intent
4 physics and collision
5 projectiles
6 enemies/NPC AI
7 combat/status resolution
8 liquids/wiring/environment
9 pickup/container/state maintenance
10 progression/spawn rules
11 event flush
12 presentation snapshot/render
```

The exact sequence may evolve, but changes to authoritative ordering must be documented and regression-tested.

---

## 7. World representation

Long-term world data should support localized dirty tracking.

Conceptual chunk fields:

```text
foreground tile index
background wall index
tile shape/frame metadata
liquid type + amount
wire channel bitfields
lighting cache/dirty flags
```

Dense/typed arrays are preferred in hot paths. Do not convert the world into per-tile JavaScript objects purely for architectural aesthetics.

---

## 8. World generation

World generation is deterministic for a given:

```text
seed + generationVersion + configuration
```

It is composed from named passes, for example:

```text
terrain
surface-biomes
caves
ore
structures
decoration
validation
```

Every pass receives an injected deterministic RNG/context. `Math.random()`, current time, viewport state and runtime combat RNG are forbidden sources for persistent world generation.

---

## 9. Liquids

Liquid is eventually an independent world layer rather than a normal foreground tile ID.

Minimum logical state:

```text
type
amount/volume
```

Simulation uses active/dirty-cell queues. Rendering may produce waterfalls and surface effects from liquid state, but those visuals do not become authoritative fluid state.

---

## 10. Combat and stats

`projectiles.js` concepts should become the canonical projectile subsystem.

Combat should converge on:

```text
DamageClassRegistry
StatResolver
StatusEffectSystem
ProjectileSystem
CombatResolver
```

Resolved stats are composed from:

```text
base
+ equipment
+ accessories/prefixes
+ buffs/debuffs
+ temporary world/event modifiers
```

Melee, ranged, magic and future summon-style content use the same hit-resolution contract.

---

## 11. Persistence

Saves are versioned independently from the game version.

Target envelope:

```json
{
  "formatVersion": 2,
  "gameVersion": "0.x",
  "generationVersion": 2,
  "registryFingerprint": "...",
  "world": {},
  "character": {},
  "metadata": {}
}
```

Persistent systems register serializers under stable keys. A feature must not wrap `Save.save` to participate.

Requirements:

- migrations N → N+1;
- fixtures for historical versions;
- backup before migration/replacement;
- corruption validation;
- export/import;
- explicit missing-content handling.

---

## 12. Rendering

Canvas 2D remains the default renderer until profiling demonstrates a renderer bottleneck.

Target render layers:

```text
background
walls
liquids-behind
foreground tiles
entities
projectiles
particles
lighting
world overlays/wiring
HUD
menus/tooltips
```

Gameplay modules provide render data/layers. They should not replace `World.draw` or `UI.draw`.

PixiJS/WebGL migration is an optimization decision, not an architectural milestone by itself.

---

## 13. Audio

Simulation/application emits semantic sound/music events. Audio adapter decides synthesis/sample playback, mixing and crossfades.

Do not let biome/enemy code directly construct uncontrolled WebAudio graphs.

---

## 14. Localization

Persistable content definitions reference localization keys rather than storing user-facing English as identity.

```text
item.core.iron_sword.name
npc.core.guide.dialogue.some_hint
ui.inventory.quick_stack
```

Localization is presentation/content metadata, not save identity.

---

## 15. Testing contract

Every new/refactored system should have the lowest-cost suitable proof:

- data/schema validation;
- unit/simulation tests;
- deterministic seed fixture when world-related;
- save round-trip/migration test when persistent;
- Playwright flow when browser integration changes;
- performance measurement when hot-path behavior changes.

Critical invariants:

- no duplicate item/tile gains or losses from one transaction;
- deterministic worldgen remains deterministic;
- persistent content identity never depends on load order;
- old supported saves do not silently reinterpret data;
- new systems do not introduce undocumented monkey patches.

---

## 16. Extension stages

Extensibility should progress in this order:

```text
resource packs
→ declarative data packs
→ capability-limited script mods
```

Resource/data packs use the same validated registries as core content. Script mods are deferred until public APIs and security boundaries are stable.

---

## 17. Multiplayer preconditions

Do not start full multiplayer until:

- simulation runs without Canvas/DOM;
- world mutations are commands;
- entity IDs are stable;
- content/version negotiation exists;
- save ownership is explicit;
- combat/inventory/progression are authoritative transactions.

Target model: authoritative server; clients submit input/commands and receive state replication.

---

## 18. Change rule

Any change that alters one of the following should update this document or create an ADR:

- content ID semantics;
- save schema/migration policy;
- simulation update order;
- command/event authority boundary;
- world storage layout;
- liquid representation;
- renderer strategy;
- multiplayer authority model;
- mod security/capability model.

Architecture documentation is part of the implementation contract, not post-hoc commentary.