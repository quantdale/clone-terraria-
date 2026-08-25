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
Headless runtime benchmark: `node tools/bench-runtime.js [ticks]`

## Architecture

Global namespace `window.TC`. Each module is an IIFE attaching its API to `TC`.
Script load order is fixed in `index.html`; modules only *call* each other at runtime,
so load order is not critical, but guard optional dependencies (`if (TC.Audio) ...`).

Coordinate conventions: world pixels unless a name ends in `Tx/Ty` (tile coords).
Tile size `TC.CONST.TS = 16`. +y is down. Camera `TC.camera = {x, y, zoom}`.

Update order per fixed 1/60s step is owned by the scheduler — `TC.Runtime.tick()` →
`TC.Systems.updateAll(dt)` over the phases declared in `js/systems.js`: input (UI +
player-intent creation) → commands (queue drain) → environment → movement (grapple-pre
→ player → grapple-post → loot) → physics → projectiles (driven inside combat) → ai
(fishing, spawn-director → enemies, npcs) → items → combat (projectiles/accessories/
gear/magic/particles) → liquidsWiring (world → wiring → liquids) → progression
(lighting, music, minimap, autosave) → eventsFlush. Systems may declare `when` gates:
title/paused run only UI + event flush. main.js registers systems and drawers; it no
longer sequences updates manually.

World-region invalidation is owned by `TC.WorldRegions` (W21): every authoritative mutation seam reports there; renderer/lighting/minimap consume through independent cursors (multi-consumer invariant — nobody can steal another's invalidation). RGB lighting (W21) is production-integrated with quality profiles via `TC.Lighting.setQuality` (persisted in TC.Settings). Draw order per frame is owned by `TC.RenderLayers` (declared in `js/systems.js`): the
browser host draws only the sky/background clear, then `drawWorld` runs world-space
layers under the camera transform (tiles → liquids → decor → wiring overlay → items →
enemies → npcs → player → projectiles/combatFx → particles), then `drawScreen` runs
screen layers (biome tint → lighting → minimap/cursor overlays → HUD/magic/accessories
→ debug). World-space draw functions wrap drawing with `TC.applyCam(ctx)` /
`TC.clearCam(ctx)` from main.js when invoked outside the pipeline.

## Module API contract

```js
const PHASES = ['input', 'commands', 'environment', 'movement', 'physics', 'projectiles',
                'ai', 'items', 'combat', 'liquidsWiring', 'progression', 'eventsFlush'];
```

Systems may declare `when(state)` gates; the production loop gates simulation systems
to `playing && !UI.paused` (pause genuinely freezes the world), while UI and event
flush always run. Registration order breaks ties inside a phase. Observability:
`currentPhase()`, `tickCount()`, `getCounts()/getPerTickCounts()/resetCounts()`.
Per-drawer call/error counters live on `TC.RenderLayers.list()` entries.

| Module (file) | Exposes |
|---|---|
| constants.js | `TC.CONST`, `TC.TILE`, `TC.TILE_DEFS[]`, `TC.ITEM_DEFS`, `TC.RECIPES`, `TC.ENEMY_DEFS` (lead-owned, read-only) |
| utils.js | `TC.Utils`: `mulberry32(seed)`, `hash2(x,y,s)`, `randRange/randInt/choose(rng,...)`, `clamp`, `lerp`, `aabb(...)`, `Noise2D(seed)` with `.noise2(x,y)` and `.fbm2(x,y,octaves,lac,gain)` |
| worldgen.js | `TC.WorldGen.generate(seed)` → `{width, height, tiles:Uint8Array, walls:Uint8Array, surfaceY:Int16Array, spawnX, spawnY, timings, stats}`. Deterministic from seed + GENERATION_VERSION (never `Math.random`): structured as named passes `PASSES = terrain → surface-biomes → caves → deep-caves → ores → micro-biomes → structures → decor → validation` (v3, W4), each with its own seeded rng stream (`runPass(name, ctx)` for debug); `CONFIG = {deepCaves, microBiomes, richOres}` feature flags (**default on** since v3). Walls: WALL.DIRT/STONE background wherever `y > surfaceY[x]+1`; biomes snow/jungle/desert/ocean/corruption/dungeon/pyramids/underworld per GEN; micro-biomes crystal cavern/mushroom grotto/granite/marble/moss cave. WATER/LAVA tiles are worldgen OUTPUT format only — main.buildWorld imports them into TC.Liquids at load. Loot post-pass is invoked explicitly via `TC.Loot.populateWorld(gen, seed)` from main.buildWorld |
| tiles.js | `TC.Tiles.drawTile(ctx,id,px,py,ts,tx,ty,mask)` (mask bits N=1,E=2,S=4,W=8 = neighbor opaque), `TC.Tiles.drawWall(ctx,id,px,py,ts,tx,ty)` (flat darker texture + subtle grain), `TC.Tiles.drawCracks(ctx,px,py,ts,stage0to3)`. Also platforms (hammerable), ropes, hammer tool variants |
| world.js | `class TC.World(gen)`: `get/set/setRaw/isSolid/solidAtPixel/applyMineDamage(tx,ty,amt)→broken`, wall layer `getWall/setWall/setRawWall/applyWallDamage(tx,ty,amt)→broken` (walls render under tiles in chunk canvases; separate damage map), `damage` map. W21: chunk dirty tracking is delegated to `TC.WorldRegions` (consumer 'renderer'); `update(dt)` rebuilds ≤3 stale regions/frame camera-nearest; `regionStats()` exposes rebuilt/backlog/maxBacklog/skipped/budget counters; `markDirtyAt(x,y[,reason])` and `markAllDirty()` delegate to the authority (legacy border fan-out lives in `WorldRegions.markTile`), `draw(ctx,cam)`, `width/height/tiles/walls/surfaceY`. `set()` enforces support-pop (plants/torch/furniture drop when support lost) and notifies `TC.Lighting.onTileChanged`. `setRaw()` writes without side effects (save-load, tree felling). |
| worldregions.js | `TC.WorldRegions` (W21): THE canonical world-region invalidation authority — 32×32-tile regions over the live world, monotonic per-region revisions + per-consumer delivery queues + per-region last-seen arrays; multi-consumer invariant (no consumer can steal another's invalidation). API: `init(world)/reset`, `chunkOf/chunkCoords`, `markCell/markTile/markRect/markChunk/markAll(,reason)`, `consume(name)` → `{isDirty,pendingCount,dirtyRegions,staleAll,observe,observeAll}`, `revision/pendingKinds/stats`. Reasons: tile/wall/shape/paint/liquid/bulk/world. Headless-safe, Canvas-free; substrate for future NET-004 replication/ack. |
| lighting.js | `TC.Lighting` (W21 RGB rewrite): three-channel Float32 field (R,G,B) per camera-window cell + display layer (field ⊕ dynamic sources); sky ambient mixes authored warm-day/moon-blue by daylight; emissive tiles carry per-name colors (neutral fallback). `init/onTileChanged/addDynamic(x,y,r,intensity,ttl[,'#rrggbb' color])/update(dt,cam)/draw(ctx,cam)`, queries `lightAt(tx,ty)→0..1 luminance` and `lightRgbAt(tx,ty[,out])`; region-aware invalidation via WorldRegions consumer 'lighting' (halo-expanded rect recomputes; full reseeds on 8-tile-aligned window moves / daylight quanta / world swap); `counters()` observability; quality profiles low|medium|high (`setQuality`, persisted via TC.Settings 'lightingQuality') scale ONLY overlay raster step + dynamic-merge cadence — queried values identical across profiles. |
| sky.js | `TC.Sky.update(dt)`, `draw(ctx,cam,w,h)` (screen space), `daylight()→0..1`, `time` (seconds, saved), `reset()` |
| input.js | `TC.Input.init(canvas)`, `down/pressed(code)`, `endFrame()`, `axis()→{x,jump}`, `mouse{x,y,down,rightDown,worldX,worldY}`, `hotbarScroll`, `uiHover`, `drawCursor(ctx,cam)` |
| audio.js | `TC.Audio.play(name)`, `toggleMuted()`, `muted` |
| particles.js | `TC.Particles.spawn/burst/floatText/update/draw/clear` |
| items.js | `class TC.Inventory` (50 slots, `add/remove/count/get/serialize/deserialize`), `TC.Items`: `drops[]`, `spawnDrop(x,y,id,count,scatter?)`, `update(dt,player)`, `draw(ctx,cam)`, `clearDrops()`, `iconFor(id)→canvas`; `TC.Chests`: per-position 20-slot containers — `get(tx,ty)→slot array (lazy-created)`, `spill(tx,ty)` (scatter contents as drops), `serialize()/load(data)` |
 | player.js | `class TC.Player` (instance at `TC.player`): `update/draw/damage/heal/giveStarterKit/serialize`, static `deserialize(data)`. Held-use and right-click INTENT is created by the scheduler's input phase ('player-intent', main.js) and executed by the canonical UseItem/InteractTile transactions in the same tick's commands phase — the player never mutates the world directly from input (legacy `useHeld/interact` remain as fallbacks for embeds without commands). Equipment: `equipment{head,body,feet}` (armor items from ITEM_DEFS kind 'armor'; equipping swaps with any worn piece via EquipItem), `totalDefense()→n`; summon items (kind 'summon') call `TC.Enemies.spawnBoss(def.boss,…)` with declarative `summon:{time,biome,requires,placement}` — charge consumed ONLY on success, exactly once on valid encounter. Breaking a CHEST calls TC.Chests.spill first. Mining AIR tiles with a wall behind (pick equipped) mines the wall via MineWall. Standing in LAVA burns (through Combat.hurtPlayer src 'lava'); head underwater drains breath over BREATH_SECONDS then drowns (field `breath` 0..1 for the UI bubble row) |
| ui.js | `TC.UI.update(dt)`, `draw(ctx,w,h)`; title screen, HUD, inventory + equipment slots (with defense readout), crafting panel (craft clicks submit the CraftRecipe transaction), pause menu, death overlay, boss health bar while a boss lives, chest panel via `openChest(tx,ty)`/`closeChest()` when a chest is open (drag between chest and bag), NPC dialog box via `showDialog(name,text)`/auto-close, shop rows transacting through ShopBuy/ShopSell, breath bubble row under hearts while the player's head is underwater; sets `TC.Input.uiHover` |
| enemies.js | `TC.Enemies` (ENTITY lifecycle only — W13 split): `list[]`, `update/draw/clear`, `damageEnemy(e,finalDmg,dir,kb,crit)` applies RESOLVER-final damage and is the single emitter of EntityDamaged/EntityKilled/BossDefeated (death exactly once), `spawnBoss(type,x,y,opts)→enemy|null` (respects MAX_BOSSES; null = full; `opts:{dir,band}` for Wall), `spawnEnemy(type,x,y)`, `spawnDirector(dt)` facade → TC.EnemySpawn; additive seams: `makeEnemy`, `trackHostileShot(pr,shooter,dmg)`, `spawnServantOf(boss,type,bx,by)`, `clearHostileShotsOf(boss)`, `getWofEncounter()→{state,phase,elapsed,hpFrac,servants,peakServants,peakProjectiles,transitions,despawnReason,dir,hostile}`, `clearEncounter()`. Wall is noclip sweeping wall with direction-locked band, explicit despawn, and F3 observability. Rendering for all archetypes lives here |
| combat.js | CANONICAL hit resolution (W12): `TC.Combat.resolveHit(spec)→{ok,damage,crit,kb,cls,source,defenseApplied,mitigated,statuses,rejected}` — pure, injectable `spec.rng`; classes generic/melee/ranged/magic/summon via `DAMAGE_CLASSES` (statField per class); player-owned attacks scale through TC.Stats, everything else deals declared base; target defense + flat `pen`; min damage 1; `registerMitigation(key,fn)` content policies. `hitEnemy(target,dir,spec)` resolve+apply via Enemies.damageEnemy. `meleeStrike/shootArrow/update/draw/clear`, `hurtPlayer(dmg,kbx,kby,src)→{finalDamage,defenseApplied,crit,rejected}` (environmental policy: 'fall'/'void' bypass defense; lava burning via TC.Buffs.statusForSource), `shockwave(...)` |
| crafting.js | `TC.Crafting`: `stationsNearby(px,py)→Set`, `available(inv,stations)`, `canCraft(r,inv,st)`, `craft(r,inv,st)→bool`, plus W14 progression gating — recipes may declare `requires` (shared condition grammar); `lockReason(r,inv,st)→null|'progression'|'station'|'costs'` for UI hints |
| lootables.js | `TC.LootTables` (W13 canonical loot): entry schema `{id,min,max,chance,requires}`, `roll(table,{rng})→[{id,count}]`, `rollCoins([min,max])`, `rollEntity(def,cx,cy)` (ENEMY_DEFS drops+coins scatter), `validate/validateRange/validateAll` (unknown ids, chance bounds, inverted ranges); injectable rng for tests |
| enemydefs.js | Enemy content extensions extracted from constants-adjacent ownership (W13+W17): ENEMY_DEFS biome regulars + bosses (king_slime, skeletron+hand, wof, storm_jelly, moss_mother) + ember_wraith post-Wall, summon ITEM_DEFS (slime_crown/skull_sigil/flesh_sigil/blood_sigil) with `summon:{time,biome,requires,placement}` + infernal_core family (hellforged_blade/infernal_greaves/infernal_hook), their RECIPES; pure data merged at load time |
| enemyai.js | `TC.EnemyAI` (W13+W17): reusable behavior archetypes keyed by def.ai — slime/zombie/eye/bat/walker(+lunge/charge)/harpy/stationary/teleporter + boss AIs king_slime/eye_boss/skeletron/skele_hand/wof/storm_jelly/moss_mother + hungry (W17 tethered servant); `get(aiName)→impl`, shared `util.{rand,clamp,approach,daylight,weightedPick,solidAt,rectSolid}`, `isFlyer(ai)` authority; `wof` is a direction-locked, band-constrained multi-phase wall (enter→phase1→phase2→enrage) with telegraphed fans/bolts and bounded servant shedding; impls `(e,{clock},dt)→bool` (false = remove) |
| enemyspawn.js | `TC.EnemySpawn` (W13+W19): spawn director + rules — `update(dt)` (Blood Moon dusk/dawn lifecycle then director tick), `spawnDirector`, `zoneOf(p,w,dl)→'day'|'night'|'cave'|'underworld'` (depth-first: underworld membership via TC.Biomes.isUnderworldAt outranks the generic cave rule; Blood Moon stays surface-night-only), `zoneTable(zone,pcol)` (biome override replaces vanilla for every zone except ordinary 'cave'; `[type,weight,condition]` entries filtered everywhere through Progression.test, fail-closed), `findSpot(def,tx,ty,surf)`, `surfaceBiome/playerDepthT`, `setBloodMoon/isBloodMoon/reset` |
| save.js | `TC.Save`: dual-format persistence. With SaveCore: providers 'world.core'/'character.core', `save()`→SaveCore.saveNow('tc_save_v2') versioned envelope (all system providers ride along), `load()` flattens the envelope to the legacy shape + `__envelope` for SaveCore.restore; falls back to legacy 'tc_save_v1' blob `{v,seed,time,diffs,wallDiffs,player,chests,npcs}`; `hasSave()/deleteSave()` cover both formats; `exportSave()/importSave(str)`, `computeWorldDiffs()`, `autosave(dt)` |
| minimap.js | `TC.MiniMap` (W21 region-driven): `update(dt)` toggles on pressed('KeyN'); repaints ONLY WorldRegions-stale blocks (≤24/frame catch-up on reveal; zero work while hidden); per-block pixels tinted by biome (Underworld cutoff via `TC.Biomes.underworldTopPx`, ocean margin via `TC.Biomes.oceanEdge`); localized biome label + hint; player dot/viewport drawn per frame independent of terrain; `stats()` observability |
| npcs.js | `TC.NPCs`: `list[]`, `spawnGuide(x,y)` + generic `spawn(type,x,y)` over NPC_KINDS table (dialog/unlocks/shop/look), `evaluateUnlocks()` (consults TC.Progression.test + population), `validateHome(tx,ty,w,h)` (floor/blocked/entrance/walls≥60%/flooded/dark/open + size bounds), incremental house claiming on move-in (`claimHouse/houseOf`, state.home persisted), context-aware dialog (progression-gated dialogFlags pools > night/biome pools, deterministic), damage→respawn-at-home after delay; `update/draw/clear/serialize/load` (loader tolerates legacy blobs); progression-aware `shopOf(type)/kindDef(type)` for UI (stock rows carry `requires` conditions) |
| music.js | `TC.Music`: `update(dt)` (call once per frame from main), generative WebAudio soundtrack — mood priority boss > biome (`TC.Biomes.musicTag`: underworld drone / snow arpeggio / jungle percussion / desert phrygian / ocean swells) > day/night; lazy context after first gesture; follows TC.Audio.muted |
| accessories.js | `TC.Accessories` (5 equip slots: `slotsOf/equip/unequip/modsOf/serialize/deserialize`, PREFIX_DEFS + deterministic `rollPrefix`) + `TC.Buffs` (timed buffs/debuffs; `apply/remove/has/modsOf/tick/drawIcons`, emits BuffApplied/BuffExpired). No runtime wraps: stats flow through TC.Stats (`modsOf` is a Stats source); hooks `update(dt)/onUseHeld(player,def,dt)→bool/drawHud(ctx)/iconFor(id)`; SaveCore provider 'character.core.accessories'; `restoreLegacy(playerData)` for v1 blobs. Adds its own ITEM_DEFS/RECIPES at load |
| magic.js | `TC.Magic`: mana pool (base 20, cap 200 via mana crystals), regen stars, potion sickness, magic weapons firing pooled bolts via TC.Projectiles.spawn('magic_bolt',…); no runtime wraps: `update/drawWorld/drawHud/clear/ensureMana/spendMana/restoreMana/fire/onRespawn/captureOf/attachToPlayer/restoreLegacy/iconFor`; mana persists via player-blob parity fields + SaveCore provider 'character.core.magic' |
| fishing.js | `TC.Fishing`: rods+bait→power, bobber cast, bite rolls + reel timing window, per-zone loot tables (surface/underground/ocean/lava/honey), crates, daily quest fish. No runtime wraps: hooks `update(dt)/draw(ctx,cam)/onUseHeld(player,def,dt)→bool/iconFor(id)`; persistence via SaveCore provider 'systems.core.fishing' + `restoreLegacy(blob)` |
| projectiles.js | `TC.Projectiles` — CANONICAL projectile system: pre-allocated pool (128) of typed projectiles — arrow/magic_bolt/yoyo/boomerang/grenade/falling_star/wire_dart — with pierce/bounce/homing/tile collision/explosions/light hooks (`getLights()`); `spawn(type,x,y,ang,opts)` emits ProjectileSpawned; per-spawn opts override type defs |
| wiring.js | `TC.Wiring`: wire tiles + mechanisms (switch/lever/pressure plate/timer/dart trap/actuator); BFS signal flood from a source cell, receivers fire once per pulse emitting WirePulse. No core patches: reacts to TileChanged events, exposes `isGhost(tx,ty)` consulted by World.isSolid, darts ride the projectile pool; `init/update/draw/pulse/toggleDevice/placeWire/removeWire/interact/isGhost/attachActuatorAt/serialize/load/reset/resetForNewWorld`; SaveCore provider 'systems.core.wiring' |
| biomes.js | `TC.Biomes`: player-centered biome detection (forest/desert/snow/jungle/ocean/cave/underworld) with hysteresis; no wraps: `update(dt)` ticked by main, `drawOverlay(ctx,w,h,cam)` drawn between world and lighting, `getSpawnOverride()` consumed by enemies.zoneTable (underworld base + post-Wall supplement declared as `[type,weight,condition]` grammar entry `ember_wraith` gated on `boss.wall_of_flesh.defeated`, filtered fail-closed by zoneTable); THE shared Underworld authority (W19): pure `underworldTopPx()` + `isUnderworldAt(xPx,yPx)`; pure `oceanEdge()` (W21, consumed by minimap) — summon validation, Wall lifecycle and spawn zoning all derive from it; getters `current/raw/blend/musicTag`; `reset()` (auto on WorldLoaded) |
| gear.js | `TC.Gear`: yoyos (tethered), boomerangs (returning), grenades/fire grenades (fuse + radial damage), night falling stars dropping `fallen_star`. No wraps: `update(dt)/draw(ctx,cam)/onUseHeld(player,def,dt)→bool/iconFor(id)`; `defs`, `reset()` |
| loot.js | `TC.Loot`: breakable POT tiles + LIFE_CRYSTAL (+20 maxHp to 400) + deterministic worldgen post-pass `populateWorld(gen,seed)` called from buildWorld; pot loot rides the TileBroken event; crystal use via `onUseHeld`; `crystalBonus(p)` feeds TC.Stats; SaveCore provider 'character.core.loot'; `reset/populateChest(tx,ty)/stats` |
| loot.js | (see above) |
| registry.js | `TC.Registry`: stable namespaced content ids (`core:dirt`) across kinds tile/wall/item/recipe/enemy/npc/buff/projectileType/biome/station; auto-mirrors TILE_DEFS/ITEM_DEFS/RECIPES/ENEMY_DEFS at load (`syncFromTables()`), legacy numeric aliases, `validate()` throws on problems, deterministic `fingerprint()`, `stableToIndex/byIndex/legacyToStable` |
| events.js | `TC.Events`: on/off/once/emit immediate + queue/flush deferred per-frame bus; frozen `EVENT` name map (TileChanged/TileBroken/WallChanged/LiquidChanged/EntitySpawned/EntityDamaged/EntityKilled/BossDefeated/ProjectileSpawned/InventoryChanged/BuffApplied/BuffExpired/CraftCompleted/WorldProgressChanged/NpcMovedIn/WirePulse/DayChanged/WorldLoaded/LocaleChanged…); '*' wildcard; listener errors isolated |
| settings.js | `TC.Settings` (W20): tiny versioned user-preference store in ONE localStorage envelope `tc_settings_v1` ({v:1,values:{...}}) — corrupt-safe, unknown-field tolerant; locale choice lives here, OUTSIDE world/character saves; `available/get/set/remove/clear` |
| systems.js | `TC.Systems`: THE production fixed-step scheduler — phases per the block above, register(phase,name,{init?,update?},{after/before/when}) with state gates, initAll/updateAll/resolved-order constraints/cycle isolation + boot/runBoot explicit init; observability `currentPhase()/tickCount()/getCounts()/getPerTickCounts()/resetCounts()`; `TC.RenderLayers`: named world/screen draw layers (register/drawWorld/drawScreen/clear/list) with per-drawer call+error counters |
| runtime.js | `TC.Runtime` (alias `TC.Simulation`): canonical fixed-step host — `tick(dt)/advanceTicks(n)` drive Systems.updateAll (guarded legacy direct-call sequence only when systems.js is absent); state gating (title/paused run UI + event flush only), camera follow, tick/phase/command observability; headless boundary: `createWorld(seed)`, `advanceTicks`, `reset`, `getState()` run meaningful simulation with no Canvas/DOM/rAF; tick count + queue reset on WorldLoaded |
| commands.js | `TC.Commands`: canonical transactions `submit(name,ctx)→{ok,result}|{ok:false,error}` — MineTile/MineWall/PlaceTile/PlaceWall/UseItem (full live dispatch incl. integration hooks, hammer shaping, actuator, honest used/reason results)/MoveItem/EquipItem/CraftRecipe/InteractTile/ShopBuy/ShopSell; PLUS deterministic FIFO queue: `enqueue/drain/pending/clearQueue/stats` drained once per tick in the scheduler's commands phase (snapshot semantics, bounded 256, cleared on WorldLoaded) |
| savecore.js | `TC.SaveCore`: versioned envelope {formatVersion:2, gameVersion, generationVersion, registryFingerprint, metadata, world{}, character{}, systems{}}; provider registry `register('section.key',{serialize,deserialize,version})`; migrations; atomic saveNow (tmp→bak→swap); loadFrom with .bak + legacy-blob fallback; export/import |
| netproto.js | `TC.NetProto` (W22): versioned authoritative-multiplayer protocol — envelope `{v,t,sid,pid,cseq,sseq,tick,p}`, strict fail-closed validation, message TYPES (hello/welcome/reject/snapshot/input/cmd/cmdres/worldupd/ack/resync/bye), COMMAND_WHITELIST, region full/delta codecs, deterministic state digests; transport-agnostic, headless-safe |
| nettransport.js | `TC.NetTransport` (W22): byte-mover boundary — `loopbackPair()` deterministic duplex (manual pump + dropNext/dupNext/swapNext injection) and `websocket(url)` platform client wrapper. Endpoints: send/onMessage/onStatus/close |
| players.js | `TC.Players` (W22): multi-player identity registry — `create/remove/get/all/entry/idOf/primary/setPrimary/retainOnly/resetForNewWorld/count/isRemote/MAX`; exactly one local primary (`TC.player` aliases it); remotes can never become primary; session teardown hygiene |
| netserver.js | `TC.NetServer.create(opts)` (W22): authoritative session runner — start/attachLocal/connect/tick/stop/runForever(summary); per-tick inbound processing → Runtime.tick → replication; private per-client WorldRegions consumers ('net:<cid>'), region interest (~56 tiles), bounded snapshot streams + last-sent-baselined deltas, acks as desync detector, detached-identity reconnect with cseq floors and grace expiry; stats in F3 |
| netclient.js | `TC.NetClient.create(opts)` (W22): joining-side controller — connect/sendCmd/disconnect/tryReconnect/frame; phases idle→connecting→syncing→playing→closed; applies snapshots/deltas into a presentation mirror (world tiles/walls via setRaw, player/enemy/drop mirrors, self-inventory refresh); samples+streams input frames; never runs the local simulation while joined (`drivesTick()` gates main.js) || stats.js | `TC.Stats`: contributor-based stat resolver — `registerSource(name,priority,fn(player,out))`, `resolve(player)`→frozen snapshot (maxHealth/regen/mana/defense/moveSpeed/melee|ranged|magic damage/critChance/miningSpeed/fishingPower…), `explain(player)`, `invalidate()`; built-ins: armor, accessories+prefixes, buffs, life crystals. player.totalDefense/movement/combat consume it |
| progression.js | `TC.Progression`: world flag store + W14 declarative condition grammar — `set/has/all/discoverBiome/resetForNewWorld`, `test(cond)→bool` (pure, fail-closed; flag strings / all-any-not compounds / {boss|event|biome} shorthands — THE shared gate for recipes, NPC unlocks, shop stock, loot entries, spawn entries, boss summons), FLAGS incl. storm_jelly/moss_mother boss flags, BOSS_FLAG map (BossDefeated → canonical key); auto-records BossDefeated (wof also sets `world.infernal_gateway.opened`/`event.underworld_frontier.completed`); SaveCore provider 'systems.core.progression'; `spawnMultiplier()` scales spawn rate per defeated boss |
| liquids.js | `TC.Liquids`: THE single runtime liquid authority (W1 migration — legacy WATER/LAVA tiles are worldgen/legacy-save representation only, imported into the volume layer at build time by main.buildWorld; no tile-water simulation exists). Type Uint8 + amount Uint8 arrays (water/lava/honey), budgeted settling with equalize/evaporation, water×lava→stone contact; `init/reset/update/wake/set/sampleAt/queryAt/displace/collectAt/placeAt/onUseHeld/columnSurface/draw/importFromWorld/stats/mode/isLiquid`; SaveCore provider 'world.core.liquids'; buckets are kind-'bucket' items converting in place |
| economy.js | `TC.Economy`: canonical currency (coin_copper/silver/gold = 1/100/10000 copper); `total/pay/give/dropCoins/format/DENOMS`; pay is atomic with exact change; shop transactions live in TC.Commands ShopBuy/ShopSell (validate-then-apply, emit ShopBuy/ShopSell events); sell price = 1/5 of ITEM_DEFS[].value |
| grapple.js | `TC.Grapple`: grappling-hook state machine (flying/latched/retracting) driven by kind-'grapple' item defs `{grapple:{range,pull,speed}}` (hook_basic, hook_gemshot); pull thrust pre-player-update + rope constraint post-update via main.step hooks; `onUseHeld/preUpdate/postUpdate/drawWorld/release/active/resetForNewWorld/phase()/anchor()`; solid-tile anchors only, velocity capped |
| debug.js | `TC.Debug`: rolling timings (mark/endMark/frame/stats), counters/snapshot, F3 overlay `drawHud` (fps buckets, tick/phase/command-queue stats, liquids, projectiles, flags, wof encounter fields), `window.__TEST__` hooks only under location.hash '#test' (`getWofEncounter/setWofHp/getRuntimeState` + W20 localization hooks `getLocale/setLocale/translate/getLocalizationStats/getMissingKeys`) |
| localization.js | `TC.Localization` (W20): THE canonical translation authority — additive locale registration (`register(locale,catalog,meta?)`, nested catalogs flatten to dotted keys), English fallback ('en') with visible `[key]` placeholder + warn-once diagnostics, `{name}` interpolation (missing var stays literal + reported), Intl.PluralRules plural entries with one/other fallback, `setLocale/getLocale/availableLocales/localeMeta/t/has/contentName/contentDescription/contentKey/validate/missing/stats/restore/isRegistered`; content names resolve through the registry from ANY reference form (numeric legacy index, object key, shorthand, stable id); emits LocaleChanged; syncs document lang/title when DOM present; registers the en-XA pseudo stress locale ONLY under '#test' |
| locales/en.js | Canonical English fallback catalog (W20): ALL normal user-facing text — ui.* surfaces, progress/event/feedback templates, prefix.*, and every displayable tile/wall/item/enemy/npc/buff/biome/station `.name`/`.description`/`.title` plus Guide/Merchant dialogue pools under `<kind>.<ns>.<id>…` registry-derived keys. New user-facing strings MUST ship here or check:i18n fails. Future languages = new js/locales/<id>.js registering + restore() |

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

### Localization rules (W20 — mandatory)

- NEVER localize machine identity: registry ids (`ns:name`), TILE numeric ids,
  WALL ids, ITEM_DEFS/enemy/npc/projectile/buff type ids, recipe identities,
  biome tags, station ids/tags, progression flags, command/event names, save
  provider/schema keys, test selectors, debug counters. Translated strings are
  never authoritative identity and never feed the registry fingerprint
  (`bdad6cfa` is regression-guarded by tools/check-i18n.js +
  tests/core/localization-identity.test.js).
- Legacy `def.name` fields are FROZEN identity metadata — do not reword them;
  do not read them in presentation paths (resolve via
  `TC.Localization.contentName(kind, ref)` instead).
- All normal player-facing strings (UI labels, tooltips, dialogue, toasts,
  feedback floaters, announcements) live in js/locales/en.js and render via
  `t(key, vars)` / `contentName(kind, ref)`. No new raw string literals, no
  `'x' + value` English concatenation, no id→TitleCase conversion in UI code.
  Parameterized messages use named `{vars}` templates — never assembled word
  order. Plurals use plural entries, never `+'s'` logic.
- New content workflow: add the def (any module), then add its catalog entry
  (`item.core.<key>.name` etc., dialogue keys for NPCs) in js/locales/en.js.
  NPC dialog pools hold CATALOG KEYS; `UI.showDialog(npcType, lineKey)` takes
  the STABLE npc type — display names must never decide shop/dialog identity.
- User preferences (locale, future settings) persist ONLY via TC.Settings —
  never inside world/character saves.
- Gate: `npm run check:i18n` runs inside `npm run validate` and fails on
  missing catalog coverage or registry-identity drift.

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

Multiplayer (W22): authoritative two-client vertical slice over loopback/WebSocket
transports (host via title menu or `node tools/mp-server.js`; clients join from the
title screen). Single-player remains the default path with zero networking.

Stretch backlog: more NPC types beyond the housing set, water pressure simulation,
moon phases + rain/weather, events (goblin army), hardmode layer, deeper progression
tiers, reforge UI for accessory prefixes.
