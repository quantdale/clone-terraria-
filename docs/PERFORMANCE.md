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

## Sky backdrop (`js/sky.js`)

- **(W27 WS2) Silhouette layers are cached as `Path2D` geometry, not
  re-pathed per frame.** `drawBgLayer` used to issue ~160 `lineTo` per
  layer per frame (435 ops/frame total). A `Path2D` object holds the same
  geometry with zero per-frame construction calls: it is rebuilt when the
  geometry inputs change (biome, seed, viewport, exact camera scroll /
  base height — a rebuild is pure JS math, strictly cheaper than the
  direct path, which does the same math AND 330 canvas calls) and filled
  (1 op) per frame. Color is deliberately NOT in the cache key: palette
  drift costs one `fillStyle` write, never a rebuild. Baked and direct
  pixels are identical (verified by a deterministic in-page before/after
  pixel diff with fixed camera/time/biome inputs: day 3.4% pixels differ,
  mean Δ 0.08, max 81, all diffuse — no ridge-line clusters).
- **Clouds, orbs and the sky gradient are baked sprites.** Cloud shape is
  static (seeded lobes); only drift position moves, so each cloud is one
  baked white union blitted with the exact per-frame alpha (the original
  single-path fill is uniform-alpha, which the blit reproduces exactly).
  Blit coordinates are integer-rounded (<=0.5px on soft blobs/glows —
  invisible). Sun/moon are baked once (moon: 4 phase variants, shadow
  position is discrete); the gradient repaints only when its exact phase
  key changes. Fallbacks (`!Path2D`, no `document.createElement`) run the
  original immediate code via shared paint functions.
- **Stars are one baked white sprite with the fade envelope only.** Two
  deliberate, stated simplifications: star tint is now white (it used to
  inherit the far-silhouette layer's opaque color — an incidental
  coupling, never a designed tint) and per-star twinkle is dropped (the
  fade-in/out envelope is kept). Night cost went 842 → ~22 ops/frame
  (38×); the ~2-op residual over the round WS2 ≤20 target at night is the
  documented star-fade blit (save + drawImage + restore), irreducible
  without hand-rolled alpha state. Do not reintroduce per-star
  `globalAlpha` writes — that was ~400 ops/night-frame.
- **Keep `save`/`restore` discipline around every alpha use.** Several
  bakes rely on browsers eliding no-change style writes across
  save/restore boundaries; hand-rolled alpha state (write + write-back)
  saves nothing and leaks into the silhouette blits. `tools/bench-render.js`
  models the save/restore style stack for exactly this reason.

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
  `docs/W27-PERFORMANCE-PLAN.md` §4). The real-browser gate
  (`tests/browser/perf.spec.js`, WS0.2) now exists and is green on the
  reference machine below — it measures both rAF frame-time percentiles
  and instrumented canvas-op budgets against the live game. Two harness
fidelity notes: the counting context models the save/restore *style
stack* (restores silently reset tracked styles, exactly like the native
stack bypasses wrapped JS setters — without this, re-set-after-restore
writes are miscounted), and `Path2D` construction is untallied pure-JS
geometry in both harnesses (browsers don't wrap `Path2D.prototype`; the
headless `load-game.js` stub mirrors that).

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

| | Before | After WS1+WS4 | After WS2 |
| --- | ---: | ---: | ---: |
| Total ops/frame | 1,229 | 682 | 267 |
| `UI.draw` ops/frame (100 max HP) | 612 | 67 | 67 |
| `UI.draw` ops/frame (400 max HP, 15 life crystals) | 2,262 | 82 | 82 |
| HUD max-HP scaling ratio (400hp / 100hp; 1.00x = flat, the target) | 3.70x | 1.22x | 1.22x |
| `putImageData`/frame (lighting overlay upload) | 1.0 | 0 | 0 |
| `Lighting.draw` ops/frame | 5 | 4 | 5* |
| `Sky.draw` ops/frame (day scenes) | 435 | 435 | 19.1 |
| `Sky.draw` ops/frame (night, previously unmeasured) | 842 | 842 | 22.3 |

* `Lighting.draw` reads 5 in `bench-render.js` only because the tool now
models the save/restore style stack honestly (the lighting pass re-sets
its multiply composite every frame — a real wrapped-setter write in
browsers too). Previously under-counted, not regressed.

`Sky.draw` was ~35% of the pre-W27 total by day and the single largest
cost by night (842 ops/frame — never measured before WS2; the plan's 435
figure is the day scene). Both remaining cost centers are entities
(`player.draw` 39, `NPCs.draw` 37 — W27 WS5) and the world-startup
rebuild treadmill (W27 WS3).
Simulation-only benchmarks (`bench-runtime`, `bench-scenarios`) are unaffected
by any of these changes (within normal run-to-run noise) — all fixes are
strictly presentation-layer.

### Real-browser gate (`tests/browser/perf.spec.js`, WS0.2, W27)

Reference machine: Windows 11 x64, headless Chromium software raster
(Playwright 1.62.1 / Chromium 151.0.7922.34), 1280×720 viewport.
Scene: deterministic world (seed 4242), player idle at spawn, 180-frame
settle (chunk-rebuild backlog drain + camera easing), 300-frame sample.
Counters are snapshotted AFTER the settle — snapshotting before it folds
the startup rebuild burst (~2,000 drawImages/frame) into the average and
was the first calibration bug in this gate's history.

| | Measured (post-WS2) | Budget | Headroom |
| --- | ---: | ---: | ---: |
| Total ops/frame @100 max HP | ~280 | 500 | loose* |
| Total ops/frame @400 max HP (15 life crystals) | ~310-410 | 550 | loose* |
| UI-attributed ops/frame @100hp | 75 | 100 | 33% |
| UI-attributed ops/frame @400hp | 90 | 120 | 33% |
| UI-attributed growth 100hp→400hp | +15.0 ops | 30 | 2× |
| Frame time p95 / p99 / mean | < 33 / < 50 / < 33 ms | same | vsync-bound |

*Whole-frame totals wander ±30% between runs (respawn composition during
the sampling window — enemies are cleared at each window start but the
director respawns a few mid-window) while UI-attributed numbers repeat to
the decimal (75/90/delta 15.0 three runs straight). The total budgets are
therefore deliberately loose: they catch every prior render-path stage
(pre-W27, pre-WS2, injected per-pixel control — all 2×+ over budget) and
the tight gate is the attributed HUD triple (100/120/delta 30). Do not
"fix" a total-budget breach by clearing more scene — investigate the
render path first.

(Environment note: the frame-time leg passed repeatedly on this reference
machine, then failed under sustained third-party host load (disk scan +
VM + parallel sessions, CPU ~64%): p95 60→111ms while op counts stayed
flat and the op-budget leg stayed green. A control run of pre-WS2 code on
the same loaded host failed identically (p95 92.5ms) — conclusive that the
failure is host contention, not a render regression. Per ONBOARDING §8 the
absolute budgets stand; the contention episode is recorded, not
accommodated. Re-verify the frame-time leg on a quiet host at campaign
close.)

The flatness check is UI-drawer-attributed (absolute delta), not a relative
whole-frame ratio: the spawn director keeps spawning during sampling, so
whole-frame totals wander and a tight relative gate would flake. The
attributed gate is strictly more sensitive to the §3.1 regression —
a negative control injecting the old per-pixel heart cost (+55 ops/heart)
breaches every leg (totals 968/1,827 vs 800/860; UI delta +837 vs 30).
The old `fps > 10` liveness assertion in `boot.spec.js` was removed when
this gate landed (promoted, not duplicated).
