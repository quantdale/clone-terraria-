/* tests/browser/boot.spec.js — Phase 4: zero-console-error boot gate.
   Launches the real game in Chromium and proves: all scripts load, the title
   screen renders, multiple frames render through the real rAF loop, and
   neither console.error nor an uncaught exception ever fires. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

test.describe("boot gate", () => {
  test("title screen boots clean: every script loads, no console/page errors", async ({
    page,
  }) => {
    const errors = await H.openGame(page);

    // real DOM: exactly one game canvas, sized to the viewport
    const canvasInfo = await page.evaluate(() => {
      const c = document.getElementById("game");
      return { w: c.width, h: c.height, has2d: !!c.getContext("2d") };
    });
    expect(canvasInfo.has2d).toBe(true);
    expect(canvasInfo.w).toBeGreaterThan(0);
    expect(canvasInfo.h).toBeGreaterThan(0);

    // title screen is up and every module attached its public API
    expect(await page.evaluate(() => window.TC.state)).toBe("title");
    const api = await page.evaluate(() => ({
      worldgen: !!(window.TC.WorldGen && window.TC.WorldGen.generate),
      save: !!window.TC.Save,
      player: !!window.TC.Player,
      ui: !!window.TC.UI,
      enemies: !!window.TC.Enemies,
      registry: !!window.TC.Registry,
      savecore: !!window.TC.SaveCore,
      systems: !!window.TC.Systems,
      liquids: !!window.TC.Liquids,
      wiring: !!window.TC.Wiring,
      fishing: !!window.TC.Fishing,
      magic: !!window.TC.Magic,
      accessories: !!window.TC.Accessories,
    }));
    for (const [k, v] of Object.entries(api)) {
      expect(v, "module API missing: TC." + k).toBe(true);
    }

    // exercise many real frames through the live rAF loop
    await H.runFrames(page, 120);
    expect(await page.evaluate(() => window.TC.fps)).toBeGreaterThan(10);

    H.assertNoErrors(errors, "boot");
  });

  test("registry validates cleanly after FULL script load (wiring included)", async ({
    page,
  }) => {
    const errors = await H.openGame(page);
    const reg = await page.evaluate(() => {
      try {
        window.TC.Registry.validate();
        let count = 0;
        for (const k of window.TC.Registry.KINDS)
          count += window.TC.Registry.count(k);
        return {
          ok: true,
          fingerprint: window.TC.Registry.fingerprint(),
          count: count,
        };
      } catch (e) {
        return { ok: false, error: String(e.message) };
      }
    });
    expect(
      reg.ok,
      "post-boot Registry.validate() must pass: " + (reg.error || ""),
    ).toBe(true);
    expect(reg.count).toBeGreaterThan(100);
    H.assertNoErrors(errors, "boot/registry");
  });

  test("no duplicate system / render-layer / save-provider registrations at boot", async ({
    page,
  }) => {
    const errors = await H.openGame(page);
    const dupes = await page.evaluate(() => {
      const out = { systems: [], layers: [] };
      const countBy = (arr) => {
        const m = new Map();
        for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
        return [...m.entries()].filter(([, n]) => n > 1).map(([k]) => k);
      };
      if (window.TC.Systems && window.TC.Systems.list) {
        out.systems = countBy(
          window.TC.Systems.list().map((e) => e.phase + ":" + e.name),
        );
      }
      if (window.TC.RenderLayers && window.TC.RenderLayers.list) {
        out.layers = countBy(
          window.TC.RenderLayers.list().map((l) =>
            l.layer == null ? l.name : l.layer + ":" + l.name,
          ),
        );
      }
      return out;
    });
    expect(dupes.systems).toEqual([]);
    expect(dupes.layers).toEqual([]);
    H.assertNoErrors(errors, "boot/dupes");
  });

  test("new world via __TEST__ hook renders animated frames with zero errors", async ({
    page,
  }) => {
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 424242, 60);
    const st = await H.gameState(page);
    expect(st.hasWorld).toBe(true);
    expect(st.hasPlayer).toBe(true);
    expect(st.hp).toBeGreaterThan(0);
    await H.runFrames(page, 60);
    const anim = await H.canvasIsAnimating(page);
    expect(
      anim.framesAdvanced,
      "draw loop must keep executing frames",
    ).toBeGreaterThan(3);
    expect(
      anim.distinctColors,
      "framebuffer must hold varied content, not blank",
    ).toBeGreaterThan(4);
    H.assertNoErrors(errors, "boot/newWorld");
  });
});
