# Architecture and Technical-Debt Plan

## Goal

Evolve the current browser prototype without a big-bang rewrite. Preserve working gameplay while creating explicit extension points for content, persistence, rendering, stats, commands, events and testing.

The migration should be **strangler-style**: new contracts are introduced beside legacy `window.TC` APIs, existing modules are adapted one at a time, and compatibility shims are removed only after consumers migrate.

---

## 1. Current architectural pressure points

### Shared global namespace

The project uses `window.TC` as the central namespace/service locator. This is convenient but makes dependency relationships implicit.

### Mutable shared registries

Feature modules append tile/item/recipe definitions at load time. `worldgen.js`, `fishing.js`, `magic.js`, `accessories.js`, and `wiring.js` all demonstrate variants of this pattern.

### Function wrapping / monkey-patching

The most serious debt is runtime wrapping of unrelated systems. `wiring.js` documents patches across World, Player, Items, Save and lifecycle flow. `magic.js` and `accessories.js` similarly wrap combat/player/UI behavior.

### Persistence coupling

Core persistence uses a fixed save envelope while features either patch it or remain partly outside it.

### Content identity coupling

Runtime arrays and numeric IDs are efficient, but they are unsafe as long-lived persistent identities when definitions can be appended in different places.

---

## 2. Target architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ Presentation                                                │
│ renderer • camera • HUD • menus • particles • audio        │
└───────────────────────────┬─────────────────────────────────┘
                            │ reads snapshots / sends intents
┌───────────────────────────▼─────────────────────────────────┐
│ Application                                                 │
│ GameSession • GameState • CommandBus • EventBus • Clock     │
└───────────────────────────┬─────────────────────────────────┘
                            │ deterministic rules
┌───────────────────────────▼─────────────────────────────────┐
│ Simulation Core                                             │
│ World • Entities • Physics • Combat • Items • Crafting      │
│ Biomes • Liquids • Wiring • NPCs • Progression • Fishing   │
└───────────────────────────┬─────────────────────────────────┘
                            │ stable interfaces
┌───────────────────────────▼─────────────────────────────────┐
│ Adapters                                                    │
│ browser input • local save • file export • asset loader     │
│ future network transport                                   │
└─────────────────────────────────────────────────────────────┘
```

### Dependency rule

Lower layers must not call presentation/UI directly. Simulation emits events/state; presentation observes and renders.

This single rule makes headless testing and eventual multiplayer much easier.

---

## 3. Bootstrap and module graph

### Phase A: introduce Vite without behavioral change

Use Vite primarily as:

- dev server;
- production bundler;
- ES-module entry point;
- test ecosystem foundation.

The first Vite migration should preserve the current `index.html` behavior and load legacy scripts through a deterministic bootstrap.

### Phase B: explicit feature registration

Create an application bootstrap conceptually similar to:

```js
const game = createGame({
  contentRegistry,
  systems: [
    worldSystem,
    physicsSystem,
    combatSystem,
    projectileSystem,
    fishingSystem,
    wiringSystem,
  ],
  persistenceProviders,
  renderLayers,
});
```

Legacy modules can initially be adapters around `TC.*` objects. The important change is that the order and contracts become visible in one place.

### Phase C: remove load-time side effects

A module should export definitions and installers rather than automatically mutating globals when evaluated.

Bad long-term pattern:

```js
(function () {
  TC.ITEM_DEFS.foo = ...;
  Player.prototype.update = wrap(Player.prototype.update);
})();
```

Target:

```js
export function registerFoo(context) {
  context.items.register(fooDefinition);
  context.events.on('player:update', fooUpdate);
}
```

---

## 4. Stable content registry

### Requirements

Every persistable/content-addressable definition gets a stable namespaced ID:

```text
core:dirt
core:stone
core:cactus
core:wooden_fishing_rod
core:green_slime
core:guide
```

### Registry responsibilities

- reject duplicate IDs;
- validate definition schemas;
- map string IDs to compact runtime indexes after registration;
- expose lookup by ID/index;
- track content source/pack;
- support aliases/migrations for renamed content;
- produce a deterministic registry fingerprint for saves/networking.

### Runtime optimization

Hot arrays may still use numeric indexes:

```text
persistent ID → registry index → dense runtime data
```

Do not serialize the runtime index as the authoritative identity.

### Migration strategy

The current numeric IDs need a one-time mapping table tied to the current save version. Do not infer old identities from future array order.

---

## 5. Commands and transactions

Gameplay-changing actions should become explicit commands/transactions:

```text
MineTile
PlaceTile
ShapeTile
PlaceWall
UseItem
InteractTile
OpenContainer
MoveItem
CraftRecipe
EquipItem
CastFishingLine
TalkToNpc
BuyItem
TriggerMechanism
```

### Why

A command layer gives:

- one validation path;
- deterministic tests;
- undo/debug logging where useful;
- multiplayer-ready authority boundaries;
- fewer accidental cross-module writes.

### Example mining transaction

`wiring.js` currently documents a shim that clears a mined tile because a canonical path allegedly drops the item without clearing it. The correct architectural fix is one transaction:

```text
MineTile(tx, ty, tool)
  validate reach/tool/protection
  accumulate damage
  if broken:
    calculate drops
    mutate tile once
    emit TileChanged + TileBroken + DropSpawned
```

Then wiring listens to `TileChanged`; it does not patch `World.applyMineDamage`.

---

## 6. Event bus

Use events for observation, not arbitrary state mutation.

Candidate events:

```text
WorldLoaded
WorldGenerated
TileChanged
WallChanged
LiquidChanged
EntitySpawned
EntityRemoved
EntityDamaged
EntityKilled
ProjectileSpawned
ItemPickedUp
InventoryChanged
ItemEquipped
BuffApplied
BuffExpired
CraftCompleted
BossDefeated
WorldProgressChanged
NpcMovedIn
WirePulse
DayChanged
```

### Rule

Commands change authoritative state. Events announce what happened.

Do not allow event listeners to create hidden ordering dependencies. Where ordering matters, orchestrate the systems explicitly in the simulation tick.

---

## 7. System update ordering

Declare update phases instead of relying on script/wrapper order.

Example:

```text
1 input intent collection
2 command processing
3 player movement intent
4 physics/collision
5 projectiles
6 enemies/NPC AI
7 combat/status resolution
8 liquids/wiring/environment
9 item pickups/container state
10 progression/spawns
11 event flush
12 presentation snapshot
```

The exact order can change, but it must be documented and tested.

---

## 8. Stat and modifier architecture

Accessories/buffs/magic should not each wrap combat/player functions.

### Base model

```js
ResolvedStats = resolveStats({
  base,
  equipment,
  accessories,
  prefixes,
  buffs,
  debuffs,
  worldModifiers
});
```

Candidate fields:

- maxHealth / healthRegen;
- maxMana / manaRegen;
- defense;
- moveSpeed / jump / flight modifiers;
- genericDamage;
- melee/ranged/magic/summon damage;
- crit chance;
- knockback;
- armor penetration;
- mining speed;
- fishing power/luck.

Calculate an immutable snapshot when contributors change rather than recomputing arbitrary wrappers on every use.

---

## 9. Combat architecture

### Canonical services

- `CombatResolver`
- `ProjectileSystem` — promote existing `projectiles.js`
- `StatusEffectSystem`
- `StatResolver`
- `DamageClassRegistry`

### Attack definition

```js
{
  damageClass: 'core:ranged',
  baseDamage: 12,
  knockback: 3,
  critEligible: true,
  projectile: 'core:wooden_arrow'
}
```

### Damage event

Use a structured damage result for UI, AI and tests:

```js
{
  sourceId,
  targetId,
  damageClass,
  rawDamage,
  finalDamage,
  crit,
  knockback,
  statusApplied: []
}
```

---

## 10. Persistence architecture

### Separate world and character concerns

Even if stored in one browser file initially, structure them independently.

### Save envelope

```json
{
  "formatVersion": 3,
  "gameVersion": "0.8.0",
  "registryFingerprint": "...",
  "world": {},
  "character": {},
  "metadata": {
    "createdAt": "...",
    "savedAt": "..."
  }
}
```

### Registered serializers

Each persistent system owns a stable key and schema:

```text
world.core.tiles
world.core.liquids
world.core.wiring
world.core.progression
character.core.inventory
character.core.magic
character.core.buffs
```

The save service calls providers. Providers do **not** wrap `Save.save`.

### Migrations

A migration is an explicit function from version N to N+1 with fixtures.

Never silently reset unknown system data unless the user chooses recovery mode.

### Reliability

- write new save to a temporary record;
- validate/parse it;
- retain previous backup;
- then replace current pointer;
- allow export/download and import/upload;
- include human-readable error path on corruption.

---

## 11. World data architecture

### Chunks

The current world can remain contiguous arrays initially, but introduce chunk concepts for dirty tracking and future scale:

```text
Chunk 32x32 or 64x64
  foreground tile index
  wall index
  shape/frame metadata
  liquid type/amount
  wire bitfields
  lighting cache
  dirty flags
```

Chunking benefits:

- localized rendering;
- localized lighting recalculation;
- localized liquid queues;
- future network interest management;
- save compression/streaming options.

Do not prematurely convert every array to objects; keep typed/dense arrays for hot data.

---

## 12. World-generation architecture

Create an ordered pass API:

```js
runPass('terrain', terrainPass)
runPass('surface-biomes', biomePass)
runPass('caves', cavePass)
runPass('ores', orePass)
runPass('structures', structurePass)
runPass('decor', decorPass)
runPass('validation', validationPass)
```

Each pass receives:

- world buffer;
- deterministic RNG stream;
- config/world size;
- shared generation metadata;
- cancellation/progress callbacks;
- profiler.

Each pass should define invariants and deterministic tests.

---

## 13. Rendering architecture

### Keep Canvas 2D first

Do not couple simulation cleanup to a renderer rewrite.

Introduce render layers:

```text
background
walls
liquids-behind
foreground tiles
entities
projectiles
particles
lighting/composite
world overlays/wires
HUD
menus/tooltips
```

Modules register draw data/layers rather than wrap `World.draw` or `UI.draw`.

### When to consider PixiJS

Only after measurements show Canvas submission/fill-rate is the limiting factor and the simulation/lighting workload is already controlled.

---

## 14. Type-safety migration

Avoid a full TypeScript rewrite.

Sequence:

1. add `// @ts-check` or project `checkJs` to selected stable modules;
2. write JSDoc typedefs for content definitions, save schemas and public system APIs;
3. enable checking gradually by directory/module;
4. convert files to `.ts` only when actively refactoring them and the benefit is clear.

This gives earlier contract errors without freezing feature development for months.

---

## 15. Technical-debt register

| Debt | Severity | Fix | Gate |
|---|---:|---|---|
| Runtime monkey patches across core systems | Critical | commands/events/providers/render layers | M2 |
| Numeric/load-order content identity | Critical | namespaced registry + migration map | M2 |
| Save v1 with fragmented feature state | Critical | schema/migrations/providers/backups | M2 |
| Feature definitions appended at module load | High | explicit data registration | M2 |
| Script-order coupling | High | bootstrap/module graph | M1/M2 |
| Worldgen accumulating special cases | High | named passes | M3 |
| Liquid-as-tile representation | High | separate liquid layer | M3 |
| Combat wrappers and overlapping projectile logic | High | unified resolver + canonical projectiles | M4 |
| NPC model not generalized | Medium/High | NPC registry + housing/town services | M5 |
| Fragmented smoke tests | High | Vitest/Playwright/CI | M1 |
| Embedded user-facing strings | Medium | localization keys/catalog | M2/M5 |
| Renderer rewrite temptation | Medium | profile first, budgets | continuous |

---

## 16. Migration rules for agents

1. Never remove working behavior before a compatibility test exists.
2. No new global monkey patch unless it is a temporary, documented migration shim with a deletion task.
3. Any new persistent field requires a schema/version decision and test.
4. Any new content ID must be stable and registry-validated.
5. Worldgen randomness must be deterministic and scoped.
6. Simulation logic must not require Canvas/DOM to execute.
7. Performance work must include measurements.
8. Refactors should be vertical and incremental: migrate one real feature through the new contract before generalizing further.

## 17. Recommended first vertical migration

Use **fishing persistence** as the first proof:

1. introduce serializer-provider registration;
2. adapt core save service to call providers;
3. register fishing state;
4. remove/reject any fishing-specific save wrapping;
5. add save → reload → state-preserved Playwright/Vitest fixture;
6. document provider contract;
7. migrate wiring, magic and accessories using the same mechanism.

This demonstrates that the architecture solves an existing user-visible defect rather than becoming abstract infrastructure with no payoff.