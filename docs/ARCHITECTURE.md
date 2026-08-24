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

---

## 19. Capability matrix (authoritative state)

This matrix reflects the code that actually exists. When it disagrees with older prose
in this file or in `docs/terraria-parity/*`, this table and the implementation win.
Update it whenever ownership, persistence, events or phases change.

Legend — Persist: SaveCore provider key; Events ▸ produced / ◂ consumed; Phase: update
phase under `TC.Systems` (or `main.js` direct call when noted).

| Module | Canonical responsibility | Public API (abridged) | Persist | Events ▸ / ◂ | Phase |
|---|---|---|---|---|---|
| constants.js (lead) | Shared tuning + TILE/TILE_DEFS/WALL/WALL_DEFS/ITEM_DEFS/RECIPES/ENEMY_DEFS tables | `TC.CONST/TILE/TILE_DEFS/WALL/WALL_DEFS/ITEM_DEFS/RECIPES/ENEMY_DEFS` | — | — | — |
| utils.js | Seeded RNG/hash/noise | `TC.Utils` | — | — | — |
| registry.js | Stable `ns:name` content ids; mirrors shared tables; legacy aliases; validate/fingerprint | `TC.Registry` | fingerprint in envelope | — | boot |
| events.js | Deferred per-frame bus, frozen EVENT names, wildcard, isolated listener errors | `TC.Events` | — | all | eventsFlush |
| systems.js | Update-phase scheduler, render layers, boot tasks | `TC.Systems`, `TC.RenderLayers` | — | — | all |
| commands.js | Canonical validate-then-apply transactions incl. ShopBuy/ShopSell | `TC.Commands.submit` | — | emits per command | commands (future home) |
| savecore.js | Versioned envelope {formatVersion:2}, providers, atomic tmp→bak→swap, migrations | `TC.SaveCore` | owns envelope | — | progression (autosave) |
| save.js | Facade: v2 envelope via SaveCore; legacy v1 blob fallback load; export/import; autosave timer | `TC.Save` | 'world.core'/'character.core' | — | progression |
| worldgen.js | Deterministic named passes v3 (terrain→…→validation), CONFIG flags | `TC.WorldGen.generate` | — | — | load-time |
| world.js | Tile+wall layers, chunk canvases, damage maps, support-pop, liquid import hook | `TC.World` | diffs via save.js | ▸ TileChanged | liquidsWiring |
| tiles.js | Tile/wall/crack rendering, shapes (platform/half/slope), hammer variants | `TC.Tiles` | shapes via world | — | render |
| liquids.js | THE runtime liquid authority: type+amount arrays, settling, buckets, water×lava | `TC.Liquids` | 'world.core.liquids' | ▸ LiquidChanged/InventoryChanged | liquidsWiring |
| lighting.js | Flood-fill light + multiply overlay, dynamic lights pool | `TC.Lighting` | — | ◂ TileChanged | progression |
| sky.js | Day/night clock, celestial draw, daylight() | `TC.Sky` | time via save.js | ▸ DayChanged | environment |
| biomes.js | Player-centered biome detection w/ hysteresis, tints, spawn override, music tag | `TC.Biomes` | — | ▸ (discovery via Progression) | environment |
| input.js | Keyboard/mouse state, uiHover, barrier, cursor draw | `TC.Input` | — | — | input |
| audio.js / music.js | SFX synthesis / generative mood score | `TC.Audio`, `TC.Music` | — | — | environment (music) |
| particles.js | Particle pool + float text | `TC.Particles` | — | — | render |
| items.js | Inventory (50 slots), drops+magnet, icons, Chests containers | `TC.Inventory`, `TC.Items`, `TC.Chests` | chests via 'world.core' | ▸ InventoryChanged | items |
| economy.js | Canonical copper currency; pay/give/drop/format | `TC.Economy` | purse via player | ▸ InventoryChanged | — |
| player.js | Movement/physics, item use switch, armor equip, summons, intake, breath/lava/fall | `TC.Player` | 'character.core' | ◂ many | movement/physics |
| accessories.js | 5 accessory slots + prefixes; TC.Buffs timed statuses; potions | `TC.Accessories`, `TC.Buffs` | 'character.core.accessories' | ▸ BuffApplied/BuffExpired | combat (tick) |
| stats.js | Contributor-based stat resolver (armor/accessories/buffs/crystals), explain() | `TC.Stats` | — | ◂ stat-invalidating events | — |
| magic.js | Mana pool, regen stars, potion sickness, magic weapons | `TC.Magic` | 'character.core.magic' | — | combat |
| fishing.js | Rods+bait→power, bite windows, zone loot, crates, quests | `TC.Fishing` | 'systems.core.fishing' | — | ai |
| enemydefs.js | Enemy/item/recipe content extensions (pure data) | mutates ENEMY_DEFS/ITEM_DEFS/RECIPES at load | — | — | load-time |
| enemyai.js | Reusable AI archetypes (slime/zombie/eye/bat/walker/harpy/stationary/teleporter + boss AIs) | `TC.EnemyAI` | — | — | ai |
| enemyspawn.js | Spawn director, zone tables, Blood Moon lifecycle, findSpot | `TC.EnemySpawn` | — | — | ai |
| enemies.js | Entity lifecycle: makeEnemy/update/contact, damage/death (events), spawnBoss, rendering | `TC.Enemies` | — | ▸ EntityDamaged/EntityKilled/BossDefeated ◂ WorldLoaded | ai |
| npcs.js | NPC kinds, housing validator/claiming, dialog pools, unlock eval, shops | `TC.NPCs` | 'world.core.npcs' | ▸ NpcMovedIn/Entity* | ai |
| projectiles.js | Pooled typed projectiles (arrow/bolt/yoyo/boomerang/grenade/star/dart), explosions, lights | `TC.Projectiles` | — | ▸ ProjectileSpawned | projectiles |
| grapple.js | Hook flight/latch/retract state machine | `TC.Grapple` | — | — | movement/pre+post |
| combat.js | CANONICAL hit resolution (`resolveHit`) + melee arcs, arrows facade, player intake policy | `TC.Combat` | — | — | combat |
| lootables.js | Canonical loot-table roll/validate (chance/min-max/coins/conditions) | `TC.LootTables` | — | — | — |
| loot.js | Pot tiles, life crystals, chest population deterministic post-pass | `TC.Loot` | 'character.core.loot' | ◂ TileBroken | ai |
| crafting.js | Station detection/tags, recipe index, transactional craft | `TC.Crafting` | — | ▸ CraftCompleted | — |
| gear.js | Yoyo/boomerang/grenade/falling-star held-item behaviors | `TC.Gear` | — | — | combat/render |
| minimap.js | Toggleable downscaled map | `TC.MiniMap` | — | — | environment |
| ui.js | Title/HUD/inventory/chest/shop/dialog/pause/death, toasts, boss bar | `TC.UI` | — | ◂ WorldProgressChanged etc. | input |
| wiring.js | Wire tiles, mechanisms, BFS pulses, actuators, trap darts | `TC.Wiring` | 'systems.core.wiring' | ▸ WirePulse ◂ TileChanged | liquidsWiring |
| debug.js | Timings/counters/F3 overlay, `#test` hooks only | `TC.Debug` | — | — | — |
| progression.js | World flag store + declarative condition evaluator (`test`) + spawn multiplier | `TC.Progression` | 'systems.core.progression' | ▸ WorldProgressChanged ◂ BossDefeated | — |

### Known fallback/legacy paths (deliberate)

- `save.js` loads legacy `tc_save_v1` blobs and bridges them into providers
  (`restoreLegacy` on accessories/fishing/magic); v2 envelope is canonical.
- `combat.js` keeps a legacy arrow fallback used only when `TC.Projectiles` is absent;
  the pooled system is canonical.
- WATER/LAVA tile ids exist only as worldgen/save representation, imported once into
  `TC.Liquids` by `main.buildWorld`.
- `debug.js __TEST__` exists exclusively under `location.hash === '#test'`.

### Remaining architectural debt (tracked)

See `docs/TASK_BOARD.md` status column. Highlights: localization layer absent (English strings inline);
render layers registered but main.js still draws via direct calls; command phase not
yet wired into the live step loop for player actions. Wall of Flesh is now a production frontier gateway (W17).

---

## 20. Campaign contracts (W12-W16)

The normative one-liners; module headers carry full detail.

### Combat resolution (combat.js, W12)

`TC.Combat.resolveHit(spec)` is the ONLY damage-math authority: base × class
statField (player-owned attacks only) × variance → crit (snapshot critChance +
bonus) → target mitigation policies (`registerMitigation`) → defense (minus flat
pen; environmental sources fall/void bypass) → floor 1. Inject `spec.rng` for
deterministic tests. Application happens once in `Enemies.damageEnemy` (final
damage), which is also the single EntityDamaged/EntityKilled/BossDefeated site.
Player intake runs the same resolver via `hurtPlayer`; i-frame/dead rejection is
reported as `result.rejected = 'iframes'` without touching hp.

### Status effects (accessories.js TC.Buffs, W13)

BUFF_DEFS rows are the generic schema: `{id, name, good, dur, stack:'refresh',
mods, dps, healPerSec, fromSource, fromSourceDur, color, parts, rate}`. No second
status runtime exists or may be added; combat consults `statusForSource(src)`
instead of hardcoding effect ids. Serialization stays `[[id, secondsLeft], ...]`
inside the accessories provider.

### Enemy definition / AI / spawn split (W13)

Adding an enemy = author a def (enemydefs.js data) + pick `def.ai` from
TC.EnemyAI archetypes (enemyai.js) + optionally a `[type, weight, condition]`
row in enemyspawn.js zone tables + loot on the def (LootTables schema). Bespoke
code is the exception, not the pipeline. enemies.js keeps entities/physics/events.

### Loot schema (lootables.js, W13)

Entry `{id, min=1, max=1, chance=1, requires?}`. Coins as `def.coins [min,max]`.
`roll(table,{rng})` is injectable-rng; `rollEntity(def,cx,cy)` scatters via
Items/Economy exactly once per death; `validateAll()` walks ENEMY_DEFS at boot
and warns on unknown ids / chance outside [0,1] / inverted ranges.

### Progression conditions (progression.js, W14)

`test(cond)` accepts null|bool|flag-string|[all-of]|{all|any|not|flag|boss|event|
biome}; unknown shapes fail closed. Consumers: recipe.requires, NPC unlocks,
shop stock rows, loot entries, spawn-table entries, summon item def.condition.
Boss flags are canonical (BOSS_FLAG incl. storm_jelly, moss_mother) and persist
in systems.core.progression.

### Save impact

No schema version bump: all W12-W16 state rides existing providers (flags array
shape unchanged, statuses unchanged). v1 blobs keep loading via restoreLegacy.

### Test coverage added

resolver.test.js, status.test.js, lootables.test.js, enemy-archetypes.test.js,
conditions.test.js, summon.test.js, journey-i-progression.spec.js (full arc).

---

## 21. Campaign contracts (W17 — Underworld Frontier)

### Summon contract (player.js, W17)

Every summon item declares `summon:{time,biome,requires,placement}` where `time` is `night|day|any` (default `night` for legacy), `biome` is the CURRENT biome (`TC.Biomes.current`, not `biome.X.discovered`), `requires` is the W14 condition grammar, and `placement` selects a custom spawn profile (`underworld_wall` for the Wall). Legacy `condition`/`requires` aliases are honored. `currentBiomeTag()` prefers depth-derived underworld detection to avoid hysteresis lag. Invalid summons (wrong time/biome/progression/duplicate boss/placement failure) emit a clear toast and consume **zero** items; exactly one item is consumed only after `TC.Enemies.spawnBoss` succeeds (or the Blood Moon event starts). Existing night-only bosses retain their `night` gate.

### Wall encounter lifecycle (enemies.js + enemyai.js, W17)

The Wall is a direction-locked, noclip sweeping wall, not a flying tracker. `Player.doSummon` computes an `underworld_wall` placement (`x` at world edge, `y` clamped to the underworld band, `dir` chosen by player side, `band` as `{minY,maxY,centerY}`) and `spawnBoss('wof',x,y,{dir,band})` stores `wofDir/wofBand/wofState/wofPhase/wofEnterTime`. `enemyai.js` `wof` is a state machine: `enter (0.9s, 68 px/s) -> combat (phase1 72 px/s -> phase2 96 px/s at 66% -> phase3 124 px/s at 33%)` with telegraphed attacks (`bolt` single, `fan` 3, `spread` 5 via `TC.Projectiles.spawn('magic_bolt',...,{owner:null})` + `TC.Enemies.trackHostileShot`), bounded servant shedding (phase caps 4/5/6, `spawnServantOf('hungry',...)`), and explicit despawn for `world_unload/player_dead/escaped_biome/escaped_range/world_edge` (no casual edge reversal). Vertical motion stays within `wofBand` with a slight player-tracking lerp and sine wobble. Servants use the dedicated `hungry` archetype (tethered orbit/lunge, `master` link, `tether 132`, `cap 6`, orphan `false` return). `moveAndCollide` treats `wof` as noclip (world-bounds clamp only). `clearHostileShotsOf` and `clearEncounter` ensure no orphan projectiles/servants on despawn/death/quitToTitle/world reset.

### Loot & progression gateway (enemydefs.js + progression.js + biomes.js + npcs.js, W17)

`wof` loot is data-driven via `TC.LootTables` (unique `infernal_core 6-10` + `blood_shard` + `gold_bar` + coins, validated, exactly-once via `killEnemy`). Post-Wall gateway is gated on `boss.wall_of_flesh.defeated` (canonical) plus companion flags `world.infernal_gateway.opened`/`event.underworld_frontier.completed` set by `progression.js` BossDefeated listener. Unlocks: `hellforged_blade`/`infernal_greaves`/`infernal_hook` recipes (`requires: 'boss.wall_of_flesh.defeated'`), Guide `dialogFlags` and Merchant `shopOf` rows gated on the same flag, `Biomes.getSpawnOverride()` underworld post-Wall supplement (`ember_wraith 1.6` when flag set), and `Enemyspawn`/`Biomes`/`Progression.spawnMultiplier` already respect the flag. All ride existing providers; no save-format bump.

### Observability & perf (debug.js + enemies.js + tools/perf-probe-w17-wof.js, W17)

`TC.Enemies.getWofEncounter()` exposes `{state,phase,elapsed,hpFrac,servants,peakServants,peakProjectiles,transitions,despawnReason,dir,hostile}` for `TC.Debug.drawHud` (F3) and `window.__TEST__.getWofEncounter/setWofHp` (#test). `TC.Debug` also counts `wof_despawn_*`. `tools/perf-probe-w17-wof.js` measures `wof AI`, `wof+hungry`, `hostile projectile load`, `full Enemies.update`, `arena placement`, and `Biomes.getSpawnOverride` with hard caps (projectiles 12, servants 6) and no per-frame world scans. Frame budget remains <0.5ms for the encounter.

### Remaining limitations

Localization absent; render-layer dual path with direct draw calls remains; command transactions not yet wired to live
player input. Wall of Flesh is now production-ready; remaining Hardmode-equivalent expansion is deferred.