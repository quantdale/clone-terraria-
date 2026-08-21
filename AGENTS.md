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
| worldgen.js | `TC.WorldGen.generate(seed)` → `{width, height, tiles:Uint8Array, walls:Uint8Array, surfaceY:Int16Array, spawnX, spawnY}`. Fully deterministic from seed (never `Math.random`). Walls: WALL.DIRT/STONE background wherever `y > surfaceY[x]+1` (dirt above the stone line, stone below), none in open sky. Biomes from GEN.biomes: snow regions (SNOW surface+layer) and a jungle region (JGRASS surface, denser trees), avoiding spawn; oceans at both world edges (beach slope + water), desert overhaul with pyramids, corruption strip, dungeon entrance. Underworld from GEN.underworld: large caverns below startY with LAVA pools on their floors. js/loot.js wraps generate() for a deterministic pots/life-crystals/chest-loot post-pass |
| tiles.js | `TC.Tiles.drawTile(ctx,id,px,py,ts,tx,ty,mask)` (mask bits N=1,E=2,S=4,W=8 = neighbor opaque), `TC.Tiles.drawWall(ctx,id,px,py,ts,tx,ty)` (flat darker texture + subtle grain), `TC.Tiles.drawCracks(ctx,px,py,ts,stage0to3)`. Also platforms (hammerable), ropes, hammer tool variants |
| world.js | `class TC.World(gen)`: `get/set/setRaw/isSolid/solidAtPixel/applyMineDamage(tx,ty,amt)→broken`, wall layer `getWall/setWall/setRawWall/applyWallDamage(tx,ty,amt)→broken` (walls render under tiles in chunk canvases; separate damage map), `damage` map, water flow: active-set cellular sim stepped inside `update(dt)` (fall into AIR below, else spread sideways; seeded when tile changes touch WATER; budgeted per frame), `update(dt)` (rebuild ≤3 dirty chunks/frame), `draw(ctx,cam)`, `width/height/tiles/walls/surfaceY`. `set()` enforces support-pop (plants/torch/furniture drop when support lost) and notifies `TC.Lighting.onTileChanged`. `setRaw()` writes without side effects (save-load, tree felling). |
| lighting.js | `TC.Lighting.init(world)`, `onTileChanged(x,y)`, `update(dt,cam)`, `draw(ctx,cam)` (multiply darkness overlay), `lightAt(tx,ty)→0..1` |
| sky.js | `TC.Sky.update(dt)`, `draw(ctx,cam,w,h)` (screen space), `daylight()→0..1`, `time` (seconds, saved), `reset()` |
| input.js | `TC.Input.init(canvas)`, `down/pressed(code)`, `endFrame()`, `axis()→{x,jump}`, `mouse{x,y,down,rightDown,worldX,worldY}`, `hotbarScroll`, `uiHover`, `drawCursor(ctx,cam)` |
| audio.js | `TC.Audio.play(name)`, `toggleMuted()`, `muted` |
| particles.js | `TC.Particles.spawn/burst/floatText/update/draw/clear` |
| items.js | `class TC.Inventory` (50 slots, `add/remove/count/get/serialize/deserialize`), `TC.Items`: `drops[]`, `spawnDrop(x,y,id,count,scatter?)`, `update(dt,player)`, `draw(ctx,cam)`, `clearDrops()`, `iconFor(id)→canvas`; `TC.Chests`: per-position 20-slot containers — `get(tx,ty)→slot array (lazy-created)`, `spill(tx,ty)` (scatter contents as drops), `serialize()/load(data)` |
| player.js | `class TC.Player` (instance at `TC.player`): `update/draw/damage/heal/giveStarterKit/serialize`, static `deserialize(data)`. Equipment: `equipment{head,body,feet}` (armor items from ITEM_DEFS kind 'armor'; using one equips it, swapping with any worn piece), `totalDefense()→n`; summon items (kind 'summon') call `TC.Enemies.spawnBoss(def.boss,…)` at night when used. Right-click interacts: toggles DOOR_CLOSED↔DOOR_OPEN via world.set, opens chests via TC.UI.openChest(tx,ty); breaking a CHEST calls TC.Chests.spill first. Mining AIR tiles with a wall behind (pick equipped) mines the wall via world.applyWallDamage. Standing in LAVA burns (LAVA_TICK/LAVA_DMG through Combat.hurtPlayer src 'lava'); head underwater drains breath over BREATH_SECONDS then drowns at DROWN_DMG/s (field `breath` 0..1 for the UI bubble row) |
| ui.js | `TC.UI.update(dt)`, `draw(ctx,w,h)`; title screen, HUD, inventory + equipment slots (with defense readout), crafting panel, pause menu, death overlay, boss health bar while a boss lives, chest panel via `openChest(tx,ty)`/`closeChest()` when a chest is open (drag between chest and bag), NPC dialog box via `showDialog(name,text)`/auto-close, breath bubble row under hearts while the player's head is underwater; sets `TC.Input.uiHover` |
| enemies.js | `TC.Enemies`: `list[]`, `update/draw/spawnDirector/clear`, `damageEnemy(e,dmg,dir,kb,crit)`, `spawnBoss(type,x,y)` (respects MAX_BOSSES; boss = def.boss). AIs: slime/zombie/eye/bat/eye_boss + king_slime, skeletron (head+hands), wall-of-flesh stub, harpy, eater_of_souls, granite_golem (shockwave); Blood Moon event multiplies spawn rate with unique drops |
| combat.js | `TC.Combat`: `meleeStrike(cx,cy,r,a0,a1,dmg,kb,swingId)`, `shootArrow(x,y,angle,speed,dmg)` (delegates to TC.Projectiles), `update/draw/clear`, `hurtPlayer(dmg,kbx,kby,src)` — subtracts player equipment defense except src 'fall'/'void'; `shockwave(x,y,r,dmg,kb)` radial player hit |
| crafting.js | `TC.Crafting`: `stationsNearby(px,py)→Set`, `available(inv,stations)`, `canCraft(r,inv,st)`, `craft(r,inv)→bool` |
| save.js | `TC.Save`: `save()→bool`, `load()→data|null`, `hasSave()`, `deleteSave()`, `autosave(dt)`. Data: `{v,seed,time,diffs,wallDiffs,player,chests,npcs}` (wallDiffs/chests/npcs optional; npcs = [{type,x,y}] from TC.NPCs.serialize) |
| minimap.js | `TC.MiniMap`: `update(dt)` (toggles on pressed('KeyN'), refreshes its downscaled tile canvas in round-robin strips), `draw(ctx,w,h)` screen-space top-right ~200×150 px region centered on the player, player dot; hidden by default |
| npcs.js | `TC.NPCs`: `list[]`, `spawnGuide(x,y)`, `update(dt)` (wander near home, self-detect RMB over bbox → TC.UI.showDialog), `draw(ctx,cam)`, `clear()`, `serialize()/load(data)` |
| music.js | `TC.Music`: `update(dt)` (call once per frame from main), generative WebAudio soundtrack — mood priority boss > biome (`TC.Biomes.musicTag`: underworld drone / snow arpeggio / jungle percussion / desert phrygian / ocean swells) > day/night; lazy context after first gesture; follows TC.Audio.muted |
| accessories.js | `TC.Accessories` (5 equip slots: `slotsOf/equip/unequip/modsOf/serialize/deserialize`, PREFIX_DEFS + deterministic `rollPrefix` stub) + `TC.Buffs` (timed buffs/debuffs: ironskin/regeneration/swiftness/wrath/poisoned/burning/slowed; `apply/remove/has/modsOf/tick/drawIcons`). Self-installs via runtime wraps: defense/damage mods into Player+Combat, potion consumables, HUD buff row. Adds its own ITEM_DEFS/RECIPES at load |
| magic.js | `TC.Magic`: mana pool (base 20, cap 200 via mana crystals), regen stars, potion sickness, 8+ magic weapons (kind 'magic') firing pooled bolts; `update/drawWorld/clear/ensureMana/spendMana/restoreMana/fire`; HUD mana bar + crystals persist in player save |
| fishing.js | `TC.Fishing`: rods+bait→power, bobber cast, bite rolls + reel timing window, per-zone loot tables (surface/underground/ocean/lava/honey), crates, daily quest fish; `serialize/load` provided (not yet spliced into save blob). Self-wraps Player.useHeld/update/draw |
| projectiles.js | `TC.Projectiles`: pre-allocated pool (128) of typed projectiles — arrow/magic_bolt/yoyo/boomerang/grenade/falling_star/dart — with pierce, bounce, homing, tile collision, explosions, light hooks; `spawn(type,x,y,ang,opts)/update/draw/clear/viewOf(type)`; TC.Combat delegates arrows here (legacy fallback kept) |
| wiring.js | `TC.Wiring`: wire tiles + mechanisms (switch/lever/pressure plate/timer/dart trap/actuator); BFS signal flood from a source cell, receivers fire once per pulse; `init/update/draw/pulse/toggleDevice/placeWire/removeWire/interact/onTileChanged/serialize/load/reset`. Extends TILE/TILE_DEFS/ITEM_DEFS/RECIPES at load; patches World/Player/Save/newGame/continueGame at runtime; wiring blob rides inside the save record under key `wiring` |
| biomes.js | `TC.Biomes`: player-centered biome detection (forest/desert/snow/jungle/ocean/cave/underworld) with hysteresis; screen tint+fog overlay via Sky wrap, ambient particles, spawn-table overrides via spawnDirector wrap; getters `current/raw/blend/musicTag`, `getSpawnOverride()`, `update(dt)`, `reset()` |
| gear.js | `TC.Gear`: yoyos (tethered), boomerangs (returning), grenades/fire grenades (fuse + radial damage), night falling stars dropping `fallen_star`; extends ITEM_DEFS/RECIPES at load, wraps Player.useHeld + Combat.update + iconFor; `defs`, `reset()` |
| loot.js | `TC.Loot`: breakable POT tiles + LIFE_CRYSTAL (+20 maxHp to 400, persisted) + deterministic worldgen post-pass placing pots/crystals and pre-filling generated chests with loot keyed by position hash; pot breaks scatter small loot; `reset/populateChest(tx,ty)/stats`. Extends TILE/TILE_DEFS/ITEM_DEFS at load, wraps WorldGen.generate/World.applyMineDamage/Player.useHeld/serialize |

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
bosses (Eye of the Void, King Slime, Skeletron, Wall of Flesh stub), armor/accessories/
buffs, fishing with per-zone loot, wiring mechanisms (switches/levers/plates/timers/dart
traps/actuators), breakable pots + life crystals + chest loot, biome-aware soundtrack +
tints + minimap, inventory + hotbar, save/load via localStorage, synthesized SFX.

Stretch backlog: more NPC types beyond the housing set, water pressure simulation,
moon phases + rain/weather, events (goblin army), hardmode layer, deeper progression
tiers, reforge UI for accessory prefixes.
