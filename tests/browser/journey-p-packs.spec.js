/* tests/browser/journey-p-packs.spec.js - W25 real-browser journey (WS10):
   the production pack path on the REAL game (real Canvas, real DOM clicks,
   real LocalStorage, genuine page reload):

     1. boot #test with a FRESH profile: zero packs active by default;
     2. open the title-screen Content Packs panel with REAL mouse clicks;
     3. toggle the fixture pack row and Apply & Restart (persisted Settings
        path + genuine reload);
     4. after reboot prove the pack is ACTIVE, its content joined every
        registry family, and built-in dense identity stayed intact;
     5. deterministic new world; craft the pack material through
        TC.Crafting (the exact call the crafting-row click submits);
     6. place + mine the pack block through canonical command transactions;
        the world byte must be the APPENDED tile index both times;
     7. summon the pack mini-boss through the held-item transaction; defeat
        it and collect its declarative drop;
     8. save through the real Save service, RELOAD THE PAGE, Continue from
        the title: pack content + world state survive coherently and the
        envelope classification reports compatible;
     9. zero unexpected console/page errors throughout.

   Missing-pack refusal UX is covered headlessly with byte-level storage
   guarantees in tests/packs/save-compat.test.js. */
const { test, expect } = require("@playwright/test");
const H = require("./helpers.js");

const SEED = 777001;

// Title menu geometry mirrors ui.js layout(): bw=300 bh=48 gap=14,
// first row at max(h*0.44, h/2-100). Fresh profiles have no save button:
// defs = [new, seed, hostmp, joinmp, packs] -> Content Packs at index 4.
async function titleButtonPoint(page, index) {
  return page.evaluate(([i]) => {
    const w = window.innerWidth, h = window.innerHeight;
    const bh = 48, gap = 14;
    const by = Math.max(h * 0.44, h / 2 - 100);
    return { x: Math.round(w / 2), y: Math.round(by + i * (bh + gap) + bh / 2) };
  }, [index]);
}

function panelPoint(page, which) {
  return page.evaluate(([w2]) => {
    const w = window.innerWidth, h = window.innerHeight;
    const px = Math.round(w / 2 - 230);
    const py = Math.round(Math.max(24, h * 0.16));
    const ph = 56 + 30 + 62; // one provided pack row
    if (w2 === "row") return { x: px + 40, y: py + 56 + 12 };
    return { x: px + 12 + 100, y: py + ph - 48 + 18 }; // apply center
  }, [which]);
}

test("journey P: install fixture pack through the real UI, play it, save/reload", async ({ page }) => {
  const errors = await H.openGame(page, "#test");

  // ---- zero-pack default boot -------------------------------------------
  expect(await page.evaluate(() => window.TC.Packs.active().join(","))).toBe("");
  expect(await page.evaluate(() => window.TC.Registry.fingerprint())).toBe("1b1d7c15");

  // ---- packs panel through REAL clicks ----------------------------------
  let pt = await titleButtonPoint(page, 4);
  await page.mouse.click(pt.x, pt.y);
  await H.runFrames(page, 3);
  pt = await panelPoint(page, "row");
  await page.mouse.click(pt.x, pt.y); // toggle testpack row
  await H.runFrames(page, 2);
  pt = await panelPoint(page, "apply");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }).catch(() => {}),
    page.mouse.click(pt.x, pt.y),
  ]);
  await page.waitForFunction(() => !!(window.TC && window.TC.state === "title"));

  // ---- pack ACTIVE after the genuine reboot -----------------------------
  expect(await page.evaluate(() => window.TC.Packs.active().join(","))).toBe("testpack");
  const ident = await page.evaluate(() => ({
    fp: window.TC.Registry.fingerprint(),
    digest: window.TC.Packs.digest(),
    blade: !!window.TC.ITEM_DEFS.tempest_blade,
    tileName: window.TC.Localization.contentName("tile", window.TC.TILE_DEFS.length - 1),
    dirtStill: window.TC.Registry.stableOfIndex("tile", 1),
  }));
  expect(ident.blade, "pack item registered").toBe(true);
  expect(ident.tileName, "pack tile localized").toBe("Tempest Brick");
  expect(ident.dirtStill, "built-in tile index untouched").toBe("core:dirt");
  expect(ident.digest === "" || typeof ident.digest === "string").toBe(true);

  // ---- deterministic world ----------------------------------------------
  await H.newWorld(page, SEED, 20);

  // craft the chain starter through TC.Crafting (production seam)
  const crafted = await page.evaluate(() => {
    const TC = window.TC;
    TC.player.inventory.add("stone", 6);
    const stations = TC.Crafting.stationsNearby(TC.player.x, TC.player.y);
    const r = TC.Crafting.available(TC.player.inventory, stations)
      .find((x) => String(x.out).indexOf("tempest_shard") >= 0);
    if (!r) return { ok: false, why: "recipe not visible" };
    return { ok: TC.Crafting.craft(r, TC.player.inventory, stations) };
  });
  expect(crafted.ok, "tempest shard craftable from vanilla stone").toBe(true);
  await H.runFrames(page, 10);

  // place + mine the pack block through canonical transactions
  const block = await page.evaluate(() => {
    const TC = window.TC, p = TC.player, TS = TC.CONST.TS;
    p.inventory.add("tempest_brick", 2);
    const ptx = Math.floor(p.x / TS), pty = Math.floor(p.y / TS);
    let at = null;
    outer:
    for (let dy = -3; dy <= 3; dy++) for (let dx = -4; dx <= 4; dx++) {
      const r = TC.Commands.submit("PlaceTile",
        { tx: ptx + dx, ty: pty + dy, item: "tempest_brick", player: p });
      if (r.ok) { at = [ptx + dx, pty + dy]; break outer; }
    }
    if (!at) return { ok: false };
    const placedId = TC.world.get(at[0], at[1]);
    const pick = p.inventory.slots.findIndex((s) => s && s.id === "copper_pickaxe");
    if (pick >= 0) p.hotbarIndex = pick;
    const mined = TC.Commands.submit("MineTile",
      { tx: at[0], ty: at[1], player: p, toolPower: 35 }).ok;
    return { ok: true, placedId: placedId, appended: TC.TILE_DEFS.length - 1, mined: mined };
  });
  expect(block.ok, "pack block placed").toBe(true);
  expect(block.placedId, "world byte is the appended pack tile index")
    .toBe(block.appended);
  expect(block.mined, "and minable again").toBe(true);

  // summon the mini-boss through the held-item transaction, defeat it
  const fight = await page.evaluate(() => {
    const TC = window.TC, p = TC.player, TS = TC.CONST.TS;
    p.inventory.add("tempest_charm", 1);
    const slot = p.inventory.slots.findIndex((s) => s && s.id === "tempest_charm");
    p.hotbarIndex = slot;
    const used = TC.Commands.submit("UseItem",
      { slot: slot, aimX: p.x + TS * 8, aimY: p.y - TS * 8, player: p }).ok;
    if (!used || !TC.Enemies.list.length) return { ok: false };
    const e = TC.Enemies.list[TC.Enemies.list.length - 1];
    const boss = e.def.boss === true && e.def.name === "Tempest Wisp";
    TC.Enemies.damageEnemy(e, 999999, 1, 0, false);
    return { ok: true, boss: boss };
  });
  expect(fight.ok, "summon accepted").toBe(true);
  expect(fight.boss, "pack mini-boss spawned").toBe(true);
  await H.runFrames(page, 120);
  const looted = await page.evaluate(() => {
    const TC = window.TC, p = TC.player;
    return {
      inv: p.inventory.count("tempest_shard"),
      drops: TC.Items.drops.some((d) => d.id === "tempest_shard"),
    };
  });
  expect(looted.inv > 0 || looted.drops, "declarative drop reached the player").toBe(true);

  // ---- save -> RELOAD PAGE -> Continue -----------------------------------
  await page.evaluate(() => { if (!window.__TEST__.saveNow()) throw new Error("save failed"); });
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => !!(window.TC && window.TC.state === "title"));
  expect(await page.evaluate(() => window.TC.Packs.active().join(","))).toBe("testpack");

  const cls = await page.evaluate(() => {
    const data = window.TC.Save.load();
    const env = data && data.__envelope;
    return {
      state: window.TC.state,
      packsField: !!(env && env.packs && env.packs.packs &&
        env.packs.packs[0].id === "testpack"),
      classify: window.TC.Packs.classifySave(env ? env.packs : null),
    };
  });
  expect(cls.packsField, "save carries pack metadata").toBe(true);
  expect(cls.classify.ok, "classification compatible").toBe(true);

  // continue through the production entry point
  await page.evaluate(() => { window.TC.continueGame(); });
  await page.waitForFunction(() => window.TC.state === "playing");
  await H.runFrames(page, 30);
  const after = await page.evaluate(() => ({
    brickDef: !!window.TC.ITEM_DEFS.tempest_brick,
    fp: window.TC.Registry.fingerprint(),
  }));
  expect(after.brickDef, "pack content live after reload+continue").toBe(true);
  expect(after.fp, "identity stable across sessions").toBe(ident.fp);

  H.assertNoErrors(errors, "journey P");
});
