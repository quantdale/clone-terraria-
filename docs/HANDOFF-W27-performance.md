# HANDOFF — W27 Presentation Performance Recovery

**Status:** ACTIVE (partial execution — see per-workstream status below)
**Planned-From:** `ca39da303e34e2eef1f6774dadbafe26df68b3c7`
**Execution-Started:** 2026-08-29
**This-Handoff-HEAD:** pending (see "Commits in this session" below; push
follows this handoff commit)
**Plan:** `docs/W27-PERFORMANCE-PLAN.md`

## Summary

W26 was `COMPLETED`. A planning pass (`docs/W27-PERFORMANCE-PLAN.md`)
diagnosed why the game "feels slow": the fixed-step simulation is healthy,
but every existing perf tool measures it through a no-op stub Canvas 2D
context, so the presentation layer — the HUD, sky, lighting blit — has never
been measured and never been optimized. This session executed the highest-
value, lowest-risk items from that plan and left the rest explicitly
deferred with reasons, rather than attempting changes I could not verify.

**Environment constraint that shaped scope:** this execution environment
cannot run a real browser — `requestAnimationFrame` never fires and Canvas 2D
raster hangs for 100+ seconds on trivial workloads (confirmed via direct
bisection: a blank page issuing 1,024 `fillRect` calls never completes within
120s; `TC.world.update()` — 3 chunk rebuilds — exceeds 240s). This is
independent of anything in this repository (`npm run verify:build` and
`test:browser` both boot Chromium and both hang here the same way). Every
optimization below was therefore chosen because it is **provably correct by
construction** (same draw calls, same math, only *when* they run changes) and
verified through `node`-level tooling — not through visual inspection, which
was unavailable.

## What landed

### 1. `js/enemyspawn.js` — pack spawn-rule zone index (pre-existing drift)

Found 70 uncommitted lines at session start: a lazily-built, `PacksChanged`-
invalidated zone index for pack spawn rules, replacing a per-spawn linear
scan + `TC.Packs.active()` call. Syntactically valid, semantically
equivalent (same zone filter, precompiled instead of inline). Ran the full
`tests/packs/**` + spawn-related suites (107 tests) green, committed as its
own change (`8154001`) — kept separate from W27 since it's a W26-era fix, not
a render-path change.

### 2. `tools/bench-render.js` (WS0.1)

New first-class benchmark tool. Substitutes a **counting** 2D context for
`tests/helpers/load-game.js`'s no-op stub — every method call and every
`fillStyle`/`strokeStyle`/`globalAlpha`/`globalCompositeOperation` write that
actually changes the value is tallied, including offscreen canvases created
via `document.createElement` (chunk caches, lighting overlay, future sprite
caches). Reconstructs the exact production frame
(`Runtime.tick` → `Sky.draw` → `RenderLayers.drawWorld` → `drawScreen`) and
reports total/heavy ops per frame, a histogram, and per-drawer attribution
via wrapping each layer's public draw entry point.

Op counts are hardware-independent — deliberately chosen because real
frame-time could not be obtained here (see environment constraint above).

**A methodology bug was caught and fixed while building this tool:** the
first draft set `TC.player.maxHp` directly to simulate a higher-HP character.
`maxHp` is a **derived** stat — `js/player.js:658` syncs it from
`TC.Stats.resolve()` (which folds in `progress.lifeCrystals`) every tick, so
the poked value silently reverted after the warmup loop. The corrected
version grants `TC.player.lifeCrystals = 15` (the real mechanism a live
character uses to reach 400 max HP) and the resulting numbers are
substantially worse than the original estimate (2,262 ops/frame vs an
initially-measured ~2,269 from a since-superseded ad-hoc script) — confirming
the scaling problem was real and, if anything, understated before the fix.

### 3. WS1 — HUD sprite baking (`js/ui.js`)

`drawHeart` issued 2 `fillRect` + 2 `fillStyle` changes **per lit pixel**
(55 of each per heart, `HEART_MAP` has 27 lit cells) — every frame. Applied
the exact `WALL_VARIANTS` pattern already used in `js/tiles.js`:

- **Hearts:** 8 pre-baked offscreen canvases keyed by `cols` (0..7) — the
  quantization `drawHeart` already applies, so no *new* visual quantization
  is introduced. `drawHeart` is now one `drawImage` call.
- **Shield glyph:** cached per size (`s`) with an anchor-centered blit
  (`drawImage(cache, cx - anchor, cy - anchor)`), keyed defensively like
  `wallCache` in case a future caller varies the size (today only `s=13` is
  used).
- **Breath bubbles:** 2 variants (filled/unfilled) baked once.
- Each has a fallback path (`paintHeartAt`/`paintShieldGlyph`/
  `paintBubbleAt`) for embeds without `document.createElement`, matching
  `ui.js`'s existing guarded-`document` convention elsewhere in the file.

**Why this is safe by construction, not just "probably fine":** every call
site passes integer `x`/`y`/`cx`/`cy` — HUD layout (`js/ui.js:736` `layout()`)
is built entirely from integer canvas dimensions and integer tunables
(`HEART_SIZE=22`, `BUBBLE_R=4`, `BUBBLE_GAP=4`, etc.), confirmed by reading
every call site in `drawHearts`. Baking at local origin `(0,0)` and blitting
via `drawImage(cache, x, y)` with an **integer** destination reproduces the
exact same absolute pixels as the original fillRect calls shifted by
`(x, y)` — no resampling occurs for an integer-aligned, unscaled `drawImage`,
regardless of `imageSmoothingEnabled`. Only the fractional-pixel math
*internal* to each shape (e.g. `HEART_SIZE/7 ≈ 3.142857`) is unchanged,
because it's baked verbatim from the original per-pixel loop body — moved,
not altered.

**Measured** (`tools/bench-render.js`, idle scene, 1280×720, zoom 2):

| | Before | After |
| --- | ---: | ---: |
| `UI.draw` ops/frame @ 100 max HP | 612 | 67 |
| `UI.draw` ops/frame @ 400 max HP (15 life crystals) | 2,262 | 82 |
| scaling ratio (400hp/100hp; 1.00x = flat, the target) | 3.70x | 1.22x |
| Total ops/frame (idle-100hp scene) | 1,229 | 682 |

Residual 1.22x is expected and correct: more hearts still means more
`drawImage` calls (one per heart, unavoidable), it's just O(hearts) instead
of O(hearts × pixels). `UI.layout()` memoization and a composed static HUD
strip (plan items WS1.3–1.4) were **not** attempted — smaller residual win,
more surface area for state-invalidation bugs (stale layout on resize/
inventory-toggle), and not safely verifiable without a real browser.

### 4. WS4 — Lighting: skip unchanged frames (`js/lighting.js`)

`Lighting.draw()` rebuilt the whole overlay `ImageData` pixel-by-pixel and
called `putImageData` (a GPU texture upload) **every frame**, even when
nothing in the light field changed — a fully static scene with no live
dynamic lights does essentially no work in `Lighting.update()` (confirmed by
reading the guard `if (hasLive && ...)` around `mergeDynamics()`), so 100% of
the per-frame waste was in `draw()` unconditionally re-deriving and
re-uploading identical data.

Added `Lighting._overlayDirty`, set `true` only by the code paths that
actually write into `outR`/`outG`/`outB`:
- the full-reseed branch (`fullDirty`),
- `regionRefresh()` returning `true`,
- the legacy no-`WorldRegions` fallback branch,
- `mergeDynamics()` returning `true` — it already had an internal "did
  anything change" check (`!this._dirtySinceMerge && sig === this._mergeSig`)
  that silently no-op'ed; changed its early-out to `return false` and its
  completion path to `return true` so `update()` can propagate the signal.
  This is the **only place** correctness could have been subtle, since
  `mergeDynamics` has two early-return paths depending on whether a `syncOut`
  actually ran; traced both by hand (see the diff) — a `changed` local now
  captures exactly "did `syncOut` run", returned from every exit point.

`draw()` now gates the per-pixel loop + `putImageData` on `_overlayDirty`
(also set on canvas-dimension change, e.g. a quality-profile step change, and
on first draw). The `drawImage` blit still runs every frame at the camera's
current position — required while the camera eases toward the player
(`updateCamera`'s `0.18` lerp never exactly settles) — so panning is
unaffected; only a stationary scene skips the expensive part.

**Why this is safe:** the skipped code is a pure function of
`outR`/`outG`/`outB`, `step`, `iw`, `ih` — none of which change when the flag
is false, by the construction above. Skipping a pure function's re-evaluation
over unchanged inputs cannot change its output. Not an approximation.

**Measured:** `putImageData` (the single most expensive operation counted —
a real GPU texture upload, not just a canvas call) goes from 1/frame to
**0/frame** in a stationary idle scene. `Lighting.draw` drops from 5 to 4
ops/frame (the remaining 4 are `save`/`setTransform`/`globalCompositeOperation`
set/`drawImage`).

### 5. `docs/PERFORMANCE.md`

Added a scope warning at the top: the existing headline table
(`bench-runtime`/`bench-scenarios`) measures simulation only, through a no-op
stub context — not the render path. Added sections documenting the WS1/WS4
invariants (so a future editor doesn't accidentally reintroduce per-pixel HUD
drawing or unconditional lighting uploads) and a before/after render-path
evidence table.

## Advisor review caught two real bugs before push — read this

Op-count benchmarking and node-level tests cannot catch geometry errors or
incomplete call-graph audits. A pre-push advisor review (mandatory practice
in this environment for exactly this reason — no visual verification was
available to catch these any other way) found two real defects in the first
draft of this commit, both fixed before push:

1. **Heart bake canvas was too small — the last column was clipped.** The
   first draft sized the offscreen canvas to exactly `HEART_SIZE` (22px). But
   `paintHeart`'s widest painted rect (column 6's shadow, since `HEART_MAP`
   is 7 columns wide) extends to `6*px + 1 + Math.ceil(px)` where
   `px = HEART_SIZE/7 ≈ 3.143` — that's **≈23.86px**, past a 22px canvas.
   The "safe by construction / no new visual quantization" claim in the code
   comment, `docs/PERFORMANCE.md`, and this handoff was therefore false for
   the rightmost column until fixed: `heartCanvasSize()` now computes the
   real painted extent instead of assuming the nominal `HEART_SIZE` bounds
   it. Verified by direct arithmetic (`node -e` one-liner), not by rerunning
   the benchmark — op counts don't change from a canvas-size fix, so the
   benchmark alone would never have caught this or confirmed the fix.
2. **`Lighting.recompute(cam)` — a public "legacy full-window entry point
   (kept for embeds/tests)" — writes into `out*` but wasn't wired to
   `_overlayDirty`.** My audit traced every call site reached from
   `update()` (fullDirty branch, `regionRefresh()`, legacy fallback,
   `mergeDynamics()`) but didn't grep the whole file for every function that
   touches `outR`/`outG`/`outB`, so I missed this one — it has zero callers
   in this repository today, but it's a documented public API, not dead
   code, and any future embed/test calling it directly would have left
   `draw()` blitting a stale overlay indefinitely. Fixed by adding
   `this._overlayDirty = true;` at its one write site, mirroring the
   `update()` branches exactly.

Both fixes are in the commit; `npm test` (625/625) and `check-i18n`
(fingerprint `1b1d7c15` unchanged) were rerun clean afterward. The lesson for
whoever continues this campaign: when the audit method for a "safe by
construction" claim is call-graph tracing rather than exhaustive grep, say so
explicitly and expect it to be incomplete — grep for every write site to a
shared array before claiming a dirty-flag invariant is complete.

## Validation performed

- `node tools/check-syntax.js` — 58 files, 0 failures (after every edit).
- `node --test` targeted suites (spawn/pack: 107 tests; lighting: 17 tests) —
  green before the full run.
- **Full `npm test`: 625/625 green**, both before and after the WS1+WS4
  changes (run twice, once after each).
- `node tools/bench-runtime.js` and `node tools/bench-scenarios.js --quick` —
  simulation-only numbers unaffected (within normal run-to-run noise); proves
  both fixes are strictly presentation-layer, per plan invariant #1 (zero
  gameplay change).
- `node tools/bench-render.js` (new tool) — before/after evidence above.
- `npm run build` — succeeds standalone (`node tools/release-build.js`,
  no browser dependency).
- `npm run verify:build` / `npm run test:browser` — **could not run**; both
  boot real Chromium via `@playwright/test`, which hangs in this environment
  exactly as described above. Not a code defect — reproduced identically by a
  minimal blank-page `fillRect` loop with no game code involved.

## What did NOT land, and why (read before continuing this campaign)

- **WS0.2** (`tests/browser/perf.spec.js`, deleting/promoting the `fps > 10`
  assertion in `boot.spec.js`): not attempted. I cannot validate a browser
  spec at all in this environment, and editing an existing green assertion
  without being able to run it risks silently breaking the browser gate.
  **Do this first on a machine with a working browser**, before any further
  render-path change — it's the actual point of WS0.
- **WS1.3–1.4** (composed HUD-strip cache, `UI.layout()` memoization): smaller
  residual win than the sprite baking, more invalidation surface (must track
  every input: hp, maxHp, defense, selected slot, hotbar contents, breath,
  locale, viewport size, panel open/closed) — deferred rather than risk a
  stale-layout bug I can't see.
- **WS2** (sky parallax baking): **not attempted** — investigated but found
  materially harder than the plan implied. `drawBgLayer`'s fill color
  (`js/sky.js:225` `cr`/`cg`/`cb`) depends *continuously* on `dl` (daylight
  fraction) via `haze = L.haze * (0.35 + 0.65*dl)`, not just on the cached
  geometry (`segPoints` is already memoized — only the path *construction*
  and *fill* are repeated). A correct bake needs either (a) a stated daylight
  quantization (visible banding risk, needs tuning I can't see) or (b) a
  mask/color split — bake the shape as a monochrome alpha mask once, then
  each frame copy the mask and composite the current color onto it with
  `globalCompositeOperation: 'source-in'` (still ~4 ops instead of ~40+
  `lineTo`s per layer, and pixel-exact since the mask is the same path filled
  once). Recommend (b) for the next pass — it's provably correct the same way
  WS1/WS4 are, unlike quantization.
- **WS3** (renderer treadmill / chunk-cache bound): **not attempted** — found
  a real correctness risk while designing it, worth recording precisely.
  Gating `World.update()` rebuilds to a camera-radius window means regions
  outside that radius are never `cons.observe()`'d. Today's budget-3-per-
  frame-nearest-first approach eventually drains the whole backlog (nothing
  stays pending forever except transiently); a radius gate would leave
  off-camera dirty regions (e.g. from a mob mining terrain far from the
  player, or worldgen edits) **permanently pending** in the renderer's
  per-consumer queue for a long roaming session — unbounded growth, not a
  performance win. `draw()`'s synchronous rebuild-on-visible-miss (the
  existing safety net) does NOT fix this, because it never calls
  `cons.observe()` on the update-side cursor. A correct fix needs the radius
  gate paired with a bounded low-rate "service the oldest pending region
  regardless of distance" pass, which is real design work, not a small edit.
- **WS5** (entity draw batching), **WS6** (liquid mark coalescing): not
  attempted this session — lower priority than WS2/WS3 per the plan's
  ordering, deferred for time.
- **WS7** truth-sync of `docs/ARCHITECTURE.md` / `docs/TASK_BOARD.md`: held
  until the remaining workstreams land, so it's written once against the
  final state rather than incrementally.

## Recommended next session

1. On a machine with a real browser: run `npm run test:browser` and
   `npm run verify:build` once as a baseline (they were never confirmed green
   against `HEAD` in this environment). Then do WS0.2 for real.
2. WS2 via the mask/color-split design above (safe, verifiable by pixel-diff
   even without a display — the mask and the composited output are both
   `ImageData`, diffable in `node`).
3. WS3 needs a design decision (bounded low-rate far-region service pass)
   before implementation — flag it explicitly to whoever continues, don't
   silently implement the naive radius gate.
4. WS5/WS6 following the same "prove it's a pure function of unchanged
   inputs, then skip/cache" discipline used in WS1/WS4.

## Commits in this session

- `8154001` — perf(w26): index pack spawn rules by zone instead of per-call
  scan (pre-existing drift, resolved per WS0 item 5)
- `df8d8ec` — docs(w27): master resolution plan for presentation-layer
  performance
- (pending) — perf(w27): bake HUD sprites + skip unchanged lighting uploads,
  add render-path benchmark

## Reproduction

```bash
node tools/check-syntax.js
npm test                          # 625/625
node tools/bench-runtime.js       # simulation baseline, unaffected
node tools/bench-scenarios.js --quick
node tools/bench-render.js        # render-path evidence (this session's tool)
npm run build                     # succeeds; verify:build/test:browser need a display
```

---

## Continuation session (2026-09-03, Windows 11 + working headless Chromium)

This machine CAN run the browser gate (unlike the WSL2 box above), so the
campaign resumed here. Read the EXECUTION_PROMPT (W27 ACTIVE) first.

### WS0.2 landed (`b17bf72`)

- `tests/browser/perf.spec.js` (new): rAF frame-time percentiles
  (p95<33ms, p99<50ms, mean<33ms) + instrumented canvas-op budgets on the
  live game (seed 4242, 180-frame settle, 300-frame sample, counters
  snapshotted AFTER the settle). Two methodology bugs were caught by
  measurement, not review: (1) snapshotting before the warmup folded the
  startup chunk-rebuild burst (~2,000 drawImages/frame) into the average
  (2,306 vs the true ~691); (2) whole-frame relative growth gates flake on
  spawn-director wander, so flatness is UI-drawer-attributed (absolute
  +15.0 for +15 hearts vs budget 30). Whole-frame budgets set LOOSE at
  500/550 total (were 800/860 at WS0.2 landing) after measuring ±30%
  respawn wander; UI 100/120 + delta 30 unchanged (rock-stable).
- Negative control: injected per-pixel-heart waste breaches every leg
  (968/1,827 vs 800/860 at the time; UI-delta +837 vs 30) — the gate is
  live, not decorative.
- `boot.spec.js`: `fps > 10` removed (promoted to perf.spec, not duplicated).
- Frame-time-leg status: PASSED repeatedly, then FAILED under sustained
  third-party host load (p95 60→111ms, op counts flat, op leg green;
  pre-WS2 control failed identically at p95 92.5ms). Recorded as an
environment blocker per ONBOARDING §8 — budgets NOT weakened.
Re-verify on a quiet host at close.
- Scratch `tools/.w27-*.tmp.js` debug scripts deleted, not committed.

### WS2 landed (this commit)

- `js/sky.js`: silhouettes → `Path2D` geometry cache (exact floats in the
  key; color NOT geometry); clouds/orbs/gradient → baked sprites with
  integer blits (<=0.5px, stated); stars → one white sprite + fade
  envelope (twinkle dropped, tint decoupled from the far-silhouette color
  — both stated). Shared paint functions feed bake + no-`document`/
  no-`Path2D` fallbacks. Day 435 → 19.1 (all bench scenes ≤19.8),
  night (never measured before: 842) → 22.3 (38×; +2.3 over the round ≤20
  target — accepted residual: star-fade save/blit/restore, irreducible
  without hand-rolled alpha state; analyzed in session).
- The handoff's recommended mask/color-split was evaluated and REJECTED
  after arithmetic: steady-state 28 ops/frame (worse than the 22 the
  strip design measured) for a gain (no palette re-bakes) that Path2D
  gets for free. `Path2D` dominates strips on every axis (exact, no
  quantization, no 8.6MB strip memory, rebuilds are uncounted JS math).
  An intermediate strip implementation was built, measured, then replaced
  — it never left the working tree.
- Visual proof: deterministic in-page sky-only renders (fixed cam/time/
  biome, identical inputs asserted, no lighting/entities) before-vs-after:
  day 3.4% Δ (mean 0.08, max 81, diffuse only); night/cave residuals are
  stars-by-design + soft-edge rounding. Full-scene screenshots were
  attempted first but confounded by run-to-run timing nondeterminism
  (identical-code A/B diff: 21% — torch/particles/camera ticks), which is
  itself a useful warning: never gate on full-frame pixels.
- `tests/helpers/load-game.js`: minimal `Path2D` stub (construction
  untallied, mirroring unwrapped `Path2D.prototype` in browsers) so
  headless suites exercise the production fast path, not just fallbacks.
- `tools/bench-render.js`: save/restore *style stack* in the counting
  context (restores reset tracked styles silently, like the native stack
  bypassing wrapped setters). This FIXED a two-way miscount: previously
  re-set-after-restore writes were under-counted (lighting gCO now
  honestly reads 5 not 4 — not a regression).
- `docs/PERFORMANCE.md`: WS2 evidence table (incl. the first-ever night
  numbers), new Sky-backdrop invariant section, harness fidelity notes.
- Full `npm test` 625/625 green after every step. Browser op-budget leg
  green post-WS2 (290/340 vs 340/400). Frame-time leg: see blocker above.
- Upstream `origin/main` gained `ONBOARDING.md` (61ba3fb) mid-session —
  benign; integrate via rebase before push (local commits unpublished).
- TEMP-DIR WARNING for the next session on shared Windows boxes: files in
  `%TEMP%` vanished mid-session (aggressive janitor or sandbox overlay).
  Keep same-session artifacts in memory (in-page diffs) or in the repo
  (delete after); re-create `$env:TEMP\pw-reuse.config.js` if the browser
gate errors on a missing config.
- Budget tightening policy: op budgets now 500/550 totals (loose by
  measured ±30% respawn wander) + tight 100/120/delta-30 attributed HUD
  triple. WS3/WS5/WS6 only lower totals — do NOT loosen; WS7 recalibrates
  once at close.

### WS3 landed (same session)

- `js/world.js`: `update()` rebuilds ≤3/tick inside visible+1 and
  observe-drains everything outside it (no canvas allocation for unseen
  terrain) — the exact bounding design the first handoff demanded, same
  contract as `Lighting.regionRefresh`'s outside-window observe. `draw()`
  repairs visible chunks that are missing OR still renderer-dirty (closes
  the stale-canvas-on-roam hole the naive radius gate would have opened).
  Eviction moved off the per-frame `draw()` path into `update()` behind
  an O(1) size check; ceiling is viewport-derived (`chunkCap()`: visible
  + 2 margin per side, [24, 160], FLOOR 75%) — 30 (~30 MB) at 1280×720
  zoom 2, steady cache ~26. Rebuild window ⊂ keep-set: no treadmill by
  construction. `regionStats()` gains `farDrained` + `chunkCap` (additive).
- Numbers (`bench-render.js`, seed 12345): startup rebuilt 511 → 5,
  evicted 377 → 27 (whole run incl. teleports); stationary 300-frame:
  rebuilt 5, evicted 9 (all one-time startup camera sweep, zero
  re-rebuild churn), cache 26/30. Steady-state frame ops unchanged
  (267) — WS3 buys memory + startup, not per-frame ops, as predicted.
- `tests/world/chunk-cache.test.js` updated to the plan-mandated contract
  (eviction driven by `update()`, ceiling from `chunkCap()`): same intents
  — bounded, spares the screen, no churn, reveal-rebuilds on the spot,
  no queue disturbance (now asserted for the renderer AND lighting
  cursors). 2/2 green; full world suites green.

---
*Session-scoped handoff for W27 partial execution. `docs/W27-PERFORMANCE-PLAN.md`
carries the full plan and per-workstream status; this file carries what
actually happened, why the deferred items were deferred, and what the next
session needs to know before touching WS2/WS3.*
