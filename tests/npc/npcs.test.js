/* tests/npc/npcs.test.js — TARGET: TC.NPCs behaviors.
   Covers NPC_KINDS def completeness (guide/merchant), ground-snapping spawn,
   evaluateUnlocks duplicate protection + Progression.has integration,
   shopOf copy semantics, damage -> death -> respawn-at-home cadence,
   validateHome accept/open-top/dark verdicts on a hand-built room,
   serialize/load tolerance for legacy and extended blobs, and the lead-side
   shop purchase path degrading gracefully with an empty purse (no crash). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 20260821 : seed);
  return g;
}

// Find a flat, obstacle-free surface span: surfaceY constant across the run,
// solid ground tile, clear air above (no trees). Returns the ground row.
function flatSpan(TC, minRun) {
  const w = TC.world;
  for (let start = 40; start < w.width - minRun - 40; start++) {
    const fy = w.surfaceY[start];
    let ok = true;
    for (let x = start; x < start + minRun && ok; x++) {
      if (w.surfaceY[x] !== fy) ok = false;
      else if (!w.isSolid(x, fy)) ok = false;
      else {
        for (let dy = 1; dy <= 9 && ok; dy++) {
          if (w.get(x, fy - dy) !== TC.TILE.AIR) ok = false;
        }
      }
    }
    if (ok) return { tx: start + 1, fy };
  }
  return null;
}

test('npcs: NPC_KINDS defs are complete for guide and merchant', () => {
  const g = boot();
  const TC = g.TC;
  const K = TC.NPCs.KINDS;
  assert.ok(K, 'TC.NPCs.KINDS must expose the kind table');

  for (const type of ['guide', 'merchant']) {
    const d = K[type];
    assert.ok(d, 'missing kind ' + type);
    assert.equal(d.type, type, 'def.type must match its key');
    assert.ok(typeof d.name === 'string' && d.name.length > 0, type + '.name');
    assert.ok(Array.isArray(d.dialogLines) && d.dialogLines.length > 0 &&
      d.dialogLines.every((l) => typeof l === 'string' && l.length > 0),
      type + '.dialogLines must be a non-empty string array');
    assert.ok(d.home && typeof d.home === 'object', type + '.home');
    assert.ok((d.hp | 0) > 0, type + '.hp must be positive');
    assert.ok(d.look && typeof d.look === 'object', type + '.look');
    assert.ok(TC.NPCs.kindDef(type) === d, 'kindDef must return the same def');
  }

  const shop = K.merchant.shop;
  assert.ok(Array.isArray(shop) && shop.length > 0, 'merchant.shop stock');
  for (const e of shop) {
    assert.ok(typeof e.itemId === 'string' && e.itemId.length > 0, 'entry.itemId');
    assert.equal(typeof e.price, 'number', 'entry.price must be numeric');
    assert.ok(e.price > 0, 'entry.price must be positive');
    assert.ok(TC.ITEM_DEFS[e.itemId], 'stocked item missing from ITEM_DEFS: ' + e.itemId);
  }
  assert.equal(K.guide.shop, null, 'guide must have no shop');
});

test('npcs: spawn(type,x,y) snaps NPCs onto terrain', () => {
  const g = boot();
  const TC = g.TC;
  const w = TC.world;
  const ts = TC.CONST.TS;

  // At-surface drop: feet land exactly on the first solid row below.
  const px = ((w.width / 2) | 0) * ts;
  const surfY = w.surfaceY[(w.width / 2) | 0];
  const n1 = TC.NPCs.spawn('guide', px, surfY * ts);
  assert.ok(n1, 'surface spawn failed');
  const ftx = Math.floor((n1.x + n1.w / 2) / ts);
  const feetTy = Math.floor((n1.y + n1.h) / ts);
  assert.ok(w.isSolid(ftx, feetTy), 'feet must rest on solid ground');
  assert.ok(!w.isSolid(ftx, feetTy - 1), 'body must not intersect the ground');
  assert.ok(Math.abs(n1.x - px) <= ts, 'spawn must keep the requested column');

  // Deep-underground drop still surfaces onto walkable ground, not cave air.
  const n2 = TC.NPCs.spawn('guide', px + 200 * ts, 300 * ts);
  assert.ok(n2, 'deep spawn failed');
  const ftx2 = Math.floor((n2.x + n2.w / 2) / ts);
  const feetTy2 = Math.floor((n2.y + n2.h) / ts);
  assert.ok(w.isSolid(ftx2, feetTy2), 'deep spawn must end standing on solid ground');

  // Sky drop: far above the surface the scanner must fall back to the
  // surface column instead of leaving the NPC floating in the air.
  const sx = ((w.width / 2) | 0) * ts + 40 * ts;
  const sSurf = w.surfaceY[Math.floor(sx / ts)];
  const n3 = TC.NPCs.spawn('guide', sx, 1);
  assert.ok(n3, 'sky spawn failed');
  const sfty = Math.floor((n3.y + n3.h) / ts);
  assert.equal(sfty, sSurf, 'sky-dropped NPC must land on its column surface');

  assert.equal(TC.NPCs.spawn('no_such_kind', 0, 0), null, 'unknown kind rejected');
});

test('npcs: evaluateUnlocks is duplicate-free and honors Progression.has', () => {
  const g = boot();
  const TC = g.TC;
  const P = TC.Progression;

  // newGame already ran one pass: guide present, merchant still locked
  // (starter kit carries no *_bar items).
  assert.equal(TC.NPCs.list.length, 1);
  assert.equal(TC.NPCs.list[0].type, 'guide');
  const movedIn = JSON.parse(JSON.stringify(TC.NPCs.evaluateUnlocks()));
  assert.deepStrictEqual(movedIn, [], 'second pass must not duplicate anyone');
  assert.equal(TC.NPCs.list.filter((n) => n.type === 'guide').length, 1);

  // String unlock rule gated by the real Progression store.
  TC.NPCs.KINDS.sage = {
    type: 'sage', name: 'Sage', hp: 100, dialogLines: ['Hmm.'],
    unlocks: 'flag.sage', home: { spanTiles: 4 }, shop: null, look: {}
  };
  try {
    assert.ok(!TC.NPCs.list.some((n) => n.type === 'sage'), 'locked sage must wait');
    P.set('flag.sage');
    // evaluateUnlocks builds its result inside the vm realm — clone through
    // JSON before strict comparisons against host-realm arrays.
    const moved = JSON.parse(JSON.stringify(TC.NPCs.evaluateUnlocks()));
    assert.deepStrictEqual(moved, ['sage'],
      'setting the flag must let the sage move in');

    // Stubbed Progression.has must be honored too (unlock consults it live).
    TC.NPCs.KINDS.hermit = {
      type: 'hermit', name: 'Hermit', hp: 100, dialogLines: ['...'],
      unlocks: 'flag.hermit', home: { spanTiles: 4 }, shop: null, look: {}
    };
    const origHas = P.has;
    P.has = (k) => (k === 'flag.hermit' ? true : origHas.call(P, k));
    try {
      const moved2 = JSON.parse(JSON.stringify(TC.NPCs.evaluateUnlocks()));
      assert.deepStrictEqual(moved2, ['hermit'],
        'a stubbed Progression.has must unlock kinds through the same path');
    } finally { P.has = origHas; }
    assert.equal(TC.NPCs.list.filter((n) => n.type === 'hermit').length, 1);
    const moved3 = JSON.parse(JSON.stringify(TC.NPCs.evaluateUnlocks()));
    assert.deepStrictEqual(moved3, [],
      'population cap: one NPC per kind, ever');
  } finally {
    delete TC.NPCs.KINDS.sage;
    delete TC.NPCs.KINDS.hermit;
  }
});

test('npcs: shopOf returns copies — mutating them cannot touch internals', () => {
  const g = boot();
  const TC = g.TC;
  const internal = () => TC.NPCs.KINDS.merchant.shop;

  // W2 economy: some stock rows are progression-gated; raise every gate so
  // the full table is visible for this copy-isolation probe.
  if (TC.Progression) {
    for (const k of Object.keys(TC.Progression.FLAGS)) {
      try { TC.Progression.set(TC.Progression.FLAGS[k]); } catch (e) {}
    }
  }

  const before = JSON.stringify(internal());
  const s1 = TC.NPCs.shopOf('merchant');
  assert.ok(Array.isArray(s1) && s1.length === internal().length);

  s1.push({ itemId: 'dirt', price: 1 });          // array-level mutation
  s1[0].price = -999;                             // entry-level mutation
  s1.length = 0;

  assert.equal(JSON.stringify(internal()), before,
    'shopOf must isolate the def table from caller mutations');
  const s2 = TC.NPCs.shopOf('merchant');
  assert.equal(s2.length, JSON.parse(before).length, 'next reader sees intact stock');
  assert.equal(s2[0].price, JSON.parse(before)[0].price, 'entry price intact');

  assert.equal(TC.NPCs.shopOf('guide'), null, 'shop-less kind yields null');
  assert.equal(TC.NPCs.shopOf('nope'), null, 'unknown kind yields null');
});

test('npcs: damage kills once, then respawns at home after the delay', () => {
  const g = boot();
  const TC = g.TC;
  const EV = TC.Events.EVENT;
  const killed = [];
  TC.Events.on(EV.EntityKilled, (p) => killed.push(JSON.parse(JSON.stringify(p))));

  const n = TC.NPCs.list[0];
  assert.ok(n && n.type === 'guide');
  const homeX = n.homeX;

  // Stale-reference guard: hitting an already-dead NPC object must be a no-op.
  assert.equal(TC.NPCs.damage(n, 99999, 1), true, 'lethal hit lands');
  assert.equal(TC.NPCs.list.length, 0, 'dead NPC leaves the list');
  assert.deepEqual(killed, [{
    kind: 'npc', type: 'guide', name: n.name, x: n.x, y: n.y
  }]);

  assert.equal(TC.NPCs.damage(n, 5, 1), false,
    'damaging a corpse reference must be rejected');
  TC.NPCs.update(0.05);                    // rejected hit must push no pending

  // Approach the threshold in coarse slices, then cross it with a 0.01 s
  // step: the spawn fires inside that call, and the newborn gets just one
  // tiny AI tick (its first tick always nudges it — targetX anchors to the
  // sprite's left edge — which would otherwise walk it off home).
  const respawnT = 45;                             // RESPAWN_SECONDS
  let elapsed = 0;
  while (elapsed < respawnT - 0.5) { TC.NPCs.update(0.5); elapsed += 0.5; }
  assert.equal(TC.NPCs.list.length, 0, 'too early: must stay dead');
  while (elapsed < respawnT) { TC.NPCs.update(0.01); elapsed += 0.01; }

  assert.equal(TC.NPCs.list.length, 1, 'exactly one respawn');
  const back = TC.NPCs.list[0];
  assert.equal(back.type, 'guide');
  assert.equal(back.hp, back.maxHp, 'respawn restores full health');
  assert.ok(Math.abs(back.x - homeX) <= 2 * TC.CONST.TS,
    'respawn lands at homeX, got ' + back.x + ' vs ' + homeX);
  assert.equal(killed.length, 1, 'death event fires exactly once');
});

function buildRoom(TC, w, h) {
  const spot = flatSpan(TC, w + 4);
  assert.ok(spot, 'no flat surface span found for room building');
  const world = TC.world;
  const T = TC.TILE;
  const floorY = spot.fy;
  const ty = floorY - h + 1;
  const tx = spot.tx;
  // normalize shell + interior
  for (let x = tx - 1; x <= tx + w; x++) {
    world.setRaw(x, ty - 1, T.DIRT);              // roof
    world.setRaw(x, floorY, T.DIRT);              // floor
    world.setRaw(x, floorY + 1, T.DIRT);          // subfloor seals the bottom band
    world.setRaw(x, floorY + 2, T.DIRT);
  }
  for (let y = ty; y < floorY; y++) {
    world.setRaw(tx - 1, y, T.DIRT);              // left wall
    world.setRaw(tx + w, y, T.DIRT);              // right wall
    for (let x = tx; x < tx + w; x++) world.setRaw(x, y, T.AIR);
  }
  // W10 housing contract: background walls across the footprint plus one
  // entrance door in the left wall column.
  for (let y = ty; y <= floorY; y++) {
    for (let x = tx; x < tx + w; x++) world.setRawWall(x, y, TC.WALL.DIRT);
  }
  world.setRaw(tx - 1, floorY - 1, T.DOOR_CLOSED);
  return { tx, ty, w, h, floorY };
}

test('npcs: validateHome accepts an enclosed door+torch room, flags open tops', () => {
  const g = boot();
  const TC = g.TC;
  const T = TC.TILE;
  const room = buildRoom(TC, 6, 4);
  const world = TC.world;

  // No light yet: conservative validator must complain before the torch.
  let res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.ok(!res.ok && res.problems.includes('dark'),
    'torchless sealed room must be flagged dark: ' + JSON.stringify(res));

  // Torch inside -> accepted.
  world.setRaw(room.tx + 1, room.floorY - 1, T.TORCH);
  res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res)), { ok: true, problems: [] },
    'enclosed lit room with a door must validate');

  // Door in the wall counts as sealing (swap a wall cell for DOOR_CLOSED).
  world.setRaw(room.tx - 1, room.ty + 1, T.DOOR_CLOSED);
  world.setRaw(room.tx + 1, room.floorY - 1, T.AIR);   // drop the torch
  world.setRaw(room.tx + 3, room.floorY - 1, T.TORCH); // re-light elsewhere
  res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res)), { ok: true, problems: [] },
    'door must seal the room like a wall block');

  // Open top: carve two roof cells away.
  world.setRaw(room.tx + 2, room.ty - 1, T.AIR);
  world.setRaw(room.tx + 3, room.ty - 1, T.AIR);
  res = TC.NPCs.validateHome(room.tx, room.ty, room.w, room.h);
  assert.ok(!res.ok && res.problems.includes('open'),
    'open-top room must be flagged open: ' + JSON.stringify(res));
});

test('npcs: serialize/load tolerates legacy and extended population blobs', () => {
  const g = boot();
  const TC = g.TC;
  const ts = TC.CONST.TS;
  const w = TC.world;
  const midTx = (w.width / 2) | 0;
  const px = (midTx + 20) * ts;
  const py = w.surfaceY[midTx + 20] * ts;

  // Legacy v1 shape: bare {type,x,y}, unknown kinds skipped.
  assert.doesNotThrow(() =>
    TC.NPCs.load([{ type: 'merchant', x: px, y: py },
                  { type: 'trader_gone', x: 0, y: 0 }]));
  assert.equal(TC.NPCs.list.length, 1, 'unknown kinds must be skipped');
  assert.equal(TC.NPCs.list[0].type, 'merchant');

  // Extended shape: homeX/hp/state restored, respawnT resumes as pending.
  assert.doesNotThrow(() => TC.NPCs.load([
    { type: 'guide', x: px, y: py, homeX: px, hp: 123, state: { visits: 7 } },
    { type: 'merchant', x: px, y: py, respawnT: 10 }
  ]));
  assert.equal(TC.NPCs.list.length, 1);
  const guide = TC.NPCs.list[0];
  assert.equal(guide.type, 'guide');
  assert.equal(guide.hp, 123, 'saved hp restored (clamped to maxHp)');
  assert.equal(guide.homeX, px, 'homeX restored');
  assert.deepEqual(guide.state, { visits: 7 }, 'state blob restored');

  // Pending-respawn resume: after the timer elapses the merchant returns.
  // Must run before any degenerate load — load([])/load(null) reset pending.
  TC.NPCs.update(11);
  assert.ok(TC.NPCs.list.some((n) => n.type === 'merchant'),
    'respawnT entry must resume its countdown and come back');

  // Round-trip: serialize output feeds load back cleanly.
  const blob = TC.NPCs.serialize();
  assert.ok(Array.isArray(blob) && blob.length >= 2);
  assert.doesNotThrow(() => TC.NPCs.load(blob));
  assert.equal(TC.NPCs.list.length,
    blob.filter((r) => !r.respawnT).length,
    'live entries restore 1:1');

  // Degenerate inputs fall back to a fresh Guide without throwing.
  assert.doesNotThrow(() => TC.NPCs.load([]));
  assert.equal(TC.NPCs.list.length, 1);
  assert.equal(TC.NPCs.list[0].type, 'guide', 'empty blob falls back to a Guide');
  assert.doesNotThrow(() => TC.NPCs.load(null));
});

test('npcs: shop purchase with no currency degrades gracefully (no crash)', () => {
  const g = boot();
  const TC = g.TC;
  const inv = TC.player.inventory;

  // A merchant stands next to the player and talks -> shop rows appear.
  const p = TC.player;
  const m = TC.NPCs.spawn('merchant', p.x + 24, p.y);
  assert.ok(m, 'merchant spawn failed');
  assert.doesNotThrow(() => TC.UI.showDialog('Merchant', 'Fine wares here.'));

  const ctxStub = TC.canvas.getContext('2d');
  const mouse = TC.Input.mouse;
  const torchesBefore = inv.count('torch');

  // The buy path lives in UI.draw's click handling. Sweep plausible shop-row
  // coordinates; a hit keeps the dialog open, a miss dismisses it.
  let hit = false;
  outer:
  for (let y = 400; y <= 660; y += 12) {
    for (let x = 420; x <= 860; x += 20) {
      TC.UI.showDialog('Merchant', 'Fine wares here.');
      mouse.x = x; mouse.y = y;
      mouse.clicked = true; mouse.rightClicked = false;
      assert.doesNotThrow(() => TC.UI.draw(ctxStub, 1280, 720),
        'clicking the shop with an empty purse must not throw');
      mouse.clicked = false;
      if (TC.UI.dialog) { hit = true; break outer; }
    }
  }
  assert.ok(hit, 'sweep never landed on a shop row — geometry drifted');

  // Degrade contract: nothing bought, nothing charged, inventory untouched.
  assert.equal(inv.count('coin_item') | 0, 0, 'no coin item exists yet');
  assert.equal(inv.count('torch'), torchesBefore, 'stock must not move without payment');
  assert.ok(TC.NPCs.shopOf('merchant').length > 0, 'stock listing survives');
});
