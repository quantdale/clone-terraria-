/* tests/browser/journey-d-combat.spec.js — Journey D: spawn enemy → melee →
   ranged → projectile collision → enemy dies → loot generated. Watches for
   duplicate EntityKilled events and duplicate drops. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

// Flatten a deterministic fighting arena around the player: stone floor at
// the feet row, air above, solid sub-floor. Removes terrain-dependent flakiness
// (slimes knocked into dips leave the strike arc).
async function buildArena(page) {
  await page.evaluate(() => {
    const TC = window.TC;
    const px = Math.floor((TC.player.x + TC.player.w / 2) / TC.CONST.TS);
    const feetTy = Math.floor((TC.player.y + TC.player.h) / TC.CONST.TS);
    for (let dx = -12; dx <= 16; dx++) {
      for (let dy = -9; dy <= -1; dy++) {
        TC.world.setRaw(px + dx, feetTy + dy, TC.TILE.AIR);
      }
      for (let dy = 0; dy <= 2; dy++) {
        TC.world.setRaw(px + dx, feetTy + dy, TC.TILE.STONE);
      }
    }
    window.__TEST__.teleportPlayer(
      px * TC.CONST.TS,
      feetTy * TC.CONST.TS - TC.CONST.PLAYER_H,
    );
  });
  await H.runFrames(page, 20);
}

test.describe("journey D — combat", () => {
  test("melee kills a slime with exactly one EntityKilled and gel loot", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 2024);
    await buildArena(page);

    // count events for duplicate detection
    await page.evaluate(() => {
      window.__kills = 0;
      window.__spawns = 0;
      window.TC.Events.on(window.TC.Events.EVENT.EntityKilled, () => {
        window.__kills++;
      });
      window.TC.Events.on(window.TC.Events.EVENT.EntitySpawned, () => {
        window.__spawns++;
      });
    });

    // spawn a green slime right next to the player via the generic spawner
    const spawned = await page.evaluate(() => {
      const TC = window.TC;
      const x = TC.player.x + TC.player.w + 8; // inside the 34px strike arc
      const y = TC.player.y;
      const e = TC.Enemies.spawnEnemy("green_slime", x, y);
      window.__slime = e; // page-side reference: director spawns can't confuse us
      return !!e;
    });
    expect(spawned, "generic spawnEnemy must work for regular types").toBe(
      true,
    );

    // melee: sword is starter slot 2; swing at the slime until it dies
    await H.selectSlot(page, 2);
    let dead = false;
    for (let i = 0; i < 40 && !dead; i++) {
      // Pin the target inside the small melee arc on every swing: knockback
      // would otherwise slide the slime out of reach and every later swing
      // would whiff no matter where the cursor aims.
      await page.evaluate(() => {
        const TC = window.TC,
          s = window.__slime;
        if (!s || s.hp <= 0 || s.dead) return;
        s.x = TC.player.x + TC.player.w + 4;
        s.y = TC.player.y + TC.player.h - s.h;
      });
      const tgt = await page.evaluate(() => {
        const s = window.__slime;
        if (!s || s.hp <= 0 || s.dead) return null;
        return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
      });
      if (!tgt) {
        dead = true;
        break;
      }
      // move the REAL pointer: a real mousedown recomputes worldX/Y from the
      // last mousemove, so synthetic Input.mouse writes alone would be lost.
      const scr = await page.evaluate((p) => {
        const cam = window.TC.camera,
          z = cam.zoom || 1;
        return { x: (p.x - cam.x) * z, y: (p.y - cam.y) * z };
      }, tgt);
      await page.mouse.move(scr.x, scr.y);
      await page.mouse.down();
      await H.runFrames(page, 14);
      await page.mouse.up();
      dead = await page.evaluate(
        () =>
          !window.__slime ||
          window.__slime.hp <= 0 ||
          window.__slime.dead === true,
      );
    }
    expect(dead, "the slime must die from melee swings").toBe(true);
    await H.runFrames(page, 10);

    // exactly one kill event, no duplicates
    expect(await page.evaluate(() => window.__kills)).toBe(1);
    // loot: green slimes always drop gel (1..2)
    const gel = await page.evaluate(() => {
      let n = 0;
      for (const d of window.TC.Items.drops) if (d.id === "gel") n += d.count;
      return n;
    });
    expect(gel, "slime death must drop gel loot").toBeGreaterThanOrEqual(1);
    expect(gel).toBeLessThanOrEqual(2);

    H.assertNoErrors(errors, "journey D/melee");
  });

  test("bow shot travels as a pooled projectile, hits and drops a second slime", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 2025);
    await buildArena(page);

    await page.evaluate(() => {
      window.__kills = 0;
      window.__arrows = 0;
      window.TC.Events.on(window.TC.Events.EVENT.EntityKilled, () => {
        window.__kills++;
      });
      window.TC.Events.on(window.TC.Events.EVENT.ProjectileSpawned, (p) => {
        if (String((p && p.type) || "").indexOf("arrow") >= 0)
          window.__arrows++;
      });
    });

    // second slime a fixed distance away, tracked by reference
    const ok = await page.evaluate(() => {
      const TC = window.TC;
      const e = TC.Enemies.spawnEnemy(
        "green_slime",
        TC.player.x + 9 * TC.CONST.TS,
        TC.player.y,
      );
      window.__slime = e;
      return !!e;
    });
    expect(ok).toBe(true);

    // bow + arrows into the hotbar-free slots, then select the bow
    await page.evaluate(() => {
      window.__TEST__.giveItem("wooden_bow", 1);
      window.__TEST__.giveItem("arrow", 20);
      const inv = window.TC.player.inventory;
      for (let i = 4; i < 10; i++) {
        const s = inv.get(i);
        if (s && s.id === "wooden_bow") {
          window.TC.player.hotbarIndex = i;
          break;
        }
      }
    });

        // One arrow deals ~10 vs 14 hp: KEEP FIRING until the slime dies.
    let fired = false;
    let killed = false;
    for (let i = 0; i < 40 && !killed; i++) {
      const scr = await page.evaluate(() => {
        const TC = window.TC;
        const s = window.__slime;
        if (!s || s.hp <= 0 || s.dead) return null;
        const cam = TC.camera,
          z = cam.zoom || 1;
        const wx = s.x + s.w / 2,
          wy = s.y + s.h / 2;
        return { x: (wx - cam.x) * z, y: (wy - cam.y) * z };
      });
      if (!scr) {
        killed = true;
        break;
      }
      await page.mouse.move(scr.x, scr.y);
      await page.mouse.down();
      await H.runFrames(page, 3);
      await page.mouse.up();
      fired = fired || (await page.evaluate(() => window.__arrows > 0));
      await H.runFrames(page, 12);
      killed = await page.evaluate(
        () =>
          window.__kills > 0 &&
          (!window.__slime || window.__slime.hp <= 0 || window.__slime.dead),
      );
    }
    expect(fired, "a bow shot must fire an arrow projectile").toBe(true);
    
    expect(killed, "the arrow must collide and kill the slime").toBe(true);
    expect(await page.evaluate(() => window.__kills)).toBe(1);

    const gel = await page.evaluate(() => {
      let n = 0;
      for (const d of window.TC.Items.drops) if (d.id === "gel") n += d.count;
      return n;
    });
    expect(gel).toBeGreaterThanOrEqual(1);

    H.assertNoErrors(errors, "journey D/ranged");
  });
});
