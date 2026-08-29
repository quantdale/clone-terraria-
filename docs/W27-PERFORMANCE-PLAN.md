# W27 — Presentation Performance Recovery

**Status:** PROPOSED (planning-only; no code changed by this document)
**Planned-From:** `ca39da303e34e2eef1f6774dadbafe26df68b3c7`
**Planned-At:** 2026-08-29
**Target-Branch:** `main`
**Campaign-Type:** performance investigation + render-path optimization + measurement-gate construction
**Supersedes-Context:** W26 (`.agent/EXECUTION_PROMPT.md`) is `COMPLETED`; this is the next campaign.

---

## 1. Mission

The game feels slow. This campaign proves *why* with hardware-independent
measurements, closes the measurement gap that allowed the problem to grow
unnoticed, and then fixes the render path — without changing a single frame of
gameplay behavior, determinism, save format, protocol identity, or visual
output.

The campaign is **not** complete when a benchmark number improves. It is
complete when a real-browser frame-time gate exists, passes, and would fail if
the regression came back.

---

## 2. Executive diagnosis

**The simulation is not the problem. The presentation layer is, and nobody has
ever measured it.**

Every performance tool in this repository (`tools/bench-runtime.js`,
`tools/bench-scenarios.js`, every `tests/**` suite) boots the real game through
`tests/helpers/load-game.js`, which installs a **stub 2D canvas context whose
every method is a no-op**. Under that harness, `fillRect`, `drawImage`,
`fill`, `stroke` and `fillText` are literally free. `bench-scenarios.js` says
so in its own header comment, and the headline table in `docs/PERFORMANCE.md`
("full sim tick 21.8 ms → 0.73 ms") is therefore a *simulation* result being
read as a *game* result.

The only performance assertion in the entire browser suite is:

```js
// tests/browser/boot.spec.js:47
expect(await page.evaluate(() => window.TC.fps)).toBeGreaterThan(10);
```

A 10 fps floor is not a performance gate. It is a liveness check.

The consequence is a codebase where **simulation was optimized exhaustively
and presentation was never optimized at all**. The chunk renderer, wall
texture baking, noise inlining, liquid settling and lighting recompute have all
had real optimization passes (all documented in `docs/PERFORMANCE.md`). The
HUD, the sky, the entity sprites and the lighting blit have had none — they are
still naive immediate-mode Canvas 2D code issuing one state change per drawn
pixel.

Measured on a settled world at 1280×720, zoom 2, default 100 max HP:

| | ops/frame | share |
|---|---:|---:|
| **Total canvas operations** | **1,229** | 100% |
| `UI.draw` (HUD) | 612 | 49.8% |
| `Sky.draw` (parallax) | 435 | 35.4% |
| everything else (world, entities, lighting, minimap, cursor) | 182 | 14.8% |

At 60 fps that is **~74,000 canvas operations per second, of which ~85% are the
health bar and the sky**. The world, the enemies, the lighting and the terrain
— the things the player is actually looking at — cost 15%.

And it gets worse as the player progresses, because the worst offender scales
with character power (§3.1).

---

## 3. Findings

Severity is engineering impact on frame time, ranked.

### 3.1 CRITICAL — The health bar is drawn one `fillRect` per pixel, and scales with max HP

`js/ui.js:1213` `drawHeart()` renders a 7×6 pixel-art heart by iterating
`HEART_MAP` and issuing, **for every lit pixel, two `fillRect` calls and two
`fillStyle` assignments** (one shadow, one body). `HEART_MAP` has 27 lit
pixels, so one heart costs **55 `fillRect` + 55 `fillStyle` changes**, every
frame, forever. `drawHearts()` draws `ceil(maxHp / 20)` of them.

Measured, one static `TC.UI.draw()` call, everything else held constant:

| max HP | hearts | `fillRect` | `fillStyle` changes | total UI ops |
|---:|---:|---:|---:|---:|
| 100 | 5 | 305 | 319 | 704 |
| 200 | 10 | 561 | 574 | 1,169 |
| 300 | 15 | 836 | 849 | 1,719 |
| 400 | 20 | 1,111 | 1,124 | 2,269 |
| 500 | 25 | 1,386 | 1,399 | 2,819 |

Perfectly linear: **+55 `fillRect` and +55 `fillStyle` per heart.**

An endgame character at 400 max HP pays **1,111 `fillRect` + 1,124 style state
changes per frame — 66,660 rasterizer state transitions per second — to draw a
health bar that changes maybe once a second.** `fillStyle` assignment is not
free: each one is a paint-source rebind, and each string literal is a style
re-parse.

This is the single largest cost in the game, it is invisible to every existing
benchmark, and it gets worse the longer the player plays.

**The fix pattern already exists in this repository.** `js/tiles.js:544`
documents exactly this problem being solved for walls:

> *PERF: position speckles are baked into `WALL_VARIANTS` pre-rendered canvases
> per wall id … The previous per-call path (9 hashes + string-built fillStyle +
> 3 fillRects per wall tile, per rebuild) dominated CPU profiles (~20% of frame
> time).*

The technique was applied to walls and never carried to the HUD.

### 3.2 CRITICAL — The sky rebuilds its parallax silhouette from scratch every frame

`js/sky.js:225` `drawBgLayer()` walks the screen in 8px steps
(`1280 / 8 = 160` samples) and issues a `lineTo` per sample, per background
layer, then fills the path — **every frame, whether or not the camera moved.**

Measured: **328 `lineTo` + 37 `moveTo` + ~90 `fillStyle` changes per frame**,
435 total ops — 35% of all canvas work in the game.

The *height data* is already cached (`segPoints()` memoizes `Float32Array`
sample sets per segment, `js/sky.js:199`). Only the path construction and fill
are repeated. The silhouette is a function of `(biome, layer, scroll, daylight
quantum)` and is a pure horizontal scroll between segment boundaries — it is
trivially bakeable into an offscreen strip and blitted with an offset.

### 3.3 HIGH — Chunk-canvas rebuild↔evict treadmill at world start, ~160 MB retained

`docs/PERFORMANCE.md` claims the rebuild↔evict treadmill was avoided. It was
avoided **for visible chunks only**. The far-chunk path still thrashes.

On world creation, `markAllDirty()` → `WorldRegions.markAll('bulk')` dirties
**every** region for the `renderer` consumer. `World.update()` (`js/world.js:665`)
then materializes chunks at 3/frame from that whole-world backlog — including
chunks nowhere near the camera — while `evictFarChunks()` (CAP 160 / FLOOR 120)
drops the farthest ones. The two fight each other.

Measured over 300 frames on a 1200×400 world (38×13 = **494 chunks**):

```
renderer: {"rebuilt":494, "maxBacklog":494, "chunkCacheSize":158, "chunksEvicted":336}
```

494 rebuilds and 336 evictions, to end up holding 158 chunks. Each chunk canvas
is `CHUNK*TS` square = **512×512 = 1 MB of raster**, so:

- **~165 frames of guaranteed startup jank** (494 chunks ÷ 3 per frame), each
  rebuild painting up to 1,024 tiles + walls immediate-mode;
- **~336 MB of canvas allocation churn** in the first five seconds;
- **up to 160 MB steady-state retained** (CAP × 1 MB) for a world where the
  visible set at zoom 2 is roughly **2×2 chunks**.

The cap is 40× larger than the working set, and the renderer is eagerly
building chunks the player cannot see. `evictFarChunks()` additionally runs
from `World.draw()` — i.e. **every frame** — iterating the whole cache and
sorting a candidate array.

### 3.4 HIGH — `UI.layout()` rebuilds the entire UI geometry every frame

`js/ui.js:736` `layout(ctx, w, h)` is called unconditionally at the top of
`UI.draw` (`js/ui.js:2260`) and allocates a fresh object with **15 arrays**,
then pushes 10 hotbar rects, the bag grid, craft rows, equipment rects and shop
rows — **new objects, every frame, at title and in play, whether or not the
inventory is even open.** This is pure GC pressure on the hot path; the layout
is a function of `(w, h, open panels, inventory contents)` and changes on
resize and interaction, not on frame boundaries.

### 3.5 MEDIUM — Lighting re-uploads and re-composites unconditionally

`js/lighting.js:625` `Lighting.draw()` rebuilds the whole overlay `ImageData`
pixel by pixel, calls `putImageData`, then blits it full-screen with
`globalCompositeOperation = 'multiply'` and `imageSmoothingEnabled = true`
scaled up by `TS × zoom` — **every frame, with no check for whether the light
field or the camera changed.**

`putImageData` forces a CPU→GPU texture upload and defeats accelerated canvas
paths; a full-screen bilinear `multiply` composite is one of the most expensive
single operations a 2D context can perform. In a static scene, both are pure
waste. The field already has revision tracking available through its
`WorldRegions` consumer and `counters()`.

### 3.6 MEDIUM — Entities are immediate-mode, unbatched, per-instance

Every enemy, NPC, the player, dropped items and particles are drawn as a series
of `fillStyle` + `fillRect` pairs per instance per frame (`js/enemies.js:720+`
is ~20–40 state changes per enemy; `js/particles.js:109` sets `fillStyle` per
particle with no color grouping).

Measured: 24 on-screen enemies add **+409 ops/frame (+216 heavy)**, ≈17 ops and
9 `fillRect` per enemy per frame. Correct in isolation, but it is the same
un-batched pattern as the HUD and it compounds during boss fights and Blood
Moons — precisely when frame budget is tightest.

### 3.7 MEDIUM — Liquid invalidation volume

Measured over a 120-frame window: **85,161 `WorldRegions` marks, of which
67,547 (79%) were `liquid`** — ≈563 region marks per frame — with 3,728 cells
still active after 300 ticks of settling. The renderer correctly skips
liquid-only regions (`liquidOnlySkipped: 475`), but the marks are still paid
for: allocation, revision bump and per-consumer queue work, per cell, rather
than coalesced per region per tick.

### 3.8 INFO — Uncommitted working-tree optimization

`js/enemyspawn.js` has **70 uncommitted lines** adding a lazily-built,
`PacksChanged`-invalidated pack spawn-rule zone index (replacing a per-spawn
`TC.Packs.active()` call and its defensive array copy). It is syntactically
valid (`node tools/check-syntax.js` → 58 files, 0 failures) and directionally
correct, but it is untested and uncommitted. W27 must either finish, test and
commit it, or revert it — it must not be carried silently through a performance
campaign as unattributed drift.

---

## 4. Methodology and evidence quality

**What was measured, and how.**

1. **Headless simulation** — `node tools/bench-runtime.js` and
   `node tools/bench-scenarios.js` were run against `HEAD`. Full sim tick
   **303 µs**, scheduler `updateAll` **128 µs**, stub render dispatch **147 µs**.
   Scenario medians: exploration 119 µs, construction 45 µs, combat-dense 58 µs,
   projectiles 668 µs, lighting-stress 332 µs, dynamic-lights 535 µs, liquids
   119 µs, minimap 105 µs, save-diff 1.03 ms, worldgen 237 ms.
   **Conclusion: the fixed-step simulation is healthy and is not the bottleneck.**

2. **Canvas operation counting** — a counting 2D context (every method and
   every `fillStyle`/`strokeStyle`/`globalAlpha`/`globalCompositeOperation`
   write tallied) was substituted for the stub, including for
   `document.createElement('canvas')` so offscreen chunk/lighting canvases were
   counted too. The real `main.js` frame was reconstructed exactly —
   `Runtime.tick` → `Sky.draw` → `RenderLayers.drawWorld` → `RenderLayers.drawScreen`
   — and per-drawer attribution taken by wrapping the public draw entry points.
   All §3 op counts come from this harness, warmed 180 frames, measured over
   60–120 frames.

   **Op counts are hardware-independent.** They are the work the rasterizer is
   asked to do, and they are the honest currency for a campaign whose whole
   problem is that wall-clock raster was never measured.

**What could NOT be measured here, and why it matters.**

Real browser wall-clock frame times were **not** obtained. This WSL2
environment cannot run the browser gate at all:

- `requestAnimationFrame` **never fires** — 30 rAF callbacks on a blank page
  time out after 5 s, with both the bundled headless shell and the full
  Chromium channel;
- Canvas 2D raster is pathologically slow — **1,024 `fillRect` calls on an
  otherwise empty page exceed 120 seconds**, and a single `TC.world.update()`
  (3 chunk rebuilds) exceeds 240 s.

This is an environment defect, not a game defect, and it is consistent with the
W26 handoff's own note that `test:browser` "requires Playwright display". No
browser-derived timing in this document should be trusted, and none is quoted.
**WS0 must establish the browser baseline on real hardware before WS1 lands.**

---

## 5. Non-negotiable preserved behavior

Inherited from the standing repository contracts; a performance campaign is the
easiest place to break them by accident.

1. **Zero gameplay change.** This is a presentation campaign. No change to
   simulation order, physics, AI, spawn tables, loot, damage or timing.
2. **Determinism intact.** No `Math.random` on any gameplay path; `TC.GameRng`
   stream call *counts and order* must not change. Presentation-only randomness
   stays out of the gameplay streams. World-byte and registry-fingerprint
   digests must be unchanged.
3. **Visual parity.** Every optimization must be visually equivalent. Where a
   cache quantizes something continuous (sky daylight, heart fill fraction),
   the quantization must be stated, bounded and justified — the way
   `WALL_VARIANTS` documents its own periodicity.
4. **`TC.RenderLayers` remains the single draw authority.** No second render
   loop, no bypass, no drawing outside a registered layer. Layer order is a
   contract.
5. **`TC.WorldRegions` multi-consumer invariant.** No consumer may observe or
   clear another's invalidation. The renderer must **not** re-mark regions on
   eviction (`docs/PERFORMANCE.md` records that this was tried and broke the
   "no perpetual repainting" guarantee).
6. **`draw()` still repairs visible holes synchronously.** A visible chunk with
   no canvas must still be rebuilt on the spot. Do not convert this into a
   proactive background rebuild queue — that is the documented treadmill.
7. **Canonical scheduling.** No second update loop. New bookkeeping registers
   into the existing fixed-step phases and is bounded.
8. **Save/protocol/pack identity untouched.** No save format, `SaveCore`
   provider, protocol field or pack digest changes. Zero-pack equivalence and
   the W25 base registry fingerprint `1b1d7c15` hold exactly.
9. **Localization stays presentation-only** and stays out of cache keys that
   affect gameplay identity.
10. **Boot order is a contract.** Any new module must work in browser, headless
    test loader, release build and `file://` execution. No bundle-only imports.
11. **No failure masking.** No weakened assertions, no inflated timeouts, no
    skipped suites, no "flaky is acceptable".
12. **No Critical/High regressions**, and no destructive Git behavior
    (no force-push, no history rewrite, `main`-only policy).

---

## 6. Workstreams

Ordered. **WS0 is a hard prerequisite** — this campaign exists because work
landed without measurement, and repeating that mistake would be the worst
possible outcome.

### WS0 — Make rendering measurable (blocking)

1. Add `tools/bench-render.js`: the counting-context harness from §4, promoted
   to a first-class tool. Reports total ops/frame, heavy-raster ops/frame, a
   per-operation histogram and per-drawer attribution, for a fixed set of named
   scenes (idle-100hp, idle-400hp, inventory-open, 24-enemies, particles,
   world-start). Deterministic, no raster, runs in `node`, safe for CI.
2. Add `tests/browser/perf.spec.js`: a real-browser journey that measures rAF
   frame-time **percentiles** (p50/p95/p99) over a fixed scene and asserts a
   budget. **Delete the `fps > 10` assertion** in `boot.spec.js` or promote it
   to the real budget — do not leave both.
3. Record the `HEAD` baseline for both, on real hardware, in
   `docs/PERFORMANCE.md`, with the machine/browser stated.
4. Correct `docs/PERFORMANCE.md`: its headline table measures **simulation
   only**. Say so at the top of the table, not only in a tool's source comment.
5. Resolve the uncommitted `js/enemyspawn.js` change (§3.8): test and commit, or
   revert. Decide before any other edit so the baseline is clean.

**Exit:** two commands produce numbers, both are in the docs, and a deliberate
regression (e.g. temporarily doubling heart draws) makes the browser gate fail.

### WS1 — HUD: stop re-rasterizing the health bar (largest win)

1. Bake heart sprites into pre-rendered offscreen canvases, following the
   `WALL_VARIANTS` precedent in `js/tiles.js`: 8 variants keyed by the existing
   `cols = round(frac * 7)` quantization (which the current code *already*
   applies — so this introduces **no** new visual quantization). One
   `drawImage` per heart replaces 55 `fillRect` + 55 `fillStyle`.
2. Same treatment for `drawShieldGlyph`, `drawBubble` and `drawSlotBox` /
   `drawFavPin` chrome.
3. Cache the composed static HUD strip to an offscreen canvas, invalidated only
   when its inputs change (`hp`, `maxHp`, defense, selected slot, hotbar
   contents, breath, locale, viewport size). Blit one image per frame.
4. Hoist `UI.layout()` (§3.4) into a memoized structure recomputed on resize
   and on panel/inventory state change — not per frame.

**Target:** `UI.draw` from 612 ops/frame → **< 40**, and **flat in max HP**
(400 HP must cost the same as 100 HP). This alone removes ~50% of all canvas
work at 100 HP and ~75% at 400 HP.

### WS2 — Sky: bake the parallax bands

Render each background layer silhouette into an offscreen strip keyed by
`(biome, layer, daylight quantum)`; blit with a horizontal scroll offset;
rebuild only when the scroll crosses a segment boundary or the daylight quantum
changes. Reuse the existing `segPoints` cache as the height source. State the
daylight quantization explicitly.

**Target:** `Sky.draw` from 435 ops/frame → **< 20**.

### WS3 — Renderer: end the treadmill, bound the memory

1. Gate `World.update()` rebuilds to a camera-radius window. Regions outside it
   stay stale in the renderer's own cursor and are rebuilt on demand by
   `draw()` — which already does exactly this correctly. **Do not** re-mark
   `WorldRegions` (§5.5) and **do not** build a background rebuild queue (§5.6).
2. Move `evictFarChunks()` off the per-frame `draw()` path into the update
   phase on a cadence.
3. Derive `CAP`/`FLOOR` from the viewport chunk footprint plus a margin instead
   of the fixed 160 (≈160 MB). Keep hysteresis.
4. Re-examine whether world creation needs `markAll('bulk')` for the **renderer**
   consumer specifically, given nothing off-screen needs a canvas yet.

**Target:** startup rebuild burst from 494 → the visible working set;
`chunksEvicted` ≈ 0 in a stationary 300-frame run; steady-state canvas memory
stated and bounded in `docs/PERFORMANCE.md`.

### WS4 — Lighting: skip unchanged frames

Track a light-field revision plus camera position; when neither changed since
the last `Lighting.draw`, skip the `ImageData` rebuild and the `putImageData`
and blit the existing overlay canvas. Measure whether
`imageSmoothingEnabled = true` on the multiply blit is worth its cost at each
quality profile. Queried light values must remain identical across profiles
(existing contract).

### WS5 — Entity draw batching

Bake per-type enemy/NPC/player sprite variants keyed by `(type, facing,
animation frame)` — the `WALL_VARIANTS` pattern again — or, where sprites are
genuinely dynamic, group draws by `fillStyle` to collapse state changes. Sort
particles by color before drawing.

**Target:** per-enemy cost from ~17 ops → **≤ 3** (one `drawImage` plus overlay).

### WS6 — Coalesce liquid invalidation

Accumulate liquid marks per region per tick and bump each affected region once,
instead of once per cell. Must preserve the settle-order determinism contract in
`docs/PERFORMANCE.md` (ascending-index snapshot iteration, bit-exact
post-reload continuation) and the multi-consumer invariant.

**Target:** liquid marks from ≈563/frame → within a small constant of the
number of distinct dirty regions.

### WS7 — Validation, gate and truth-sync

Full `npm run validate` including `test:browser` on real hardware. Update
`docs/PERFORMANCE.md` (before/after, both harnesses, machine stated),
`docs/ARCHITECTURE.md` where render-path ownership changed,
`docs/TASK_BOARD.md`, and write `docs/HANDOFF-W27-performance.md`.

---

## 7. Acceptance criteria

A workstream is done when its numeric target is met **and** proven by WS0's
tooling. The campaign is done when all of:

1. `tools/bench-render.js` and `tests/browser/perf.spec.js` exist, run clean,
   and are documented with baselines taken on real hardware.
2. Idle frame total canvas ops: **1,229 → ≤ 250** at 100 max HP.
3. HUD cost is **flat in max HP**: 400 max HP costs within 5% of 100 max HP
   (today it is 3.2× worse).
4. `Sky.draw` ≤ 20 ops/frame; `UI.draw` ≤ 40 ops/frame.
5. Stationary 300-frame run reports `chunksEvicted` ≈ 0 and a chunk-cache
   ceiling derived from the viewport, with the memory ceiling documented.
6. Real-browser p95 frame time meets the WS0 budget on the reference machine,
   and the gate demonstrably fails when a regression is injected.
7. Simulation is not slower: `bench-runtime` and `bench-scenarios` within noise
   of the `HEAD` baseline in §4.1.
8. Zero behavior change: full `npm run validate` green — 624 Node tests, 30
   browser journeys, pack fuzz 0 escapes, build + `verify:dist` — plus
   unchanged world-byte digests, unchanged `TC.GameRng` stream digests, and the
   W25 base registry fingerprint `1b1d7c15` intact.
9. `js/enemyspawn.js` working-tree drift resolved (committed with tests, or
   reverted).
10. No known Critical/High regressions. `docs/PERFORMANCE.md` no longer
    presents simulation-only numbers as whole-game numbers.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Sprite baking changes visuals subtly | Heart baking reuses the *existing* `cols` quantization — no new quantization. For sky, state the daylight quantum and diff screenshots before/after. |
| Renderer rebuild-gating hides terrain | `draw()` already rebuilds visible missing chunks synchronously; keep that path untouched and assert it in a browser journey. |
| Touching `WorldRegions` breaks the multi-consumer invariant | Coalescing (WS6) changes mark *volume*, never delivery semantics. Existing `tests/world/buckets.test.js` and region tests must pass unmodified. |
| Liquid coalescing breaks bit-exact save/load continuation | Documented failure mode with a real prior incident. Keep ascending-index snapshot iteration; run the determinism suites explicitly. |
| Optimizing without a browser gate repeats the original mistake | WS0 is blocking. Do not start WS1 until the browser baseline exists on real hardware. |
| This environment cannot validate the browser gate | Known and stated (§4). The executor must run `test:browser` where a display is available; a green Node-only gate is **not** sufficient for completion. |

---

## 9. Out of scope

- WebGL / renderer rewrite. Everything here is achievable in Canvas 2D by
  applying the caching pattern the repo already uses for walls.
- Offscreen/worker rendering, WASM, or a build step. The game must keep running
  from `index.html` with plain script tags.
- Simulation changes, gameplay tuning, new content, pack families.
- MOD-004 sandboxed mods (remains deferred).
- Multiplayer bandwidth/tick work (`bench-multiplayer` is a separate axis).

---

## 10. Reproduction of the evidence in this document

```bash
# simulation baseline (healthy — proves the bottleneck is elsewhere)
node tools/bench-runtime.js
node tools/bench-scenarios.js

# after WS0 lands, the render evidence becomes first-class:
node tools/bench-render.js
npm run test:browser -- perf.spec.js     # requires a display
```

Until `tools/bench-render.js` exists, the §3 numbers are reproduced by
substituting a counting 2D context for the stub in
`tests/helpers/load-game.js` (including for `document.createElement('canvas')`)
and reconstructing the `main.js` frame as
`Runtime.tick` → `Sky.draw` → `RenderLayers.drawWorld` → `RenderLayers.drawScreen`.
WS0.1 exists precisely so this is never an ad-hoc reconstruction again.

---

*Planning-only document. No source file was modified in producing it. The
`js/enemyspawn.js` working-tree change predates this campaign and is recorded
in §3.8 as drift to be resolved, not as W27 work product.*
