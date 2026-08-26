# W25 Campaign Plan — Safe Extensibility Foundation

Status: ACTIVE. Branch: `main` only (repository policy).

- Planned-From: `93fc990` (expected W24 checkpoint)
- Actual-Start: `eda8fdf` — reconciliation found origin/main exactly at the
  expected checkpoint, plus an uncommitted but complete perf/determinism work
  package from an interrupted session in the working tree. That package was
  validated (573 headless tests + 29 browser journeys + build/verify green)
  and landed as its own commit before any W25 edit.
- Reconciliation result: no post-plan implementation existed; no W25
  requirement pre-satisfied. MOD-001..004 all TODO on the task board.

## WS0 audit conclusions (whole content lifecycle)

Places that assume "all content is compiled into built-in JS tables" and the
decision for each:

| Surface | Today | Decision |
|---|---|---|
| TILE_DEFS / WALL_DEFS arrays | numeric world encoding, pattern-driven painters | tiles SUPPORTED via append-only pack families; walls excluded in W25 (documented) |
| ITEM_DEFS object | string keys everywhere (inventory/chests/costs/drops) | SUPPORTED |
| RECIPES array | live-scanned by crafting with length-keyed index cache | SUPPORTED |
| ENEMY_DEFS object | `ai`/`look` are names resolved against built-ins | SUPPORTED (built-in refs only) |
| Registry mirror | walks tables at boot/sync | pack commit defines explicitly + aliases; sync stays idempotent |
| SaveCore envelope | registryFingerprint only | gains top-level `packs` metadata + classification |
| main.js boot/continue | unconditional load | activation before registry sync; continue gated by classifySave |
| NetProto v3 handshake | no content identity on the wire | v4: bounded `packs` meta in hello/welcome; mismatch rejects pre-admit |
| Localization | fixed en catalog | additive `extend()` API for pack fragments (presentation-only overrides recorded) |
| Rendering/icons/audio | def.pattern / kind-driven procedural painters | unchanged; packs declare supported pattern/kind vocabularies |
| Worldgen | writes built-in ids only; SOLID LUT sized from TILE_DEFS.length | unaffected |
| Release build / test loader | both derive script lists from index.html | new scripts auto-included |

## Data-pack scope (MOD-002)

Supported families in W25: **tiles, items, enemies, recipes**.
Explicitly excluded: walls, NPCs/shops, standalone loot tables, projectiles,
buffs, biomes (documented rationale in ARCHITECTURE §29). Enemy drops already
give declarative loot; recipes may use the existing Progression condition
grammar; enemy AI/look and tile patterns must reference built-in vocabulary —
no pack-supplied functions anywhere.

## Security boundary

Every manifest is untrusted: parse → structural validation → semantic/
reference validation → dependency/version resolution → deterministic identity →
staged registration → atomic commit. Prototype-pollution keys, non-finite
numbers, functions/symbols, oversized values/arrays/depths, unknown fields,
forbidden namespaces (`core`), traversal-shaped resource paths, and duplicate
ids are rejected before any mutation. No eval/new Function/script injection
anywhere in the pipeline.

## Identity model

A. built-in stable identity: untouched (base fingerprint stays `1b1d7c15`).
B. active pack-set identity: `TC.Packs.digest()` (gameplay packs only) +
   `TC.Packs.contentDigest()` (all packs), FNV-1a over canonicalized data.
C. pack-owned stable ids: `<packid>:<key>` where namespace == pack id.
D. dense runtime indices: appended after built-ins in topological order,
   ties broken by ascending pack id — subset-stable across sessions.

## Activation surface (production)

`TC.Packs.provide(id, manifest)` registers availability (fixture ships as a
declarative script); activation is Settings-backed (`activePacks`) and runs in
main boot before registry sync. Title screen gains a Packs panel (toggle +
Apply) so the browser path is real user UI, exercised by Journey P.
