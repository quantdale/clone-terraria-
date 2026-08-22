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
    // clear an L-run in the air row `py` and ground below it
    for (let dx = -6; dx <= 1; dx++) {
      TC.world.setRaw(px + dx, py, TC.TILE.AIR);
      if (
        TC.world.get(px + dx, py + 1) === TC.TILE.AIR ||
        !TC.TILE_DEFS[TC.world.get(px + dx, py + 1)].solid
      ) {
        TC.world.setRaw(px + dx, py + 1, TC.TILE.STONE);
      }
    }
    const hostX = px,
      hostY = py;
    if (TC.world.get(hostX, hostY) !== TC.TILE.AIR) return null;

    const W = TC.Wiring;
    // stone host block for the actuator
    if (!TC.world.set(hostX - 0, hostY, TC.TILE.STONE)) return null;
    if (
      !W.attachActuatorAt(null, {
        worldX: hostX * TS + 8,
        worldY: hostY * TS + 8,
      })
    ) {
      return { error: "attachActuatorAt failed" };
    }
    // wire run: switch cell .. host cell (exclusive of host? inclusive ok —
    // placeWire only writes AIR cells)
    let wired = 0;
    for (let x = hostX - 4; x < hostX; x++) {
      if (W.placeWire(x, hostY)) wired++;
    }
    if (!TC.world.set(hostX - 5, hostY, TC.TILE.SWITCH_OFF)) {
      return { error: "switch placement failed" };
    }
    return {
      hostX: hostX,
      hostY: hostY,
      switchX: hostX - 5,
      switchY: hostY,
      wired: wired,
      ghostBefore: !W.isGhost(hostX, hostY), // actuator attached => ghost
    };
  });
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
        window.__pulses.push(
          p && p.source ? [p.source.x, p.source.y] : "pulse",
        );
      });
    });

    const rig = await buildRig(page);
    expect(rig && !rig.error, JSON.stringify(rig)).toBeTruthy();
    expect(rig.wired).toBeGreaterThanOrEqual(3);

    // before activation the stone host is ghosted (passable)
    const ghost0 = await page.evaluate(
      ([x, y]) => window.TC.Wiring.isGhost(x, y),
      [rig.hostX, rig.hostY],
    );
    expect(ghost0, "actuated host must start as a ghost").toBe(true);

    // activate the switch through the real right-click interact path
    await page.evaluate(
      ([x, y]) => {
        const TC = window.TC;
        TC.Input.mouse.rightDown = true;
        TC.Input.mouse.rightClicked = true;
        TC.Input.mouse.worldX = x * 16 + 8;
        TC.Input.mouse.worldY = y * 16 + 8;
      },
      [rig.switchX, rig.switchY],
    );
    await H.runFrames(page, 2);
    await page.evaluate(() => {
      window.TC.Input.mouse.rightDown = false;
      window.TC.Input.mouse.rightClicked = false;
    });
    await H.runFrames(page, 4);

    expect(
      await page.evaluate(() => window.__pulses.length),
      "exactly ONE WirePulse per activation",
    ).toBe(1);

    const state1 = await page.evaluate(
      ([x, y]) => ({
        ghost: window.TC.Wiring.isGhost(x, y),
        solidNow: window.TC.world.isSolid(x, y),
      }),
      [rig.hostX, rig.hostY],
    );
    expect(state1.ghost, "after one pulse the host is no longer ghosted").toBe(
      false,
    );
    expect(state1.solidNow).toBe(true);

    // second activation flips back, again exactly one pulse
    await page.evaluate(
      ([x, y]) => {
        const TC = window.TC;
        TC.Input.mouse.rightDown = true;
        TC.Input.mouse.rightClicked = true;
        TC.Input.mouse.worldX = x * 16 + 8;
        TC.Input.mouse.worldY = y * 16 + 8;
      },
      [rig.switchX, rig.switchY],
    );
    await H.runFrames(page, 2);
    await page.evaluate(() => {
      window.TC.Input.mouse.rightDown = false;
      window.TC.Input.mouse.rightClicked = false;
    });
    await H.runFrames(page, 4);

    expect(await page.evaluate(() => window.__pulses.length)).toBe(2);
    expect(
      await page.evaluate(
        ([x, y]) => window.TC.Wiring.isGhost(x, y),
        [rig.hostX, rig.hostY],
      ),
    ).toBe(true);

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
      window.TC.Events.on(window.TC.Events.EVENT.WirePulse, () => {
        window.__pulses.push("p");
      });
    });
    const restored = await page.evaluate(
      ([x, y]) => ({
        ghost: window.TC.Wiring.isGhost(x, y),
      }),
      [rig.hostX, rig.hostY],
    );
    expect(restored.ghost, "ghost/actuator registry must survive reload").toBe(
      true,
    );

    await page.evaluate(
      ([x, y]) => {
        const TC = window.TC;
        TC.Input.mouse.rightDown = true;
        TC.Input.mouse.rightClicked = true;
        TC.Input.mouse.worldX = x * 16 + 8;
        TC.Input.mouse.worldY = y * 16 + 8;
      },
      [rig.switchX, rig.switchY],
    );
    await H.runFrames(page, 4);
    expect(
      await page.evaluate(() => window.__pulses.length),
      "activation works again after reload, exactly one pulse",
    ).toBe(1);

    H.assertNoErrors(errors, "journey G");
  });
});
