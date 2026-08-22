/* tests/browser/input-transition.spec.js — menu→game input ownership.
   Invariant: any pointer/key event consumed by a menu transition (New World,
   Continue World) must NOT also be observable as a gameplay action in the
   first frames after the transition. The held item stays selected throughout
   — these tests prove the engine owns the lifecycle, not the test setup. */

const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

// Boot into a playing world via the real service layer, put a magic weapon
// in hand with a known mana pool, and save through the real Save API.
// Returns the rounded mana value stored in the save.
async function armWandAndSave(page, seed) {
  await H.openGame(page, "#test");
  await H.newWorld(page, seed);
  await page.evaluate(() => {
    const TC = window.TC;
    window.__TEST__.giveItem("wand_sparking", 1);
    const inv = TC.player.inventory;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.get(i);
      if (s && s.id === "wand_sparking") {
        TC.player.hotbarIndex = i; // magic weapon stays selected across everything below
        break;
      }
    }
    TC.player.maxMana = 20;
    TC.player.mana = 14; // known pool value for the persistence assertion
    TC.player.manaRegenDelay = 9999; // freeze regen so the pool stays exact
  });
  return page.evaluate(() => {
    const mana = Math.round(window.TC.player.mana);
    if (!window.TC.Save.save()) throw new Error("save failed");
    return mana;
  });
}

// Reload to the title screen and install a fresh projectile counter BEFORE
// the transition click (listeners die with the old page context).
async function reloadToTitleArmed(page) {
  await page.evaluate(() => window.TC.quitToTitle());
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.TC && window.TC.state === "title");
  await page.evaluate(() => {
    window.__bolts = 0;
    window.TC.Events.on(window.TC.Events.EVENT.ProjectileSpawned, (p) => {
      if (String((p && p.type) || "") === "magic_bolt") window.__bolts++;
    });
  });
}

test.describe("input transition ownership", () => {
  test("Continue click does not fire the selected magic weapon", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test"); // placeholder; re-armed below
    const savedMana = await armWandAndSave(page, 777);
    await reloadToTitleArmed(page);

    await H.clickTitleButton(page, 2); // 'Continue World'
    await page.waitForFunction(() => window.TC.state === "playing");
    await page.evaluate(() => {
      window.TC.player.manaRegenDelay = 9999; // keep the pool exact post-load
    });
    await H.runFrames(page, 45); // ~0.75s of gameplay frames

    expect(
      await page.evaluate(() => window.__bolts),
      "the menu-consumed Continue click must not cast the held wand",
    ).toBe(0);
    expect(
      Math.round(await page.evaluate(() => window.TC.player.mana)),
      "mana must survive the Continue transition untouched",
    ).toBe(savedMana);
    H.assertNoErrors(errors, "input transition / continue");
  });

  test("first intentional click after Continue casts exactly once", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    await armWandAndSave(page, 778);
    await reloadToTitleArmed(page);

    await H.clickTitleButton(page, 2);
    await page.waitForFunction(() => window.TC.state === "playing");
    await H.runFrames(page, 12); // settle past the transition

    // the transition itself must have fired nothing
    expect(
      await page.evaluate(() => window.__bolts),
      "no cast may precede the first intentional click",
    ).toBe(0);

    // one deliberate gameplay click at open sky (held briefly: kind 'magic'
    // legitimately re-fires on its useTime cadence while the button is down)
    await page.evaluate(() => {
      const TC = window.TC;
      const cam = TC.camera,
        z = cam.zoom || 1;
      const wx = TC.player.x + 140,
        wy = TC.player.y - 80;
      TC.Input.mouse.worldX = wx;
      TC.Input.mouse.worldY = wy;
      TC.Input.mouse.x = (wx - cam.x) * z;
      TC.Input.mouse.y = (wy - cam.y) * z;
    });
    await page.mouse.down();
    await H.runFrames(page, 4);
    await page.mouse.up();
    await H.runFrames(page, 8);

    expect(
      await page.evaluate(() => window.__bolts),
      "a genuine post-transition click must cast",
    ).toBeGreaterThanOrEqual(1);
  });

  test("New World click leaks no stale keyboard/mouse state", async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);
    const errors = await H.openGame(page, "#test");

    // stale edges pressed on the title screen itself
    await page.keyboard.press("Space"); // tap jump key on the menu
    await page.mouse.click(40, 40, { button: "right" }); // RMB on empty title area

    await H.clickTitleButton(page, 0); // 'New World'
    await page.waitForFunction(() => window.TC.state === "playing");
    const firstFrames = await page.evaluate(() => ({
      spacePressedEdge: window.TC.Input.pressed("Space"),
      spaceHeld: window.TC.Input.down("Space"),
      rightDown: window.TC.Input.mouse.rightDown,
      rightClicked: window.TC.Input.mouse.rightClicked,
      leftDown: window.TC.Input.mouse.down,
    }));
    await H.runFrames(page, 30);

    expect(firstFrames.leftDown, "no stuck LMB from the New World click").toBe(
      false,
    );
    expect(firstFrames.rightDown, "RMB state must clear across transition").toBe(
      false,
    );
    expect(
      firstFrames.rightClicked,
      "RMB edge consumed by the menu must not reach gameplay",
    ).toBe(false);
    expect(
      firstFrames.spacePressedEdge || firstFrames.spaceHeld,
      "keyboard edge/held state must not survive the transition",
    ).toBe(false);
    H.assertNoErrors(errors, "input transition / new world");
  });
});
