/* tests/browser/journey-g-wiring.spec.js — Journey G: place wire → trigger
   (switch) → receiver (actuator on a stone host) → activate → EXACTLY ONE
   WirePulse and the ghost flips solid↔passable → save → reload → activate
   again. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

// Build a deterministic wiring rig near the player:
//   stone host at (x,y), wire run from (x-3,y)..(x,y), switch at (x-4,y).
async function buildRig(page) {
  return page.evaluate(() => {
    const TC = window.TC;
    const TS = TC.CONST.TS;
    const px = Math.floor((TC.player.x + TC.player.w / 2) / TS);
    const py = Math.floor((TC.player.y + TC.player.h) / TS) - 1;
    // clear the rig row and ground below it (covers trap extension too)
    for (let dx = -9; dx <= 1; dx++) {
      TC.world.setRaw(px + dx, py, TC.TILE.AIR);
      if (
        !TC.TILE_DEFS[TC.world.get(px + dx, py + 1)] ||
        !TC.TILE_DEFS[TC.world.get(px + dx, py + 1)].solid
      ) {
        TC.world.setRaw(px + dx, py + 1, TC.TILE.STONE);
      }
    }
    const hostX = px,
      hostY = py;
    if (TC.world.get(hostX, hostY) !== TC.TILE.AIR)
      return { error: "host not air: " + TC.world.get(hostX, hostY) };

    const W = TC.Wiring;
    // stone host block for the actuator
    // World.set() returns undefined (it throws only on refusal-by-exception);
    // verify placement by reading back.
    TC.world.set(hostX - 0, hostY, TC.TILE.STONE);
    if (TC.world.get(hostX, hostY) !== TC.TILE.STONE)
      return { error: "host stone set failed" };
    // Attaching CONSUMES an 'actuator' item from the player inventory
    if (!window.__TEST__.giveItem("actuator", 1)) {
      return { error: "could not grant an actuator item" };
    }
    const p = TC.player;
    if (!p || !p.inReach(hostX, hostY)) {
      return { error: "host out of reach of player" };
    }
    if (
      !W.attachActuatorAt(p, {
        worldX: hostX * TS + 8,
        worldY: hostY * TS + 8,
      })
    ) {
      return { error: "attachActuatorAt failed" };
    }
    // wire run: switch cell .. host cell, extended WEST of the switch with a
    // DART_TRAP receiver adjacent to the far end (actuators toggle silently —
    // fireReceiver emits WirePulse only for doors/dart traps).
    const W2 = TC.Wiring;
    for (const xw of [hostX - 6, hostX - 7]) W2.placeWire(xw, hostY);
    TC.world.set(hostX - 8, hostY, TC.TILE.DART_TRAP);
    let wired = 0;
    for (let x = hostX - 4; x < hostX; x++) {
      if (W.placeWire(x, hostY)) wired++;
    }
    TC.world.set(hostX - 5, hostY, TC.TILE.SWITCH_OFF);
    if (TC.world.get(hostX - 5, hostY) !== TC.TILE.SWITCH_OFF) {
      return { error: "switch placement failed" };
    }
    TC.world.set(hostX - 8, hostY, TC.TILE.DART_TRAP);
    return {
      hostX: hostX,
      hostY: hostY,
      switchX: hostX - 5,
      switchY: hostY,
      trapX: hostX - 8,
      trapY: hostY,
      wired: wired,
    };
  });
}

  // Toggle the switch through TC.Wiring.interact — the SAME entry point the
  // player's right-click path invokes. Called exactly once per activation so
  // variable fixed-step counts per rAF frame can never double-toggle.
  async function activateSwitch(page, rig) {
    await page.evaluate(([x, y]) => {
      const TC = window.TC;
      const p = TC.player;
      p.interact({
        worldX: x * 16 + 8,
        worldY: y * 16 + 8,
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
    }, [rig.switchX, rig.switchY]);
    await H.runFrames(page, 6);
  }

test.describe("journey G — wiring", () => {
  test("switch pulse flips the actuator exactly once per activation", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");
    await H.newWorld(page, 4242);

    await page.evaluate(() => {
      window.__pulses = [];
      window.TC.Events.on(window.TC.Events.EVENT.WirePulse, (p) => {
        window.__pulses.push([p && p.x, p && p.y]); // receiver cell
      });
    });

    const rig = await buildRig(page);
    expect(rig && !rig.error, JSON.stringify(rig)).toBeTruthy();
    expect(rig.wired).toBeGreaterThanOrEqual(3);

    // before any pulse the host is SOLID: attaching does not ghost it
    const ghost0 = await page.evaluate(
      ([x, y]) => ({
        ghost: window.TC.Wiring.isGhost(x, y),
        solid: window.TC.world.isSolid(x, y),
      }),
      [rig.hostX, rig.hostY],
    );
    expect(ghost0.ghost, "freshly attached actuator starts solid").toBe(false);
    expect(ghost0.solid).toBe(true);

    // activate through the real right-click interact path
    await activateSwitch(page, rig);

    const counts = await page.evaluate(([tx, ty]) => {
      const per = {};
      for (const [px, py] of window.__pulses) {
        const k = px + "," + py;
        per[k] = (per[k] || 0) + 1;
      }
      return { trap: per[tx + "," + ty] || 0, total: window.__pulses.length };
    }, [rig.trapX, rig.trapY]);
    expect(counts.trap, "dart-trap receiver fires EXACTLY once").toBe(1);

    const state1 = await page.evaluate(
      ([x, y]) => ({
        ghost: window.TC.Wiring.isGhost(x, y),
        solidNow: window.TC.world.isSolid(x, y),
      }),
      [rig.hostX, rig.hostY],
    );
    expect(state1.ghost, "after one pulse the host is ghosted").toBe(true);
    expect(state1.solidNow).toBe(false);

    // second activation flips back, again exactly one pulse per receiver
    await activateSwitch(page, rig);

    expect(await page.evaluate(() => window.__pulses)).toHaveLength(2);
    expect(
      await page.evaluate(
        ([x, y]) => window.TC.Wiring.isGhost(x, y),
        [rig.hostX, rig.hostY],
      ),
    ).toBe(false);

    // ---- persistence: save → reload → continue → activate again ----
    await page.evaluate(() => {
      if (!window.TC.Save.save()) throw new Error("save failed");
    });
    await page.evaluate(() => window.TC.quitToTitle());
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.TC && window.TC.state === "title");
    await H.clickTitleButton(page, 2);
    await page.waitForFunction(() => window.TC.state === "playing");

    await page.evaluate(() => {
      window.__pulses = [];
      window.TC.Events.on(window.TC.Events.EVENT.WirePulse, (p) => {
        window.__pulses.push([p && p.x, p && p.y]); // receiver cell
      });
    });
    const restored = await page.evaluate(
      ([x, y]) => ({
        ghost: window.TC.Wiring.isGhost(x, y),
      }),
      [rig.hostX, rig.hostY],
    );
    expect(restored.ghost, "solid state after 2nd pulse survives reload").toBe(
      false,
    );

    await activateSwitch(page, rig);
    const counts3 = await page.evaluate(([tx, ty]) => {
      const per = {};
      for (const [px, py] of window.__pulses) {
        const k = px + "," + py;
        per[k] = (per[k] || 0) + 1;
      }
      return { trap: per[tx + "," + ty] || 0 };
    }, [rig.trapX, rig.trapY]);
    expect(
      counts3.trap,
      "activation works again after reload, exactly one trap pulse",
    ).toBe(1);

    H.assertNoErrors(errors, "journey G");
  });
});
