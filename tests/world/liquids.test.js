/* tests/world/liquids.test.js — T2: Liquids layer torture + dual-authority
   documentation probes.

   DUAL-AUTHORITY MODEL (verified against world.js/main.js):
   - LEGACY WATER/LAVA TILES are the authoritative live simulation today:
     main.js step() runs TC.world.update(dt) -> World.stepWater (active-set
     tile mover); buildWorld() seeds nothing into the Liquids layer.
   - THE LIQUIDS LAYER (TC.Liquids) is a parallel foundation fed only by
     TC.Liquids.set/importFromWorld/provider-deserialize. Nothing in world.js
     writes or wakes it; Liquids writes tiles back only for the
     water+lava -> stone contact rule (world.setRaw).
   - DIVERGENCE #1 (asserted): world.set() near a populated layer cell wakes
     ONLY the legacy sim; the layer cell stays dormant. Liquids.set() never
     creates a WATER tile. Readers of tiles vs readers of the layer can
     disagree until the lead flips migration. MEDIUM; fix needs a shared-file
     hook (world.set -> TC.Liquids.wake), reported to lead.
   - DIVERGENCE #2 (documented here, repro in comment): World.flowWater
     ping-pongs a lone water tile between two flat-floor cells forever
     (vacated cell always qualifies as next spread target) -> active set
     never drains, per-tick budget burned on a 2-cell oscillation. HIGH,
     lead-owned js/world.js; see final report. Not asserted as pass/fail
     here because the fix belongs to the lead. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

// Carve an isolated arena: interior [x0..x1]x[y0..y1] AIR, side walls STONE,
// solid STONE floor at y1+1. Raw writes only (no support pops).
function carveArena(TC, x0, y0, x1, y1) {
  const w = TC.world;
  const AIR = TC.TILE.AIR, STONE = TC.TILE.STONE;
  for (let y = y0 - 1; y <= y1 + 2; y++) {
    for (let x = x0 - 2; x <= x1 + 2; x++) w.setRaw(x, y, AIR);
  }
  for (let y = y0 - 1; y <= y1; y++) {
    w.setRaw(x0 - 1, y, STONE);
    w.setRaw(x1 + 1, y, STONE);
  }
  for (let x = x0 - 1; x <= x1 + 1; x++) w.setRaw(x, y1 + 1, STONE);
}

function setup(opts) {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame((opts && opts.seed) || 1);
  return { g, TC };
}

// Step the layer until the active set drains (or cap).
function settle(TC, maxSteps) {
  const n = maxSteps || 4000;
  for (let i = 0; i < n; i++) {
    TC.Liquids.update(0.05);
    if (TC.Liquids.stats().active === 0) return i + 1;
  }
  return -1;
}

// Sparse [[x,y,type,amount]] snapshot of a region via the public sampler.
function snapshotRegion(TC, x0, y0, x1, y1) {
  const out = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const s = TC.Liquids.sampleAt(x * 16 + 8, y * 16 + 8);
      if (s.type !== TC.Liquids.TYPE.NONE && s.amount > 0) {
        out.push([x, y, s.type, s.amount]);
      }
    }
  }
  return out;
}

test('liquids: water column settles into an equalized grounded puddle, volume conserved', () => {
  const { TC } = setup({ seed: 42 });
  const X0 = 605, X1 = 614, Y1 = 150;
  carveArena(TC, X0, Y1 - 5, X1, Y1);
  TC.Liquids.reset(TC.world);

  const W = TC.Liquids.TYPE.WATER, FULL = TC.Liquids.FULL;
  // two stacked columns of 3 FULL cells = 6*255 units (divides evenly)
  for (const cx of [X0 + 4, X0 + 5]) {
    for (let dy = 0; dy < 3; dy++) {
      assert.ok(TC.Liquids.set(cx, Y1 - dy, W, FULL), 'set failed');
    }
  }
  const initialSum = 6 * FULL;

  const steps = settle(TC);
  assert.notStrictEqual(steps, -1, 'active set never drained');
  assert.strictEqual(TC.Liquids.stats().active, 0);

  const wet = snapshotRegion(TC, X0, Y1 - 5, X1, Y1);
  assert.ok(wet.length > 0, 'all water vanished');
  let sum = 0;
  for (const e of wet) sum += e[3];
  assert.ok(sum <= initialSum, 'volume grew?!');
  assert.ok(initialSum - sum <= 24, 'lost too much volume: ' + (initialSum - sum));

  // every wet cell grounded: solid below or FULL same-type liquid below
  const w = TC.world;
  for (const [x, y, t] of wet) {
    if (w.isSolid(x, y + 1)) continue;
    const bs = TC.Liquids.sampleAt(x * 16 + 8, (y + 1) * 16 + 8);
    assert.ok(bs.type === t && bs.amount >= FULL - 1,
      'floating/partially-supported liquid at ' + x + ',' + y);
  }

  // per-column fill is a contiguous run ending on the floor row, and surface
  // amounts are roughly equalized across columns
  const byCol = new Map();
  for (const [x, y, , a] of wet) {
    if (!byCol.has(x)) byCol.set(x, { ys: [], topAmt: 0 });
    const c = byCol.get(x);
    c.ys.push(y);
    if (!c.topAmt || y < Number(c.topY)) { c.topY = y; c.topAmt = a; }
    void c;
  }
  const tops = [];
  for (const [x, c] of byCol) {
    c.ys.sort((a, b) => a - b);
    assert.strictEqual(c.ys[c.ys.length - 1], Y1, 'column ' + x + ' not grounded');
    for (let i = 1; i < c.ys.length; i++) {
      assert.strictEqual(c.ys[i], c.ys[i - 1] + 1, 'gap in column ' + x);
    }
    tops.push(c.topAmt);
  }
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 64,
    'puddle surface not equalized: ' + tops.join(','));
});

test('liquids: water above lava consumes BOTH and places EXACTLY ONE stone', () => {
  const { TC } = setup({ seed: 7 });
  const X0 = 300, X1 = 304, Y1 = 120;
  carveArena(TC, X0, Y1 - 3, X1, Y1);
  TC.Liquids.reset(TC.world);

  const cx = X0 + 2;
  const lavaY = Y1, waterY = Y1 - 1;
  assert.ok(TC.Liquids.set(cx, lavaY, TC.Liquids.TYPE.LAVA, 255));
  assert.ok(TC.Liquids.set(cx, waterY, TC.Liquids.TYPE.WATER, 255));

  const countStone = () => {
    let n = 0;
    for (let y = Y1 - 4; y <= Y1 + 1; y++) {
      for (let x = X0 - 1; x <= X1 + 1; x++) {
        if (TC.world.get(x, y) === TC.TILE.STONE) n++;
      }
    }
    return n;
  };
  const stoneBefore = countStone();

  const contacts = [];
  TC.Events.on(TC.Events.EVENT.LiquidChanged, (p) => contacts.push(p));
  settle(TC);
  TC.Events.flush();

  assert.strictEqual(countStone() - stoneBefore, 1, 'expected exactly one stone');
  assert.strictEqual(TC.Liquids.sampleAt(cx * 16 + 8, lavaY * 16 + 8).amount, 0,
    'lava not consumed');
  assert.strictEqual(TC.Liquids.sampleAt(cx * 16 + 8, waterY * 16 + 8).amount, 0,
    'water not consumed');
  const ev = contacts.find((p) => p.contacts && p.contacts.length);
  assert.ok(ev, 'no LiquidChanged contact event queued');
  assert.strictEqual(ev.contacts.length, 1, 'more than one contact recorded');
});

test('liquids: side-by-side water|lava does NOT react (contact is vertical-only)', () => {
  const { TC } = setup({ seed: 9 });
  const X0 = 210, X1 = 214, Y1 = 110;
  carveArena(TC, X0, Y1 - 2, X1, Y1);
  TC.Liquids.reset(TC.world);
  assert.ok(TC.Liquids.set(X0 + 1, Y1, TC.Liquids.TYPE.WATER, 255));
  assert.ok(TC.Liquids.set(X0 + 2, Y1, TC.Liquids.TYPE.LAVA, 255));
  settle(TC);
  assert.notStrictEqual(TC.world.get(X0 + 1, Y1), TC.TILE.STONE);
  assert.notStrictEqual(TC.world.get(X0 + 2, Y1), TC.TILE.STONE);
  const a = TC.Liquids.sampleAt((X0 + 1) * 16 + 8, Y1 * 16 + 8);
  const b = TC.Liquids.sampleAt((X0 + 2) * 16 + 8, Y1 * 16 + 8);
  assert.strictEqual(a.type, TC.Liquids.TYPE.WATER, 'water destroyed without contact');
  assert.strictEqual(b.type, TC.Liquids.TYPE.LAVA, 'lava destroyed without contact');
});

test('liquids: tiny volumes evaporate instead of lingering', () => {
  const { TC } = setup({ seed: 11 });
  const X0 = 400, X1 = 404, Y1 = 90;
  carveArena(TC, X0, Y1 - 1, X1, Y1);
  TC.Liquids.reset(TC.world);
  assert.ok(TC.Liquids.set(X0 + 2, Y1, TC.Liquids.TYPE.WATER, 5));
  assert.strictEqual(TC.Liquids.stats().cells, 1);
  settle(TC);
  assert.strictEqual(TC.Liquids.stats().cells, 0, 'thin film did not evaporate');
  assert.strictEqual(TC.Liquids.stats().active, 0);
});

test('liquids: persistence round-trip via SaveCore envelope preserves sparse cells', () => {
  const { TC } = setup({ seed: 13 });
  const X0 = 700, X1 = 704, Y1 = 130;
  carveArena(TC, X0, Y1 - 2, X1, Y1);
  TC.Liquids.reset(TC.world);
  assert.ok(TC.Liquids.set(X0 + 1, Y1, TC.Liquids.TYPE.WATER, 200));
  assert.ok(TC.Liquids.set(X0 + 3, Y1 - 1, TC.Liquids.TYPE.LAVA, 90));

  const before = snapshotRegion(TC, X0 - 1, Y1 - 3, X1 + 1, Y1 + 1);
  assert.ok(before.length >= 2, 'sanity: expected several wet cells');

  const env = TC.SaveCore.buildEnvelope({ world: TC.world, player: TC.player });
  const entry = env.world['core.liquids'];
  assert.ok(entry && entry.data, 'liquids provider missing from envelope');

  TC.Liquids.reset(TC.world);
  assert.strictEqual(TC.Liquids.stats().cells, 0, 'reset did not clear');
  const res = TC.SaveCore.restore(env, { world: TC.world, player: TC.player });
  assert.ok(res.restored.includes('world.core.liquids'),
    'provider not restored: ' + JSON.stringify(res));

  const after = snapshotRegion(TC, X0 - 1, Y1 - 3, X1 + 1, Y1 + 1);
  assert.deepStrictEqual(after, before, 'round-trip changed the liquid state');
});

test('liquids: a fresh game holds ALL liquid in the layer; import is idempotent', () => {
  const { TC } = setup({ seed: 21 });
  let tiles = 0;
  for (let i = 0; i < TC.world.tiles.length; i++) {
    const id = TC.world.tiles[i];
    if (id === TC.TILE.WATER || id === TC.TILE.LAVA) tiles++;
  }
  assert.strictEqual(tiles, 0,
    'buildWorld left WATER/LAVA tiles behind — build-time import missing');
  assert.strictEqual(TC.Liquids.mode(), 'layer', 'authority must be the layer');
  assert.ok(TC.Liquids.stats().cells > 0, 'layer empty after import');
  // one-way act: re-import finds nothing left to claim
  assert.strictEqual(TC.Liquids.importFromWorld(TC.world), 0);
});

test('liquids: single authority — stray tiles never simulate; edits never leak across layers', () => {
  const { TC } = setup({ seed: 31 });
  const X0 = 800, Y1 = 100;
  carveArena(TC, X0, Y1 - 6, X0 + 4, Y1);

  // (a) placing a WATER TILE writes the grid but never enters/moves in any
  // simulation: no tile-water mover exists and the layer is untouched.
  TC.world.set(X0 + 2, Y1 - 4, TC.TILE.WATER);          // mid-air in the shaft
  const s = TC.Liquids.sampleAt((X0 + 2) * 16 + 8, (Y1 - 4) * 16 + 8);
  assert.strictEqual(s.type, TC.Liquids.TYPE.NONE,
    'tile water leaked into the layer');
  for (let i = 0; i < 20; i++) TC.world.update(0.05);
  assert.strictEqual(TC.world.get(X0 + 2, Y1 - 4), TC.TILE.WATER,
    'a tile-water simulation still runs — dual simulation is back');

  // (b) writing the layer never leaks into the tile grid either
  TC.Liquids.reset(TC.world);
  assert.ok(TC.Liquids.set(X0 + 1, Y1, TC.Liquids.TYPE.WATER, 255));
  assert.strictEqual(TC.world.get(X0 + 1, Y1), TC.TILE.AIR,
    'layer write leaked into tiles');
});
