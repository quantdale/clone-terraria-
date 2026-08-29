# Assets, Localization, and Modding Plan

## Objective

Improve visual/audio quality and future content extensibility without sacrificing the repository's strongest legal and technical advantage: it currently uses original/procedural rendering and synthesized audio rather than copied Terraria assets.

This document defines a pipeline for original authored content, localization, resource packs, data packs, and eventual scripting.

---

# 1. IP and provenance rules

The project should target **mechanical and experiential inspiration**, not asset/content duplication.

Never commit or ship:

- Terraria sprite sheets, tiles, backgrounds, music or sound effects;
- extracted Terraria data files or decompiled source;
- copied NPC dialogue, item descriptions, lore text or UI wording;
- Terraria logos/trademarks as project branding;
- third-party fan assets without a compatible license and attribution record.

Every non-generated asset should have provenance recorded.

Recommended manifest fields:

```yaml
id: core:forest_background_01
source: original
creator: project-team
license: project-license
source_file: art/backgrounds/forest/forest-01.aseprite
exported_file: public/assets/backgrounds/forest-01.png
notes: original work, no Terraria source asset used
```

For third-party permissive assets:

```yaml
source: third-party
source_url: ...
license: CC-BY-4.0
attribution: ...
```

Add `THIRD_PARTY_NOTICES.md` before any release containing third-party content.

---

# 2. Current presentation baseline

The root README states that graphics are drawn procedurally in code and audio is synthesized through WebAudio. Keep those systems available as:

- debug/fallback mode;
- accessibility/high-contrast experimentation;
- deterministic test visuals;
- placeholder generation during content development.

Do **not** delete the procedural pipeline simply because authored assets are introduced.

---

# 3. Original pixel-art pipeline

## Recommended directory structure

```text
art/
  sprites/
    player/
    enemies/
    npcs/
    items/
    projectiles/
  tiles/
  walls/
  backgrounds/
  ui/
  effects/

public/assets/
  sprites/
  tiles/
  backgrounds/
  ui/

assets-manifest.json
```

Source files should remain separate from exported runtime files.

Aseprite-compatible sources are recommended because Aseprite supports CLI sprite-sheet and metadata export:

https://www.aseprite.org/docs/cli/

## Export contract

Every sprite export should be deterministic:

- stable filenames;
- stable frame tags;
- stable pivot/anchor metadata;
- no manual runtime cropping assumptions;
- metadata checked into the repository when appropriate;
- build script fails when manifest references missing frames.

Example metadata concept:

```json
{
  "id": "core:green_slime",
  "sheet": "assets/sprites/enemies/slime.png",
  "animations": {
    "idle": { "frames": [0,1,2,3], "fps": 8 },
    "jump": { "frames": [4,5,6], "fps": 10 }
  },
  "pivot": [0.5, 1.0]
}
```

## Visual direction

Do not target a pixel-perfect Terraria imitation. Define a project-specific visual identity through:

- original palette rules;
- distinct silhouettes;
- original material textures;
- consistent outline/shading policy;
- animation timing guidelines;
- biome-specific color scripts;
- readable combat silhouettes;
- clear foreground/background separation.

The game can still feel Terraria-like through density, responsiveness, layered world detail, lighting, particles and systemic interaction without duplicating its exact art.

---

# 4. Tile rendering and framing

A more polished sandbox needs tile variants and adjacency.

Target tile render schema:

```js
{
  id: 'core:stone',
  atlas: 'core:terrain',
  frameRule: 'blob47',
  randomVariants: 3,
  shapeFrames: true,
  emissive: null
}
```

Separate **simulation identity** from **visual frame**. A stone tile remains `core:stone` regardless of adjacency frame or slope sprite.

This prevents save files from depending on atlas positions.

---

# 5. Animation system

Create a generic animation controller shared by player/enemy/NPC sprites.

Inputs should be semantic state:

```text
idle
walk/run
jump/fall
swim
attack/use
hurt
cast
interact
```

The simulation should expose state; the renderer chooses animation. Avoid gameplay rules that depend on a specific sprite frame except where an explicit animation event is intended and tested.

For attacks, use simulation timings as authoritative and let animation events mirror them rather than making image-frame timing the source of combat truth.

---

# 6. Background and atmosphere pipeline

Each biome definition should be able to reference:

- sky gradient/profile;
- far/mid/near background layers;
- fog/tint;
- ambient particle set;
- ambient sound set;
- music state;
- optional weather profile;
- lighting ambient contribution.

Example:

```js
{
  id: 'core:forest',
  presentation: {
    background: 'core:forest-day',
    ambientParticles: ['core:leaf-drift'],
    music: 'core:forest-day',
    ambientSound: 'core:forest-birds'
  }
}
```

This makes biome identity systemic instead of being scattered through renderer conditionals.

---

# 7. Audio pipeline

## Current strength

WebAudio synthesis is original and lightweight.

## Target hybrid

Support both synthesized and authored original clips behind one API:

```js
Audio.play('core:item.swing.light', { position, volume, pitchJitter })
```

### Mixer buses

```text
master
music
ambient
sfx
ui
```

Expose independent settings.

### Avoid

- creating excessive new WebAudio nodes each frame;
- uncontrolled stacking of identical sounds;
- hard-coding music transitions in biome render code;
- importing Terraria music/SFX as “temporary placeholders” that later accidentally ship.

## Music state machine

Priority example:

```text
boss > invasion/event > special biome > normal biome > day/night fallback
```

Transitions should crossfade and debounce rapid biome-border changes.

---

# 8. Localization architecture

Localization should happen **before** mass content authoring.

## Why now

Today, many names and labels live directly in item/tile/enemy definitions. If hundreds more are added first, extraction becomes expensive and duplicated wording spreads across modules.

## Key convention

```text
ui.menu.new_game
ui.inventory.quick_stack
ui.crafting.search_placeholder
item.core.iron_sword.name
item.core.iron_sword.description
enemy.core.green_slime.name
npc.core.guide.name
npc.core.guide.dialogue.spawn_hint_01
status.core.poisoned.name
```

Definitions reference keys:

```js
{
  id: 'core:iron_sword',
  nameKey: 'item.core.iron_sword.name',
  descriptionKey: 'item.core.iron_sword.description'
}
```

## Catalog format

Either a small in-house JSON catalog or i18next is acceptable.

Example:

```json
{
  "ui": {
    "inventory": {
      "quick_stack": "Quick Stack"
    }
  }
}
```

i18next is a reasonable choice when pluralization, interpolation and language fallbacks become important:

https://www.i18next.com/

## Requirements

- fallback locale;
- missing-key diagnostics in development;
- interpolation/plural rules;
- no string concatenation that assumes English word order;
- UI layout tested with longer strings;
- font fallback for supported scripts;
- user-selected language persisted in settings, not world save.

## Original writing rule

Localization extraction is also an IP safety mechanism. All user-visible narrative/dialogue should be intentionally authored under project-owned keys rather than copied from Terraria reference pages.

---

# 9. Resource-pack plan

Resource packs are the safest first extensibility layer because they modify presentation without executing code.

## Manifest

```json
{
  "id": "example.pretty-pack",
  "version": "1.0.0",
  "gameVersion": ">=0.9.0 <1.0.0",
  "type": "resource-pack",
  "overrides": {
    "core:green_slime": "sprites/green-slime.png"
  }
}
```

## Capabilities

- sprites/tiles/backgrounds;
- sounds/music;
- UI theme resources;
- localization overrides where policy allows.

## Security

No JavaScript execution. Validate paths and file types. Do not allow `../` traversal or arbitrary remote fetches by default.

---

# 10. Data-pack plan

After stable content registries and schemas exist, allow declarative additions:

- items;
- recipes;
- loot tables;
- enemies using approved AI behavior IDs;
- NPC/shop definitions;
- biomes/worldgen parameters where safe;
- buffs/status definitions;
- projectile definitions using registered motion behaviors.

Manifest:

```json
{
  "id": "example.expansion",
  "type": "data-pack",
  "namespace": "example",
  "depends": ["core>=0.10.0"]
}
```

Definitions must use their own namespace:

```text
example:moon_ore
example:moon_blade
```

### Validation

Data packs must pass the same schema validation as core content. Invalid references fail with actionable diagnostics before entering a world.

### Save compatibility

A save records active pack IDs/versions or a registry fingerprint. On load with missing content:

- do not silently reinterpret IDs;
- present the missing dependencies;
- optionally load in explicit recovery mode using placeholder/unknown entries only where safe.

---

# 11. Script-mod plan — late stage only

Arbitrary mods are a security and API-stability commitment.

Do not expose raw `window`, DOM, LocalStorage or internal simulation objects as the official mod API.

Instead expose capabilities:

```text
content.registerItem
content.registerRecipe
events.on
actions.request
world.readRegion
ui.registerPanel
storage.modScoped
```

A mod should not be able to overwrite `Player.prototype.update` or replace `Save.save` through the supported interface.

## Sandboxing options

Browser sandboxing is non-trivial. Evaluate Worker-based execution, iframe isolation, a restricted interpreter, or a carefully capability-limited API depending on performance requirements. Treat this as P3 research, not an early promise.

---

# 12. Content-authoring tools

Once schemas stabilize, build lightweight tools that reduce human/agent errors:

- content validator CLI;
- registry ID browser;
- recipe dependency visualizer;
- loot-table simulator;
- sprite manifest validator;
- localization missing-key report;
- biome/worldgen preview seed runner;
- entity stat/AI debug overlay;
- asset provenance checker.

These can become more valuable than manually editing giant definition files.

---

# 13. Rollout sequence

## Phase 1

- provenance policy;
- localization key convention;
- asset manifest format;
- keep procedural visuals/audio.

## Phase 2

- original authored sprite/background/audio import support;
- deterministic asset export;
- animation definitions;
- localization catalogs.

## Phase 3

- resource-pack manifest and local loader;
- schema validation;
- content registry fingerprinting.

## Phase 4

- declarative data packs;
- pack dependency/version checks;
- missing-pack save handling.

## Phase 5

- script-mod research after simulation and APIs are stable.

---

# 14. Acceptance criteria

- No shipped production asset has unknown provenance.
- The game can run with original authored assets without changing simulation results.
- Procedural fallback/debug rendering remains available where useful.
- All user-visible content introduced after localization migration uses keys.
- Resource packs cannot execute arbitrary code.
- Data-pack IDs are namespaced and validated.
- Save files never confuse one pack's content with another because of numeric registration order.
- Mod/API work cannot regress the rule that core gameplay uses explicit commands/events/services instead of monkey patches.