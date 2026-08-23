/* tests/npc/housing.test.js — W10 housing: validateHome deepening (size
   bounds, background-wall coverage, flooded interiors via TC.Liquids,
   border-ring entrance doors), incremental home claiming (claimHouse /
   houseOf, plot persistence through serialize/load, homeX re-anchor), and
   context-aware dialog pools (night > biome > base cycle, deterministic). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 20260821 : seed);
  return g;
}

// Hand-built room centered on the world midpoint. Every shell cell is written
// explicitly, so no natural flat span is required. Options: {w,h,walls,door,
// torch} — each piece can be withheld to probe one validator rule at a time.
function buildHouse(TC, opts) {
  opts = opts || {};
  const w = opts.w || 6, h = opts.h || 4;
  const world = TC.world;
  const tx = ((world.width / 2) | 0) - 3;
  const floorY = world.surfaceY[tx + 2];
  return buildHouseAt(TC, tx, floorY, w, h, opts);
}

function buildHouseAt(TC, tx, floorY, w, h, opts) {
  opts = opts || {};
  const T = TC.TILE, world = TC.world;
  const ty = floorY - h + 1;
  for (let x = tx - 1; x <= tx + w; x++) {
    world.setRaw(x, ty - 1, T.DIRT);              // roof
    world.setRaw(x, floorY, T.DIRT);              // floor
    world.setRaw(x, floorY + 1, T.DIRT);          // subfloor seals bottom band
    world.setRaw(x, floorY + 2, T.DIRT);
  }
  for (let y = ty; y < floorY; y++) {
    world.setRaw(tx - 1, y, T.DIRT);              // left wall
    world.setRaw(tx + w, y, T.DIRT);              // right wall
    for (let x = tx; x < tx + w; x++) world.setRaw(x, y, T.AIR);
  }
  // Evict any imported liquid volume from the footprint.
  if (TC.Liquids && typeof TC.Liquids.set === 'function') {
    for (let y = ty; y <= floorY; y++) {
      for (let x = tx; x < tx + w; x++) TC.Liquids.set(x, y, 0, 0);
    }
  }
  if (opts.walls !== false) {
    for (let y = ty; y <= floorY; y++) {
      for (let x = tx; x < tx + w; x++) world.setRawWall(x, y, TC.WALL.DIRT);
    }
  }
  if (opts.door !== false) world.setRaw(tx - 1, floorY - 1, T.DOOR_CLOSED);
  if (opts.torch !== false) world.setRaw(tx + 1, floorY - 1, T.TORCH);
  return { tx, ty, w, h, floorY };
}

test('housing: validateHome rejects too-small and too-large footprints', () => {
  const g = boot();
  const TC = g.TC;
  const world = TC.world;
  const tx = (world.width / 2) | 0;
  const fy = world.surfaceY[tx];

  const small = TC.NPCs.validateHome(tx, fy - 3, 3, 3);
  assert.ok(!small.ok, '3x3 must fail');
  assert.ok(small.problems.includes('too-small'),
    '3x3 must report too-small: ' + JSON.stringify(small));

  const tall = TC.NPCs.validateHome(tx, fy - 11, 6, 11);
  assert.ok(!tall.ok, '11-tall room must fail');
  assert.ok(tall.problems.includes('too-large'),
    'oversized height must report too-large: ' + JSON.stringify(tall));

  const wide = TC.NPCs.validateHome(tx, fy - 4, 15, 4);
  assert.ok(!wide.ok, '15-wide room must fail');
  assert.ok(wide.problems.includes('too-large'));

  // A legal-sized (if unfinished) room reports neither bound problem.
  const mid = TC.NPCs.validateHome(tx, fy - 4, 6, 4);
  assert.ok(!mid.problems.includes('too-small'), JSON.stringify(mid));
  assert.ok(!mid.problems.includes('too-large'), JSON.stringify(mid));
});

test('housing: validateHome demands background-wall coverage', () => {
  const g = boot();
  const TC = g.TC;
  const room = buildHouse(TC, { w: 6, h: 4, walls: false });
  const world = TC.world;

  let res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.ok(!res.ok, 'wall-less room must fail');
  assert.ok(res.problems.includes('no-walls'),
    'must report no-walls: ' + JSON.stringify(res));
  assert.equal(res.problems.filter((p) => p === 'no-walls').length, 1);

  // Fill the background -> the very same room validates clean.
  for (let y = room.ty; y <= room.floorY; y++) {
    for (let x = room.tx; x < room.tx + room.w; x++) {
      world.setRawWall(x, y, TC.WALL.DIRT);
    }
  }
  res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res)), { ok: true, problems: [] },
    'walled lit sealed room must validate');
});

test('housing: validateHome flags flooded interiors via TC.Liquids', () => {
  const g = boot();
  const TC = g.TC;
  assert.ok(TC.Liquids && typeof TC.Liquids.queryAt === 'function',
    'liquids layer must be available headless');
  const room = buildHouse(TC, { w: 6, h: 4 });
  const LQ = TC.Liquids;

  assert.equal(LQ.queryAt(room.tx + 2, room.ty + 1).amount, 0, 'starts dry');

  LQ.set(room.tx + 2, room.ty + 1, LQ.TYPE.WATER, 200);
  let res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.ok(!res.ok, 'flooded room must fail');
  assert.ok(res.problems.includes('flooded'),
    'must report flooded: ' + JSON.stringify(res));

  LQ.set(room.tx + 2, room.ty + 1, LQ.TYPE.NONE, 0);
  res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res)), { ok: true, problems: [] },
    'drained room must validate again');
});

test('housing: validateHome requires an entrance door on the border ring', () => {
  const g = boot();
  const TC = g.TC;
  const room = buildHouse(TC, { w: 6, h: 4, door: false });
  const world = TC.world;

  let res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.ok(!res.ok, 'doorless sealed room must fail');
  assert.ok(res.problems.includes('no-entrance'),
    'must report no-entrance: ' + JSON.stringify(res));

  // Anywhere on the ring counts: swap a left-wall cell for a closed door.
  world.setRaw(room.tx - 1, room.ty + 1, TC.TILE.DOOR_CLOSED);
  res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res)), { ok: true, problems: [] },
    'ring door restores acceptance');
});

test('housing: forced claim stores a plot, re-anchors homeX, persists', () => {
  const g = boot();
  const TC = g.TC;
  const ts = TC.CONST.TS;
  const guide = TC.NPCs.list[0];
  assert.ok(guide && guide.type === 'guide', 'fresh boot has a Guide');

  assert.equal(TC.NPCs.houseOf(guide), null, 'pre-claim lookup is null');
  assert.equal(TC.NPCs.houseOf('guide'), null, 'type lookup is null pre-claim');
  assert.equal(TC.NPCs.claimHouse('merchant'), false,
    'claiming for an absent kind fails cleanly');

  // Hand-build a valid house a few tiles ahead of the Guide's arrival spot.
  // No flat span is needed: every shell cell gets written explicitly.
  const gx = Math.floor((guide.x + guide.w / 2) / ts);
  const startCol = gx + 10;
  assert.ok(startCol + 9 < TC.world.width - 20, 'house site inside world');
  const room = buildHouseAt(TC, startCol, TC.world.surfaceY[startCol + 3],
    6, 4, {});
  const dist = Math.abs((room.tx + room.w / 2) - gx);
  assert.ok(dist <= 48, 'test house must sit inside the claim radius');

  assert.equal(TC.NPCs.claimHouse(guide), true, 'claim kicks off a scan');
  let plot = null;
  for (let i = 0; i < 400 && !plot; i++) {   // incremental: pump update ticks
    TC.NPCs.update(0.05);
    plot = TC.NPCs.houseOf(guide);
  }
  assert.ok(plot, 'claim never landed within the pump budget');
  assert.ok(plot.w >= 5 && plot.w <= 9, 'claimed width within scan bounds');
  assert.ok(plot.h >= 4 && plot.h <= 6, 'claimed height within scan bounds');
  const v = TC.NPCs.validateHome(plot.tx, plot.ty, plot.w, plot.h);
  assert.ok(v.ok, 'claimed plot must itself validate: ' + JSON.stringify(v));
  assert.ok(guide.homeX >= plot.tx * ts && guide.homeX <= (plot.tx + plot.w) * ts,
    'homeX re-anchored into the plot, got ' + guide.homeX);
  assert.equal(JSON.stringify(TC.NPCs.houseOf('guide')),
    JSON.stringify(plot), 'type-string lookup finds the plot');
  assert.equal(TC.NPCs.houseOf('merchant'), null, 'absent kind has no house');

  // Persistence: the plot rides npc.state through serialize/load untouched.
  const blob = JSON.parse(JSON.stringify(TC.NPCs.serialize()));
  const rec = blob.find((r) => r.type === 'guide');
  assert.ok(rec && rec.state && rec.state.home, 'state.home serialized');
  assert.deepEqual(rec.state.home, plot, 'serialized plot matches the claim');
  assert.equal(rec.homeX, guide.homeX, 're-anchored homeX serialized');

  TC.NPCs.load(blob);
  const back = TC.NPCs.list[0];
  assert.ok(back && back.type === 'guide', 'guide restored');
  assert.deepEqual(TC.NPCs.houseOf(back), plot, 'plot restored through load');
  assert.equal(back.homeX, rec.homeX, 'homeX restored');
});

function poolsOf(def) {
  const out = [].concat(def.dialogLines || [], def.dialogNight || []);
  const bio = def.dialogBiome || {};
  for (const k of Object.keys(bio)) out.push.apply(out, bio[k]);
  return out;
}

test('housing: night/biome dialog pools select deterministically', () => {
  const g = boot();
  const TC = g.TC;
  const K = TC.NPCs.KINDS;
  const guide = TC.NPCs.list[0];

  // Content requirements: guide covers grappling hooks + buckets; merchant
  // covers selling spare stock (RMB a bag slot) for coins.
  assert.ok(poolsOf(K.guide).some((l) => /grappling/i.test(l) && /bucket/i.test(l)),
    'guide must mention grappling hooks and buckets');
  assert.ok(poolsOf(K.merchant).some((l) =>
    /right-click/i.test(l) && /bag slot/i.test(l) &&
    /sell/i.test(l) && /coin/i.test(l)),
    'merchant must mention RMB-selling bag slots for coins');

  const sky = TC.Sky;
  const DAY = TC.CONST.DAY_LENGTH;
  const CYCLE = DAY + (TC.CONST.NIGHT_LENGTH || 240);
  const savedTime = sky.time;
  let biomeDesc = null;
  try {
    // Day, unpatched biome: base cycle walks dialogLines in order.
    const basePool = JSON.parse(JSON.stringify(K.guide.dialogLines));
    const seq = [];
    for (let i = 0; i < basePool.length; i++) {
      seq.push(TC.NPCs.dialogLineFor(guide));
    }
    assert.deepStrictEqual(seq, basePool, 'base pool cycles in order');

    biomeDesc = Object.getOwnPropertyDescriptor(TC.Biomes || {}, 'current');

    // Deep night beats even a patched biome pool.
    sky.time = Math.floor(savedTime / CYCLE) * CYCLE + DAY + 60;
    try {
      Object.defineProperty(TC.Biomes, 'current',
        { value: 'snow', configurable: true });
    } catch (e) { /* realm refuses the patch; night check still runs */ }
    const nightPool = JSON.parse(JSON.stringify(K.guide.dialogNight));
    const nseq = [];
    for (let i = 0; i < nightPool.length * 2; i++) {
      nseq.push(TC.NPCs.dialogLineFor(guide));
    }
    assert.deepStrictEqual(nseq.slice(0, nightPool.length), nightPool,
      'night pool wins over biome pool');
    assert.deepStrictEqual(nseq.slice(nightPool.length), nightPool,
      'night pool cycles deterministically');

    // Back to day with the snow patch: the biome pool takes over.
    sky.time = savedTime;
    if (biomeDesc) {
      const bioPool = JSON.parse(JSON.stringify(K.guide.dialogBiome.snow));
      const bseq = [];
      for (let i = 0; i < bioPool.length * 2; i++) {
        bseq.push(TC.NPCs.dialogLineFor(guide));
      }
      assert.deepStrictEqual(bseq.slice(0, bioPool.length), bioPool,
        'biome pool picked for TC.Biomes.current');
      assert.deepStrictEqual(bseq.slice(bioPool.length), bioPool,
        'biome pool cycles deterministically');
    }
  } finally {
    sky.time = savedTime;
    if (biomeDesc && TC.Biomes) {
      try { Object.defineProperty(TC.Biomes, 'current', biomeDesc); } catch (e) {}
    }
  }
});
