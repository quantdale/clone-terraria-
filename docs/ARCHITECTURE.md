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

Canonical order (declared in `js/systems.js` `PHASES`, driven by `TC.Runtime.tick` →
`TC.Systems.updateAll`):

```text
input         TC.UI.update (runs on title too) + player-intent creation
commands      TC.Commands queue drain (transactions execute here)
environment   TC.Sky, TC.Biomes
movement      Grapple pre → Player.update → grapple post → Loot
physics       collision resolution (folded into entity updates today)
projectiles   (driven inside combat/core.combat via TC.Projectiles)
ai            Fishing → spawn director → Enemies → NPCs
items         TC.Items magnet/pickup
combat        core.combat (projectiles) → accessories/buffs → gear → magic → particles
liquidsWiring World.update → wiring → liquids
progression   Lighting → Music → MiniMap → autosave
eventsFlush   drain the deferred event queue after all mutation
```

Systems may declare `when(state)` gates; production gates simulation systems to
`playing && !UI.paused` (pause freezes the world; UI and event flush keep running).
Registration order breaks ties within a phase; `after`/`before` constraints refine it.
The browser host (`main.js`) registers systems and drawers but does not sequence them;
headless consumers call `TC.Runtime.createWorld/advanceTicks` directly.

Changes to authoritative ordering must be documented here and regression-tested
(`tests/core/runtime-authority.test.js`).

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

Persistable content definitions reference localization keys rather than storing user-facing English as identity. Since W20 this section is IMPLEMENTED — see §24 for the authoritative contract.

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
| systems.js | Update-phase scheduler (THE production authority), render layers, boot tasks, per-system/drawer counters | `TC.Systems`, `TC.RenderLayers` | — | — | all |
| runtime.js | Canonical fixed-step host + headless boundary (tick/advanceTicks/createWorld/reset/getState), state gating, camera follow | `TC.Runtime` (`TC.Simulation`) | — | — | host |
| commands.js | Canonical validate-then-apply transactions incl. ShopBuy/ShopSell + deterministic FIFO queue drained in the commands phase | `TC.Commands.submit/enqueue/drain/pending/clearQueue/stats` | — | emits per command | commands (live) |
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
| settings.js (W20) | Versioned user-preference store (`tc_settings_v1`), corrupt-safe, outside world saves | `TC.Settings` | localStorage envelope | — | — |
| localization.js (W20) | THE translation authority: catalogs, fallback/interpolation/plural, contentName via registry, pseudo-locale (#test), validate/stats | `TC.Localization` | locale pref via TC.Settings | ▸ LocaleChanged | — (call-time) |
| locales/en.js (W20) | Canonical English fallback catalog: UI, templates, dialogue keys, all display names/descriptions | registers 'en' | — | — | load-time |
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
- Legacy English `def.name` fields remain frozen IDENTITY metadata (registry
  derives stable ids from them); presentation resolves text through
  TC.Localization instead. `en-XA` exists only under '#test'.

### Remaining architectural debt (tracked)

See `docs/TASK_BOARD.md` status column. Highlights: real secondary-language
catalogs are not yet authored (engine + validator accept them as-is);
RTL/complex-script typography is deferred (see §24). The former dual
update/render paths are closed: the scheduler,
command phase and render layers ARE the production path (W18 convergence); remaining
legacy fallbacks are deliberate compatibility seams (direct `useHeld`/`interact` when
commands module absent; guarded legacy tick sequence when systems.js is absent).
Wall of Flesh is a production frontier gateway (W17).

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

Every summon item declares `summon:{time,biome,requires,placement}` where `time` is `night|day|any` (default `night` for legacy), `biome` is the CURRENT biome (`TC.Biomes.current`, not `biome.X.discovered`), `requires` is the W14 condition grammar, and `placement` selects a custom spawn profile (`underworld_wall` for the Wall). Legacy `condition`/`requires` aliases are honored. Since W19 the underworld check routes through the ONE shared pure query `TC.Biomes.isUnderworldAt` (see §23) so validation can never drift from encounter lifecycle or spawn zoning. Invalid summons (wrong time/biome/progression/duplicate boss/placement failure) emit a clear toast and consume **zero** items; exactly one item is consumed only after `TC.Enemies.spawnBoss` succeeds (or the Blood Moon event starts). Existing night-only bosses retain their `night` gate.

### Wall encounter lifecycle (enemies.js + enemyai.js, W17)

The Wall is a direction-locked, noclip sweeping wall, not a flying tracker. `Player.doSummon` computes an `underworld_wall` placement (`x` at world edge, `y` clamped to the underworld band, `dir` chosen by player side, `band` as `{minY,maxY,centerY}`) and `spawnBoss('wof',x,y,{dir,band})` stores `wofDir/wofBand/wofState/wofPhase/wofEnterTime`. `enemyai.js` `wof` is a state machine: `enter (0.9s, 68 px/s) -> combat (phase1 72 px/s -> phase2 96 px/s at 66% -> phase3 124 px/s at 33%)` with telegraphed attacks (`bolt` single, `fan` 3, `spread` 5 via `TC.Projectiles.spawn('magic_bolt',...,{owner:null})` + `TC.Enemies.trackHostileShot`), bounded servant shedding (phase caps 4/5/6, `spawnServantOf('hungry',...)`), and explicit despawn for `world_unload/player_dead/escaped_biome/escaped_range/world_edge` (no casual edge reversal). Vertical motion stays within `wofBand` with a slight player-tracking lerp and sine wobble. Servants use the dedicated `hungry` archetype (tethered orbit/lunge, `master` link, `tether 132`, `cap 6`, orphan `false` return). `moveAndCollide` treats `wof` as noclip (world-bounds clamp only). `clearHostileShotsOf` and `clearEncounter` ensure no orphan projectiles/servants on despawn/death/quitToTitle/world reset.

### Loot & progression gateway (enemydefs.js + progression.js + biomes.js + npcs.js, W17)

`wof` loot is data-driven via `TC.LootTables` (unique `infernal_core 6-10` + `blood_shard` + `gold_bar` + coins, validated, exactly-once via `killEnemy`). Post-Wall gateway is gated on `boss.wall_of_flesh.defeated` (canonical) plus companion flags `world.infernal_gateway.opened`/`event.underworld_frontier.completed` set by `progression.js` BossDefeated listener. Unlocks: `hellforged_blade`/`infernal_greaves`/`infernal_hook` recipes (`requires: 'boss.wall_of_flesh.defeated'`), Guide `dialogFlags` and Merchant `shopOf` rows gated on the same flag, the underworld post-Wall spawn supplement (`ember_wraith`, declared with the shared `[type, weight, condition]` grammar since W19 — see §23), and `Enemyspawn`/`Biomes`/`Progression.spawnMultiplier` already respect the flag. All ride existing providers; no save-format bump.

### Observability & perf (debug.js + enemies.js + tools/perf-probe-w17-wof.js, W17)

`TC.Enemies.getWofEncounter()` exposes `{state,phase,elapsed,hpFrac,servants,peakServants,peakProjectiles,transitions,despawnReason,dir,hostile}` for `TC.Debug.drawHud` (F3) and `window.__TEST__.getWofEncounter/setWofHp` (#test). `TC.Debug` also counts `wof_despawn_*`. `tools/perf-probe-w17-wof.js` measures `wof AI`, `wof+hungry`, `hostile projectile load`, `full Enemies.update`, `arena placement`, and `Biomes.getSpawnOverride` with hard caps (projectiles 12, servants 6) and no per-frame world scans. Frame budget remains <0.5ms for the encounter.

### Remaining limitations

Localization absent. Wall of Flesh is production-ready; remaining Hardmode-equivalent
expansion is deferred.

---

## 22. Campaign contracts (W18 — Runtime Authority Convergence)

### Canonical runtime (runtime.js + systems.js, W18)

`TC.Runtime.tick(dt)` is the ONE fixed-step host: the browser rAF loop and headless
tests both drive it; it executes `TC.Systems.updateAll` exclusively (a guarded legacy
direct-call sequence remains only for embeds without js/systems.js). Systems carry
`when(state)` gates: title/pause run only `input/ui`, `input/player-intent` (playing-
gated) and `eventsFlush/core.flush`; pause genuinely freezes the simulation (intentional
semantic fix — enemies/time-of-day/autosave halt while paused). Observability:
`Runtime.getState()` (read-only snapshot incl. per-tick system counts and render-layer
counters), F3 line `tick N phase X cmds p/ok rej R`, `__TEST__.getRuntimeState`
(#test only).

### Command intake (commands.js, W18)

Discrete player mutations flow input/UI → intent → `TC.Commands.enqueue(name, ctx)` →
drain in the scheduler's commands phase → canonical transaction → events. Queue
contract: FIFO; commands enqueued during a drain wait for the next tick (snapshot
semantics); bounded at 256 (overflow drops newest, counted); `clearQueue()` runs on
WorldLoaded and quitToTitle so intents never cross worlds; rejected commands mutate
nothing and increment `stats().rejected`. Held-use cadence stays fixed-step: the input
phase enqueues one UseItem intent per tick with its own dt; click-edge consumers
(fishing) are preserved because intent creation precedes the drain in the same tick.
UseItem results distinguish `used/reason` (cooldown, invalid target, inert,
player-cannot-X) instead of blanket success.

### Render authority (main.js + systems.js, W18)

`TC.RenderLayers.drawWorld/drawScreen` are THE production pipeline; main.js registers
every drawer (layer vocabulary extended minimally: `liquids`, `worldDecor` world
layers; `ambient`, `overlays` screen layers) and draws only the sky/background clear
itself. Per-drawer `calls/errors` counters on `list()` power exactly-once regression
proofs (`tests/core/runtime-authority.test.js`).

### Headless boundary (runtime.js, W18)

`TC.Runtime.createWorld(seed)` / `advanceTicks(n)` / `reset()` / `getState()` run the
full game loop — scheduler phases, command queue, SaveCore persistence — without
Canvas drawing, DOM layout or requestAnimationFrame. Determinism proof:
`tests/core/headless-sim.test.js` runs identical seed+command scripts across two VM
boots and requires identical world digest, physics outcome, inventory and progression.
This is a simulation foundation only; no networking was added (NET preconditions §17
now partially satisfied: simulation without Canvas/DOM ✓, world mutations as commands ✓).

### Save impact

None: no schema/provider changes; all W18 state is execution-path state. v1 blobs and
v2 envelopes keep loading unchanged.

### Test coverage added

runtime-authority.test.js (9), headless-sim.test.js (3), runtime-authority.spec.js (3
browser), tools/bench-runtime.js benchmark.

---

## 23. Campaign contracts (W19 — Underworld Spawn Truth-Sync)

Reconciliation audit of the W17 frontier found the encounter, summon policy,
loot and progression gateway production-complete EXCEPT one live defect: the
spawn director classified deep players as `cave`, so the Underworld roster —
and the post-Wall gateway entry — never reached runtime spawns. This section
documents the corrected contracts.

### Authoritative Underworld boundary (biomes.js, W19)

ONE pure, deterministic query owns the boundary; summon validation (player.js
`currentBiomeTag`), Wall lifecycle confinement (enemyai.js/enemies.js band +
despawn checks) and spawn zoning (enemyspawn.js) all derive from it:

- `TC.Biomes.underworldTopPx()` → authoritative boundary in world pixels
  (`GEN.underworld.startY * TS`); headless-safe, no world/Canvas access;
- `TC.Biomes.isUnderworldAt(xPx, yPx)` → canonical membership including the
  4-tile enter grace above the line (xPx reserved for future shapes).

No consumer recomputes `(GEN.underworld.startY||355)*TS` with private slack;
deliberate per-consumer margins are expressed relative to `underworldTopPx()`
(Wall escape: −10 tiles; legacy fallbacks keep a guarded literal).

### Depth-first spawn zoning (enemyspawn.js, W19)

`TC.EnemySpawn.zoneOf(p, w, dl)` is the extracted classifier (exported for
tests): underworld membership via the shared query outranks the generic
15-tiles-below-surface cave rule; shallower depths keep unchanged
cave/day/night behavior. Zones: `day | night | cave | underworld`.

`zoneTable(zone, pcol)` contract update: entries anywhere in the effective
table — biome override base OR extras — may carry `[type, weight, condition]`;
conditions evaluate through `TC.Progression.test` and FAIL CLOSED (unknown
flag strings/shapes drop the entry). The biome override replaces the vanilla
table for every zone except ordinary `cave`. Blood Moon precedence stays on
the surface `night` zone only (`BLOOD_MOON_TABLE` early return); underground
zones keep their own ecology by design — intentional and tested.
Spawn cadence key `attemptUnderworld: 2.2` added to lead `CONST.SPAWN`.

### Declarative post-Wall spawn consequence

The underworld supplement moved from bespoke flag code in biomes.js into the
shared grammar: `getSpawnOverride()` always returns the underworld base plus
`['ember_wraith', 1.6, 'boss.wall_of_flesh.defeated']`; `zoneTable` filters
the gated entry until the canonical progression flag exists. Defeating the
Wall therefore changes the live spawn table through the same declarative path
as recipes/NPC stock/loot — no second progression store.

### Harness hardening (journey-i / journey-j)

Both known W18 flakes fixed without weakening gameplay assertions: journey-i
keeps the fighter on full hp + i-frames during real-time boss-damage loops
and loot pickup windows (a dead player has no magnet / triggers boss despawn);
journey-j accepts `enter|combat` at first observation (the 0.9s enter window
races rAF) while the poll loop still observes the enter→combat transition.
The journey-j defeat loop additionally pins survivability so the documented
`player_dead` lifecycle cannot pre-empt the canonical kill.

### Save impact

None. No schema/provider changes; progression rides the existing
`systems.core.progression` provider; v1 blobs and v2 envelopes unaffected.

### Test coverage added

`tests/unit/enemyspawn-underworld.test.js` (8): depth-first classification,
roster isolation vs vanilla cave, unchanged surface/cave tables, Blood Moon
precedence (surface night only), post-Wall grammar absent-before/present-after,
fail-closed conditions, director-level underworld spawn proof.
`tests/unit/wof-frontier.test.js` ember_wraith case now proves the unlock
through the real zoneTable pipeline (stronger than the prior getter peek).

### Performance evidence (tools/perf-probe-w17-wof.js, W19 refresh)

Probe corrected to keep a LIVE wall under measurement (the terminal sweep
previously emptied later benches): representative worst-case load = wall +
servants at cap (peakServants 6 observed) + hostile volley (12 hostile cap /
17 pool peak). Headless results: single wall AI ≈ 10.2 µs/op, wall+servants
≈ 15.6 µs/op, full Enemies.update under encounter load ≈ 11.8 µs/op, spawn
zoning (`zoneOf`+`zoneTable`) ≈ 0.57 µs/op, director tick ≈ 0.31 µs/op.
Worst op ≈ 0.09% of the 16.67 ms fixed-step budget.

### Remaining limitations

Unchanged from §21: no localization; Hardmode-equivalent expansion deferred.
Underworld roster stays deliberately small (demon_eye/cave_bat/zombie +
post-Wall ember_wraith).
---

## 24. Campaign contracts (W20 — Localization & Content Presentation)

The normative one-liners; module headers carry full detail.

### Localization authority (localization.js, W20)

`TC.Localization` is the single translation authority (no competing helpers):

```text
register(locale, catalog, meta?)      additive; duplicate locales rejected
                                      without {replace:true}; nested objects
                                      flatten to dotted keys; plural entries
                                      are {zero?,one,two?,few?,many?,other}
setLocale(locale) -> bool             activates + persists + emits LocaleChanged
getLocale()/getFallbackLocale()       'en' is THE fallback
availableLocales(includeDev?)         dev/pseudo locales hidden by default
t(key, vars?)                         lookup -> interpolate -> plural-select
has(key, locale?)
contentName(kind, ref)                registry-resolved display name
contentDescription(kind, ref) -> string|null
contentKey(kind, ref, field)
validate() -> {ok, errors, warnings}  structure + cross-locale parity
missing() -> [{key, locale}]          unique lookup misses
stats() / clearDiagnostics()
restore()                             apply persisted preference once per boot
```

Key shapes: `ui.*`, `progress.*`, `event.*`, `feedback.*`, `prefix.*`,
`app.title`, and content keys `<kind>.<ns>.<name>.name|.description|.title`
plus `npc.<ns>.<name>.dialogue.*` pools. Keys derive from REGISTRY stable ids,
never from translated text.

Fallback semantics: active -> fallback -> literal `[key]` placeholder +
warn-once diagnostic; never empty, never `'undefined'`. Interpolation uses
`{name}` placeholders; a MISSING variable stays literal in output and is
reported. Plural selection uses Intl.PluralRules when available with a
deterministic one/other fallback.

### Identity/display separation (hard invariant)

Registry stable ids (`core:iron_sword`), dense indexes, legacy numeric/string
aliases, save keys, flags, command/event names are machine values and NEVER
localized or derived from translations. Legacy English `def.name` fields stay
frozen as identity metadata (the registry mints stable ids from them);
presentation resolves through `TC.Localization.contentName`. The baseline
snapshot (`tests/fixtures/registry-baseline-w20.json`: fingerprint `bdad6cfa`,
368 stable ids) is enforced by `tools/check-i18n.js` AND
`tests/core/localization-identity.test.js` — a deliberate identity migration
must refresh both explicitly.

### Locale persistence (settings.js, W20)

`TC.Settings` owns ONE localStorage envelope (`tc_settings_v1`:
`{v:1,values:{...}}`) for user preferences that must never ride world/character
saves. Locale choice lives there; corrupt payloads degrade to warn-once
in-memory storage; unknown fields are preserved; an unavailable stored locale
falls back for the session WITHOUT deleting the stored choice. Deleting,
saving, importing or exporting worlds cannot touch it.

### NPC/dialogue identity fix

`UI.showDialog(npcType, lineKey)` carries the STABLE npc type plus a catalog
KEY. Shop resolution matches `n.type === dialog.npcType`; localized display
names never decide shop ownership, stock, prices or progression gates.
Dialogue pools hold key arrays so deterministic cycling picks the same entry
index in every locale.

### Pseudo-locale stress mode

`en-XA` (deterministic accent mapping + vowel doubling ~+35% length, optional
wrap markers) registers ONLY under `location.hash === '#test'`. It derives
from the fallback at render time and exists for layout stress in tests —
never offered to players as a language.

### Canvas layout hardening shipped with W20

Inventory action buttons size via measureText (no fixed per-char guess); craft
rows and shop rows ellipsize before fixed right columns; the craftable/all
toggle keeps a fixed rect (stable hit target). Dialog text wraps via existing
measureText wrapping.

### Save impact

None to world/character formats. New persistence is the separate
`tc_settings_v1` settings envelope. `tc_save_v1`/`v2` semantics untouched;
existing saves load unchanged.

### Validation gate

`npm run check:i18n` (wired into `npm run validate`) boots the real headless
game and enforces: catalog validity, display names for all user-visible
registry entries, npc dialogue/nameKey resolution, registry fingerprint +
stable-id equality with the baseline snapshot. Tests:
`tests/core/localization*.test.js` (service, coverage, identity blocker,
persistence, determinism, npc identity) and browser
`journey-k-localization.spec.js` (switch, stress layout metrics, real-reload
persistence of locale AND world, fallback return).

### Known limitations (deferred)

- No real secondary-language catalog is authored yet; adding
  `js/locales/<id>.js` requires zero engine changes (register + restore).
- RTL and complex-script typography are out of scope; the rendering path uses
  system font stacks + measureText (never byte-count truncation), but no
  bidi/shaping work has been done.
- Coin purse notation (`1g 23s 45c`) remains a compact unit format rather
  than a word-order-sensitive template.
- Translator workflow/export tooling does not exist yet.

---

## 25. Campaign contracts (W21 — World Regions, RGB Lighting, Performance)

### Canonical region invalidation authority (worldregions.js, W21 / PERF-004)

TC.WorldRegions is THE single authority for world-region invalidation.
Geometry: 32x32-tile regions (CHUNK), index = cy*chunksX+cx. Monotonic
per-region revisions + per-consumer delivery queues + per-region last-seen
arrays give the multi-consumer invariant: no consumer can steal or clear
another's invalidation; an entry stays queued for its owner until that owner
observes it. Marks carry a reason ('tile'|'wall'|'shape'|'paint'|'liquid'|
'bulk'|'world'); pendingKinds(idx) exposes the pending bitmask (cleared when
the last consumer observes). Marks are O(consumers); sweeps scan only the
consumer's own queue with a reused scratch buffer; constant-time fast path
when nothing was marked since its last clean sweep. Headless and Canvas-free.
Stable identity + monotonic revisions are the documented substrate for
future NET-004 replication/ack work (not implemented).

Mutation seams (authoritative paths report here): World.set/setRaw/setWall/
setRawWall/setShape/setPaint/rawSetTile and Liquids' change notes; world
build runs init() then markAll('world'); unload runs reset().
TileChanged/LiquidChanged events remain unchanged.

### Renderer on the shared authority (world.js, W21 / VIS-002)

The chunk renderer is consumer 'renderer': bounded (3/frame) camera-nearest
rebuilds of stale regions; legacy border fan-out lives in
WorldRegions.markTile. Instrumentation: World.regionStats().

### RGB lighting (lighting.js, W21 / LGT-001)

Three Float32 channels per window cell: propagated field (sky ambient +
colored emissive tiles, 4-dir BFS decaying by opacity) and display layer
(field + dynamic sources). Authored colors: warm-day/moon-blue sky mix,
per-emitter tints keyed by frozen def.name (torch/furnace/lava/gleamstone/
gleam crystal/life crystal), neutral-white fallback. Queries: lightAt =
Rec.709 luminance (legacy-compatible), lightRgbAt additive. INVALIDATION:
region-driven partial recomputes of halo-expanded rects (HALO =
ceil(1/decayAir)+2 >= max propagation distance makes rect-local BFS exact);
full reseeds only on window movement (8-tile aligned), daylight quantum
(2%), world swap/init or missing infrastructure. Deterministic BFS. Dynamic
sources: 64-slot pool, optional '#rrggbb' color (5-arg form stays neutral
white), max-blend stamping with union reset and static-layout skip. Quality
profiles low|medium|high scale ONLY overlay raster step (3/2/1) and dynamic-
merge cadence (15/30/60 Hz); queried values are identical across profiles;
selection via TC.Lighting.setQuality, persisted in tc_settings_v1
('lightingQuality'), default from CONST.LIGHT_QUALITY. Counters:
TC.Lighting.counters().

### Minimap on regions (minimap.js, W21)

Consumer 'minimap': hidden means zero paints and frozen cursor (catch-up at
<=24 regions/frame on reveal); terrain/wall/liquid marks repaint only their
regions; world swap forces fresh full paint. Underworld depth cutoff uses
TC.Biomes.underworldTopPx(); ocean margin uses new pure
TC.Biomes.oceanEdge(). Localized label unchanged (W20).

### Benchmarks (tools/bench-scenarios.js, W21 / PERF-002)

Ten named scenes through the real VM loader with warmup + medians:
exploration, construction, combat-dense, projectiles, lighting-stress,
dynamic-lights, liquids, minimap, save-diff, worldgen. Stub-context
(simulation/dispatch) numbers — explicitly NOT browser raster. Measured-and-
deferred with evidence: PERF-003 spatial broad phase (~3-5us/enemy linear;
production cap 8) and save-diff incremental indexing (~2ms once per 30s
autosave).

### Save impact

None to formats/providers/atomicity; round-trip proven byte-exact under hot
presentation state. Lighting quality persists via tc_settings_v1 (W20
settings envelope), never inside saves. Registry fingerprint unchanged
(bdad6cfa, 368 ids).

### Test coverage added

- tests/core/worldregions.test.js — authority invariants incl. drain-race.
- tests/core/lighting-rgb.test.js — RGB model, compat, profiles, determinism.
- tests/world/minimap-regions.test.js — region-driven refresh contract.
- tests/core/w21-integration.test.js — seam fan-out, no-steal, cascades,
  determinism under presentation churn, hot-state save round-trip.
- tests/browser/journey-l-regions-lighting.spec.js — real-browser journey
  (day/night rendering, torch field, violet dynamic source, minimap
  locality, quality persistence, reload fingerprint equality).


## 26. Campaign contracts (W22 — Authoritative Multiplayer Foundation & Two-Client Slice)

### 26.1 Authority model (binding)

The server/authoritative session owns world truth: world seed + state, the
simulation tick, player entities, positions/velocities after simulation,
enemies, projectiles, mining/placement results, inventory mutations, combat
results, loot, shared-world progression and replicated region revisions.
Clients own ONLY intent and presentation. A client may propose movement input,
jump/drop state, aim, item use, mining targets, placement targets, interaction
and inventory moves; it may never declare "I moved to X", "this block is now
air", "give me an item", "that enemy lost HP" or "my inventory contains X".
Every mutation flows through the canonical `TC.Commands` transactions inside
the canonical fixed-step scheduler (`TC.Runtime.tick`).

### 26.2 Player identity — `TC.Players` (js/players.js)

Stable per-session ids (`p1`, `p2`, …), `create/remove/get/all/entry/idOf/
primary/setPrimary/retainOnly/resetForNewWorld`. Exactly one LOCAL entry is
primary; `TC.player` remains an alias of it, so legacy single-player code is
untouched when no session exists. Remote mirrors are flagged `remote:true`
and can never become primary. World/session teardown uses `retainOnly`/
`resetForNewWorld` so identities cannot leak between worlds.

### 26.3 Protocol v1 — `TC.NetProto` (js/netproto.js)

Envelope `{v,t,sid,pid,cseq,sseq,tick,p}`; strict fail-closed validation
(unknown fields, wrong types, non-finite numbers, oversize frames → reject).
Message types: hello / welcome / reject / snapshot / input / cmd / cmdres /
worldupd / ack / resync / bye. Only whitelisted command names ride `cmd`
(MineTile, MineWall, PlaceTile, PlaceWall, UseItem, MoveItem, EquipItem,
InteractTile). Region codec: full layers as hex pairs; deltas as
`[cellIdx,tile,wall]` triples baselined against the last sent copy.
Deterministic digests (`digestWorld/digestPlayers/digestInventory`) hash
gameplay state only (tiles, walls, essentials) for replay/resync checks.

Sequence rules: client→server cseq strictly increasing per stream (input/cmd
separately); duplicates/stale frames counted and rejected; server→client sseq
strictly increasing; a bound connection may only speak as its own pid
(spoof → reject). Reconnect raises a cseq floor so dead-generation packets
cannot apply.

Continuous vs discrete: per-tick sampled movement/jump/down/aim/use/hotbar
rides `input` frames (latest-wins, stale rejected, zeroed after 30 ticks of
silence = safe default). Discrete gameplay rides `cmd` intents executed in the
scheduler's commands phase via the registered `net-commands` system (runs
after core.queue drain), through the SAME `TC.Commands.submit` validation as
local play. The server derives tool/power/dt itself; clients cannot declare
mining speed or oversized dt.

### 26.4 Transport boundary — `TC.NetTransport` (js/nettransport.js)

Endpoints expose `send/onMessage/onStatus/close`. `loopbackPair()` gives a
deterministic manual-pump duplex with hostile injection (dropNext/dupNext/
swapNext); `websocket(url)` wraps the platform WebSocket (browser native /
Node ≥ 22 global). Transport moves opaque strings only. The Node-side real
server is the dependency-free RFC6455 shim `tools/net/wsserver.js`
(handshake, masked frames, ping/pong, close; fragmentation reassembled;
everything else fails closed) attached to an ordinary http server by
`tools/mp-server.js`.

### 26.5 Server runner — `TC.NetServer` (js/netserver.js)

Lifecycle: `create(opts)` → `start({seed|adoptWorld})` (creates/adopts world
via Runtime) → `attachLocal(name)` (host pawn) → `connect(ep,{name})` →
per-tick `tick()` (processInbound → Runtime.tick(STEP) → replicate) →
`stop(reason)`. Registers scheduler systems `input/net-remote-intents`
(remote held-use intent + hotbar selection through the same seam as local
player-intent) and `commands/net-commands`. Standalone hosts use
`runForever()` (wall-clock fixed-step driver).

Replication (first NET-004 prototype): every connection owns a PRIVATE
WorldRegions consumer `'net:<cid>'`; renderer/lighting/minimap cursors are
never touched (multi-consumer invariant preserved). Interest = regions
intersecting ±56 tiles around the player's position. Join/rejoin streams
full region snapshots (≤12 regions/message, reason 'streaming' until
'complete'); steady state sends baselined cell deltas under a budget of 4
changed interested regions/tick/connection. Entity lines (players always,
enemies/drops interest-filtered, capped) ride every worldupd; own-inventory
refresh rides worldupd every 30 ticks. Acks are accounting + desync detector:
a client acking a revision above the authority forces a fresh snapshot.
Disconnect parks the identity in `detached` (inputs zeroed, entity kept);
`hello.rejoin{sid,pid}` rebinds generation, resends snapshots; explicit bye
or 18000-tick grace expiry removes the entity and forgets the consumer.
Diagnostics: `summary()` + stats {msgs/bytes in/out by type, rejected
breakdown, cmds accepted/rejected, regionsSentFull/Delta, acks, snapshots,
resyncs, joins, reconnects}; F3 shows one bounded line per active role.

### 26.6 Client controller — `TC.NetClient` (js/netclient.js)

Phases idle→connecting→syncing→playing→closed. While joined, main.js routes
fixed steps to `TC.NetClient.frame(dt)` (input sampling, mirror application,
presentation-only advancement: sky/biomes/world chunks/lighting/minimap/
particles/UI/events + camera follow). The mirror world is regenerated from
the authoritative seed, then relevant regions/e entities/inventory are
overwritten from snapshots/deltas — production render pipeline consumes it
unchanged. Clients never simulate enemies/combat/spawning locally and never
autosave (`Save.autosave` gates on `NetClient.drivesTick()`; quitToTitle
skips saving a mirror). Discrete intents go through `sendCmd(name,ctx)` —
slots only, inventories resolved server-side, cross-player selection
structurally impossible.

### 26.7 Multi-player simulation seams

`main.js` movement iterates all registered players (single-player =
degenerate one-entry case); enemy contact damage and hostile shots iterate
players via `Combat.hurtPlayer(..., {target})`; drop magnet/pickup selects
the nearest eligible collector among all players (`items.js`). Enemy AI still
targets the primary pawn — multi-target AI is future work. Enemies carry a
stable `eid` (additive) used as replication identity.

### 26.8 UI flow (developer quality)

Title menu gains "Host Local Multiplayer" (starts an in-tab session over the
current/new world; host plays through the normal single-player path while
the session serves clients) and "Join Local Server" (prompt for ws:// URL).
Toasts surface connecting/connected/link-lost/server-closed transitions; a
link loss during play returns the client to title automatically. All strings
live under `ui.net.*` / `ui.menu.*` in js/locales/en.js.

### 26.9 Persistence boundary

Session/socket data is NEVER persisted. The HOST saves the shared world with
the existing envelope exactly as single-player does; joined clients cannot
write saves at all. Existing save formats and compatibility untouched.

### 26.10 Tests & benchmarks

Headless (tests/net/): proto hostility, players registry, loopback +
REAL WebSocket echo, session slice (join/move/mine/place/combat/inventory
dup-safety/hostile packets/disconnect-resync/deterministic two-client
replay digests), replication guarantees (consumer independence, interest
crossing, edit-while-away, forced resync, burst coalescing, teardown),
cross-realm join of the REAL NetClient over a bridge realm.
Browser: journey-m-multiplayer.spec.js — two Chromium pages over the REAL
Node mp-server: same-world join, movement replication, mine→loot→place chain
with exactly-once inventory accounting, newcomer resync after reload,
coherent shutdown. Benchmarks: tools/bench-multiplayer.js (idle-2p,
move-2p, mine-burst, resync-churn, 1-vs-2 client comparison; VM-realm tax
applies as documented in W21 — relative deltas are the signal).

## 27. Campaign contracts (W23 — Multiplayer Productionization)

## 27. Campaign contracts (W23 — Multiplayer Productionization)

Deterministic gameplay RNG (`js/gamerng.js` — `TC.GameRng`). Five named mulberry32
streams (ai/spawn/loot/combat/misc) derived per-name from one seed; reset on
WorldLoaded from `TC.worldSeed`; `state()/restore()/digest()` expose exact stream
state for replay proofs; `override()/clearOverrides()` is the test seam that replaced
host-Math.random pinning. Every gameplay-affecting runtime draw routes here:
enemy AI decisions, spawn placement/zoning/Blood-Moon rolls, drop tables + coins +
blood shards, crit/variance, drop scatter physics, NPC wander, falling stars.
Presentation-only randomness (particles/blink/trails) and worldgen stay outside.
Replay proof: two independent realms with the same seed+command/input trace
converge on world+players+inventory+enemy-AI digests AND the RNG digest
(tests/net/rng-replay.test.js) — the W22 enemy-AI exclusion is closed.

Multi-player targeting (`js/targeting.js` — `TC.Targets`; of/nearest/all/count/anchor).
Eligible = registered live players with finite positions (empty-registry single-player
falls back to the legacy singleton exactly as W22 shipped). Nearest-by-d2 with
deterministic tie-break by stable id and per-entity stickiness (a challenger must be
>=20% closer to steal aggro). Consumed by every enemyai archetype + wof helpers,
enemies.update despawn (persist while ANY player is near), spawnBoss/spawnEnemy
anchors, render eye-tracking, enemyspawn director (per-attempt seeded anchor across
the roster). Deliberate primary/local uses: camera follow, input sampling, HUD,
client self-mirror identification. Attack attribution: resolveHit treats ANY
registered attacker as player-owned and scales through ITS stats;
meleeStrike/shootArrow take byPlayer; magic bolts carry owner -> impact attribution;
mana bookkeeping ticks per registered player; shockwave hits every player in radius.

Networked transaction parity (protocol v2 — `TC.NetProto.VERSION = 2`, v1 envelopes
get a clean explicit rejection). Whitelist adds CraftRecipe / ShopBuy / ShopSell /
ContainerMove with strict bounded per-command ctx schemas (unknown or nested-object
fields reject at the protocol layer). cmdres carries an optional authoritative result
bundle {action, inv, chest}; worldupd gains the same bounded chest section plus rm
tombstones plus inSeq for prediction reconciliation. Server authority:
- CraftRecipe resolves the recipe from the client STABLE registry id only; stations
  re-scan around the acting player; progression gates apply canonically;
- ShopBuy/ShopSell are proximity-gated against live NPC kinds before the transaction;
- InteractTile on a chest binds a per-connection container session; sessions expire
  on tile loss / out-of-reach / disconnect; ContainerMove requires the server-bound
  session and supports authoritative auto-placement (omitted toSlot merges then
  fills empties under exactly one InventoryChanged emission). UI craft/shop/chest
  paths route through one txSubmit seam: local transactions standalone, proposals
  while joined; the result bundle refreshes mirrors immediately.

Replication productionization (NET-004 no longer a prototype): stable ids everywhere
(drops gain per-session identity 'd<did>'; enemies e<eid>; players registry ids);
per-connection baselined entity deltas (only changed fields cross the wire in fixed
key order — deterministic encoding), explicit rm tombstones on death/pickup/despawn/
interest-exit/disconnect, periodic keyframes (keyframeEveryTicks) healing lost
baselines, presentation cadence decoupled from the 60 Hz sim
(replicateEveryTicks, default 2 => 30 Hz), idle suppression (no empty worldupd),
dirty-region delivery prioritized nearest-player-first within the budget, and a
per-tick outbound byte budget per connection (maxOutBytesPerTick) with baselines
committed only after admission. Measured idle-2p outbound dropped 86.0 -> ~29 KiB/s
(-66% vs W22; target was >=35%). Host knobs are server options exposed via
tools/mp-server.js flags (--interest/--budget/--rate/--keyframe/--detach-grace/--max-out-kb).

Latency masking (presentation-only): TC.NetTransport.impairedPair models deterministic
latency/jitter/drop/dup/reorder/stall over virtual time with a seeded PRNG (ordered
delivery unless reorderChance is set — matching reliable-transport semantics). Joined
clients interpolate remote players/enemies DELAY ticks behind newest snapshots
(hold-on-spawn, never extrapolate, snap above teleportDistPx, teleports counted) and
predict SELF locomotion through the canonical Player.update with bounded
reconciliation against worldupd.inSeq-bearing truth (soft blend, hard snap beyond
predictHardSnapPx, history flush). Prediction never touches mining, loot, damage,
inventory, crafting or world mutation.

Tests: tests/core/gamerng.test.js; tests/net/{targeting,parity,rng-replay,replication2,latency,fourplayer,soak}.test.js; browser journeys M (slice) + N (productionization:
networked craft round trip, non-primary targeting via /debug target attribution,
interpolation buffers, resync, coherent shutdown). Benchmarks: extended
tools/bench-multiplayer.js scenes (idle-4p, move-4p, separated-explore-4p,
combat-multi-2p, tx-burst-craft-shop) + tools/soak-multiplayer.js (seeded 20k-tick
soak/fuzz with durable JSON evidence).

## 28. Campaign contracts (W24 — Liquid & Wiring Completion)

LIQ-006 ships as production gameplay: **inlet/outlet pumps** are wire-powered
liquid endpoints owned by `TC.Wiring`, mutating ONLY the authoritative
`TC.Liquids` layer.

Pump contract (v1): an inlet READS the liquid layer at its own tile coordinate;
an outlet WRITES to its own. Pump tiles are deliberately NON-SOLID so the
volume layer can occupy their cell; no liquid is ever encoded in tile ids.
When one wiring pulse floods a component, every pump endpoint reached by that
SAME pulse is collected into a deduped set and processed ONCE as a
deterministic batch AFTER receiver discovery — ascending world cell index,
never Set/insertion order. Two phases per batch: MEASURE (exact per-pair
transfer matrix against per-outlet cumulative budgets: empty outlets accept
any ONE type, partially filled accept only their own type; incompatible types
never convert or overwrite) then APPLY via `TC.Liquids.set()` so wakeups,
water+lava reaction, LiquidChanged, WorldRegions and persistence stay on the
canonical path. Volume is exactly conserved except where the canonical
reaction consumes it into stone. Boundedness: `PUMP_ENDPOINT_CAP = 64`
endpoints per pulse (excess counted as cap hits, left untouched) and
`PUMP_TRANSFER = 48` units per endpoint per pulse; observability via
`TC.Wiring.pumpStats()` ({pulses,endpoints,unitsMoved,rejected,capHits}).
Content is additive-only: tiles `wiring:inlet_pump`/`wiring:outlet_pump`
(TILE_DEFS length 56 -> 58), items, anvil recipes, catalog entries; registry
fingerprint bdad6cfa/368 -> 1b1d7c15/374 with an additive-only proof against
the retained W20 fixture (`tests/fixtures/registry-baseline-{w20,w24}.json`).

Liquid replication (protocol v3): region lines now carry authoritative liquid
type+amount alongside tiles/walls. Full lines are four equal-length hex layers;
delta cells are `[cellIdx, tile, wall, liqType, liqAmt]` quintuples restating
ALL authoritative fields of a changed cell (no ambiguous omission). v3 rejects
v1/v2/unknown versions with a clean expected-version error. Host side reads
layers through the bounded read-only seam `TC.Liquids.snapshotRegion()`;
baselines (`conn.lastSent`) include liquid so ACK bookkeeping cannot mix stale
liquid with fresh tiles. Client mirror applies truth through the
presentation-only `TC.Liquids.applyMirrorRegion()` — direct array writes plus
local WorldRegions 'liquid' marks for renderer/minimap/lighting repaint; it
never wakes settling, queues gameplay events, or echoes to the server, and a
joined client runs no settle/pump/reaction simulation of its own.

Mechanism multiplayer authority: `js/wiring.js` enumerates players through
`registeredPlayers()` (TC.Players roster, TC.player fallback). Pressure plates
press on ANY registered live player; door-close safety checks EVERY live
player's hitbox; trap darts damage the actual victim via
`Combat.hurtPlayer(..., {target})` so a remote player can never redirect
damage onto the primary pawn. `TC.Targets` remains AI-only policy.

Defect fixed en route: `TC.Liquids.set()` (the documented spigot/migration
seam) never reported to WorldRegions — invisible to every region consumer,
including multiplayer replication. All mutation seams now report uniformly.

Tests: tests/world/pumps.test.js (conservation matrix, mixed types, loops,
endpoint cap, canonical reaction, replay digests);
tests/net/proto.test.js v3 codec/version/hostile-liquid cases;
tests/net/liquid-replication.test.js (driver-level layer checks + cross-realm
convergence: join/settle/pump/reaction/resync + no-local-sim guard);
tests/net/mechanisms-multiplayer.test.js; tests/save/pumps-save.test.js.
Browser journey O over `node tools/mp-server.js --fixture pumps` (opt-in
host-authoritative rig): non-primary plate activation through networked input,
exactly-once transfer via /debug counters, two-client mirror coherence,
rejoin-current-truth, clean shutdown. Benchmarks: bench-multiplayer scenes
liquid-churn + pump-burst (bounded deltas, idle suppression retained).
