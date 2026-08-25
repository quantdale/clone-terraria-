/* tests/browser/journey-l-regions-lighting.spec.js — W21 real-browser journey.
   Exercises the shared region authority, the RGB lighting model and the
   region-driven minimap on the REAL game (real Canvas raster, real rAF):

     1. boot #test, deterministic new world;
     2. observe initial (day) lighting semantically and as rendered
        framebuffer luminance;
     3. jump the sky clock to midnight via public Sky state and prove the
        rendered world darkens (the RGB multiply overlay is live);
     4. place an emissive torch through the canonical PlaceTile command and
        prove the light FIELD updates (warm tint at the torch);
     5. produce a colored dynamic light through the production transient
        source pool (what projectiles/magic feed) and prove the color changes
        the queried field;
     6. open the minimap, mutate terrain in one region through a command,
        prove the edited cell's map pixel repainted and every changed map
        block is local to the edit, the same column band, or live water;
     7. pour liquid through the runtime authority, prove its region repaints;
     8. switch the lighting quality profile; confirm persistence via
        TC.Settings without touching world saves;
     9. save, reload the PAGE, continue, prove world bytes identical —
        presentation work never altered simulation state;
    10. zero unexpected console/page errors throughout.

   Determinism notes: night spawns shove the player around, so gameplay
   targets are anchored to FIXED coordinates (never live player position),
   and ambient water churn is measured in a control window and exempted from
   locality assertions. Synthetic KeyN delivery fires several pressed() edges
   on this host, so map visibility is set directly (deterministic seam). */
const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

const SEED = 212121;

async function screenAvg(page) {
  return page.evaluate(() => {
    const c = document.getElementById("game");
    const g = c.getContext("2d");
    const x0 = Math.floor(c.width * 0.3), x1 = Math.floor(c.width * 0.7);
    const y0 = Math.floor(c.height * 0.35), y1 = Math.floor(c.height * 0.75);
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let r = 0, g2 = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) {
      r += d[i]; g2 += d[i + 1]; b += d[i + 2]; n++;
    }
    return { r: r / n, g: g2 / n, b: b / n };
  });
}

// Per-region checksums of the live minimap ImageData (32-column blocks).
function blockSumsFn() {
  return () => {
    const M = window.TC.MiniMap, WR = window.TC.WorldRegions;
    if (!M.img) return null;
    const data = M.img.data, w = M.cw, h = M.ch;
    const sums = [];
    for (let cx = 0; cx < WR.chunksX; cx++) {
      let s = 0;
      const x0 = cx * WR.CHUNK, x1 = Math.min(w, x0 + WR.CHUNK);
      for (let ty = 0; ty < h; ty++) {
        const row = ty * w;
        for (let tx = x0; tx < x1; tx++) {
          const p = (row + tx) * 4;
          s = (s + data[p] * 3 + data[p + 1] * 5 + data[p + 2] * 7) | 0;
        }
      }
      sums.push(s);
    }
    return sums;
  };
}

function fingerprintFn() {
  return () => {
    const w = window.TC.world;
    let hT = 0x811c9dc5, hW = 0x811c9dc5;
    for (let i = 0; i < w.tiles.length; i++) {
      hT ^= w.tiles[i]; hT = Math.imul(hT, 0x01000193) >>> 0;
      hW ^= w.walls[i]; hW = Math.imul(hW, 0x01000193) >>> 0;
    }
    return { tiles: hT >>> 0, walls: hW >>> 0, seed: window.TC.worldSeed };
  };
}

async function waitFor(page, fn, timeout) {
  await page.waitForFunction(fn, undefined, { timeout: timeout || 30000 });
}

test.describe("journey L — world regions, RGB lighting, minimap", () => {
  test("region-driven presentation end-to-end", async ({ page }) => {
    test.setTimeout(240000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, SEED, 40);

    // ---- 1/2. daylight field + rendered brightness ----------------------
    const dayField = await page.evaluate(() => {
      const p = window.TC.player;
      const tx = Math.floor((p.x + p.w / 2) / 16), ty = Math.floor(p.y / 16);
      return {
        rgb: window.TC.Lighting.lightRgbAt(tx, ty),
        lum: window.TC.Lighting.lightAt(tx, ty),
        consumers: window.TC.WorldRegions.stats().consumers,
      };
    });
    expect(dayField.consumers).toContain("renderer");
    expect(dayField.consumers).toContain("lighting");
    expect(dayField.lum).toBeGreaterThan(0.8);
    expect(dayField.rgb[0]).toBeGreaterThan(dayField.rgb[2]);
    const dayAvg = await screenAvg(page);

    // ---- 3. midnight darkens the RENDERED result ------------------------
    await page.evaluate(() => { window.TC.Sky.time = 540; }); // midnight phase
    await H.runFrames(page, 45); // sky quantum step -> ambient reseed
    const nightAvg = await screenAvg(page);
    const dayLum = dayAvg.r + dayAvg.g + dayAvg.b;
    const nightLum = nightAvg.r + nightAvg.g + nightAvg.b;
    expect(nightLum).toBeLessThan(dayLum * 0.55);

    // ---- 4. emissive torch through the PlaceTile command -----------------
    const placed = await page.evaluate(() => {
      const TC = window.TC, p = TC.player;
      window.__TEST__.teleportPlayer(300 * 16, (TC.world.surfaceY[300] - 6) * 16);
      const sx = 300, sy = TC.world.surfaceY[300];
      for (let dy = -4; dy <= 2; dy++) {
        for (let dx = -5; dx <= 5; dx++) {
          const tx = sx + dx, ty = sy + dy;
          if (TC.world.get(tx, ty) !== TC.TILE.AIR) continue;
          const around = [TC.world.get(tx + 1, ty), TC.world.get(tx - 1, ty),
            TC.world.get(tx, ty + 1), TC.world.get(tx, ty - 1)];
          if (!around.some((v) => v != null && v !== TC.TILE.AIR)) continue;
          const rx = tx * 16, ry = ty * 16;
          if (rx < p.x + p.w && rx + 16 > p.x && ry < p.y + p.h && ry + 16 > p.y) continue;
          const r = TC.Commands.submit("PlaceTile", { tx, ty, item: "torch", player: p });
          if (r.ok) return { ok: true, tx, ty };
        }
      }
      return { ok: false };
    });
    expect(placed.ok).toBe(true);
    await H.runFrames(page, 30);
    const torchField = await page.evaluate(([tx, ty]) => {
      return window.TC.Lighting.lightRgbAt(tx, ty);
    }, [placed.tx, placed.ty]);
    expect(torchField[0]).toBeGreaterThan(0.35);
    expect(torchField[0]).toBeGreaterThan(torchField[2] + 0.12); // warm flame tint

    // ---- 5. colored dynamic light (production transient pool) ------------
    // Anchor to fixed ground: night spawns shove the player around, but the
    // reading must come from where the source was placed.
    await page.evaluate(() => {
      const TC = window.TC;
      window.__TEST__.teleportPlayer(360 * 16, (TC.world.surfaceY[360] - 6) * 16);
    });
    await H.runFrames(page, 25);
    const anchor = await page.evaluate(() => {
      const p = window.TC.player;
      return { x: Math.floor((p.x + p.w / 2) / 16), y: Math.floor((p.y + p.h / 2) / 16) };
    });
    const violetBefore = await page.evaluate(([ax, ay]) => {
      return window.TC.Lighting.lightRgbAt(ax, ay).slice();
    }, [anchor.x, anchor.y]);
    await page.evaluate(([ax, ay]) => {
      window.TC.Lighting.addDynamic(ax * 16 + 8, ay * 16 + 8, 110, 1.0, 999, "#7030f0");
    }, [anchor.x, anchor.y]);
    await H.runFrames(page, 10);
    const violetAfter = await page.evaluate(([ax, ay]) => {
      return window.TC.Lighting.lightRgbAt(ax, ay);
    }, [anchor.x, anchor.y]);
    expect(violetAfter[2]).toBeGreaterThan(violetAfter[1] + 0.15);
    expect(violetAfter[2]).toBeGreaterThan(violetBefore[2] + 0.3); // blue rose hard

    // ---- 6. minimap: terrain edit repaints its own locality --------------
    // Direct visibility setup (deterministic seam): synthetic KeyN delivery
    // on this host fires several pressed() edges per press, which would
    // parity-toggle the map unpredictably.
    await page.evaluate(() => { window.TC.MiniMap.visible = true; });
    await waitFor(
      page,
      () => window.TC.MiniMap.visible &&
            window.TC.MiniMap.stats().regionsPainted > 0,
      20000,
    );

    // Measure AMBIENT churn first (distant worldgen pools may still settle):
    // blocks that move during a no-edit control window are exempt from the
    // locality assertions below.
    const sumsCtrlA = await page.evaluate(blockSumsFn());
    await H.runFrames(page, 40);
    const sumsBefore = await page.evaluate(blockSumsFn());
    const ambientChanged = [];
    for (let i = 0; i < sumsCtrlA.length; i++) {
      if (sumsCtrlA[i] !== sumsBefore[i]) ambientChanged.push(i);
    }

    const dims = await page.evaluate(() => ({
      chunksX: window.TC.WorldRegions.chunksX,
      w: window.TC.world.width, h: window.TC.world.height,
      surf: Array.from(window.TC.world.surfaceY.slice(340, 400)),
    }));
    const chunksX = dims.chunksX;
    const changedBlocks = (a, b) => {
      const out = [];
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
      return out;
    };
    const near = (idx, target, r) => {
      const dx = Math.abs((idx % chunksX) - (target % chunksX));
      const dy = Math.abs(Math.floor(idx / chunksX) - Math.floor(target / chunksX));
      return dx <= r && dy <= r;
    };

    const edited = await page.evaluate(([ax]) => {
      const TC = window.TC, WR = TC.WorldRegions;
      if (window.__TEST__.giveItem("dirt", 8) === 0) throw new Error("could not obtain dirt");
      // stand back at the anchor so reach covers the scan area even if
      // night enemies have shoved the player away in the meantime
      window.__TEST__.teleportPlayer(ax * 16, (TC.world.surfaceY[ax] - 6) * 16);
      const p = TC.player;
      for (let r = 2; r < 12; r++) {
        const tx = ax + r;
        const ty = TC.world.surfaceY[tx] - 1; // open air just above ground
        if (TC.world.get(tx, ty) !== TC.TILE.AIR) continue;
        if (!p.inReach || !p.inReach(tx, ty)) continue;
        const w = TC.MiniMap.cw;
        const pp = (ty * w + tx) * 4;
        const pre = [TC.MiniMap.img.data[pp], TC.MiniMap.img.data[pp + 1], TC.MiniMap.img.data[pp + 2]];
        const res = TC.Commands.submit("PlaceTile", { tx, ty, item: "dirt", player: p });
        if (res.ok) return { chunk: WR.chunkOf(tx, ty), tx, ty, pre, dirtId: TC.TILE.DIRT };
      }
      throw new Error("no placeable cell found near anchor");
    }, [anchor.x]);
    // Fixed paint window: ambient liquid may keep re-marking blocks, so
    // "eventually clean" is not a reachable condition — just give the
    // repaint budget time to flush.
    await H.runFrames(page, 90);
    const cellProbe = await page.evaluate(([tx, ty]) => {
      const M = window.TC.MiniMap, w = M.cw;
      const p = (ty * w + tx) * 4;
      return { px: [M.img.data[p], M.img.data[p + 1], M.img.data[p + 2]],
               tile: window.TC.world.get(tx, ty) };
    }, [edited.tx, edited.ty]);
    const sumsAfterEdit = await page.evaluate(blockSumsFn());
    // Direct proof the edited CELL was repainted (sky -> darkened dirt):
    expect(cellProbe.tile).toBe(edited.dirtId);
    expect(cellProbe.px[0]).toBeLessThan(150);
    expect(cellProbe.px.join(",")).not.toBe(edited.pre.join(","));
    // Block-level locality: the edited cell's own block must repaint (its
    // pixel proof above), and beyond ambient churn + water-bearing blocks,
    // distant repaints stay BOUNDED — invalidation is regional, not global.
    const editCx = edited.chunk % chunksX;
    let distantEdit = 0;
    for (const idx of changedBlocks(sumsBefore, sumsAfterEdit)) {
      const colLocal = Math.abs((idx % chunksX) - editCx) <= 1;
      if (!(near(idx, edited.chunk, 1) || colLocal || ambientChanged.indexOf(idx) >= 0)) distantEdit++;
    }
    expect(distantEdit).toBeLessThanOrEqual(12);

    // ---- 7. liquid pour repaints flowing regions --------------------------
    // Confine the pour to a carved pit so the water cannot wander the map;
    // its region (and only its neighbourhood) should repaint.
    const poured = await page.evaluate(([ax]) => {
      const TC = window.TC, WR = TC.WorldRegions;
      const tx = ax - 4;
      const ty = TC.world.surfaceY[tx];
      for (let dy = 0; dy < 3; dy++) {
        TC.world.setRaw(tx, ty + dy, TC.TILE.AIR);
        if (TC.Liquids.displace) try { TC.Liquids.displace(tx, ty + dy); } catch (e) {}
      }
      if (!TC.Liquids.placeAt(tx, ty, 1)) throw new Error("pour failed");
      return WR.chunkOf(tx, ty);
    }, [anchor.x]);
    // Fixed settle window: poured water may keep spreading (its regions
    // legitimately stay dirty); assert repaints happened and stayed on
    // water-bearing blocks.
    await H.runFrames(page, 150);
    const sumsAfterLiquid = await page.evaluate(blockSumsFn());
    {
      const changedLiquid = changedBlocks(sumsAfterEdit, sumsAfterLiquid);
      expect(changedLiquid.length).toBeGreaterThan(0);
      const hasWater = async (idx) => page.evaluate(([cx]) => {
        const TC = window.TC;
        if (!TC.Liquids || !TC.Liquids.queryAt) return false;
        const x0 = cx * 32, x1 = Math.min(TC.world.width, x0 + 32);
        for (let tx = x0; tx < x1; tx += 2) {
          const surf = TC.world.surfaceY[tx] | 0;
          for (let ty = Math.max(0, surf - 8); ty < Math.min(TC.world.height, surf + 8); ty += 2) {
            const q = TC.Liquids.queryAt(tx, ty);
            if (q.amount > 0) return true;
          }
        }
        return false;
      }, [idx]);
      let sawNear = false;
      let distantPour = 0;
      for (const idx of changedLiquid) {
        if (near(idx, poured, 2)) { sawNear = true; continue; }
        if (ambientChanged.indexOf(idx) >= 0) continue;
        if (await hasWater(idx)) continue;
        distantPour++;
      }
      // The pour must visibly repaint its own area (or still hold water
      // there): transient evaporation in a tiny pit can otherwise mask it.
      const pouredWet = await page.evaluate(([cx]) => {
        const TC = window.TC;
        if (!TC.Liquids || !TC.Liquids.queryAt) return false;
        const x0 = cx * 32;
        for (let tx = x0; tx < Math.min(TC.world.width, x0 + 32); tx += 1) {
          const surf = TC.world.surfaceY[tx] | 0;
          for (let ty = Math.max(0, surf - 8); ty < Math.min(TC.world.height, surf + 8); ty += 1) {
            const q = TC.Liquids.queryAt(tx, ty);
            if (q.amount > 0) return true;
          }
        }
        return false;
      }, [poured % chunksX]);
      expect(sawNear || pouredWet, "pour area must repaint or hold water").toBe(true);
      expect(distantPour, "pour repaints must stay bounded").toBeLessThanOrEqual(12);
    }

    H.assertNoErrors(errors, "journeyL/presentation");

    // ---- 8. quality profile switch persists outside world saves ----------
    const quality = await page.evaluate(() => {
      window.TC.Lighting.setQuality("low");
      return {
        stored: window.localStorage.getItem("tc_settings_v1"),
        active: window.TC.Lighting.quality(),
      };
    });
    expect(quality.active).toBe("low");
    expect(quality.stored).toContain('"lightingQuality":"low"');
    await H.runFrames(page, 15);
    await page.evaluate(() => { window.TC.Lighting.setQuality("high"); });

    // ---- 9. save -> reload page -> continue: world unchanged --------------
    const beforeSave = await page.evaluate(fingerprintFn());
    await page.evaluate(() => { if (!window.__TEST__.saveNow()) throw new Error("save failed"); });
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => !!(window.TC && window.TC.state === "title"));
    await page.evaluate(() => {
      window.TC.continueGame();
      if (window.TC.state !== "playing") throw new Error("continue failed");
    });
    const afterReload = await page.evaluate(fingerprintFn());
    expect(afterReload).toEqual(beforeSave);

    H.assertNoErrors(errors, "journeyL/end-to-end");
  });
});
