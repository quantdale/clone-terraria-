/* tests/world/fishing.test.js — zones, power math, cast->bite->reel,
   single-grant loot, daily quest + reward-once, persistence, and the
   restoreHold regression (load() -> WorldLoaded keeps restored state). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

const TS = 16;
const jv = (x) => JSON.parse(JSON.stringify(x == null ? null : x)); // cross-realm safe

// Hand-built deterministic world: flat stone ground at y=40 with named
// fishing pools far apart.
function miniWorld(TC) {
  const W = 240, H = 90;
  const gen = {
    width: W, height: H,
    tiles: new Uint8Array(W * H),
    walls: new Uint8Array(W * H),
    surfaceY: new Int16Array(W),
    spawnX: 120, spawnY: 39
  };
  const t = TC.TILE;
  const idx = (x, y) => y * W + x;
  const rect = (x0, y0, x1, y1, id) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) gen.tiles[idx(x, y)] = id;
  };
  rect(0, 0, W - 1, H - 1, t.AIR);
  rect(0, 40, W - 1, H - 1, t.STONE);
  for (let x = 0; x < W; x++) gen.surfaceY[x] = 40;
  // open-pit pools: carve shafts through the crust so bobbers can reach water
  const pit = (x0, x1) => { for (let x = x0; x <= x1; x++) for (let y = 40; y <= 43; y++) gen.tiles[idx(x, y)] = t.AIR; };
  rect(0, 34, 21, 44, t.WATER);                    // ocean strip, seabed 45
  for (let x = 0; x <= 21; x++) gen.surfaceY[x] = 45;
  rect(72, 44, 83, 47, t.WATER); pit(72, 83);      // surface pool
  rect(100, 44, 107, 47, t.WATER);                 // snow pool
  pit(100, 107); rect(98, 39, 109, 39, t.SNOW);
  for (let x = 98; x <= 109; x++) gen.surfaceY[x] = 39;
  rect(150, 44, 157, 47, t.WATER);                 // jungle pool
  pit(150, 157); rect(148, 39, 159, 39, t.JGRASS);
  for (let x = 148; x <= 159; x++) gen.surfaceY[x] = 39;
  rect(180, 58, 189, 63, t.AIR);                   // underground cavern
  rect(181, 60, 188, 63, t.WATER);
  rect(192, 58, 199, 63, t.AIR);                   // lava pocket
  rect(193, 60, 198, 62, t.LAVA);
  TC.world = new TC.World(gen);
  TC.worldSeed = 4242;
  return TC.world;
}

function setup(seed) {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(seed == null ? 77 : seed);
  return { g, TC };
}

function prepareAngler(TC, rodId) {
  const inv = TC.player.inventory;
  for (let i = 0; i < inv.slots.length; i++) {
    const s = inv.get(i);
    if (s && TC.ITEM_DEFS[s.id] && TC.ITEM_DEFS[s.id].kind === 'bait') inv.remove(i, s.count);
  }
  inv.slots[0] = { id: rodId, count: 1 };
  TC.player.hotbarIndex = 0;
}
function invTotal(TC) {
  let n = 0; const inv = TC.player.inventory;
  for (let i = 0; i < inv.slots.length; i++) { const s = inv.get(i); if (s) n += s.count; }
  return n;
}
function invCount(TC, id) {
  const inv = TC.player.inventory;
  for (let i = 0; i < inv.slots.length; i++) { const s = inv.get(i); if (s && s.id === id) return s.count; }
  return 0;
}

// One full cast cycle aiming at pool cell (cx,cy). `perfectReel` hooks at the
// instant of the bite (2 loot rolls); otherwise waits out the perfect window
// (1 roll). Returns after the cycle completes or fails.
function castCycle(TC, px, py, cx, cy, maxFrames, perfectReel) {
  const p = TC.player;
  p.x = px; p.y = py; p.vx = 0; p.vy = 0;
  const inp = TC.Input.mouse;
  const def = TC.ITEM_DEFS.iron_fishing_rod;
  const dbg = () => TC.Fishing._debug();
  const tick = () => TC.Fishing.update(1 / 60);

  inp.down = false; tick();                        // arm edge tracker low
  inp.worldX = cx * TS + 8; inp.worldY = cy * TS + 8;
  inp.down = true;
  TC.Fishing.onUseHeld(p, def, 1 / 60);            // rising edge -> cast
  tick();
  inp.down = false;

  let frames = 0;
  while (frames++ < maxFrames && dbg().mode !== 'waiting' && dbg().mode !== 'idle') tick();
  if (dbg().mode === 'idle') return 'no-cast';
  if (dbg().mode !== 'waiting') return 'no-bite';

  let bframes = 0;
  while (bframes++ < maxFrames && dbg().mode !== 'biting') tick();
  if (dbg().mode !== 'biting') return 'missed';
  if (!perfectReel) {
    // burn past the perfect fraction (45% of the reel window) so the hook
    // counts as a normal single-roll catch
    const burn = Math.ceil((TC.Fishing._debug().windowT || 1) * 0.5 * 60);
    for (let i = 0; i < burn && dbg().mode === 'biting'; i++) tick();
    if (dbg().mode !== 'biting') return 'missed';
  }
  inp.down = true;
  TC.Fishing.onUseHeld(p, def, 1 / 60);            // rising edge -> reel
  inp.down = false;
  frames = 0;
  while (frames++ < 240 && dbg().mode !== 'idle') tick();
  return dbg().mode === 'idle' ? 'caught' : 'stuck';
}

test('fishing: zoneFor maps liquid/depth/edge/ground-tile correctly', () => {
  const { TC } = setup();
  miniWorld(TC);
  const z = (tx, ty) => jv(TC.Fishing.zoneFor(tx, ty));
  assert.deepStrictEqual(z(10, 40), { zone: 'ocean', liquid: 'water' });
  assert.deepStrictEqual(z(76, 45), { zone: 'surface', liquid: 'water' });
  assert.deepStrictEqual(z(103, 45), { zone: 'snow', liquid: 'water' });
  assert.deepStrictEqual(z(153, 45), { zone: 'jungle', liquid: 'water' });
  assert.deepStrictEqual(z(184, 61), { zone: 'underground', liquid: 'water' });
  assert.deepStrictEqual(z(195, 61), { zone: 'lava', liquid: 'lava' });
});

test('fishing: powerFor applies bait, liquid and zone multipliers with caps', () => {
  const { TC } = setup();
  const D = TC.ITEM_DEFS;
  const pf = (rod, bait, zone, liquid) => TC.Fishing.powerFor(rod, bait, zone, liquid);
  assert.strictEqual(pf(D.wooden_fishing_rod, D.worm, 'surface', 'water'), 20);
  assert.strictEqual(pf(D.wooden_fishing_rod, D.worm, 'ocean', 'water'), Math.round(20 * 1.15));
  assert.strictEqual(pf(D.wooden_fishing_rod, D.worm, 'underground', 'water'), Math.round(20 * 0.85));
  assert.strictEqual(pf(D.gold_fishing_rod, D.grub, 'underground', 'lava'),
    Math.round(64 * 0.5 * 0.85));
  assert.strictEqual(pf(D.gold_fishing_rod, null, 'surface', 'honey'),
    Math.round(52 * 0.7));
  assert.strictEqual(pf({ power: 200 }, { kind: 'bait', power: 100 }, 'ocean', 'water'),
    120, 'POWER_CAP not applied');
  assert.strictEqual(pf(null, null, 'surface', 'water'), 10, 'bare fallback');
});

test('fishing: cast->bite->reel adds EXACTLY ONE loot item per catch', () => {
  const { TC } = setup();
  miniWorld(TC);
  prepareAngler(TC, 'iron_fishing_rod');
  const before = invTotal(TC);
  const beforeSlots = (function () {
    let n = 0; const inv = TC.player.inventory;
    for (let i = 0; i < inv.slots.length; i++) if (inv.get(i)) n++;
    return n;
  })();
  const r = castCycle(TC, 73 * TS, 38 * TS, 77, 45, 6000, false);
  assert.strictEqual(r, 'caught', 'cycle failed: ' + r);
  // Contract: a NORMAL catch rolls exactly ONE loot stack (minnow x1, or a
  // worm bundle x1-2). Perfect hooks intentionally roll two.
  const stacksAfter = (function () {
    let n = 0; const inv = TC.player.inventory;
    for (let i = 0; i < inv.slots.length; i++) if (inv.get(i)) n++;
    return n;
  })();
  assert.strictEqual(stacksAfter - beforeSlots, 1, 'a normal catch granted != 1 loot stack');
});

test('fishing: perfect-hook reel rolls TWO loot stacks', () => {
  const { TC } = setup();
  miniWorld(TC);
  prepareAngler(TC, 'iron_fishing_rod');
  const beforeSlots = (function () {
    let n = 0; const inv = TC.player.inventory;
    for (let i = 0; i < inv.slots.length; i++) if (inv.get(i)) n++;
    return n;
  })();
  const r = castCycle(TC, 73 * TS, 38 * TS, 77, 45, 6000, true);
  assert.strictEqual(r, 'caught', 'cycle failed: ' + r);
  const stacksAfter = (function () {
    let n = 0; const inv = TC.player.inventory;
    for (let i = 0; i < inv.slots.length; i++) if (inv.get(i)) n++;
    return n;
  })();
  assert.strictEqual(stacksAfter - beforeSlots, 2, 'perfect catch granted != 2 loot stacks');
});

test('fishing: daily quest derives deterministically, completes once, rewards once', () => {
  const { TC } = setup();
  miniWorld(TC);
  TC.Sky.time = 660 * 3;                        // day index 3
  prepareAngler(TC, 'iron_fishing_rod');
  TC.Fishing.update(1 / 60);
  const q = jv(TC.Fishing.getQuest());
  assert.ok(q, 'no quest created');
  assert.strictEqual(q.day, 3);
  const expectFish = TC.Fishing.questPool[
    Math.floor(TC.Utils.hash2(TC.worldSeed | 0, 3, 0xF155) * TC.Fishing.questPool.length)
  ];
  assert.strictEqual(q.fish, expectFish, 'quest fish not derived from hash2(seed,day)');

  const home = {
    icefish: [101, 44], seabass: [8, 40], catfish: [183, 60],
    perch: [152, 44], minnow: [75, 44], trout: [78, 44]
  };
  const [hx, hy] = home[q.fish] || [75, 44];
  let attempts = 0;
  while (attempts++ < 400 && !q.done) {
    castCycle(TC, (hx - 2) * TS, (hy - 8) * TS, hx + 2, hy + 1, 6000);
    q.done = jv(TC.Fishing.getQuest()).done;
  }
  assert.strictEqual(q.done, true, 'quest never completed in 400 catches');
  assert.ok(invCount(TC, 'gold_bar') >= 2, 'quest reward missing');
  const bars = invCount(TC, 'gold_bar');
  for (let k = 0; k < 5 && attempts < 420; k++, attempts++) {
    castCycle(TC, (hx - 2) * TS, (hy - 8) * TS, hx + 2, hy + 1, 6000);
  }
  assert.strictEqual(invCount(TC, 'gold_bar'), bars, 'quest rewarded more than once');
});

test('fishing: serialize/load round-trip restores quest + catches', () => {
  const { TC } = setup();
  const blob = { quest: { day: 7, fish: 'catfish', done: true }, catches: { minnow: 3, catfish: 1 } };
  assert.strictEqual(TC.Fishing.load(blob), true);
  const out = jv(TC.Fishing.serialize());
  assert.strictEqual(out.quest.day, 7);
  assert.strictEqual(out.quest.fish, 'catfish');
  assert.strictEqual(out.quest.done, true);
  assert.deepStrictEqual(out.catches, { minnow: 3, catfish: 1 });
  assert.strictEqual(TC.Fishing.load(null), false);
  assert.strictEqual(TC.Fishing.restoreLegacy({ fishing: blob }), true);
  assert.strictEqual(TC.Fishing.restoreLegacy(blob), true);
});

test('regression: restored quest/catches survive the trailing WorldLoaded (restoreHold)', () => {
  const { TC } = setup();
  TC.newGame(99);
  TC.Fishing.update(1 / 60);
  const blob = { quest: { day: 11, fish: 'perch', done: true }, catches: { perch: 4 } };
  assert.strictEqual(TC.Fishing.load(blob), true);
  // keep the in-game day on the restored quest's day, else ensureQuest
  // legitimately replaces the stale-day quest on the first update tick
  const cyc = (TC.CONST.DAY_LENGTH || 420) + (TC.CONST.NIGHT_LENGTH || 240);
  TC.Sky.time = 11 * cyc + 10;
  TC.Events.emit(TC.Events.EVENT.WorldLoaded, { seed: 99 });
  TC.Fishing.update(1 / 60);
  const q = jv(TC.Fishing.getQuest());
  assert.ok(q, 'restored quest was wiped by WorldLoaded');
  assert.strictEqual(q.day, 11);
  assert.strictEqual(q.fish, 'perch');
  const ser = jv(TC.Fishing.serialize());
  assert.strictEqual(ser.catches.perch, 4, 'restored catches were wiped');

  // counter-case: without a prior load(), WorldLoaded still resets cleanly
  TC.Events.emit(TC.Events.EVENT.WorldLoaded, { seed: 99 });
  TC.Fishing.update(1 / 60);
  const ser2 = jv(TC.Fishing.serialize());
  assert.ok(!ser2.catches || !ser2.catches.perch, 'fresh world kept old catches');
});
