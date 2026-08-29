# Clone Terraria Improvement Documentation Bundle

> Documentation-only planning package. No runtime/gameplay code is changed by this branch.

## Purpose

This branch captures the implementation plan for evolving `quantdale/clone-terraria-` from its current capable vanilla-JavaScript prototype into a substantially deeper, more coherent 2D sandbox game that reproduces the *systemic feel* of Terraria without copying Re-Logic source code, copyrighted art/audio, proprietary text, branding, or other protected assets.

The research target used for comparison is the current stable Terraria desktop behavior available during the audit on 2026-08-21. Re-Logic's July 30, 2026 State of the Game still described 1.4.5.7 as in development, while the official Terraria wiki identified 1.4.5.6 as the current desktop version. The roadmap therefore treats 1.4.5.6 as the stable behavioral reference rather than chasing unreleased behavior.

## Read this first

The project is already much more than a minimal clone. The repository contains deterministic procedural world generation, mining/building, persistence, combat, enemies and bosses, crafting, UI, lighting, minimap, audio/music, plus substantial feature modules for generalized projectiles, magic, fishing, accessories/buffs, and wiring.

The biggest risk is now **integration debt**, not lack of raw features. Several feature modules dynamically append shared definitions or wrap/patch functions at runtime. `fishing.js` explicitly notes incomplete save integration; `magic.js` wraps combat/player/UI behavior; `accessories.js` wraps player/combat/UI behavior; `wiring.js` patches multiple world/player/save/lifecycle functions and even documents a workaround for a mining-path defect. This style made parallel prototyping fast, but it will become brittle as content expands.

The highest-leverage strategy is therefore:

1. stabilize architecture, identities, persistence, and testing;
2. integrate the advanced modules through explicit contracts;
3. deepen traversal, liquids, world generation, combat, crafting, NPC/town, and progression systems;
4. improve lighting, art, audio, UI/UX, and performance;
5. only then pursue multiplayer and modding at scale.

## Documentation tree

```text
DOCUMENTATION-BUNDLE.md
CONTRIBUTING.md

docs/
  ARCHITECTURE.md
  TASK_BOARD.md

  terraria-parity/
    README.md
    repository-audit.md
    feature-gap-analysis.md
    architecture-and-technical-debt.md
    roadmap.md
    assets-localization-modding.md
    testing-ci-release.md
    risk-and-documentation-plan.md
    README-update-proposal.md
```

## Recommended reading order

1. `docs/terraria-parity/README.md` — executive plan and design principles.
2. `docs/terraria-parity/repository-audit.md` — what exists now and where the pressure points are.
3. `docs/terraria-parity/feature-gap-analysis.md` — current vs target system-by-system comparison.
4. `docs/terraria-parity/architecture-and-technical-debt.md` — structural work required before mass content expansion.
5. `docs/terraria-parity/roadmap.md` — ordered milestones, dependencies, gates, and implementation sequence.
6. `docs/TASK_BOARD.md` — practical backlog that can be converted into issues/agent work packets.
7. Supporting plans for assets, testing, release, localization, modding, risks, and documentation.

## Non-goals of this branch

- No JavaScript, HTML, CSS, save-format, asset, or gameplay implementation changes.
- No replacement of existing root `README.md`; a proposal is supplied separately.
- No attempt to copy Terraria source code or redistribute Terraria assets.
- No promise of one-to-one content parity by item count.
- No renderer rewrite merely for novelty.
- No premature multiplayer architecture before deterministic simulation and persistence boundaries are stable.

## Definition of success

The roadmap is successful when an implementation agent can take a milestone, identify the affected repository modules, understand prerequisites and invariants, execute the work in bounded increments, and prove completion through defined tests and acceptance criteria rather than subjective visual comparison alone.

The target experience is a world that feels increasingly Terraria-like because its systems interact coherently: terrain and biome context drive exploration; movement and tile geometry feel expressive; items and crafting support progression; combat classes share consistent rules; NPCs, housing, events and bosses transform the world; lighting/audio/UI communicate state; saves remain trustworthy; and future content can be added without monkey-patching the entire runtime.

## Research/reference sources

Primary/reference material used by the roadmap includes:

- Official Terraria Wiki: https://terraria.wiki.gg/
- Terraria world generation: https://terraria.wiki.gg/wiki/World_generation
- Terraria liquids: https://terraria.wiki.gg/wiki/Liquids
- Terraria blocks/slopes: https://terraria.wiki.gg/wiki/Blocks
- Terraria wiring: https://terraria.wiki.gg/wiki/Wire
- Terraria crafting stations: https://terraria.wiki.gg/wiki/Crafting_station
- Terraria Community Forums / Re-Logic State of the Game: https://forums.terraria.org/
- Vite: https://vite.dev/
- TypeScript JS checking: https://www.typescriptlang.org/tsconfig/allowJs.html and https://www.typescriptlang.org/tsconfig/checkJs.html
- Vitest: https://vitest.dev/
- Playwright: https://playwright.dev/
- PixiJS: https://pixijs.com/
- Colyseus: https://colyseus.io/
- i18next: https://www.i18next.com/
- Aseprite CLI: https://www.aseprite.org/docs/cli/

## Branch policy

This package belongs on a non-default documentation branch until reviewed. Implementation work should be split into later feature branches or milestone branches. The documentation branch itself should remain documentation-only so its intent stays auditable.