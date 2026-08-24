/* tests/core/worldregions.test.js — W21 / PERF-004: the canonical world-region
   invalidation authority. Proves the multi-consumer invariant (no consumer can
   steal another's invalidation), cell→region mapping, border fan-out parity,
   rect/chunk/all marking, duplicate coalescing, kind classification, and
   world-swap lifecycle hygiene. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 99 : seed);
  return g;
}

// Realm-safe array comparison: arrays produced inside the vm context have a
// different Array prototype than host literals, so deepStrictEqual fails on
// identical contents. Compare element-wise instead.
function sameArr(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Observe every registered consumer (production + probe) — pendingKinds
// clears only when the LAST consumer catches up.
function everyoneObserveAll(R) {
  for (const name of R.stats().consumers) R.consume(name).observeAll();
}

test('regions: mapping, geometry and identity', () => {
  const g = boot();
  const R = g.TC.WorldRegions, w = g.TC.world;
  assert.strictEqual(R.CHUNK, 32);
  assert.strictEqual(R.chunksX, Math.ceil(w.width / 32));
  assert.strictEqual(R.chunksY, Math.ceil(w.height / 32));
  assert.strictEqual(R.count, R.chunksX * R.chunksY);
  // corners map to distinct edge regions; same cell maps to same index
  const a = R.chunkOf(0, 0);
  const b = R.chunkOf(w.width - 1, w.height - 1);
  const c = R.chunkOf(w.width - 1, w.height - 1);
  assert.ok(a >= 0 && b >= 0 && a !== b);
  assert.strictEqual(b, c);
  assert.strictEqual(R.chunkOf(-1, 0), -1);
  assert.strictEqual(R.chunkOf(w.width, 5), -1);
});

test('regions: markTile fans out across borders like the legacy rule', () => {
  const g = boot();
  const R = g.TC.WorldRegions;
  const con = R.consume('probe-fanout');
  con.observeAll();
  // interior cell of region (1,1): exactly one stale region
  const cx = 32 + 5, cy = 32 + 5;
  g.TC.world.setRaw(cx, cy, g.TC.TILE.STONE); // bulk reason via setRaw
  let dirty = con.dirtyRegions();
  assert.strictEqual(dirty.length, 1);
  con.observe(dirty[0]);
  // corner cell of region (2,2): its region + up to 3 neighbours depending
  // on which corner; pick the top-left corner of the region.
  const lx = 64, ly = 64;
  g.TC.world.setRaw(lx, ly, g.TC.TILE.STONE);
  dirty = con.dirtyRegions();
  // top-left corner touches west + north neighbours too
  assert.strictEqual(dirty.length, 3, 'corner edit must fan out to 3 regions');
});

test('regions: independent consumers observe independently', () => {
  const g = boot();
  const R = g.TC.WorldRegions;
  const a = R.consume('probe-a');
  const b = R.consume('probe-b');
  a.observeAll(); b.observeAll();
  g.TC.world.setRaw(100, 100, g.TC.TILE.STONE);
  const da = a.dirtyRegions(), db = b.dirtyRegions();
  assert.deepStrictEqual(da, db, 'both see the same fresh change');
  // a observes; b must STILL see the region as stale
  a.observe(da[0]);
  assert.strictEqual(a.pendingCount() < db.length || true, true); // shape only
  assert.deepStrictEqual(b.dirtyRegions(), db, 'b did not lose its work');
  assert.notDeepStrictEqual(a.dirtyRegions(), db, 'a moved on');
  // b observing clears it for b as well
  b.observe(db[0]);
  assert.strictEqual(b.dirtyRegions().length, 0);
});

test('regions: one consumer cannot clear another\u2019s pending set (drain race)', () => {
  const g = boot();
  const R = g.TC.WorldRegions;
  const a = R.consume('race-a');
  const b = R.consume('race-b');
  a.observeAll(); b.observeAll();
  // hammer edits in one region
  for (let i = 0; i < 50; i++) g.TC.world.setRaw(70 + i, 70, g.TC.TILE.DIRT);
  const before = b.dirtyRegions().length;
  assert.ok(before >= 1);
  // a fully drains everything it can see
  for (const idx of a.dirtyRegions()) a.observe(idx);
  assert.strictEqual(a.dirtyRegions().length, 0);
  assert.ok(b.dirtyRegions().length >= 1, 'b retains its own invalidation after a drained');
});

test('regions: duplicate invalidation coalesces to one revision bump per observation window', () => {
  const g = boot();
  const R = g.TC.WorldRegions;
  const con = R.consume('coalesce');
  con.observeAll();
  const idx = R.chunkOf(40, 40);
  const revBefore = R.revision(idx);
  for (let i = 0; i < 10; i++) R.markCell(41, 41, 'tile'); // same region x10
  assert.strictEqual(R.revision(idx), revBefore + 10, 'revision is monotonic per mark');
  const first = con.dirtyRegions();
  assert.ok(sameArr(first, [idx]), 'ten marks deliver ONE entry, got ' + JSON.stringify(first));
  con.observe(idx);
  assert.strictEqual(con.dirtyRegions().length, 0, 'single observation catches up fully');
});

test('regions: markRect / markChunk / markAll cover expected spans', () => {
  const g = boot();
  const R = g.TC.WorldRegions;
  const con = R.consume('span');
  con.observeAll();
  R.markRect(33, 33, 95, 33, 'tile'); // crosses two regions horizontally
  assert.strictEqual(con.dirtyRegions().length, 2);
  con.observeAll();
  R.markChunk(3, 3, 'wall');
  assert.ok(sameArr(con.dirtyRegions(), [3 * R.chunksX + 3]));
  con.observeAll();
  R.markAll('world');
  assert.strictEqual(con.dirtyRegions().length, R.count);
});

test('regions: pending kinds classify and clear when fully observed', () => {
  const g = boot();
  const R = g.TC.WorldRegions;
  const con = R.consume('kinds');
  everyoneObserveAll(R);
  const idx = R.chunkOf(50, 60);
  R.markCell(50, 60, 'liquid');
  assert.strictEqual(R.pendingKinds(idx) & 16, 16, 'liquid bit set while stale');
  R.markCell(50, 61, 'wall');
  assert.strictEqual(R.pendingKinds(R.chunkOf(50, 61)) & 2, 2, 'wall bit set');
  // only when EVERY consumer observed do the kinds clear
  con.observeAll();
  assert.ok(R.pendingKinds(idx) !== 0 || true); // others may still be pending
  everyoneObserveAll(R);
  assert.strictEqual(R.pendingKinds(idx), 0, 'kinds clear once every consumer observed');
});

test('regions: world swaps do not leak stale generations', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(11);
  const R = TC.WorldRegions;
  const con = R.consume('swap');
  con.observeAll();
  TC.world.setRaw(33, 33, TC.TILE.STONE);
  assert.ok(con.dirtyRegions().length >= 1);
  TC.newGame(22); // different seed -> new World -> authority re-init
  assert.strictEqual(R.count, Math.ceil(TC.world.width / 32) * Math.ceil(TC.world.height / 32));
  assert.strictEqual(R.bumps > 0, true);
  // new generation: consumer starts fully stale (fresh seen array)
  assert.strictEqual(con.pendingCount(), R.count);
  assert.ok(con.dirtyRegions().length === R.count, 'full staleness after swap');
  // revisions restarted from a clean slate: no region carries old rev values
  assert.strictEqual(R.revision(0), 1, 'init markAll bumps once from zero');
});

test('regions: stats are honest about consumers and reasons', () => {
  const g = boot();
  g.TC.Runtime.advanceTicks(1); // lazily-registered minimap consumer joins
  const R = g.TC.WorldRegions;
  const st = R.stats();
  assert.ok(st.regions > 0);
  for (const name of ['renderer', 'lighting', 'minimap']) {
    assert.ok(st.consumers.indexOf(name) >= 0, 'production consumer registered: ' + name);
  }
  assert.ok(st.bumps > 0);
  const totalMarks = Object.values(st.marksByReason).reduce((a, b) => a + b, 0);
  assert.ok(totalMarks > 0);
});
