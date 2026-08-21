# Feature Gap Analysis

This document compares the current repository with the **kind of systemic experience** associated with modern Terraria. It is not an instruction to copy Terraria content or assets one-for-one.

Ratings:

- **Strong:** mature enough to extend rather than redesign.
- **Functional:** playable foundation exists but lacks depth/integration.
- **Partial:** meaningful implementation exists but major mechanics are absent or isolated.
- **Missing:** no sufficiently complete system identified in the audit.

## Summary matrix

| Area | Current | Target | Priority |
|---|---|---|---|
| Core sandbox loop | Strong | Preserve and deepen | P0/P1 |
| Module integration | Partial | Explicit bootstrap/services/events | P0 |
| Stable content IDs | Partial | Namespaced IDs + runtime indexes | P0 |
| Save/versioning | Functional | Versioned schemas/migrations/backups | P0 |
| Automated testing | Partial | Unit/simulation/browser/regression suites | P0 |
| World generation | Strong prototype | Named pass pipeline + richer contexts | P1 |
| Tile geometry | Functional | Platforms/slopes/half-blocks/framing | P1 |
| Player traversal | Functional | Hooks + composable mobility + terrain feel | P1 |
| Liquids | Functional | Independent type/volume layer | P1 |
| Inventory | Functional | Specialized slots + strong QoL | P1 |
| Crafting | Functional | Tags/stations/conditions/search | P1 |
| Combat | Strong but fragmented | Unified damage/stat/status architecture | P1 |
| Projectiles | Strong | Promote as canonical subsystem | P0/P1 |
| Magic | Strong isolated module | Integrate with shared combat/save/UI | P1 |
| Accessories/buffs | Strong isolated module | Integrate with stat/equipment contracts | P1 |
| Fishing | Strong isolated module | Persist/integrate with biome/progression | P1 |
| Enemies/bosses | Strong breadth | Data-driven progression/loot/AI contracts | P1 |
| Town NPCs/housing | Partial | Generic housing/town/shop/services | P1 |
| Wiring/mechanisms | Strong isolated module | Explicit wire layer + event contracts | P1 |
| Lighting | Functional | RGB/dynamic/quality modes | P2 |
| Art/animation | Functional procedural | Original authored pipeline + procedural fallback | P2 |
| Audio/music | Functional procedural | Original adaptive authored/synth hybrid | P2 |
| Localization | Missing/partial | Keyed message catalogs | P1 |
| Multiplayer | Missing | Authoritative simulation/network layer | P2/P3 |
| Resource/data packs | Missing | Stable declarative content extension | P2 |
| Script mods | Missing | Sandboxed late-stage API | P3 |

---

## 1. World generation and exploration

### Current state

`worldgen.js` is deterministic and already goes beyond basic terrain. Its header describes edge oceans/beaches, overhauled deserts, evil-biome strips, surface dungeon content and hell temples. It also dynamically extends tile/wall/item tables for some of those additions.

### Terraria-like systemic target

The important reference is not the exact placement algorithm but the **pass-oriented structure** and the way world context connects to the rest of the game. The official Terraria wiki documents a long sequence of generation passes, each responsible for a portion of terrain/structures.

Target capabilities:

- named generation passes with deterministic inputs/outputs;
- surface, underground, cavern, underworld/deep layers;
- meaningful vertical resource/progression gradients;
- biome masks/context queries independent of visual tile colors;
- micro-biomes and structures;
- guaranteed critical progression resources/structures;
- spawn safety and reachable early resources;
- post-generation validation;
- world variants/secret-seed-like rule sets only after the normal pipeline is stable;
- progression-driven world mutations later.

### Gap

**Moderate.** Generation breadth is already strong, but architecture must become more composable before significantly more passes are added.

### Acceptance examples

- Given seed X and generation version Y, generated checksums/invariants match across runs.
- Every pass reports timing and changed-region metadata.
- Required landmarks satisfy minimum-distance and reachability constraints.
- Biome identity can be queried by gameplay systems without inspecting arbitrary render colors.

Reference: https://terraria.wiki.gg/wiki/World_generation

---

## 2. Blocks, walls, platforms, slopes and framing

### Current state

The game supports solid tiles, mining, placement and background walls. Definitions include hardness/tool/drop/pattern-style metadata.

### Target

Add tile shape and adjacency as first-class concepts:

```text
shape: full | platform | half | slope_ne | slope_nw | slope_se | slope_sw
```

Then build:

- one-way platforms;
- hammer/shaping action;
- half-block collision;
- slope collision and smooth walking;
- adjacent-tile visual framing;
- furniture multi-tile footprints;
- support rules and break propagation;
- inactive/actuated collision state without changing content identity.

The official Terraria wiki notes that most solid blocks can be shaped into half-blocks and slopes. These mechanics strongly affect moment-to-moment traversal and building feel.

### Gap

**High perceptual gap / P1.** Improving terrain geometry will make the game feel more advanced than adding dozens of decorative blocks.

Reference: https://terraria.wiki.gg/wiki/Blocks

---

## 3. Player physics and movement

### Current state

Core gravity, horizontal movement, jumping, collisions, fall handling and water movement are already playable.

### Target layers

1. **Base locomotion** — acceleration/deceleration, jump curves, coyote/buffer behavior only if consistent with chosen feel.
2. **Terrain locomotion** — platforms, slopes, half-blocks, ladders/ropes if added.
3. **Mobility equipment** — run-speed modifiers, double jumps, wings/flight equivalents, fall protection, water movement.
4. **Hook/grapple system** — projectile/anchor behavior, rope constraints, detach/re-attach.
5. **Status effects** — slow, knockback, confusion-like input transforms only through explicit modifiers.

### Gap

**Moderate.** The basics exist; composability and terrain geometry are missing.

### Rule

Do not hard-code every accessory into `Player.update`. Movement capability providers should contribute to a resolved `MovementState`/stats snapshot.

---

## 4. Liquids

### Current state

The game has water/lava-style behavior and swimming/breath-related features, but liquid representation is too tightly coupled to foreground tile identity for full Terraria-like behavior.

### Target

A liquid cell needs at least:

```js
{ type: WATER | LAVA | HONEY | SPECIAL, amount: 0..255 }
```

or a compact equivalent.

Required mechanics:

- partial amount/volume;
- downward flow and lateral equalization;
- settling queue rather than whole-world scan per frame;
- different flow rates/types;
- player buoyancy and breath based on actual fill level;
- liquid contact interactions;
- buckets and later pumps;
- rendering of partial surfaces and falls;
- persistence separate from foreground blocks.

The official Terraria wiki explicitly describes partial liquid tiles and differing flow speeds. That is the strongest reason not to continue modeling every liquid solely as a normal foreground block.

### Gap

**Architecturally significant / P1.** Implement before more liquid types or complex pumps.

Reference: https://terraria.wiki.gg/wiki/Liquids

---

## 5. Inventory and equipment

### Current state

The repository has an inventory/hotbar/chest gameplay loop and accessory work already exists.

### Target

- normal inventory slots;
- hotbar mapping;
- dedicated equipment/armor/accessory slots;
- optional ammo/coin/material conveniences;
- trash slot;
- stack split/quick transfer;
- quick stack/deposit all/sort;
- favorite/lock item semantics;
- chest naming/search later;
- keyboard/mouse shortcuts with discoverable hints;
- stable item IDs and item-instance metadata such as prefix/modifier.

### Gap

**Functional but needs QoL and schema normalization.**

---

## 6. Crafting

### Current state

`crafting.js` and `TC.RECIPES` provide a working recipe loop.

### Target recipe schema

```js
{
  id: 'core:iron_sword',
  output: { item: 'core:iron_sword', count: 1 },
  ingredients: [
    { tag: 'core:iron_bar', count: 8 }
  ],
  stations: ['core:anvil'],
  conditions: ['near:water'],
  unlock: null
}
```

Required engine features:

- item/tag ingredients;
- station tags;
- environment conditions;
- recipe indexing so UI does not scan everything expensively each frame;
- search/filter and craftable-only view;
- recipe discovery/guide behavior if desired;
- deterministic craft transaction;
- optional nearby-storage crafting only as a later design choice.

Official Terraria references show crafting depends heavily on nearby stations and environmental conditions, including liquids.

### Gap

**Moderate / P1.** Upgrade schema before recipe count explodes.

Reference: https://terraria.wiki.gg/wiki/Crafting_station

---

## 7. Combat classes, stats and hit resolution

### Current state

The game has `combat.js`, a strong pooled `projectiles.js`, `magic.js`, accessories/buffs, enemies and bosses. The ingredients for deep combat exist, but responsibilities overlap.

### Target shared model

`DamageClass` should be data, not separate combat engines:

```text
melee
ranged
magic
summon (future)
generic/environmental
```

Derived stat pipeline:

```text
base character stats
→ equipment
→ accessories/prefixes
→ buffs/debuffs
→ temporary world/event modifiers
→ resolved immutable frame snapshot
```

Shared hit transaction:

```text
attack intent
→ target acquisition/collision
→ immunity checks
→ base damage
→ class/global modifiers
→ defense/penetration
→ variance/crit
→ knockback/status
→ damage event + feedback
```

### Gap

**High architectural priority despite strong feature breadth.**

`projectiles.js` should survive this migration and become the single projectile simulation service.

---

## 8. Enemy AI, bosses and events

### Current state

`enemies.js` is one of the larger modules and already contains numerous enemies and bosses plus event-related behavior.

### Target

Separate:

- enemy definitions/stats/loot;
- reusable movement/AI behaviors;
- spawn rules by biome/time/depth/event/progression;
- boss state machines;
- encounter controllers;
- loot tables;
- progression consequences;
- bestiary/metadata later.

Boss design should be validated through telemetry-like debug counters: phase duration, damage sources, player hit frequency, despawn causes, projectile count, and arena assumptions.

### Gap

**Content breadth strong; architecture and progression integration need work.**

---

## 9. Fishing

### Current state

`fishing.js` already provides rods, bait, bobber simulation, bite timing, zone loot, crates and daily quest fish. Its header explicitly states that its serialized quest/catch state is **not yet wired into `save.js`**, so some state resets on reload.

### Target

- save integration through registered serializer, not a save wrapper;
- biome/depth/liquid context service;
- data-driven catch tables;
- fishing power/luck calculation through shared stats;
- progression gating and crates;
- quest state keyed to world/day and stable NPC/service identity;
- lava/honey/special liquid compatibility only after liquid layer is stable.

### Gap

**Mechanically strong; integration incomplete.** This is a high-value early migration showcase.

---

## 10. Magic, accessories, buffs and prefixes

### Current state

`magic.js` implements mana, mana regeneration, consumables, weapons/projectiles and HUD stars. `accessories.js` implements five accessory slots, stat modifiers, multiple buffs/debuffs, consumables and a prefix/reforge stub.

Both modules self-integrate by wrapping existing runtime functions.

### Target

- mana as a normal character resource component;
- magic weapons using canonical item/use/projectile paths;
- accessory slots as canonical equipment storage;
- modifier aggregation through stat providers;
- buff engine as a general status-effect service;
- prefixes as item-instance modifiers, not module-specific metadata;
- one HUD layer API rather than wrapping `UI.draw`.

### Gap

**Feature-rich, architecture-fragmented.** Integrate rather than rewrite from scratch.

---

## 11. NPCs, housing and towns

### Current state

Town functionality is much thinner than enemy/boss functionality; research found NPC code still centered on the Guide archetype.

### Target

A generic NPC definition should include:

```text
stable id
unlock/spawn conditions
housing requirements
home assignment
shop/service provider
biome/town preferences (optional)
dialogue localization keys
combat/defense behavior
respawn rules
serialization state
```

Housing engine should validate enclosed space, background wall coverage, furniture requirements, access/safety, occupied state and assignment.

### Gap

**Large / P1.** Town systems are one of the strongest progression/exploration multipliers.

---

## 12. Wiring and mechanisms

### Current state

`wiring.js` is substantial: BFS signal propagation, switches, levers, pressure plates, timers, dart traps and actuators. However, it extends tile/item/recipe tables and patches multiple world/player/save/lifecycle methods.

It currently models wire as tile content. The official Terraria wire system uses its own placement layer, allowing wire to coexist with blocks/walls/furniture/liquids.

### Target

- dedicated wire bitfield/layer per cell;
- multiple wire channels/colors if desired;
- device registry with input/output hooks;
- pulse transaction queue with cycle protection;
- actuator state as tile metadata/component;
- save serializer provider;
- debug overlay layer;
- pumps integrated with future liquid service.

### Gap

**Mechanically strong but needs structural migration.**

Reference: https://terraria.wiki.gg/wiki/Wire

---

## 13. Lighting and visual atmosphere

### Current state

A lighting module exists; projectile code already exposes dynamic-light hooks. Visuals are procedurally drawn.

### Target

- RGB light channels;
- emissive sources from tiles/entities/projectiles;
- dirty chunk/region propagation;
- sunlight/skylight model;
- quality presets;
- biome backgrounds and parallax;
- weather/ambient particles;
- hit flashes, trails and screen shake with accessibility toggles;
- original sprite/animation pipeline.

### Gap

**Moderate / P2.** Architecture already provides useful starting points.

---

## 14. Audio and music

### Current state

Audio is synthesized with WebAudio and music has its own module.

### Target

- event-driven SFX API;
- category buses and volume controls;
- biome/time/event/boss music state machine;
- crossfades and priority arbitration;
- original authored audio optional alongside synth assets;
- no per-frame uncontrolled node creation.

### Gap

**Functional base; polish opportunity.**

---

## 15. Persistence

### Current state

`save.js` stores local data under a fixed key and version. It regenerates a deterministic baseline world and stores differences, a useful compact strategy. Feature integration is uneven.

### Target

- world vs character separation;
- schema version and generation version;
- registered subsystem serializers;
- migrations;
- stable namespaced IDs;
- backup before destructive migration;
- export/import as a portable file;
- corruption detection and recovery path;
- migration fixture tests.

### Gap

**P0.** Save compatibility becomes more expensive with every new content system.

---

## 16. Multiplayer

### Current state

No complete network-authoritative architecture was identified.

### Target only after simulation separation

- authoritative server owns world mutation, combat, NPC AI, loot and progression;
- clients send input/commands rather than arbitrary state;
- snapshot/delta replication;
- interpolation for remote entities;
- prediction/reconciliation selectively for local movement;
- chunk interest management;
- stable content/version negotiation;
- save ownership and server persistence.

### Gap

**Very large / P2-P3.** Premature networking would magnify current global-state debt.

---

## 17. Localization

### Current state

Strings are largely embedded in JavaScript/data definitions.

### Target

Use keys:

```text
item.core.iron_sword.name
enemy.core.green_slime.name
ui.inventory.quick_stack
npc.core.guide.dialogue.early_01
```

Externalize user-visible strings before hundreds of content definitions are added. This also makes original writing easier to audit and prevents Terraria text from being copied casually.

### Gap

**P1 foundational content work.**

---

## 18. Modding/resource packs

### Target stages

1. **Resource packs:** textures, sounds, music, UI skins with manifest/versioning.
2. **Data packs:** items, recipes, loot, enemies, biomes using validated declarative schemas.
3. **Script mods:** only after APIs are stable; run through constrained capability interfaces rather than raw access to all browser globals.

### Gap

**Future work.** Stable IDs and registries are prerequisites.

---

## Recommended definition of “closer to the real thing”

Do not measure progress by percentage of Terraria's item count. Measure it by **interaction coverage and systemic coupling**:

- Can players shape terrain fluidly?
- Does biome/depth context materially change exploration?
- Do movement upgrades change traversal options?
- Does crafting form a discoverable progression graph?
- Do combat classes share rules while feeling distinct?
- Do bosses/events change world progression?
- Do NPCs create reasons to build towns?
- Do liquids/wiring/building interact rather than exist as isolated demos?
- Does the world remain stable after save/load and version upgrades?
- Can new content be added through data/contracts instead of patching the engine?

That is the parity metric this roadmap optimizes.