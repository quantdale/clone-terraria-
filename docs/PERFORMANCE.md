# Performance Notes

Non-obvious performance-sensitive invariants and their rationale. Read before
touching the modules below — several optimizations look like removable
overhead but encode correctness or determinism contracts.

**Scope warning (W27):** every number in the "Measurement" section below
(`bench-runtime`, `bench-scenarios`) is measured against a **no-op stub Canvas
2D context** (`tests/helpers/load-game.js`) — `fillRect`/`drawImage`/`fillText`
are free there. Those tools measure **simulation + dispatch cost only**. They
prove the fixed-step scheduler is healthy; they say nothing about what a real
browser's rasterizer is asked to do. `tools/bench-render.js` (added W27)
measures the render path itself, via a *counting* context (see its own section
below) — read that section for actual presentation-layer evidence. See
`docs/W27-PERFORMANCE-PLAN.md` for the full investigation.

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
- **(W27) `draw()` skips the overlay `ImageData` rebuild + `putImageData`
  upload when nothing changed.** `Lighting._overlayDirty` is set only by the
  three paths that actually write into `outR/outG/outB` (full reseed, region
  refresh, legacy-fallback recompute) and by `mergeDynamics()` returning
  `true` (it already had its own "did anything change" check — its early-out
  now reports `false` instead of silently no-op'ing). `draw()`'s per-pixel
  loop and `putImageData` only run when that flag is set; the `drawImage`
  blit still runs every frame at the camera's current position (cheap, and
  required while the camera eases toward the player). This is exact, not
  approximate: the skipped branch is a pure function of `outR/outG/outB`,
  which by construction have not changed, so the pixels it would have
  produced are identical to what's already uploaded. Do not add a second
  "dirty" flag elsewhere that bypasses this one — every write path into the
  `out*` arrays must set `_overlayDirty = true`.

## HUD sprites (`js/ui.js`)

- **(W27) Hearts, the shield glyph and breath bubbles are baked into
  offscreen canvases once, keyed by their (small, already-quantized) variant
  count**, exactly the `WALL_VARIANTS` pattern in `js/tiles.js` above.
  `drawHeart` used to issue 2 `fillRect` + 2 `fillStyle` changes **per lit
  pixel** (55 of each per heart) — a 400-max-HP health bar cost 1,111
  `fillRect`/frame. Every call site passes integer `x`/`y`/`cx`/`cy` (HUD
  layout is built from integer canvas dimensions and integer tunables), so
  baking at local origin and blitting with `drawImage(cache, x, y)` (or
  `drawImage(cache, cx - anchor, cy - anchor)` for the anchor-centered shield
  glyph) reproduces the exact same absolute pixels — no new visual
  quantization, no resampling. If a future change makes call-site coordinates
  fractional, revisit this — `drawImage` at a fractional destination can
  resample differently than the original fractional `fillRect` did.

## Measurement

- `node tools/bench-runtime.js [ticks]` — scheduler/dispatch microbench.
- `node tools/bench-scenarios.js [--quick]` — named workload scenes (median of
  rounds; stub canvas = simulation+dispatch cost, not raster).
- `node tools/bench-multiplayer.js` — authoritative-server tick/bandwidth.
- `node tools/bench-render.js` (W27) — render-path benchmark. Substitutes a
  **counting** 2D context for the no-op stub (every method call and every
  `fillStyle`/`strokeStyle`/`globalAlpha`/`globalCompositeOperation` write
  that actually changes the value is tallied, including for offscreen
  canvases created via `document.createElement`), reconstructs the exact
  production frame (`Runtime.tick` → `Sky.draw` → `RenderLayers.drawWorld` →
  `drawScreen`), and reports total/heavy canvas operations per frame with
  per-drawer attribution. Op counts are hardware-independent — the right
  currency here, since real browser frame-time could not be measured in the
  environment this tool was written in (Canvas 2D and `requestAnimationFrame`
  do not function in that headless Chromium instance; see
  `docs/W27-PERFORMANCE-PLAN.md` §4). A real-browser frame-time gate
  (`tests/browser/perf.spec.js`) is still open — see that plan's WS0.2.

Reference numbers (2026-08, Node 24, Windows, this repo, headless):

| Scenario | Before | After |
| --- | ---: | ---: |
| full sim tick (bench-runtime) | 21.8 ms | 0.73 ms |
| exploration tick | 23.8 ms | 0.55 ms |
| idle tick | 23.0 ms | 0.18 ms |
| single chunk rebuild | 3.87 ms | 0.71 ms |
| worldgen | ~395 ms | ~350 ms |

### Render-path evidence (`bench-render.js`, W27, canvas *operations*/frame)

Idle scene, 1280×720, zoom 2, stationary camera, settled world:

| | Before | After |
| --- | ---: | ---: |
| Total ops/frame | 1,229 | 682 |
| `UI.draw` ops/frame (100 max HP) | 612 | 67 |
| `UI.draw` ops/frame (400 max HP, 15 life crystals) | 2,262 | 82 |
| HUD max-HP scaling ratio (400hp / 100hp; 1.00x = flat, the target) | 3.70x | 1.22x |
| `putImageData`/frame (lighting overlay upload) | 1.0 | 0 |
| `Lighting.draw` ops/frame | 5 | 4 |

`Sky.draw` (435 ops/frame, ~35% of the pre-W27 total) is **unchanged** —
sky parallax baking is W27 WS2, not yet implemented (see
`docs/W27-PERFORMANCE-PLAN.md` and `docs/HANDOFF-W27-performance.md`).
Simulation-only benchmarks (`bench-runtime`, `bench-scenarios`) are unaffected
by either change (within normal run-to-run noise) — both fixes are strictly
presentation-layer.
