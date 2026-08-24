# clone-terraria

An original-assets, from-scratch Terraria-style 2D sandbox game. Vanilla JavaScript +
HTML5 Canvas. No frameworks, no build step, no external assets: all graphics are drawn
procedurally in code, all audio is synthesized with WebAudio. Not affiliated with Re-Logic;
no copyrighted Terraria assets, code, or audio are used.

## Run

Open `index.html` in a browser (plain `<script>` tags, works over `file://`), or serve:

```
python -m http.server 8000
```

Syntax-check any module: `node --check js/<file>.js`

## Architecture

Global namespace `window.TC`. Each module is an IIFE attaching its API to `TC`.
Script load order is fixed in `index.html`; modules only *call* each other at runtime,
so load order is not critical, but guard optional dependencies (`if (TC.Audio) ...`).

Coordinate conventions: world pixels unless a name ends in `Tx/Ty` (tile coords).
Tile size `TC.CONST.TS = 16`. +y is down. Camera `TC.camera = {x, y, zoom}`.

Update order per fixed 1/60s step (see `js/main.js`):
`Sky → Player → Enemies(spawn+update) → Items(drops) → Combat → Particles → World(chunk rebuild) → Lighting → Save(autosave)`.

Draw order: `Sky(screen) → World → Items → Enemies → Player → Combat → Particles (all world-space via TC.applyCam) → Lighting(screen) → Input cursor(screen) → UI(screen)`.

World-space draw functions must wrap drawing with `TC.applyCam(ctx)` / `TC.clearCam(ctx)`
from main.js. Screen-space functions (Sky, Lighting overlay, Input cursor, UI) must not.

## Module API contract

| Module (file) | Exposes |
|---|---|
| constants.js | `TC.CONST`, `TC.TILE`, `TC.TILE_DEFS[]`, `TC.ITEM_DEFS`, `TC.RECIPES`, `TC.ENEMY_DEFS` (lead-owned, read-only) |
| utils.js | `TC.Utils`: `mulberry32(seed)`, `hash2(x,y,s)`, `randRange/randInt/choose(rng,...)`, `clamp`, `lerp`, `aabb(...)`, `Noise2D(seed)` with `.noise2(x,y)` and `.fbm2(x,y,octaves,lac,gain)` |
| worldgen.js | `TC.WorldGen.generate(seed)` → `{width, height, tiles:Uint8Array, walls:Uint8Array, surfaceY:Int16Array, spawnX, spawnY, timings, stats}`. Deterministic from seed + GENERATION_VERSION (never `Math.random`): structured as named passes `PASSES = terrain → surface-biomes → caves → deep-caves → ores → micro-biomes → structures → decor → validation` (v3, W4), each with its own seeded rng stream (`runPass(name, ctx)` for debug); `CONFIG = {deepCaves, microBiomes, richOres}` feature flags (**default on** since v3). Walls: WALL.DIRT/STONE background wherever `y > surfaceY[x]+1`; biomes snow/jungle/desert/ocean/corruption/dungeon/pyramids/underworld per GEN; micro-biomes crystal cavern/mushroom grotto/granite/marble/moss cave. WATER/LAVA tiles are worldgen OUTPUT format only — main.buildWorld imports them into TC.Liquids at load. Loot post-pass is invoked explicitly via `TC.Loot.populateWorld(gen, seed)` from main.buildWorld |
| tiles.js | `TC.Tiles.drawTile(ctx,id,px,py,ts,tx,ty,mask)` (mask bits N=1,E=2,S=4,W=8 = neighbor opaque), `TC.Tiles.drawWall(ctx,id,px,py,ts,tx,ty)` (flat darker texture + subtle grain), `TC.Tiles.drawCracks(ctx,px,py,ts,stage0to3)`. Also platforms (hammerable), ropes, hammer tool variants |
| world.js | `class TC.World(gen)`: `get/set/setRaw/isSolid/solidAtPixel/applyMineDamage(tx,ty,amt)→broken`, wall layer `getWall/setWall/setRawWall/applyWallDamage(tx,ty,amt)→broken` (walls render under tiles in chunk canvases; separate damage map), `damage` map, water flow: active-set cellular sim stepped inside `update(dt)` (fall into AIR below, else spread sideways; seeded when tile changes touch WATER; budgeted per frame), `update(dt)` (rebuild ≤3 dirty chunks/frame), `draw(ctx,cam)`, `width/height/tiles/walls/surfaceY`. `set()` enforces support-pop (plants/torch/furniture drop when support lost) and notifies `TC.Lighting.onTileChanged`. `setRaw()` writes without side effects (save-load, tree felling). |
| lighting.js | `TC.Lighting.init(world)`, `onTileChanged(x,y)`, `update(dt,cam)`, `draw(ctx,cam)` (multiply darkness overlay), `lightAt(tx,ty)→0..1` |
| sky.js | `TC.Sky.update(dt)`, `draw(ctx,cam,w,h)` (screen space), `daylight()→0..1`, `time` (seconds, saved), `reset()` |
| input.js | `TC.Input.init(canvas)`, `down/pressed(code)`, `endFrame()`, `axis()→{x,jump}`, `mouse{x,y,down,rightDown,worldX,worldY}`, `hotbarScroll`, `uiHover`, `drawCursor(ctx,cam)` |
| audio.js | `TC.Audio.play(name)`, `toggleMuted()`, `muted` |
| particles.js | `TC.Particles.spawn/burst/floatText/update/draw/clear` |
| items.js | `class TC.Inventory` (50 slots, `add/remove/count/get/serialize/deserialize`), `TC.Items`: `drops[]`, `spawnDrop(x,y,id,count,scatter?)`, `update(dt,player)`, `draw(ctx,cam)`, `clearDrops()`, `iconFor(id)→canvas`; `TC.Chests`: per-position 20-slot containers — `get(tx,ty)→slot array (lazy-created)`, `spill(tx,ty)` (scatter contents as drops), `serialize()/load(data)` |
| player.js | `class TC.Player` (instance at `TC.player`): `update/draw/damage/heal/giveStarterKit/serialize`, static `deserialize(data)`. Equipment: `equipment{head,body,feet}` (armor items from ITEM_DEFS kind 'armor'; using one equips it, swapping with any worn piece), `totalDefense()→n`; summon items (kind 'summon') call `TC.Enemies.spawnBoss(def.boss,…)` with declarative `summon:{time,biome,requires,placement}` (time `night|day|any`, biome is CURRENT `TC.Biomes.current` not `biome.X.discovered`, requires is W14 grammar, placement `underworld_wall` for Wall) — the charge is consumed ONLY on success (time/biome/progression/MAX_BOSSES/placement failure all give feedback and consume nothing, exactly one consumed on valid encounter). Right-click interacts: toggles DOOR_CLOSED↔DOOR_OPEN via world.set, opens chests via TC.UI.openChest(tx,ty); breaking a CHEST calls TC.Chests.spill first. Mining AIR tiles with a wall behind (pick equipped) mines the wall via world.applyWallDamage. Standing in LAVA burns (LAVA_TICK/LAVA_DMG through Combat.hurtPlayer src 'lava'); head underwater drains breath over BREATH_SECONDS then drowns at DROWN_DMG/s (field `breath` 0..1 for the UI bubble row) |
| ui.js | `TC.UI.update(dt)`, `draw(ctx,w,h)`; title screen, HUD, inventory + equipment slots (with defense readout), crafting panel, pause menu, death overlay, boss health bar while a boss lives, chest panel via `openChest(tx,ty)`/`closeChest()` when a chest is open (drag between chest and bag), NPC dialog box via `showDialog(name,text)`/auto-close, breath bubble row under hearts while the player's head is underwater; sets `TC.Input.uiHover` |
| enemies.js | `TC.Enemies` (ENTITY lifecycle only — W13 split): `list[]`, `update/draw/clear`, `damageEnemy(e,finalDmg,dir,kb,crit)` applies RESOLVER-final damage and is the single emitter of EntityDamaged/EntityKilled/BossDefeated (death exactly once), `spawnBoss(type,x,y,opts)→enemy|null` (respects MAX_BOSSES; null = full; `opts:{dir,band}` for Wall), `spawnEnemy(type,x,y)`, `spawnDirector(dt)` facade → TC.EnemySpawn; additive seams: `makeEnemy`, `trackHostileShot(pr,shooter,dmg)`, `spawnServantOf(boss,type,bx,by)`, `clearHostileShotsOf(boss)`, `getWofEncounter()→{state,phase,elapsed,hpFrac,servants,peakServants,peakProjectiles,transitions,despawnReason,dir,hostile}`, `clearEncounter()`. Wall is noclip sweeping wall with direction-locked band, explicit despawn, and F3 observability. Rendering for all archetypes lives here |
| combat.js | CANONICAL hit resolution (W12): `TC.Combat.resolveHit(spec)→{ok,damage,crit,kb,cls,source,defenseApplied,mitigated,statuses,rejected}` — pure, injectable `spec.rng`; classes generic/melee/ranged/magic/summon via `DAMAGE_CLASSES` (statField per class); player-owned attacks scale through TC.Stats, everything else deals declared base; target defense + flat `pen`; min damage 1; `registerMitigation(key,fn)` content policies. `hitEnemy(target,dir,spec)` resolve+apply via Enemies.damageEnemy. `meleeStrike/shootArrow/update/draw/clear`, `hurtPlayer(dmg,kbx,kby,src)→{finalDamage,defenseApplied,crit,rejected}` (environmental policy: 'fall'/'void' bypass defense; lava burning via TC.Buffs.statusForSource), `shockwave(...)` |
| crafting.js | `TC.Crafting`: `stationsNearby(px,py)→Set`, `available(inv,stations)`, `canCraft(r,inv,st)`, `craft(r,inv,st)→bool`, plus W14 progression gating — recipes may declare `requires` (shared condition grammar); `lockReason(r,inv,st)→null|'progression'|'station'|'costs'` for UI hints |
| lootables.js | `TC.LootTables` (W13 canonical loot): entry schema `{id,min,max,chance,requires}`, `roll(table,{rng})→[{id,count}]`, `rollCoins([min,max])`, `rollEntity(def,cx,cy)` (ENEMY_DEFS drops+coins scatter), `validate/validateRange/validateAll` (unknown ids, chance bounds, inverted ranges); injectable rng for tests |
| enemydefs.js | Enemy content extensions extracted from constants-adjacent ownership (W13+W17): ENEMY_DEFS biome regulars + bosses (king_slime, skeletron+hand, wof, storm_jelly, moss_mother) + ember_wraith post-Wall, summon ITEM_DEFS (slime_crown/skull_sigil/flesh_sigil/blood_sigil) with `summon:{time,biome,requires,placement}` + infernal_core family (hellforged_blade/infernal_greaves/infernal_hook), their RECIPES; pure data merged at load time |
| enemyai.js | `TC.EnemyAI` (W13+W17): reusable behavior archetypes keyed by def.ai — slime/zombie/eye/bat/walker(+lunge/charge)/harpy/stationary/teleporter + boss AIs king_slime/eye_boss/skeletron/skele_hand/wof/storm_jelly/moss_mother + hungry (W17 tethered servant); `get(aiName)→impl`, shared `util.{rand,clamp,approach,daylight,weightedPick,solidAt,rectSolid}`, `isFlyer(ai)` authority; `wof` is a direction-locked, band-constrained multi-phase wall (enter→phase1→phase2→enrage) with telegraphed fans/bolts and bounded servant shedding; impls `(e,{clock},dt)→bool` (false = remove) |
| enemyspawn.js | `TC.EnemySpawn` (W13): spawn director + rules — `update(dt)` (Blood Moon dusk/dawn lifecycle then director tick), `spawnDirector`, `zoneTable(zone,pcol)` (lead SPAWN + biome extras; entries may carry `[type,weight,condition]`), `findSpot(def,tx,ty,surf)`, `surfaceBiome/playerDepthT`, `setBloodMoon/isBloodMoon/reset` |
| save.js | `TC.Save`: dual-format persistence. With SaveCore: providers 'world.core'/'character.core', `save()`→SaveCore.saveNow('tc_save_v2') versioned envelope (all system providers ride along), `load()` flattens the envelope to the legacy shape + `__envelope` for SaveCore.restore; falls back to legacy 'tc_save_v1' blob `{v,seed,time,diffs,wallDiffs,player,chests,npcs}`; `hasSave()/deleteSave()` cover both formats; `exportSave()/importSave(str)`, `computeWorldDiffs()`, `autosave(dt)` |
| minimap.js | `TC.MiniMap`: `update(dt)` (toggles on pressed('KeyN'), refreshes its downscaled tile canvas in round-robin strips), `draw(ctx,w,h)` screen-space top-right ~200×150 px region centered on the player, player dot; hidden by default |
| npcs.js | `TC.NPCs`: `list[]`, `spawnGuide(x,y)` + generic `spawn(type,x,y)` over NPC_KINDS table (dialog/unlocks/shop/look), `evaluateUnlocks()` (consults TC.Progression.test + population), `validateHome(tx,ty,w,h)` (floor/blocked/entrance/walls≥60%/flooded/dark/open + size bounds), incremental house claiming on move-in (`claimHouse/houseOf`, state.home persisted), context-aware dialog (progression-gated dialogFlags pools > night/biome pools, deterministic), damage→respawn-at-home after delay; `update/draw/clear/serialize/load` (loader tolerates legacy blobs); progression-aware `shopOf(type)/kindDef(type)` for UI (stock rows carry `requires` conditions) |
| music.js | `TC.Music`: `update(dt)` (call once per frame from main), generative WebAudio soundtrack — mood priority boss > biome (`TC.Biomes.musicTag`: underworld drone / snow arpeggio / jungle percussion / desert phrygian / ocean swells) > day/night; lazy context after first gesture; follows TC.Audio.muted |
| accessories.js | `TC.Accessories` (5 equip slots: `slotsOf/equip/unequip/modsOf/serialize/deserialize`, PREFIX_DEFS + deterministic `rollPrefix`) + `TC.Buffs` (timed buffs/debuffs; `apply/remove/has/modsOf/tick/drawIcons`, emits BuffApplied/BuffExpired). No runtime wraps: stats flow through TC.Stats (`modsOf` is a Stats source); hooks `update(dt)/onUseHeld(player,def,dt)→bool/drawHud(ctx)/iconFor(id)`; SaveCore provider 'character.core.accessories'; `restoreLegacy(playerData)` for v1 blobs. Adds its own ITEM_DEFS/RECIPES at load |
| magic.js | `TC.Magic`: mana pool (base 20, cap 200 via mana crystals), regen stars, potion sickness, magic weapons firing pooled bolts via TC.Projectiles.spawn('magic_bolt',…); no runtime wraps: `update/drawWorld/drawHud/clear/ensureMana/spendMana/restoreMana/fire/onRespawn/captureOf/attachToPlayer/restoreLegacy/iconFor`; mana persists via player-blob parity fields + SaveCore provider 'character.core.magic' |
| fishing.js | `TC.Fishing`: rods+bait→power, bobber cast, bite rolls + reel timing window, per-zone loot tables (surface/underground/ocean/lava/honey), crates, daily quest fish. No runtime wraps: hooks `update(dt)/draw(ctx,cam)/onUseHeld(player,def,dt)→bool/iconFor(id)`; persistence via SaveCore provider 'systems.core.fishing' + `restoreLegacy(blob)` |
| projectiles.js | `TC.Projectiles` — CANONICAL projectile system: pre-allocated pool (128) of typed projectiles — arrow/magic_bolt/yoyo/boomerang/grenade/falling_star/wire_dart — with pierce/bounce/homing/tile collision/explosions/light hooks (`getLights()`); `spawn(type,x,y,ang,opts)` emits ProjectileSpawned; per-spawn opts override type defs |
| wiring.js | `TC.Wiring`: wire tiles + mechanisms (switch/lever/pressure plate/timer/dart trap/actuator); BFS signal flood from a source cell, receivers fire once per pulse emitting WirePulse. No core patches: reacts to TileChanged events, exposes `isGhost(tx,ty)` consulted by World.isSolid, darts ride the projectile pool; `init/update/draw/pulse/toggleDevice/placeWire/removeWire/interact/isGhost/attachActuatorAt/serialize/load/reset/resetForNewWorld`; SaveCore provider 'systems.core.wiring' |
| biomes.js | `TC.Biomes`: player-centered biome detection (forest/desert/snow/jungle/ocean/cave/underworld) with hysteresis; no wraps: `update(dt)` ticked by main, `drawOverlay(ctx,w,h,cam)` drawn between world and lighting, `getSpawnOverride()` consumed by enemies.zoneTable (underworld post-Wall supplement `ember_wraith` when `boss.wall_of_flesh.defeated`); getters `current/raw/blend/musicTag`; `reset()` (auto on WorldLoaded) |
| gear.js | `TC.Gear`: yoyos (tethered), boomerangs (returning), grenades/fire grenades (fuse + radial damage), night falling stars dropping `fallen_star`. No wraps: `update(dt)/draw(ctx,cam)/onUseHeld(player,def,dt)→bool/iconFor(id)`; `defs`, `reset()` |
| loot.js | `TC.Loot`: breakable POT tiles + LIFE_CRYSTAL (+20 maxHp to 400) + deterministic worldgen post-pass `populateWorld(gen,seed)` called from buildWorld; pot loot rides the TileBroken event; crystal use via `onUseHeld`; `crystalBonus(p)` feeds TC.Stats; SaveCore provider 'character.core.loot'; `reset/populateChest(tx,ty)/stats` |
| loot.js | (see above) |
| registry.js | `TC.Registry`: stable namespaced content ids (`core:dirt`) across kinds tile/wall/item/recipe/enemy/npc/buff/projectileType/biome/station; auto-mirrors TILE_DEFS/ITEM_DEFS/RECIPES/ENEMY_DEFS at load (`syncFromTables()`), legacy numeric aliases, `validate()` throws on problems, deterministic `fingerprint()`, `stableToIndex/byIndex/legacyToStable` |
| events.js | `TC.Events`: on/off/once/emit immediate + queue/flush deferred per-frame bus; frozen `EVENT` name map (TileChanged/TileBroken/WallChanged/LiquidChanged/EntitySpawned/EntityDamaged/EntityKilled/BossDefeated/ProjectileSpawned/InventoryChanged/BuffApplied/BuffExpired/CraftCompleted/WorldProgressChanged/NpcMovedIn/WirePulse/DayChanged/WorldLoaded…); '*' wildcard; listener errors isolated |
| systems.js | `TC.Systems`: fixed update phases (input→commands→movement→physics→projectiles→ai→combat→environment→liquidsWiring→items→progression→eventsFlush) with register/initAll/updateAll + boot/runBoot explicit init; `TC.RenderLayers`: named world/screen draw layers with register/drawWorld/drawScreen |
| commands.js | `TC.Commands`: canonical transactions `submit(name,ctx)→{ok}|{error}` — MineTile/MineWall/PlaceTile/PlaceWall/UseItem/MoveItem/EquipItem/CraftRecipe/InteractTile mirroring current behavior; validate-then-apply with event emission |
| savecore.js | `TC.SaveCore`: versioned envelope {formatVersion:2, gameVersion, generationVersion, registryFingerprint, metadata, world{}, character{}, systems{}}; provider registry `register('section.key',{serialize,deserialize,version})`; migrations; atomic saveNow (tmp→bak→swap); loadFrom with .bak + legacy-blob fallback; export/import |
| stats.js | `TC.Stats`: contributor-based stat resolver — `registerSource(name,priority,fn(player,out))`, `resolve(player)`→frozen snapshot (maxHealth/regen/mana/defense/moveSpeed/melee|ranged|magic damage/critChance/miningSpeed/fishingPower…), `explain(player)`, `invalidate()`; built-ins: armor, accessories+prefixes, buffs, life crystals. player.totalDefense/movement/combat consume it |
| progression.js | `TC.Progression`: world flag store + W14 declarative condition grammar — `set/has/all/discoverBiome/resetForNewWorld`, `test(cond)→bool` (pure, fail-closed; flag strings / all-any-not compounds / {boss|event|biome} shorthands — THE shared gate for recipes, NPC unlocks, shop stock, loot entries, spawn entries, boss summons), FLAGS incl. storm_jelly/moss_mother boss flags, BOSS_FLAG map (BossDefeated → canonical key); auto-records BossDefeated (wof also sets `world.infernal_gateway.opened`/`event.underworld_frontier.completed`); SaveCore provider 'systems.core.progression'; `spawnMultiplier()` scales spawn rate per defeated boss |
| liquids.js | `TC.Liquids`: THE single runtime liquid authority (W1 migration — legacy WATER/LAVA tiles are worldgen/legacy-save representation only, imported into the volume layer at build time by main.buildWorld; no tile-water simulation exists). Type Uint8 + amount Uint8 arrays (water/lava/honey), budgeted settling with equalize/evaporation, water×lava→stone contact; `init/reset/update/wake/set/sampleAt/queryAt/displace/collectAt/placeAt/onUseHeld/columnSurface/draw/importFromWorld/stats/mode/isLiquid`; SaveCore provider 'world.core.liquids'; buckets are kind-'bucket' items converting in place |
| economy.js | `TC.Economy`: canonical currency (coin_copper/silver/gold = 1/100/10000 copper); `total/pay/give/dropCoins/format/DENOMS`; pay is atomic with exact change; shop transactions live in TC.Commands ShopBuy/ShopSell (validate-then-apply, emit ShopBuy/ShopSell events); sell price = 1/5 of ITEM_DEFS[].value |
| grapple.js | `TC.Grapple`: grappling-hook state machine (flying/latched/retracting) driven by kind-'grapple' item defs `{grapple:{range,pull,speed}}` (hook_basic, hook_gemshot); pull thrust pre-player-update + rope constraint post-update via main.step hooks; `onUseHeld/preUpdate/postUpdate/drawWorld/release/active/resetForNewWorld/phase()/anchor()`; solid-tile anchors only, velocity capped |
| debug.js | `TC.Debug`: rolling timings (mark/endMark/frame/stats), counters/snapshot, F3 overlay `drawHud` (fps buckets, liquids, projectiles, flags, wof encounter `state/phase/elapsed/hpFrac/servants/peakServants/peakProjectiles/transitions/despawnReason`), `window.__TEST__` hooks only under location.hash '#test' (`getWofEncounter/setWofHp` for Wall) |

main.js (lead-owned) exposes: `TC.newGame(seed?)`, `TC.continueGame()`, `TC.quitToTitle()`,
`TC.applyCam/clearCam`, `TC.state`, `TC.world`, `TC.worldSeed`, `TC.player`, `TC.camera`,
`TC.debug` (F3), `TC.fps`.

## Rules for contributors (agents and humans)

- Own exactly one file; read anything, write only your own file. `constants.js`, `main.js`,
  `index.html`, `css/style.css`, and this document are lead-owned.
- Match the contract table above exactly — other modules call your API by these names.
- Guard cross-module calls; modules land in parallel and may be absent.
- No external libraries, no network fetches, no copyrighted assets. Procedural everything.
- Never use `Math.random()` in worldgen or anything that must reproduce from a seed —
  use `TC.Utils` seeded RNG. Visual-only randomness elsewhere is fine.
- Style: `'use strict'` IIFE, 2-space indent, single quotes, light comments, ES2020.
- Validate with `node --check js/<file>.js` before finishing.

## Gameplay summary (current scope)

Procedural world (surface, deserts, snow, jungle, oceans, corruption, dungeon, pyramids,
caves, ores, trees, water pockets, underworld), mining/building with tool tiers
(copper → iron → gold), crafting chain (workbench → furnace → anvil), torches +
flood-fill lighting, day/night cycle, slimes/zombies/demon eyes/bats/harpies + Blood
Moon events, melee + bow + magic (mana) + thrown (yoyo/boomerang/grenade) combat,
bosses (Eye of the Void, King Slime, Skeletron, Storm Jelly, Moss Mother, Wall of Flesh production gateway with enter→phase2→enrage, telegraphed fans/bolts, tethered Hungry servants, infernal_core loot), armor/accessories/
buffs, fishing with per-zone loot, wiring mechanisms (switches/levers/plates/timers/dart
traps/actuators), breakable pots + life crystals + chest loot, biome-aware soundtrack +
tints + minimap, inventory + hotbar, save/load via localStorage, synthesized SFX.

Stretch backlog: more NPC types beyond the housing set, water pressure simulation,
moon phases + rain/weather, events (goblin army), hardmode layer, deeper progression
tiers, reforge UI for accessory prefixes.
