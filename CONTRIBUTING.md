# Contributing

This document defines the engineering rules for future implementation work in `clone-terraria-`. The current `docs/terraria-parity-master-plan` branch is documentation-only; gameplay and engine changes should be made in later implementation branches.

## 1. Development principle

Preserve a playable game while migrating the prototype toward explicit, testable architecture. Prefer small vertical migrations that prove one real feature end-to-end over large rewrites that leave the game unusable for long periods.

The long-term target is documented in:

- `docs/ARCHITECTURE.md`
- `docs/terraria-parity/architecture-and-technical-debt.md`
- `docs/terraria-parity/roadmap.md`
- `docs/TASK_BOARD.md`

## 2. Branching and scope

- Do not make unrelated changes in the same branch.
- Do not merge directly into `main` without repository-owner approval.
- Keep architecture migrations, gameplay additions, presentation work, and large content waves reviewable as bounded changes.
- A documentation-only branch must not contain runtime/gameplay changes.
- Temporary compatibility work must have an explicit removal task if it creates new technical debt.

For multi-agent development, assign disjoint write ownership wherever possible. Shared contracts such as save schemas, content registries, command/event payloads, world-cell layout, and combat-stat schemas should have one designated integration owner.

## 3. Current run behavior

At the time this plan was written, the repository can be run without a build step by opening `index.html` or serving the repository with a simple HTTP server, for example:

```bash
python -m http.server 8377
```

Do not document future `npm`/Vite commands as required until the corresponding tooling is actually implemented on the branch being changed.

## 4. Architecture rules

### 4.1 Avoid new monkey patches

Do not introduce new production behavior by replacing or wrapping unrelated core functions such as:

```text
Player.prototype.update
World.prototype.draw
UI.draw
Save.save
Combat.update
```

unless the change is a short-lived, documented migration shim with:

1. a reason the supported extension point cannot yet be used;
2. tests proving behavior;
3. an explicit follow-up task for removal.

New/refactored functionality should use supported contracts such as commands, events, stat providers, persistence providers, content registries, render layers, and explicit system update phases.

### 4.2 Stable content identity

Persistable content must use stable namespaced IDs once the registry migration is available:

```text
core:dirt
core:iron_bar
core:green_slime
core:guide
```

Runtime integer indexes are allowed for performance, but they must not become the authoritative persistent identity.

New content definitions must:

- have unique IDs;
- pass schema validation;
- reference valid items/projectiles/statuses/etc.;
- avoid depending on module registration order;
- declare migration/alias behavior when an existing persistent ID is renamed.

### 4.3 Commands own authoritative mutations

Actions such as mining, placing, crafting, item movement, equipping, interaction, and buying should use one canonical transaction path.

A successful transaction must not partially mutate state. For example, one successful tile break should produce exactly one authoritative tile change and the intended drops/events exactly once.

### 4.4 Events announce completed changes

Use events to notify other systems that something happened. Do not rely on arbitrary listener ordering for core game correctness.

Where execution order matters every tick, encode it in the simulation/system scheduler.

### 4.5 Simulation must remain testable without rendering

New game rules should not require Canvas, DOM layout, or a browser UI to execute. Rendering consumes simulation state; simulation must not depend on drawing functions for correctness.

This is required for reliable tests and eventual authoritative multiplayer.

## 5. Determinism rules

Persistent world generation must remain deterministic for a fixed:

```text
seed + generationVersion + configuration
```

World-generation code must use an injected deterministic RNG/context. Do not use:

- `Math.random()` for persistent generation decisions;
- wall-clock time;
- viewport/browser dimensions;
- frame timing;
- gameplay/combat RNG state.

Any intentional world-generation change should update the appropriate fixtures and generation-version policy rather than silently changing old-world assumptions.

Runtime combat or cosmetic randomness may remain non-deterministic where the design permits it, but tests should inject predictable randomness when verifying rules.

## 6. Persistence and save compatibility

Any change that adds or alters persistent state must answer all of the following before merge:

1. Where does this state belong: world, character, settings, or subsystem data?
2. Does the save schema/version need to change?
3. How do supported older saves migrate?
4. What happens when content referenced by the save is missing?
5. Is the state covered by round-trip and migration tests?
6. Could a failed migration/write destroy the previous valid save?

Feature modules should register serializers with the save system rather than wrapping `Save.save`.

Do not intentionally reset unknown or incompatible persistent data without an explicit recovery decision visible to the user/developer.

## 7. Testing requirements

Choose the cheapest proof that can reliably detect regression.

### Data/unit tests

Use for:

- schema validation;
- item-stack rules;
- recipe queries;
- combat/stat math;
- wire graph logic;
- liquid-cell rules;
- save encoding/migrations;
- AI state transitions where possible.

### Deterministic simulation tests

Use fixed input traces/seeds for:

- world generation;
- movement/collision;
- mining/building transactions;
- projectiles;
- progression flags;
- boss/event state where practical.

### Browser integration tests

Use Playwright or the canonical browser harness for changes involving:

- startup/lifecycle;
- Canvas/input integration;
- menus/HUD/inventory;
- browser storage;
- save → reload → continue;
- cross-system user journeys.

Prefer semantic test hooks over long chains of fragile pixel-coordinate clicks for state setup.

### Persistent changes

Must include save round-trip coverage and, when schema changes, at least one historical migration fixture.

### Performance-sensitive changes

Must include before/after measurements on a stable benchmark scene. Do not claim an optimization from subjective feel alone.

## 8. Performance rules

Profile before changing technology.

Measure at least the relevant subset of:

```text
update time
render time
lighting time
liquid time
AI time
projectile time
visible tile count
entity/enemy/projectile count
active liquid cells
dirty chunks/regions
allocations/GC behavior
world-generation pass time
save size/time
```

Prefer fixing measured hot paths—offscreen work, unnecessary scans, repeated allocations, broad collision checks, lighting invalidation, active-liquid management—before proposing a renderer rewrite.

Canvas 2D remains acceptable until profiling and a representative prototype show that another renderer provides meaningful value.

## 9. World and content-system rules

### World generation

New world-generation work should be implemented as named deterministic passes once the pass framework exists. Each substantial pass should define invariants and regression coverage.

### Liquids

Do not expand the legacy liquid-as-foreground-tile model indefinitely. New liquid mechanics should follow the independent type/amount layer defined by the architecture roadmap once that migration begins.

### Projectiles

Treat the existing unified pooled projectile work as the canonical direction. Do not introduce a separate projectile engine for each weapon class.

### Combat

Melee, ranged, magic, and future classes should converge on shared damage/stat/status/hit-resolution contracts rather than independent class-specific combat engines.

### NPCs and towns

New town NPCs should use the generic NPC/housing/shop/service model once available rather than hard-coding another one-off lifecycle.

## 10. Localization

The localization system landed in W20. New user-visible text MUST use localization keys rather than embedding English strings directly in gameplay definitions.

Examples:

```text
item.core.iron_sword.name
ui.inventory.quick_stack
npc.core.guide.dialogue.spawn_hint_01
```

Rules (enforced by `npm run check:i18n`, which runs inside `npm run validate`):

- every user-facing string ships in `js/locales/en.js` under a stable dotted key;
- parameterized messages use named `{vars}` templates — never string
  concatenation that assumes English grammar or word order; plurals use plural
  entries, never `+'s'` logic;
- presentation resolves content names via `TC.Localization.contentName(kind, ref)`
  — never by reading legacy `def.name` fields or Title-Casing ids;
- machine identity (registry ids, save keys, flags, event/command names,
  enemy/item type ids) is never localized and never derived from translations;
  the registry fingerprint baseline is regression-guarded;
- NPC dialog pools hold catalog keys and dialogs carry the stable npc type —
  display names never decide shop/dialog identity;
- locale preference persists only via `TC.Settings`, never in world saves.

## 11. Assets, audio, and IP policy

All shipped code and assets must be original to the project or used under a compatible license with required attribution/provenance.

Do not commit or redistribute:

- extracted Terraria sprite sheets, tiles, backgrounds, music, or sound effects;
- decompiled or copied Terraria source code;
- copied Terraria NPC dialogue, item descriptions, lore, or substantial game text;
- proprietary assets obtained from another game simply as placeholders;
- third-party fan assets without permission/license compatibility.

Public references may be used to understand mechanics and high-level behavior, but implementations and creative expression must be independently produced.

For any externally sourced permissible asset, record:

- source URL;
- creator;
- license;
- attribution requirements;
- modifications;
- runtime/exported asset path.

Update `THIRD_PARTY_NOTICES.md` when required.

## 12. Documentation requirements

Update documentation in the same change when altering:

- public system contracts;
- save schema or migration behavior;
- stable content-ID semantics;
- simulation update order;
- world storage layout;
- liquid representation;
- renderer strategy;
- networking authority;
- resource/data/mod API behavior.

For expensive-to-reverse choices, add an Architecture Decision Record under `docs/adr/` once that directory is established.

## 13. Pull-request / implementation checklist

Before requesting merge, verify:

- [ ] Scope is bounded and unrelated changes are excluded.
- [ ] Game/build starts from a clean checkout using documented commands.
- [ ] New/changed content IDs are stable and validated.
- [ ] Persistent changes include schema/migration handling.
- [ ] Supported older save fixtures still load or have an explicit compatibility decision.
- [ ] Deterministic worldgen invariants still pass when relevant.
- [ ] Unit/simulation tests cover the changed rules.
- [ ] Browser flow is tested when integration/UI/storage changed.
- [ ] No undocumented production monkey patch was introduced.
- [ ] Performance was measured when a hot path changed.
- [ ] New external assets have provenance/license information.
- [ ] User-visible text follows localization policy when the localization system exists.
- [ ] Architecture/system docs were updated when contracts changed.
- [ ] Known Critical/High regressions are resolved before milestone completion.

## 14. Agent handoff format

Autonomous or parallel agents should leave a durable handoff containing:

```text
Task ID:
Branch / commit:
Files changed:
Behavior added or changed:
Contracts changed:
Save/migration impact:
Tests added:
Tests run and results:
Performance measurements:
Known limitations:
Follow-up task IDs:
```

This prevents future sessions from having to reverse-engineer what a previous worker intended.

## 15. Definition of done

A feature is not done merely because it appears on screen.

It is done when the behavior is integrated through supported contracts, persistent state is trustworthy, required tests pass, performance impact is understood, documentation is current, and no Critical/High known regression remains in the touched path.