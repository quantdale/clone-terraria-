# Testing, CI, Performance, and Release Strategy

## Principle

A Terraria-like sandbox has too many interacting systems to validate primarily by manual play. The test strategy must make deterministic simulation, persistence, world generation, browser integration and performance regressions observable before content volume grows.

The repository already contains bespoke smoke/reproduction scripts for world generation, magic and accessories. Preserve their useful assertions, but move them into a single standard test system.

---

# 1. Test pyramid

```text
                 ┌─────────────────────┐
                 │ Browser E2E / visual │  small, high-value flows
                 └──────────┬──────────┘
                    Integration tests     cross-system contracts
                 ┌──────────▼──────────┐
                 │ Simulation / rules   │  deterministic, broad coverage
                 └──────────┬──────────┘
                 │ Unit/data validation │  many, fast
                 └─────────────────────┘
```

The largest suite should be fast simulation/data tests. Browser tests prove wiring and user-visible flows; they should not be the only place game rules are verified.

---

# 2. Tooling recommendation

## Vitest

Use Vitest for:

- pure functions;
- deterministic simulation slices;
- schema/content validation;
- worldgen fixtures;
- save migrations;
- recipe queries;
- combat math;
- wiring graph behavior;
- liquid-cell rules;
- AI state transitions where decoupled from rendering.

Reference: https://vitest.dev/

## Playwright

Use Playwright for real browser behavior:

- startup/new game;
- input and canvas lifecycle;
- menus/HUD/inventory overlays;
- save → reload → continue;
- browser storage adapters;
- resize/focus behavior;
- integration of rendering and simulation;
- targeted screenshots/traces.

Reference: https://playwright.dev/

Playwright's trace tooling is particularly useful when a game flow intermittently fails because it can preserve steps, console output and browser state.

---

# 3. Determinism contract

## World generation

World generation must never consume uncontrolled gameplay/UI randomness.

For every generation pass:

- deterministic RNG supplied through context;
- stable generation version;
- no `Date.now()`, browser dimensions or frame timing in generation;
- pass order explicit;
- deterministic sub-seeds when parallelization is introduced.

### Regression seed corpus

Keep at least:

```text
seed-small-basic
seed-ocean-edge
seed-desert-structure
seed-evil-left
seed-evil-right
seed-dungeon-layout
seed-hell-structure
seed-stress-caves
seed-special-regression-N
```

The actual seeds should be fixed integers/strings recorded in fixtures.

### What to assert

Avoid full byte-for-byte snapshots for every test; they can make legitimate changes painful. Combine:

- selected full checksums for “frozen baseline” seeds;
- structural invariants;
- statistical ranges;
- landmark positions;
- reachability/safety rules.

Examples:

```text
spawn has safe standing area
both world edges contain ocean region
required biome count/range is satisfied
dungeon/major structure does not overlap spawn exclusion zone
ore distribution stays within expected bounds
no generated solid tile ID is invalid
all placed walls/items resolve in registry
```

When generation intentionally changes, update generation version and fixtures deliberately.

---

# 4. Content validation tests

Run on every PR.

Validate:

- unique namespaced IDs;
- all item drop references exist;
- all recipe outputs/ingredients/stations exist;
- all projectile references exist;
- enemy loot references exist;
- NPC shop entries exist;
- localization keys exist for required user-facing fields;
- no duplicate registration;
- no cyclic aliases;
- pack namespace rules;
- persistent content has migration-safe IDs.

Treat invalid content data like a compile error.

---

# 5. Save and migration testing

Persistence is P0 because sandbox players invest time into worlds.

## Fixture library

Check in minimal fixtures for each historical format:

```text
tests/fixtures/saves/v1/basic.json
tests/fixtures/saves/v1/chests.json
tests/fixtures/saves/v1/advanced-features.json
tests/fixtures/saves/v2/...
```

If current LocalStorage encoding is not directly JSON-exportable, provide a test adapter that loads the same logical payload.

## Required tests

### Round trip

```text
state → serialize → parse → deserialize → equivalent state
```

### Migration

```text
v1 fixture → migrate → v2 → validate → load
```

### Unknown content

A save referencing an unavailable namespaced ID must produce a controlled diagnostic/recovery path, not reinterpret it as another numeric item.

### Corruption

Test:

- truncated payload;
- invalid JSON;
- wrong schema type;
- impossible item count;
- invalid tile diff index;
- missing optional feature section;
- duplicate/old fields.

### Atomic save strategy

Test backup semantics by simulating a write/validation failure before replacement.

---

# 6. Core simulation test suites

## Player physics

For each movement/collision feature:

- flat-ground walking;
- wall collision;
- ceiling collision;
- jump and landing;
- fall damage threshold;
- platform landing/drop-through;
- slopes and half-blocks;
- water immersion/breath;
- knockback;
- grapple attach/detach when implemented.

Prefer fixed-step simulation with explicit input traces.

## Mining/building

- reach validation;
- tool requirement/power;
- break accumulation;
- exactly one drop transaction;
- tile actually clears;
- support-dependent furniture breaks consistently;
- place consumes item exactly once;
- world-change events fire exactly once;
- wiring/lighting/minimap dirty notifications receive the mutation.

This suite should permanently prevent the kind of mining-path workaround documented in `wiring.js`.

## Inventory

- stack merge/split;
- max stack;
- pickup overflow;
- quick transfer;
- favorites/locked behavior;
- equip/unequip;
- item-instance prefix metadata;
- container transaction rollback on invalid operation.

## Crafting

- ingredient matching;
- station tags;
- environment conditions;
- exact consumption;
- output overflow;
- search/index correctness;
- recipe unlocks/progression gates.

## Combat

Use deterministic injected RNG for rule tests even if runtime combat intentionally uses randomness.

Test:

- defense;
- crit;
- variance boundaries;
- class/global modifiers;
- knockback;
- immunity frames;
- buffs/debuffs;
- projectile pierce/bounce/homing;
- explosion radius;
- enemy death → loot/progression events.

## Fishing

- cast validity;
- bait consumption policy;
- liquid/biome/depth context;
- bite timing under injected RNG;
- catch table selection;
- quest state;
- save/reload persistence.

## Wiring

- path connectivity;
- cycles terminate;
- one receiver triggers once per pulse;
- timers persist/reset correctly;
- actuator collision state;
- overlapping wire channels when introduced;
- mechanism → liquid pump integration later.

## Liquids

- conservation rules within chosen simulation tolerance;
- downward flow;
- lateral equalization;
- different liquid speeds;
- partial amounts;
- interactions between types;
- inactive-cell queues settle;
- save/reload round trip.

---

# 7. Browser E2E journeys

Keep the mandatory suite small enough to run routinely.

## E2E-01: Boot/new world

1. open title screen;
2. start deterministic test world;
3. wait for generation;
4. verify player spawned;
5. verify no console exceptions.

## E2E-02: Sandbox loop

1. move;
2. select tool;
3. mine known tile;
4. collect drop;
5. place block;
6. open inventory;
7. craft one item.

## E2E-03: Container

1. open chest;
2. move stack player → chest;
3. close/reopen;
4. verify state.

## E2E-04: Save/load

1. mutate known world tile;
2. change player inventory/stats;
3. save/quit;
4. continue;
5. verify mutation and player state.

## E2E-05: Combat

1. spawn deterministic test enemy using test hook;
2. attack;
3. verify damage/death/drop;
4. verify no duplicate loot.

## E2E-06: Advanced system

Cycle the selected integration showcase: fishing initially, then wiring/magic/accessories once canonical.

---

# 8. Test hooks

Browser game automation should not depend on fragile mouse positions for every state setup.

In development/test builds expose a **restricted** test API such as:

```js
window.__TEST__ = {
  newWorld(seed),
  teleportPlayer(x, y),
  giveItem(id, count),
  spawnEnemy(id, x, y),
  getStateSnapshot(),
  saveNow(),
  loadFixture(name)
}
```

Never ship dangerous cheat/debug hooks in production unless behind an intentional debug feature.

The test API should call real game services rather than directly mutating random internal fields whenever possible.

---

# 9. Visual regression

Use screenshots selectively.

Good candidates:

- title/menu layout;
- inventory/crafting panels;
- one fixed world viewport under fixed time/lighting;
- slope/platform framing fixture;
- biome background fixture;
- lighting benchmark scene;
- boss HUD layout.

Bad candidates:

- scenes with uncontrolled random particles;
- full procedural worlds after every generation change;
- animations captured at non-deterministic frames.

Before screenshot capture:

- fixed viewport;
- fixed device pixel ratio where supported;
- fixed seed;
- fixed simulation tick/time;
- disable random visual jitter or inject deterministic visual RNG.

---

# 10. Performance testing

## Instrumentation

Expose rolling timings:

```text
update.ms
render.ms
lighting.ms
liquid.ms
ai.ms
projectiles.ms
particles.ms
save.ms
worldgen.pass.<name>.ms
```

Counts:

```text
visibleTiles
entities
enemies
projectiles
particles
dynamicLights
activeLiquidCells
dirtyChunks
collisionChecks
```

## Benchmark scenes

### PERF-01 Normal exploration

Typical forest/cave movement with ordinary enemy/particle load.

### PERF-02 Dense combat

Large enemy count + projectile saturation up to/around the current pool cap.

### PERF-03 Lighting stress

Many static and dynamic colored lights.

### PERF-04 Liquid stress

Large active flow area.

### PERF-05 Construction stress

Dense furniture/walls/wiring/containers.

### PERF-06 Worldgen

Small/medium/large configurations, per-pass timing.

## Initial budget philosophy

Do not invent hardware-independent absolute claims before collecting baselines. Establish a reference machine/browser profile and track regressions.

Useful CI gates can initially be percentage-based:

- no >15% median regression in a stable benchmark without explicit approval;
- no unbounded allocation/entity growth;
- no benchmark exceeding a defined hard safety ceiling.

Later add frame targets appropriate to supported devices.

---

# 11. Profiling-driven optimization order

Prefer these before renderer replacement:

1. remove accidental per-frame allocations;
2. cull offscreen tiles/entities/particles;
3. spatial partition enemy/entity collision queries;
4. dirty-region lighting updates;
5. active-cell liquid queues;
6. cache recipe/search indexes;
7. avoid repeated biome/world scans;
8. chunk dirty flags for render/minimap/save;
9. typed/dense data in hot loops;
10. only then test renderer batching/WebGL alternatives.

A PixiJS migration should be justified by profiling and a prototype benchmark, not by assumption.

---

# 12. CI workflow design

## Pull request / push

```text
checkout
install pinned Node dependencies
validate content schemas
JS type check
Vitest
production build
Playwright Chromium smoke
artifact/upload test reports on failure
```

## Nightly

```text
large worldgen corpus
full Playwright browser matrix
performance benchmarks
save fixture migration matrix
optional screenshot regression
```

## Release candidate

```text
all normal/nightly gates
manual exploratory checklist
new-world and migrated-save soak
asset provenance validation
license/notice validation
production build hash
release notes
```

Use GitHub Actions while the application remains repository-hosted/browser-first.

---

# 13. Release channels

Recommended progression:

```text
dev/local
↓
preview branch build
↓
alpha
↓
beta / release candidate
↓
stable
```

Do not call a version stable while save migrations, critical world corruption or major input failures remain unresolved.

## Semantic-ish version policy

Before 1.0, a pragmatic scheme is enough:

- patch: fixes/content adjustments with compatible saves;
- minor: system additions/migrations;
- major/1.0+: public compatibility promises.

Always record save format version separately from game version.

---

# 14. Release checklist

- [ ] Production build succeeds from clean checkout.
- [ ] Content registry validates.
- [ ] Unit/simulation suite passes.
- [ ] Browser smoke suite passes.
- [ ] Worldgen regression corpus passes or expected changes are documented.
- [ ] Old supported save fixtures migrate.
- [ ] Save backup/recovery path tested.
- [ ] No Critical/High crash/data-loss issue remains.
- [ ] Performance benchmark has no unexplained regression.
- [ ] New assets have provenance/license entries.
- [ ] User-visible strings have localization keys.
- [ ] Changelog/release notes list save-impacting changes.
- [ ] Build artifact is reproducible enough to identify exact source commit.

---

# 15. Debugging/observability tools worth building

A sandbox engine benefits enormously from developer overlays:

- FPS/update/render timing graph;
- current biome/depth/time;
- player collision box and tile-shape contacts;
- entity IDs/AI states;
- projectile pool occupancy;
- active liquid cells;
- light dirty regions;
- chunk boundaries;
- wire channels/pulses;
- worldgen pass preview/timing;
- stat contributor breakdown;
- current progression flags;
- save/schema/registry fingerprints.

These are not player features first; they reduce future agent debugging time and make performance work objective.

---

# 16. Quality gate hierarchy

**Critical:** crash, save corruption/data loss, deterministic worldgen break, unrecoverable boot failure. Must block merge/release.

**High:** core progression blocked, mining/building broken, inventory duplication/loss, major combat exploit, persistent-system reload failure. Block milestone completion.

**Medium:** localized gameplay inconsistency, UI usability defect, noticeable performance regression with workaround. Usually fix within milestone or explicitly defer.

**Low:** polish, rare visual artifact, tuning discrepancy without structural effect. Backlog allowed.

The implementation process should make Critical/High defects expensive to ignore and cheap to diagnose.