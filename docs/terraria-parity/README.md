# Terraria-Parity Improvement Master Plan

**Repository:** `quantdale/clone-terraria-`  
**Audit date:** 2026-08-21  
**Scope:** documentation and implementation planning only  
**Target:** substantially improve mechanical depth, presentation, cohesion, reliability, and extensibility while keeping original code/assets and avoiding a literal copyrighted-content clone.

## Executive conclusion

The project has reached the point where adding more isolated features is no longer the fastest route to a better game.

The codebase already contains a strong breadth of systems: deterministic world generation, tile mining and placement, walls, movement, enemies and bosses, projectiles, crafting, inventory/chests, persistence, lighting, minimap, audio/music, fishing, magic, accessories/buffs, and wiring. Several of the newest systems are sophisticated in isolation.

The weakness is that the architecture still resembles a fast prototype: a shared global `window.TC` namespace, script-order coupling, mutable global definition tables, numerical IDs, self-installing wrappers, and feature-specific persistence hooks. That pattern will make every additional biome, item, boss, liquid, NPC, mechanism, or multiplayer feature progressively harder to reason about.

**The next major phase should turn the prototype into a coherent sandbox platform.**

## Product goal: resemblance by systems, not copied content

The project should aim for the reasons Terraria feels deep rather than for an exact inventory of Terraria content.

A successful target has:

- a deterministic, layered, discoverable world;
- multiple biomes whose identity affects terrain, enemies, loot, music, fishing, NPCs, weather/events, and progression;
- responsive movement combined with platforms, slopes/half-blocks, fall rules, water movement, grappling, and mobility accessories;
- strong mining/building feedback and reliable placement rules;
- a deep crafting loop driven by ingredients, stations, conditions, nearby resources, and recipe discovery/search;
- coherent melee/ranged/magic/summon-style combat concepts using common hit, crit, defense, status, projectile, and stat rules;
- persistent characters/worlds with migration-safe content identities;
- towns, housing, shops/services, progression gates, bosses and world-state changes;
- expressive lighting, particles, backgrounds, sound, music and UI feedback;
- performance that remains stable as entity/tile/content counts increase;
- architecture that can eventually support multiplayer, resource packs, data packs, localization and mods.

## Architectural principle

Every major gameplay action should have a supported path through the game instead of relying on one module replacing another module's functions.

Target dependency direction:

```text
Presentation
  Canvas/Pixi renderer, HUD/UI, audio, particles, camera
        │
        ▼
Application
  session, game state, commands, orchestration, progression
        │
        ▼
Simulation Core
  world, entities, physics, combat, crafting, biomes, liquids
        │
        ▼
Adapters
  browser input, persistence, asset loading, networking
```

Content should live behind registries and schemas instead of ad-hoc script mutation.

Persistent IDs should be stable strings, for example:

```text
core:dirt
core:stone
core:iron_bar
core:green_slime
core:guide
```

Compact integer indexes are still appropriate inside hot runtime arrays, but they should be derived runtime values rather than save-file identities.

## The eight workstreams

### 1. Foundation and integration

Introduce a reproducible development/build environment, explicit module/bootstrap graph, validation of content definitions, stable IDs, events/commands, save schemas/migrations, and a real automated test harness.

This is P0 because every later system benefits from it.

### 2. World, tiles and traversal

Refactor world generation into named deterministic passes. Add platform semantics, half-block/slope shape data, better collision resolution, tile framing/adjacency, richer underground strata, micro-biomes, structures, traps, environmental context, and later progression-driven world changes.

### 3. Liquids and environment

Move liquid state out of foreground tile identity. Support type + volume, partial cells, settling/flow, interactions, swimming/breath rules, buckets/pumps, and renderer effects. This prevents the current representation from blocking later world depth.

### 4. Combat and progression

Consolidate the existing melee/ranged/projectile/magic/accessory/buff implementations around shared damage classes, stats, status effects, hit resolution and projectile definitions. Then build encounter progression, loot tables, boss gates, difficulty curves and world-state transitions.

### 5. Inventory, crafting and towns

Move toward typed inventory slots, equipment/accessory areas, stack/sort/deposit conveniences, recipe queries, crafting conditions and station tags. Generalize the current NPC implementation into housing, town state, shops and services.

### 6. Presentation and UX

Keep Canvas 2D until profiling proves it is insufficient. Improve camera feel, animation, tile framing, RGB/dynamic lighting, backgrounds, particles, hit feedback, UI information hierarchy, original pixel-art production and original adaptive music/SFX.

### 7. Reliability and performance

Create deterministic regression seeds, browser integration tests, save migration fixtures, performance budgets, instrumentation and benchmark scenarios. Optimize measured hot paths: visible tile traversal, lighting invalidation, entity broad phase, particle pools, allocation pressure and world-generation passes.

### 8. Multiplayer and extensibility

Only after simulation boundaries are explicit: prototype an authoritative server, state replication and reconciliation. Resource packs and data packs can come earlier than arbitrary scripting; full mod scripting should be treated as a late security/API-stability commitment.

## Priority order

### P0 — make future development safe

- Capability matrix and architecture snapshot.
- Vite development/build layer without changing gameplay behavior.
- Incremental JS type checking (`allowJs`/`checkJs` or JSDoc contracts).
- Vitest simulation tests and Playwright browser flows.
- Stable namespaced content registry.
- Explicit bootstrap/module registration.
- Versioned save envelope + migrations + backup/export.
- Commands/events instead of new monkey patches.
- Integrate or retire existing self-installing wrappers.
- Determinism tests for world generation.

### P1 — highest perceptual return

- Platforms, slopes/half-blocks and robust collision.
- Independent liquid layer.
- Named world-generation passes and richer biome contexts.
- Unified combat/stat/status/projectile model.
- Inventory/crafting QoL and conditions.
- Generic NPC/town/housing system.
- Progression flags, boss/event gates and coherent loot.
- Localization keys before mass content expansion.

### P2 — depth and polish

- RGB/dynamic lighting and configurable quality modes.
- Original authored sprite/animation/audio pipeline.
- Richer backgrounds/weather/ambience.
- Additional biomes, bosses, NPCs, events and structures using stable data schemas.
- Multiplayer vertical slice.
- Resource packs/data packs.

### P3 — mature platform

- Broader multiplayer scale/hardening.
- Sandboxed script mods only after API contracts stabilize.
- Advanced world variants/seeds and community content tooling.
- Long-tail accessibility, replay/debug tooling and content-authoring utilities.

## What not to do

1. **Do not add hundreds of items first.** It creates data and balancing debt on unstable identities.
2. **Do not rewrite the entire engine.** Migrate incrementally behind compatibility adapters.
3. **Do not migrate to WebGL/WebGPU solely for appearance.** Profile Canvas 2D first.
4. **Do not persist raw runtime array indexes as the long-term save contract.**
5. **Do not let every feature patch `Player`, `World`, `Save`, `UI`, and `Combat`.** Establish supported extension points.
6. **Do not start multiplayer by synchronizing the current global browser state.** Separate simulation from presentation first.
7. **Do not use Terraria artwork, music, code, text, logos, or extracted data as production assets.** Reproduce mechanics through independently implemented systems and original content.

## Milestone gates

A milestone is complete only when:

- implementation is integrated into the normal boot path;
- save/load behavior is specified and tested when persistent state is affected;
- deterministic systems have regression fixtures;
- browser flows have at least one automation path;
- performance-sensitive work has before/after measurements;
- content definitions pass schema/registry validation;
- no new undocumented runtime monkey patch is introduced;
- documentation and task board are updated.

## Key repository-specific observation

`projectiles.js` is already a unified pooled projectile system with multiple motion models, collision, pierce, bounce, homing, explosions and lighting hooks. It should become the canonical projectile core rather than being replaced.

`magic.js`, `accessories.js`, `fishing.js` and `wiring.js` contain valuable feature work, but their headers explicitly document runtime wrapping, table extension, script-order requirements or persistence gaps. The roadmap treats those modules as assets to **integrate**, not prototypes to discard.

`worldgen.js` is deterministic and has already expanded into oceans, desert structures, evil biome content, dungeon/hell structures and runtime definition extension. It should be split into named passes and driven by registries rather than allowed to accumulate more special cases in one module.

`save.js` already uses deterministic baseline regeneration and world diffs, which is a useful concept. The required next step is a versioned schema with stable content identity, feature-owned migration data and corruption recovery/export rather than throwing the approach away.

## Research baseline

The official Terraria wiki documents pass-oriented world generation, block shaping, independent wire placement, partial-volume liquids, station/condition-driven crafting and a broad set of interconnected gameplay systems. Re-Logic's July 2026 State of the Game still described 1.4.5.7 as under development, so this package avoids treating unreleased 1.4.5.7 details as fixed parity requirements.

References:

- https://terraria.wiki.gg/wiki/World_generation
- https://terraria.wiki.gg/wiki/Blocks
- https://terraria.wiki.gg/wiki/Liquids
- https://terraria.wiki.gg/wiki/Wire
- https://terraria.wiki.gg/wiki/Crafting_station
- https://forums.terraria.org/

## Next document

Proceed to [`repository-audit.md`](./repository-audit.md) for the codebase-specific baseline, then [`feature-gap-analysis.md`](./feature-gap-analysis.md) and [`roadmap.md`](./roadmap.md).