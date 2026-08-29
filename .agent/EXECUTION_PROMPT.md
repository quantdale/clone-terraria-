# W27 — Presentation Performance Recovery

**Status:** ACTIVE
**Planned-From:** `ca39da303e34e2eef1f6774dadbafe26df68b3c7`
**Planned-At:** 2026-08-29
**Execution-Started:** 2026-08-29
**Target-Branch:** `main`
**Campaign-Type:** performance investigation + render-path optimization + measurement-gate construction
**Execution entrypoint:** repository-native `goal` continuation (`/goal continue`, `continue`, or equivalent supported by the active harness)
**Full plan:** `docs/W27-PERFORMANCE-PLAN.md` (mission, evidence, findings, workstreams WS0–WS7, acceptance criteria — read this in full before continuing)
**Session handoff:** `docs/HANDOFF-W27-performance.md` (what actually landed, what was deferred and why, recommended next steps — read this too, it has the load-bearing detail)

**Prior campaign:** W26 (Pack Ecosystem Productionization) is `COMPLETED` —
see `docs/HANDOFF-W26-pack-ecosystem-productionization.md`. Do not redo W26
scope. This file previously carried the W26 prompt in full; that history is
preserved in `docs/HANDOFF-W26-pack-ecosystem-productionization.md` and
`docs/W26-AUDIT.md`, not duplicated here.

## Mission (condensed — full version in the plan doc)

The simulation is healthy (`bench-runtime`/`bench-scenarios` show sub-ms
ticks). Every existing perf tool measures it through a no-op stub Canvas 2D
context, so the presentation layer has never been measured and never been
optimized. On an idle scene the HUD health bar and sky parallax alone
accounted for ~85% of per-frame canvas operations, with the health bar
scaling linearly (and badly) with max HP. Fix the render path — without
changing any gameplay behavior, determinism, save format, protocol identity,
or visual output — behind a real measurement gate so this can't silently
regress again.

## Current truth (2026-08-29, end of first execution session)

- **Landed and verified** (full detail + evidence in the handoff):
  - `tools/bench-render.js` — hardware-independent canvas-operation counter,
    the WS0.1 measurement gate. **WS0.2 (real-browser frame-time journey) is
    still open** — this execution environment cannot run a browser at all
    (`requestAnimationFrame` never fires, Canvas 2D raster hangs; confirmed
    independent of any game code). Do WS0.2 first on a machine with a working
    display before further render-path work.
  - WS1 (HUD sprite baking, `js/ui.js`): `UI.draw` 612→67 ops/frame @ 100
    max HP, 2,262→82 @ 400 max HP (3.70x→1.22x scaling ratio). Safe by
    construction — same draw calls, cached and blitted at integer
    coordinates, no new visual quantization. WS1.3–1.4 (layout memoization,
    composed HUD strip) not done — smaller win, deferred.
  - WS4 (lighting skip-unchanged, `js/lighting.js`): `putImageData`
    (GPU texture upload) 1/frame → 0/frame on a static scene.
  - `js/enemyspawn.js` pre-existing uncommitted drift (a W26-era pack
    spawn-rule zone index) resolved: tested, committed separately.
- **Explicitly deferred, with reasons already investigated** (do not
  re-derive — read `docs/HANDOFF-W27-performance.md` first):
  - **WS2** (sky baking): naive baking is wrong because fill color depends
    continuously on daylight, not just cached geometry. A mask/color-split
    design was identified as the correct approach — not yet implemented.
  - **WS3** (renderer treadmill): a real correctness risk was found while
    designing the naive fix (radius-gating `World.update()` leaves far
    off-camera dirty regions permanently unobserved — unbounded queue
    growth, not a win). Needs a bounded low-rate service-pass design before
    implementation.
  - **WS5** (entity draw batching), **WS6** (liquid mark coalescing): not
    started, lower priority per plan ordering.
  - **WS7** truth-sync of `docs/ARCHITECTURE.md`/`docs/TASK_BOARD.md`: held
    until remaining workstreams land.
- Full `npm test` was 625/625 green after each landed change. `npm run build`
  succeeds standalone. `npm run verify:build` / `npm run test:browser` could
  not be run in this environment (both boot a real browser) — **must be run
  on a machine with a display before this campaign can be marked
  `COMPLETED`.**

## Resuming this campaign

1. Read `docs/W27-PERFORMANCE-PLAN.md` in full (mission, §3 findings, §5
   preserved-behavior invariants, §6 per-workstream detail and status, §7
   acceptance criteria) and `docs/HANDOFF-W27-performance.md` (what happened,
   why deferred items were deferred, recommended next steps — this has
   design guidance for WS2/WS3 that took real investigation to produce; use
   it instead of re-investigating from scratch).
2. If on a machine with a real browser: run `npm run test:browser` and
   `npm run verify:build` once as a baseline against current `HEAD` (neither
   has been confirmed green in this repository since before this campaign
   started, only via the pre-existing W25/W26 handoffs' historical record).
   Then implement WS0.2 (the real frame-time journey) — this is the actual
   point of WS0 and should happen before further optimization work compounds
   without a real gate behind it.
3. Continue with WS2 (mask/color-split design, see handoff), then WS3 (needs
   a bounded far-region service-pass design first — do not implement the
   naive radius gate), then WS5/WS6, then WS7 truth-sync.
4. Mark `COMPLETED` only when the acceptance criteria in the plan's §7 all
   pass, including the real-browser gate — a green Node-only gate is
   explicitly **not** sufficient per the plan's own risk table.

## Non-negotiable preserved behavior

Unchanged from the plan (§5): zero gameplay change, determinism intact
(`TC.GameRng` stream order/count, world-byte digests), visual parity (any
quantization stated and justified), `TC.RenderLayers` remains the sole draw
authority, `TC.WorldRegions` multi-consumer invariant (no consumer steals
another's invalidation, no re-marking on eviction), `draw()` still repairs
visible holes synchronously (no proactive rebuild queue — documented
treadmill), no second update loop, save/protocol/pack identity untouched,
localization stays presentation-only, boot order is a contract, no failure
masking, no Critical/High regressions, no destructive Git behavior
(no force-push, `main`-only, never rewrite history).

## Git / agent operating rules

Same as prior campaigns: prefer several coherent, well-described commits over
one opaque commit. Commit messages should be reconstructable session
history. Push validated progress; never force-push. Update
`docs/HANDOFF-W27-performance.md` after each material milestone so a killed
session can resume without rediscovery.
