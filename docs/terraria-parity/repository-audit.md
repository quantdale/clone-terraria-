# Repository Audit

## Audit scope

This document records the repository baseline observed on `main` before any implementation work from this roadmap. It separates **observed codebase facts** from **recommended direction** so later agents can distinguish evidence from planning assumptions.

The repository is `quantdale/clone-terraria-` — including the trailing hyphen.

## 1. Current technical foundation

### Observed

The root `README.md` describes the project as a Terraria-style 2D sandbox survival game built with **vanilla JavaScript and HTML5 Canvas**. It states that graphics are procedurally drawn in code and audio is synthesized using WebAudio, with no external Terraria assets.

The project currently has no required build step or package dependency for basic execution. The documented run paths are opening `index.html` directly or serving the repository through a simple local HTTP server.

The game is organized around browser scripts that populate a shared `window.TC` namespace. Major gameplay/runtime concerns are separated into files under `js/`, but those modules still communicate heavily through shared mutable globals and load order.

### Implication

This is a good low-friction prototype architecture, but it has crossed the size where implicit script contracts are safe. The project should retain browser-first simplicity while gaining a real module graph, validation, tests, and clear dependency direction.

## 2. High-level module inventory

Observed major JavaScript modules include at least:

| Module | Current responsibility / evidence |
|---|---|
| `js/constants.js` | Shared constants, tile/item/recipe definitions and foundational data tables. |
| `js/worldgen.js` | Deterministic procedural generation; now also extends content definitions for cactus, evil biome blocks, dungeon/hell/sandstone content and structures. |
| `js/player.js` | Player movement, interaction, inventory/equipment-related behavior and persistence hooks used by other systems. |
| `js/tiles.js` | Tile rendering/behavior support. |
| `js/items.js` | Item behavior, drops and procedural icons. |
| `js/crafting.js` | Recipe/crafting behavior. |
| `js/combat.js` | Core combat loop and legacy ranged integration. |
| `js/projectiles.js` | Unified preallocated projectile pool supporting arrows, magic bolts, yoyos, boomerangs, grenades, falling stars and wire darts; supports pierce, bounce, homing, explosions, collision and lighting hooks. |
| `js/enemies.js` | Large enemy/boss implementation with biome and event-related content. |
| `js/npcs.js` | Town NPC behavior; research identified this as still centered mainly on the Guide rather than a generic town system. |
| `js/fishing.js` | Rods, bait, bobber simulation, bite/reel loop, zone loot, crates and daily quest fish; header explicitly says quest/catch state is not yet wired into the main save blob. |
| `js/magic.js` | Mana, regeneration stars, potions, magic weapons/projectiles and HUD mana display. Self-installs by wrapping combat, player persistence, UI and item icon behavior. |
| `js/accessories.js` | Five accessory slots, stat modifiers, buffs/debuffs, consumables and a prefix/reforge stub. Wraps player, combat, UI, items and lifecycle functions. |
| `js/wiring.js` | Wires/mechanisms, BFS signal propagation, switches/levers/pressure plates/timers/traps/actuators. Extends shared data and patches World, Player, Items, Save and lifecycle behavior. |
| `js/lighting.js` | Existing lighting/brightness system. |
| `js/minimap.js` | Minimap representation. |
| `js/audio.js` | Synthesized sound effects. |
| `js/music.js` | Procedural/synthesized music behavior. |
| `js/input.js` | Browser input. |
| `js/ui.js` | HUD and UI drawing. |
| `js/save.js` | LocalStorage world/player persistence using deterministic baseline regeneration plus diffs. |
| `js/main.js` | Main lifecycle/bootstrap/session flow. |

The repository also contains smoke/reproduction scripts such as `.magic-smoke.js`, `.magic-repro.js`, `_smoke_accessories.js`, and `_smoke_worldgen.js`, demonstrating that individual features have already required bespoke validation harnesses.

## 3. Strong existing design decisions

### Deterministic generation

`worldgen.js` is deterministic, and `save.js` uses deterministic regeneration as the pristine baseline for world diffs. This is a strong foundation for regression testing, compact persistence, reproducible bug reports and eventual multiplayer world synchronization.

**Keep this property.** Any new world generation pass must accept a deterministic RNG/context rather than use uncontrolled `Math.random()`.

### Pooled projectile architecture

`projectiles.js` is already more sophisticated than a typical early prototype. Its header documents a preallocated pool, multiple motion models, collision, bounce, pierce, homing, explosions and dynamic-light hooks. It should be promoted into the canonical projectile subsystem rather than replaced by class-specific projectile implementations.

### Self-contained advanced features

Fishing, magic, accessories and wiring show substantial independent engineering effort. These modules already define content, simulation behavior, rendering hooks and persistence strategies. The roadmap should preserve their gameplay logic while replacing their integration technique.

### Procedural/original presentation

The project deliberately avoids external copyrighted Terraria assets. That is strategically valuable: the game can improve visually without inheriting asset-provenance risk.

## 4. Architectural debt

### 4.1 Global namespace as service locator

Most systems discover each other through `window.TC`.

**Problem:** dependencies are runtime-implicit. A module can silently assume another module has already initialized specific tables/functions.

**Consequence:** load-order bugs, weak editor/type assistance, difficult isolated testing and accidental circular coupling.

**Recommendation:** introduce ES modules incrementally via Vite. Do not rewrite all files at once. Start with a bootstrap layer that imports legacy modules in a deterministic order, then migrate system boundaries gradually.

### 4.2 Runtime table mutation

`worldgen.js`, `fishing.js`, `magic.js`, `accessories.js` and `wiring.js` add content to shared definition tables at load time.

`worldgen.js` even documents that its appended tile IDs should eventually be promoted into `constants.js`.

**Problem:** persistent numerical identity becomes dependent on script order and table state.

**Recommendation:** content registry with stable namespaced string IDs plus validated registration. Runtime integer indexes may be allocated after all definitions load.

### 4.3 Monkey-patching and function wrapping

`wiring.js` explicitly patches `World.prototype.set`, `setRaw`, `isSolid`, `update`, `draw`, `Player.prototype.interact`, `doPlace`, `Items.iconFor`, `Save.save`, and lifecycle functions. It also documents a mining workaround that clears a tile because the normal mining path allegedly drops the item without clearing the tile.

`magic.js` wraps combat update/draw/clear, player serialization/deserialization, UI draw and icon rendering.

`accessories.js` wraps player defense/update/use/serialization, combat attacks/hurt, icons, UI draw and lifecycle reset behavior.

**Problem:** wrapper ordering becomes semantic. Two modules can overwrite or double-wrap each other. Failures become difficult to localize.

**Recommendation:** explicit extension contracts: commands, events, stat aggregators, render layers, serialization providers and content registries.

### 4.4 Persistence fragmentation

`save.js` has a fixed version (`v: 1`) and uses LocalStorage. Feature modules then either wrap persistence or remain partially outside it. `fishing.js` explicitly states that quest/catch stats reset on reload because its serialization is not wired to the save blob.

**Recommendation:** versioned envelope with separate character/world/system sections and registered serializers/migrations.

Example:

```json
{
  "formatVersion": 3,
  "gameVersion": "0.x",
  "world": {
    "seed": 123,
    "generationVersion": 2,
    "tileDiffs": [],
    "liquids": {},
    "progression": {},
    "systems": {
      "wiring": {},
      "fishing": {}
    }
  },
  "character": {
    "inventory": [],
    "stats": {},
    "equipment": {},
    "systems": {
      "magic": {},
      "buffs": {}
    }
  }
}
```

### 4.5 Feature-local tuning constants

Projectiles, magic, fishing and accessories include module-local balancing numbers and comments suggesting promotion into shared constants.

**Recommendation:** separate immutable content/tuning data from runtime code. Balancing should not require editing simulation control flow.

## 5. Gameplay-system audit

### World generation

**Observed strengths**

- deterministic generation;
- terrain/biome logic already beyond a minimal dirt/stone world;
- oceans/beaches, desert additions, evil-biome content, dungeon and hell-related structures are present in `worldgen.js` according to its header;
- save-diff design benefits from deterministic regeneration.

**Observed/likely constraints**

- generator is still a centralized module accumulating special cases;
- some content definitions are introduced from world generation itself;
- adding later biome-conditioned systems risks coupling generation and runtime content identity.

**Target:** named generation-pass pipeline with pass-level timing, deterministic sub-RNG streams, invariants and snapshot tests.

### Player physics

The game already has core movement, gravity, collisions, fall/swim behaviors sufficient for play. The perceptual gap to Terraria now comes from richer terrain interaction: platforms, slopes, half-blocks, hooks and accessory-driven movement.

**Target:** collision shapes and movement capability composition before attempting fine numeric tuning.

### Liquids

Current liquid behavior is functional, but the research found the representation too tile-centric for long-term Terraria-like behavior.

**Target:** liquid as an independent layer storing type and amount/volume. This enables partial liquid cells, fluid flow and coexistence rules without consuming foreground tile identity.

### Combat

There is a basic `combat.js` plus a much stronger `projectiles.js`, separate `magic.js`, accessories/buffs, and substantial enemies/bosses.

**Target:** one combat ruleset with data-driven `DamageClass`, derived stats, modifiers, immunity windows, crit/variance, knockback, statuses and projectile definitions. Class-specific systems should plug into shared resolution rather than wrap it.

### NPC/town gameplay

Research identified `npcs.js` as much narrower than the enemy system, with the Guide as the primary implemented town archetype.

**Target:** generic NPC definitions, housing validation, spawn/unlock conditions, shops/services, dialogue keys, town happiness/biome context if desired, safe serialization and respawn rules.

### Crafting and inventory

The project has a functional prototype loop but needs a content-query architecture before recipe volume grows.

**Target:** recipe ingredients by item/tag, station tags, world/environment conditions, search/filter, craftable-state queries, storage-aware crafting as a later QoL feature, explicit coin/ammo/equipment/accessory areas where appropriate.

### Lighting

Existing `lighting.js` gives a usable baseline and `projectiles.js` already exposes future dynamic-light hooks.

**Target:** dirty-region RGB light propagation with configurable quality levels; preserve a low-cost fallback.

### Audio and visuals

Procedural drawing and WebAudio synthesis keep the project original and dependency-free, but cap authored polish.

**Target:** support an original authored asset pipeline while retaining procedural fallback/debug visuals.

## 6. Testing audit

### Observed

The repository contains purpose-built smoke scripts for worldgen, magic and accessories. This is evidence that deterministic/testable seams already exist in places, but validation is fragmented rather than being a single repeatable suite.

### Gaps

- no unified package-level test command identified;
- no stable CI gate identified;
- no standard browser end-to-end flow identified;
- smoke scripts can silently diverge from production wiring;
- persistence migrations are not yet a first-class test concern;
- visual and performance regressions are not automatically bounded.

### Target

- Vitest for pure/data/simulation tests;
- Playwright for Chromium/Firefox/WebKit browser flows where feasible;
- fixed world seeds and golden invariants;
- save fixtures for every historical schema;
- screenshot comparisons only for stable, intentionally deterministic scenes;
- performance budgets captured as benchmark data, not subjective claims.

## 7. Performance audit direction

Do not assume Canvas 2D is the bottleneck. The current game can improve significantly before a renderer migration.

Instrument first:

- frame/update/render duration;
- tile draw count and offscreen culling;
- lighting cells recalculated per frame;
- entity/enemy/projectile collision checks;
- allocations per frame and garbage-collection spikes;
- world-generation pass timing;
- save serialization size/time;
- particle count/pool utilization.

A PixiJS/WebGL migration should be considered only if profiling shows rendering throughput—not simulation or lighting—is the limiting factor.

## 8. Immediate audit-derived action list

1. Freeze a module/capability map.
2. Add a build/test wrapper without changing game behavior.
3. Add deterministic worldgen tests around known seeds.
4. Create stable content registry and migration plan.
5. Create serializer registration rather than save-function wrapping.
6. Introduce commands/events/render layers/stat providers.
7. Move extension-table definitions out of gameplay modules.
8. Integrate fishing persistence.
9. Remove the wiring mining workaround by fixing the canonical mining transaction.
10. Make `projectiles.js` the sole projectile lifecycle implementation.
11. Fold magic/accessories into shared combat/stat systems.
12. Only then begin high-volume terrain, item, NPC and biome expansion.

## 9. Audit verdict

The codebase is **feature-rich but integration-fragile**. That is a favorable position: there is meaningful gameplay to preserve, and the primary problem is tractable engineering rather than a missing game.

The roadmap should therefore spend early effort on architecture and proof infrastructure even though those changes are less visually impressive. Doing so converts every later content feature from a risky patch into a predictable data/system addition.