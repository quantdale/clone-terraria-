# clone-terraria

An original-assets, from-scratch Terraria-style 2D sandbox game. Vanilla JavaScript +
HTML5 Canvas. No frameworks, no build step to play, no external assets: all graphics are
drawn procedurally in code, all audio is synthesized with WebAudio. Not affiliated with
Re-Logic; no copyrighted Terraria assets, code, or audio are used.

![gameplay](gameplay-day.png)

## Run

Open `index.html` in a browser (plain `<script>` tags, works over `file://`), or serve:

```
python -m http.server 8377
```

Development/validation commands (`node` >= 22 (glob-capable `node --test`) + `npm ci` required):

```
npm test            # node:test suites (unit/core/save/combat/player/npc/world/net/packs)
npm run test:browser  # Playwright journeys (headless Chromium)
npm run build       # reproducible dist/ assembly
npm run validate    # syntax + tests + build + build-verify + browser suite
```
npm run test:net      # multiplayer protocol/session/replication suites
npm run test:packs    # pack loader/activation/save/multiplayer suites
```

## Content packs (W26 — Pack Ecosystem)

The game ships a safe, declarative extensibility layer. Packs are pure data —
no scripts, no callbacks, no code execution; everything is validated fail-closed
before anything is committed atomically to the game.

- **Storm Frontier** (`packs/testpack.js`) ships as the built-in fixture: a small
  tempest crafting chain (Tempest Brick block, Shard/Bar/Blade items and a Wisp
  Charm that summons a mini-boss) plus its display strings.
- **Declarative families:** tiles / items / enemies / recipes / **walls** /
  **standalone loot tables** / **spawn rules** (zone/biome/depth/time/requires) —
  all validated, dependency-ordered and atomically committed with rollback.
- **PackStore** — install any validated JSON pack from the title screen via
  **Content Packs → Install JSON**, export it back, or remove it (blocked while
  active). Installed packs persist in `tc_packs_installed_v1` with caps
  (64 manifests, 256 KiB each, 4 MiB total) and corruption-safe degrade, and are
  provided before activation on every boot so they can be enabled after a reload.
- Enable packs on the title screen via **Content Packs** → toggle → **Apply &
  Restart**. The choice persists (like the locale); booting without a pack is
  byte-for-byte the historical game.
- Saves record which packs were active. Loading a save whose packs are missing
  or changed refuses cleanly with an actionable message and never touches the
  stored save.
- Multiplayer peers prove identical gameplay pack sets during the join handshake
  before any world state is shared (protocol v4). Dedicated hosts select packs
  before world creation via `node tools/mp-server.js --packs a,b --pack-file ./p.json`.

See docs/ARCHITECTURE.md §29 for the full contract and docs/ADR-MOD-004-
sandboxed-mods.md for why executable mods stay research-only.

## Multiplayer (W23 productionized)

Authoritative server; clients propose intents only. 2–4 players per session.
Two ways to play locally:

1. **Dedicated headless host** - `node tools/mp-server.js [--seed 1337] [--port 7777]`
   with tuning flags `--interest 56 --budget 4 --rate 2 --keyframe 600
   --detach-grace 300 --max-out-kb 128` and pack selection
   `--packs a,b --pack-file ./my-pack.json` (repeatable, validated before world
   creation; mismatched clients are rejected before snapshot), then open the game
   in each browser and pick **Join Local Server** (`ws://localhost:7777`).
2. **Browser host** - pick **Host Local Multiplayer** on one machine's title screen;
   other browsers join it the same way.

The host's world is the save; joined clients never write saves. Movement, mining,
placement, combat, loot, inventory, crafting, shop trading and chest transfers are
simulated only by the authority and replicated through baselined per-client region
and entity streams (protocol v4 — v3 added authoritative liquid type+amount
layers; v4 added pack-set identity to hello/welcome; see
docs/ARCHITECTURE.md §26–§29). Latency masking is client-presentation-only: remote entities render through
interpolated snapshot buffers and the local pawn predicts locomotion through the
canonical movement code, reconciled against server truth (small errors blend,
large divergences snap). Determinism: gameplay randomness runs on seeded named
streams (`TC.GameRng`), so same-seed sessions replay identically including enemy
AI and loot.

## Pumps & wiring liquids (W24)

Craft an **Inlet Pump** / **Outlet Pump** at an anvil (iron bars + wire), place
them on wire, and pulse the circuit (switch, lever, pressure plate or timer).
Each pulse moves up to 48 liquid units from every inlet to every outlet on the
same powered component — exactly conserved, deterministic cell order, water +
lava still reacts into stone per the canonical rule. In multiplayer the host
simulates pumps/liquids; joined clients see replicated liquid state in every
region update.


## Controls

| Input | Action |
|---|---|
| `A`/`D` or arrows | Move (1-tile auto step-up) |
| `Space`/`W`/`Up` | Jump / swim / drop through platforms with `S` |
| Left mouse | Mine / place / attack (hold to keep using) |
| Right mouse | Interact: chests, doors, NPCs, wiring devices |
| `1`–`0`, mouse wheel | Select hotbar slot |
| `E` | Inventory + crafting panel |
| `Esc` | Close panel / pause menu (save, quit, sound) |
| `M` / `N` / `F3` | Mute / minimap / debug overlay |

## Features

### World

- 1200×400-tile deterministic worlds from named generation passes (v3): rolling surface,
  deserts, snow, jungle, oceans, corruption, dungeon and pyramid structures, worm+cheese
  caves, a deep-cave layer, micro-biomes (crystal caverns, mushroom grottos, granite,
  marble, moss caves), copper→iron→silver→gold ore veins plus gleam crystal, trees,
  water/lava pockets, underworld.
- Tile shapes: platforms, half-blocks and slopes with hammer reshaping; background wall
  layer (mineable, persisted); flowing water/lava/honey on an independent volume layer
  with buckets; RGB lighting — colored emissive tiles (torches, lava, gleam), colored
  dynamic sources (magic bolts, falling stars, explosions), day/night ambient tint and
  quality profiles (low/medium/high via `TC.Lighting.setQuality`).

### Progression & combat

- Tool/armor tiers copper → iron → silver → gold (+ gleam-crystal endgame blade);
  workbench → furnace → anvil crafting chain with tagged ingredients and station tags.
- Melee arc combat, bows, magic weapons with a mana pool, thrown gear (yoyo, boomerang,
  grenades), grappling hooks, fishing rods with per-zone loot and daily quests.
- Enemies across every biome (slimes, zombies, demon eyes, bats, harpies, vultures,
  skeletons, granite golems, snapvines, frost wolves, void wisps…), Blood Moon events,
  accessory equipment slots with stat prefixes, potion buffs/debuffs (incl. burning).
- Bosses: Eye of the Void, King Slime, Skeletron (+ hands), Storm Jelly, Moss Mother,
  and a production Wall of Flesh gateway — a direction-locked sweeping wall with
  enter→phase2→enrage, telegraphed bolt fans, tethered Hungry servants and
  `infernal_core` loot. Boss kills persist progression flags that unlock recipes
  (Hellforged Blade, Infernal Greaves/Hook), Guide/Merchant stock, and Underworld
  spawns (Ember Wraith).

### Systems

- Canonical content registry (`core:` stable IDs), event bus, command transactions
  (mine/place/craft/equip/buy…) with a deterministic per-tick command queue,
  contributor-based stat resolver, versioned save envelope (SaveCore) with atomic
  writes, backups, export/import and legacy-save migration; per-system save providers.
- One production runtime authority: the fixed-step scheduler (`TC.Runtime` →
  `TC.Systems`) sequences every subsystem; render layers (`TC.RenderLayers`) own the
  draw pipeline; a headless simulation boundary runs the full game loop without
  Canvas/DOM/rAF for deterministic tests and `tools/bench-runtime.js` benchmarks.
- NPCs with housing validation, move-in unlocks, context-aware dialog and an economy
  shop (canonical coin currency); the Guide sells progression hints, not stock.
- Wiring mechanisms (switches, levers, pressure plates, timers, dart traps, actuators),
  breakable pots, life crystals, chest loot, minimap, generative soundtrack that follows
  biome/boss mood, synthesized SFX, deterministic headless test infrastructure
  (node:test + Playwright) and a reproducible release build.
- Localization-ready presentation (W20): every menu/panel/tooltip/dialogue/announcement
  renders through the canonical `TC.Localization` catalog (`js/locales/en.js` is the
  English fallback) with interpolation + plural rules; locale preference persists
  outside game saves; an `en-XA` pseudo-locale stress mode exists for developers under
  `#test`. Additional languages ship as plain `js/locales/<id>.js` catalogs with no
  engine changes.

See `docs/ARCHITECTURE.md` for the module/capability matrix and contracts, and
`docs/TASK_BOARD.md` for current implementation status.

## Project layout

```
index.html            script wiring (fixed load order)
css/style.css         minimal page styles
js/constants.js       lead-owned data tables & tuning (tiles, items, recipes, physics)
js/main.js            browser host: canvas lifecycle, transitions, system/layer registration
js/runtime.js         canonical fixed-step host + headless simulation boundary
js/utils.js           seeded RNG, hashes, noise
js/registry.js        stable namespaced content registry + fingerprint
js/events.js          deferred event bus
js/systems.js         update-phase scheduler + render layers + boot tasks
js/savecore.js        versioned save envelope, providers, atomic IO
js/commands.js        canonical player/system transactions
js/worldgen.js        deterministic pass-based world generation
js/world.js           tile/wall storage, chunk rendering, mining damage, support rules
js/worldregions.js    canonical world-region invalidation authority (multi-consumer)
js/tiles.js           procedural tile/wall rendering, shapes, platforms
js/liquids.js         independent liquid layer (water/lava/honey)
js/lighting.js        RGB light propagation (colored sources) + overlay
js/sky.js             day/night cycle, celestial bodies, weather visuals
js/biomes.js          biome detection, tints, spawn overrides
js/input.js           keyboard/mouse state, cursor
js/audio.js           WebAudio SFX synthesis
js/music.js           generative soundtrack
js/particles.js       particle pool + floating text
js/items.js           inventory, drops, icons, chests
js/economy.js         canonical currency + shop math
js/player.js          movement, collision, item use, armor, summons
js/accessories.js     accessory slots/prefixes + TC.Buffs status effects
js/stats.js           contributor-based stat resolver
js/magic.js           mana pool + magic weapons
js/fishing.js         rods, bait, bite windows, zone loot tables
js/enemydefs.js       enemy/item/recipe content extensions (data only)
js/enemyai.js         reusable AI archetype implementations
js/enemyspawn.js      spawn director, zone tables, Blood Moon event
js/enemies.js         enemy entity lifecycle, damage/death, rendering
js/npcs.js            NPC kinds, housing, dialog, shops
js/projectiles.js     canonical pooled projectile system
js/grapple.js         grappling-hook state machine
js/combat.js          canonical hit resolution + melee/arrows/intake
js/lootables.js       canonical loot-table evaluation + validation
js/loot.js            pots, life crystals, chest population post-pass
js/crafting.js        stations, recipe index, transactional crafting
js/gear.js            yoyo/boomerang/grenade/falling-star behaviors
js/save.js            dual-format persistence facade (v2 envelope + v1 fallback)
js/minimap.js         toggleable minimap
js/ui.js              HUD, inventory/crafting/shop panels, menus, toasts
js/wiring.js          wire tiles + mechanisms
js/debug.js           instrumentation + #test hooks
js/settings.js        user-preference store (locale choice; outside saves)
js/localization.js    canonical translation runtime
js/locales/en.js      English fallback catalog (all display text)
tests/                node:test suites + Playwright journeys
tools/                dev server, release build, verification scripts
docs/                 architecture contract, task board, parity analysis
AGENTS.md             architecture contract for contributors
```

Modules attach to a single global `window.TC` namespace and follow the API contract in
`AGENTS.md`. The game is built agent-first: one contract, one owner per file.
