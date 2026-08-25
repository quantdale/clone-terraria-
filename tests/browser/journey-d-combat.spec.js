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

// Count gel across BOTH durable locations: physical drops and inventory
// stacks. A kill near the player can legitimately magnet-collect its gel
// once pickupDelay elapses, so drops alone are a transient representation.
function gelProbe() {
  return `(() => {
    let n = 0;
    for (const d of window.TC.Items.drops) if (d.id === 'gel') n += d.count;
    const inv = window.TC.player.inventory;
    for (let k = 0; k < inv.slots.length; k++) {
      const s = inv.get(k);
      if (s && s.id === 'gel') n += s.count;
    }
    return n;
  })()`;
}

test.describe("journey D — combat", () => {
  test("melee kills a slime with exactly one EntityKilled and gel loot", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 2024);
    await buildArena(page);

    const gelBefore = await page.evaluate(gelProbe());
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
    // loot: green slimes always drop gel (1..2); count the durable invariant
    // (physical drops + anything already magnet-collected into inventory)
    const gel = (await page.evaluate(gelProbe())) - gelBefore;
    expect(gel, "slime death must yield gel loot").toBeGreaterThanOrEqual(1);
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
      window.TC.Events.on(window.TC.Events.EVENT.EntityKilled, (e) => {
        const sig = window.__slimeSig || null;
        if (!sig || !e || e.type !== sig.type) return;
        if (Math.abs(e.x - sig.x) > 32 || Math.abs(e.y - sig.y) > 32) return;
        window.__kills++;
      });
      window.TC.Events.on(window.TC.Events.EVENT.ProjectileSpawned, (p) => {
        if (String((p && p.type) || "").indexOf("arrow") >= 0)
          window.__arrows++;
      });
    });

    // second slime a fixed distance away, tracked by reference; record its
    // pinned home rectangle so every shot starts from identical geometry
    const ok = await page.evaluate(() => {
      const TC = window.TC;
      const e = TC.Enemies.spawnEnemy(
        "green_slime",
        TC.player.x + 9 * TC.CONST.TS,
        TC.player.y,
      );
      window.__slime = e;
      const feetTy = Math.floor((TC.player.y + TC.player.h) / TC.CONST.TS);
      window.__slimeHome = {
        x: TC.player.x + 9 * TC.CONST.TS,
        y: feetTy * TC.CONST.TS - e.h,
      };
      // scope kill accounting to THIS slime: the spawn director may add
      // unrelated surface enemies inside the arena during the engagement
      window.__slimeSig = { type: "green_slime", x: e.x, y: e.y };
      return !!e;
    });
    expect(ok).toBe(true);

    const gelBefore = await page.evaluate(gelProbe());

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
    // Arrows are gravity projectiles (js/projectiles.js TYPES.arrow), so a
    // dead-center aim only connects when a hop crosses the descending arc —
    // a physics lottery. Solve the low-arc launch angle against live game
    // constants instead, and re-pin the target each shot so knockback and
    // hop phase cannot drift it out of the engagement.
    let fired = false;
    let killed = false;
    for (let i = 0; i < 40 && !killed; i++) {
      const scr = await page.evaluate(() => {
        const TC = window.TC;
        const s = window.__slime;
        if (!s || s.hp <= 0 || s.dead) return null;
        // pin: feet on the arena floor at the home column, velocities zeroed
        s.x = window.__slimeHome.x;
        s.y = window.__slimeHome.y;
        s.vx = 0;
        s.vy = 0;
        const td = TC.Projectiles && TC.Projectiles.TYPES
          ? TC.Projectiles.TYPES.arrow
          : null;
        const g = (td && td.gravity) || 900;
        const v = (td && td.speed) || 520; // doBow launches at BOW_SPEED
        const p = TC.player;
        const x0 = p.x + p.w / 2,
          y0 = p.y + p.h / 2;
        let dx = s.x + s.w / 2 - x0;
        const dy = s.y + s.h / 2 - y0;
        const dir = dx >= 0 ? 1 : -1;
        dx = Math.abs(dx) || 1;
        // y-down low-arc solve: k*u^2 - dx*u + (k - dy) = 0 with u=tan(theta),
        // k = g*dx^2/(2*v^2); the plus-root is the shallow arc (aims upward).
        const k = (g * dx * dx) / (2 * v * v);
        const disc = dx * dx - 4 * k * (k - dy);
        const ang =
          disc >= 0
            ? Math.atan((-dx + Math.sqrt(disc)) / (2 * k))
            : Math.atan2(dy, dx);
        // place the cursor on the solved ray; the game recomputes this exact
        // launch angle from the pointer geometry on mousedown
        const wx = x0 + Math.cos(ang) * dir * 200;
        const wy = y0 + Math.sin(ang) * 200;
        const cam = TC.camera,
          z = cam.zoom || 1;
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
      killed = await page.evaluate(() => {
        const s = window.__slime;
        const gone =
          !s || s.hp <= 0 ||
          !(window.TC.Enemies.list || []).includes(s);
        return Boolean(window.__kills > 0 && gone);
      });
    }
    expect(fired, "a bow shot must fire an arrow projectile").toBe(true);

    expect(killed, "the arrow must collide and kill the slime").toBe(true);
    expect(await page.evaluate(() => window.__kills)).toBe(1);

    // durable loot invariant: gel exists as a drop or has already been
    // magnet-collected into inventory (both are authoritative outcomes)
    const gel = (await page.evaluate(gelProbe())) - gelBefore;
    expect(gel, "slime death must yield gel loot").toBeGreaterThanOrEqual(1);

    H.assertNoErrors(errors, "journey D/ranged");
  });
});
