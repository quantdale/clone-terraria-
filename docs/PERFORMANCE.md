# Performance Notes

Non-obvious performance-sensitive invariants and their rationale. Read before
touching the modules below — several optimizations look like removable
overhead but encode correctness or determinism contracts.

## Chunk renderer (`js/world.js`, consumer `'renderer'`)

- **Chunk canvases are a bounded cache (CAP 160 / FLOOR 120).** Each canvas is
  `CHUNK*TS` square (~1 MB raster). Before bounding, long sessions retained
  every revealed chunk (~500 MB ceiling on the standard world). Eviction drops
  farthest-from-camera chunks that are not on screen.
- **Eviction must NOT re-mark WorldRegions.** The region authority is shared;
  a global re-mark forces the minimap and lighting consumers to redo
  still-valid work (this was tried and broke "no perpetual repainting"
  guarantees). Instead, `draw()` rebuilds any *visible* chunk whose canvas is
  missing — synchronously, on the spot. Do not "optimize" this into a
  proactive background rebuild queue: merging missing chunks into the update()
  candidate list creates a rebuild↔evict treadmill (~3 wasted rebuilds/tick,
  measured).
- **Liquid-only region invalidations are skipped by the renderer**
  (`WorldRegions.LIQUID_BIT`). Chunk canvases hold walls+tiles only; liquid
  paints live through `TC.Liquids.draw`. Settling pools previously forced the
  renderer's entire 3-chunks/tick budget forever (~12 ms/tick of pure churn).

## Wall textures (`js/tiles.js`)

- Wall position speckles are baked into `WALL_VARIANTS` pre-rendered canvases
  per wall id; `drawWall` selects one with a single `hash2(tx,ty,id)` call.
  The previous per-call path (9 hashes + string-built fillStyle + 3 fillRects
  per wall tile, per rebuild) dominated CPU profiles (~20% of frame time).
  Visual result remains deterministic and position-varied; patterns repeat
  with period `WALL_VARIANTS` in hash space instead of being unique per tile.

## Liquid simulation & persistence (`js/liquids.js`)

- **The active set persists in save data (provider v2)** alongside the cells;
  v1 bare-array payloads still load (heuristic surface-wake fallback).
- **Settle visits process cells in ascending index order** from a snapshot of
  the active set; cells woken mid-step join the next settle step (50 ms).
  Together with the persisted active set this makes post-reload evolution a
  bit-exact continuation of the pre-save session. Do not revert to
  insertion-order iteration or wake-heuristic-only restores: pending
  water×lava contacts can then resolve at different positions across a
  save/load boundary (world-byte divergence — this actually shipped as a
  flaky browser-journey failure once).
- The initial world drain (worldgen pools settling) legitimately takes tens of
  thousands of cells over ~1–2 minutes of sim time; it is bounded work, not a
  leak. With the renderer skip above it costs ~0.2 ms/tick while active.

## Noise (`js/utils.js`)

- `Noise2D.noise2` inlines fade/grad/lerp in the exact original evaluation
  order. It is bit-identical to the decomposed version (250k-sample A/B, max
  diff 0) and worldgen spends most of its time here. Changing operation order
  changes generated worlds for existing seeds — keep it exact.

## Lighting dynamics (`js/lighting.js`)

- `hexToRgb` results are memoized (callers re-register the same color strings
  every frame); the dyn union-box + signature scan is single-pass into a
  scratch object. The remaining per-frame cost of `mergeDynamics` is the disc
  stamp itself for *moving* sources — irreducible at the requested quality
  profile without changing visuals.

## Measurement

- `node tools/bench-runtime.js [ticks]` — scheduler/dispatch microbench.
- `node tools/bench-scenarios.js [--quick]` — named workload scenes (median of
  rounds; stub canvas = simulation+dispatch cost, not raster).
- `node tools/bench-multiplayer.js` — authoritative-server tick/bandwidth.

Reference numbers (2026-08, Node 24, Windows, this repo, headless):

| Scenario | Before | After |
| --- | ---: | ---: |
| full sim tick (bench-runtime) | 21.8 ms | 0.73 ms |
| exploration tick | 23.8 ms | 0.55 ms |
| idle tick | 23.0 ms | 0.18 ms |
| single chunk rebuild | 3.87 ms | 0.71 ms |
| worldgen | ~395 ms | ~350 ms |
