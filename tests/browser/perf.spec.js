/* tests/browser/perf.spec.js — WS0.2 real-browser performance gate (W27).
   Two independent measurements, each on its own page:

   1. FRAME-TIME PERCENTILES — un-instrumented page, real rAF cadence over a
      settled idle scene. Budget is generous (30fps floor) and exists to catch
      catastrophic raster stalls, not small regressions: at idle the loop is
      vsync-bound (~16.7ms) on healthy hosts, so wall-clock cannot
      discriminate fine-grained cost (see docs/W27-PERFORMANCE-PLAN.md §4).
      This PROMOTES the old `fps > 10` liveness check from boot.spec.js — do
      not re-add a second fps assertion there.

   2. CANVAS-OP BUDGET — a page instrumented BEFORE boot (CanvasRenderingContext2D
      prototype wrapped by an init script) counts every context call per frame.
      This is the hardware-independent currency used by tools/bench-render.js,
      measured here against the REAL game in the REAL browser. Reference
      machine: Windows 11 x64, headless Chromium software raster
      (Playwright 1.62.1 / Chromium 151.0.7922.34), 1280x720 viewport.
      W27 settled baseline (seed 4242, cleared enemies, 180-frame settle,
      300-frame sample), after the WS1+WS2 bakes (was 691/728 before WS2):
        total ops/frame ~280 @100hp / ~310-410 @400hp;
        UI-attributed 75 / 90 (rock-stable across runs).
      Whole-frame totals wander ±30% run to run (respawn composition during
      the window) while attributed HUD numbers repeat to the decimal — so
      the TOTAL budgets below are deliberately loose (they catch every prior
      render-path stage: pre-W27 1,229/2,900, pre-WS2 691/728, injected
      per-pixel hearts 968/1,827) and the TIGHT gate is the attributed HUD
      triple.
      Budgets below are baseline + headroom. A breach means the render path
      grew — investigate before shipping. Recalibrate deliberately (update
      this file + docs), never by relaxing a failing gate.

      The max-HP flatness check is UI-drawer-attributed (absolute delta), not
      a relative whole-frame ratio: the spawn director keeps spawning during
      sampling, so whole-frame totals carry wander that a tight relative
      gate would flake on. The attributed gate is strictly more sensitive to
      the actual §3.1 regression — per-pixel heart rendering would add ~55
      ops/heart (~+825 at 400 HP) against a delta budget of 30, while the
      baked row costs exactly 1 drawImage per extra heart (measured +15.0).

   Scene: deterministic world (seed 4242), player idle at spawn, 180-frame
   settle so chunk rebuilds and camera easing are done before sampling.
   Counters are snapshotted AFTER the settle (an earlier draft snapshotted
   before it and folded the startup rebuild burst into the average). */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

const SEED = 4242;
const WARMUP_FRAMES = 180;
const SAMPLE_FRAMES = 300;

// Settle the scene, then collect SAMPLE_FRAMES rAF deltas.
async function frameDeltas(page) {
  return page.evaluate(
    ([warm, n]) =>
      new Promise((resolve) => {
        let left = warm;
        const deltas = [];
        let last = performance.now();
        (function tick() {
          const now = performance.now();
          if (left <= 0) deltas.push(now - last);
          last = now;
          if (deltas.length >= n) return resolve(deltas);
          left--;
          requestAnimationFrame(tick);
        })();
      }),
    [WARMUP_FRAMES, SAMPLE_FRAMES],
  );
}

function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

test.describe("W27 performance gate", () => {
  test("idle scene frame-time percentiles meet the W27 budget", async ({
    page,
  }) => {
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, SEED, 0);

    const deltas = await frameDeltas(page);
    const sorted = deltas.slice().sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const p99 = percentile(sorted, 0.99);
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;

    // 30fps floor at idle. Healthy hosts are vsync-bound (~16.7ms); this
    // only fires when the render path stalls the compositor outright.
    expect(p95, `p95 frame time ${p95.toFixed(1)}ms must stay under 33ms`).toBeLessThan(33);
    expect(p99, `p99 frame time ${p99.toFixed(1)}ms must stay under 50ms`).toBeLessThan(50);
    expect(mean, `mean frame time ${mean.toFixed(1)}ms must stay under 33ms`).toBeLessThan(33);

    H.assertNoErrors(errors, "perf frame-time");
  });

  test("idle scene canvas-op budget (instrumented, machine-independent)", async ({
    page,
  }) => {
    // Wrap the 2D context prototype BEFORE any game script runs, so every
    // context call the game makes is counted. Mirrors the counting rules of
    // tools/bench-render.js: context methods + changed-value style writes.
    await page.addInitScript(() => {
      window.__ops = { total: 0, byOp: {} };
      const HEAVY = new Set([
        "fillRect", "drawImage", "fill", "stroke", "fillText", "strokeText",
        "putImageData", "getImageData", "clearRect", "strokeRect",
      ]);
      const COUNTED = [
        "fillRect", "strokeRect", "clearRect", "drawImage", "fill", "stroke",
        "fillText", "strokeText", "beginPath", "closePath", "moveTo", "lineTo",
        "arc", "ellipse", "quadraticCurveTo", "bezierCurveTo", "rect", "clip",
        "save", "restore", "translate", "scale", "rotate", "setTransform",
        "putImageData", "getImageData", "createLinearGradient",
        "createRadialGradient", "createPattern",
      ];
      const P = CanvasRenderingContext2D.prototype;
      const o = window.__ops;
      for (const m of COUNTED) {
        const orig = P[m];
        if (typeof orig !== "function") continue;
        P[m] = function (...a) {
          o.total++;
          o.byOp[m] = (o.byOp[m] || 0) + 1;
          if (HEAVY.has(m)) o.heavy = (o.heavy || 0) + 1;
          return orig.apply(this, a);
        };
      }
      for (const s of ["fillStyle", "strokeStyle", "globalAlpha", "globalCompositeOperation"]) {
        const d = Object.getOwnPropertyDescriptor(P, s);
        Object.defineProperty(P, s, {
          get() { return d.get.call(this); },
          set(nv) {
            if (d.get.call(this) !== nv) {
              o.total++;
              o.byOp["set:" + s] = (o.byOp["set:" + s] || 0) + 1;
            }
            d.set.call(this, nv);
          },
          configurable: true,
        });
      }
    });

    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, SEED, 0);

    // Attribute HUD cost precisely: wrap UI.draw to charge only the ops it
    // issues. The wrapper is pure JS bookkeeping — it adds no canvas ops.
    await page.evaluate(() => {
      window.__uiOps = 0;
      window.__uiCount = true;
      const ui = window.TC.UI;
      const orig = ui.draw.bind(ui);
      ui.draw = function (ctx, w, h) {
        const t0 = window.__ops.total;
        try {
          return orig(ctx, w, h);
        } finally {
          if (window.__uiCount) window.__uiOps += window.__ops.total - t0;
        }
      };
    });

    // Sample op deltas across two windows: 100 max HP, then 400 max HP
    // (life crystals — the real mechanism), same settled idle scene.
    // Two-phase: clear spawned enemies (the director accumulates them over
    // game time, so the later window would otherwise measure a bigger crowd
    // than the earlier one), settle `warm` frames (chunk-rebuild backlog
    // drain + camera easing), snapshot the counters, then average over `n`
    // frames. Respawn during the window is the residual wander (see below).
    async function opWindow() {
      await page.evaluate(() => {
        if (window.TC.Enemies && window.TC.Enemies.clear) window.TC.Enemies.clear();
      });
      return page.evaluate(
        ([warm, n]) =>
          new Promise((resolve) => {
            let left = warm;
            (function settle() {
              if (left-- <= 0) {
                const t0 = window.__ops.total;
                const h0 = window.__ops.heavy || 0;
                const u0 = window.__uiOps;
                let frames = 0;
                (function tick() {
                  if (++frames >= n) {
                    resolve({
                      total: (window.__ops.total - t0) / n,
                      heavy: ((window.__ops.heavy || 0) - h0) / n,
                      ui: (window.__uiOps - u0) / n,
                      foes: window.TC.Enemies ? window.TC.Enemies.list.length : -1,
                    });
                    return;
                  }
                  requestAnimationFrame(tick);
                })();
                return;
              }
              requestAnimationFrame(settle);
            })();
          }),
        [WARMUP_FRAMES, SAMPLE_FRAMES],
      );
    }

    const at100 = await opWindow();
    await page.evaluate(() => { window.TC.player.lifeCrystals = 15; });
    const at400 = await opWindow();

    // Whole-frame budgets: loose by design (see header). Later workstreams
    // only lower totals; WS7 recalibrates once at close.
    expect(at100.total, `idle-100hp ops/frame ${at100.total.toFixed(0)} must stay under 500`).toBeLessThan(500);
    expect(at400.total, `idle-400hp ops/frame ${at400.total.toFixed(0)} must stay under 550`).toBeLessThan(550);

    // HUD budgets (baseline UI-attributed 75 @100hp / 90 @400hp).
    expect(at100.ui, `UI-attributed ops/frame @100hp ${at100.ui.toFixed(1)} must stay under 100`).toBeLessThan(100);
    expect(at400.ui, `UI-attributed ops/frame @400hp ${at400.ui.toFixed(1)} must stay under 120`).toBeLessThan(120);

    // Max-HP flatness on the HUD itself: baked hearts cost 1 drawImage each
    // (measured +15.0 for +15 hearts). Per-pixel hearts would add ~+825.
    const uiDelta = at400.ui - at100.ui;
    expect(
      uiDelta,
      `UI-attributed growth 100hp->400hp ${uiDelta.toFixed(1)} must stay within 30 ops`,
    ).toBeLessThan(30);

    H.assertNoErrors(errors, "perf op budget");
  });
});
