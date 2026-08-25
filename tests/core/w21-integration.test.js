/* tests/core/w21-integration.test.js — W21 cross-system integration and
   determinism gates:
     - one authoritative tile edit invalidates renderer + lighting + minimap
       independently (multi-consumer fan-out at the mutation seam);
     - wall edits, raw/bulk paths and support-pop cascades keep every
       consumer consistent;
     - liquid-driven region marks reach the minimap consumer;
     - presentation churn (edits, quality switches, dynamic lights) never
       alters deterministic simulation state for the same seed + command
       trace;
     - save round-trips stay exact while presentation state is hot. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 2026 : seed);
  return g;
}

function consumers(TC) {
  return {
    renderer: TC.WorldRegions.consume('renderer'),
    lighting: TC.WorldRegions.consume('lighting'),
    minimap: TC.WorldRegions.consume('minimap')
  };
}

test('integration: a tile edit dirties all three presentation consumers', () => {
  const g = boot(1);
  const TC = g.TC;
  const cons = consumers(TC);
  for (const k in cons) cons[k].observeAll();
  TC.world.set(100, 100, TC.TILE.STONE); // authoritative full edit path
  assert.ok(cons.renderer.dirtyRegions().length >= 1, 'renderer sees the edit');
  assert.ok(cons.lighting.dirtyRegions().length >= 1, 'lighting sees the edit');
  assert.ok(cons.minimap.dirtyRegions().length >= 1, 'minimap sees the edit');
});

test('integration: lighting consumes without stealing from renderer/minimap', () => {
  const g = boot(1);
  const TC = g.TC;
  const cons = consumers(TC);
  for (const k in cons) cons[k].observeAll();
  TC.world.set(100, 100, TC.TILE.STONE);
  // run enough ticks for the lighting system to process its regions
  TC.camera.x = 90 * 16; TC.camera.y = 95 * 16;
  TC.Runtime.advanceTicks(30);
  // Lighting DELIBERATELY leaves out-of-window regions pending (handled on
  // window movement via staleAll). Assert every stale region intersecting
  // the light window was consumed.
  const L = TC.Lighting, WR = TC.WorldRegions;
  const wx1 = L.x0 + L.w - 1, wy1 = L.y0 + L.h - 1;
  const inWindowStale = cons.lighting.dirtyRegions().filter((idx) => {
    const cc = WR.chunkCoords(idx);
    return !(cc.cx * WR.CHUNK > wx1 || (cc.cx + 1) * WR.CHUNK - 1 < L.x0 ||
             cc.cy * WR.CHUNK > wy1 || (cc.cy + 1) * WR.CHUNK - 1 < L.y0);
  });
  assert.strictEqual(inWindowStale.length, 0,
    'lighting must drain its window');
  assert.ok(cons.minimap.dirtyRegions().length >= 1,
    'minimap (hidden) still holds its invalidation');
});

test('integration: wall edit dirties applicable consumers with wall reason', () => {
  const g = boot(2);
  const TC = g.TC;
  const WR = TC.WorldRegions;
  const con = WR.consume('wall-probe');
  con.observeAll();
  w: TC.world.setWall(70, 70, TC.WALL.STONE);
  const dirty = con.dirtyRegions();
  assert.strictEqual(dirty.length, 1);
  assert.strictEqual(WR.pendingKinds(dirty[0]) & 2, 2, 'reason bit "wall" recorded');
});

test('integration: support-pop cascade leaves no stale chunks anywhere', () => {
  const g = boot(3);
  const TC = g.TC;
  const cons = consumers(TC);
  for (const k in cons) cons[k].observeAll();
  const w = TC.world;
  const x = 200;
  const y = w.surfaceY[x];
  // dirt on the ground; tallgrass ('below'-anchored) on top of it.
  w.set(x, y - 1, TC.TILE.DIRT);
  w.set(x, y - 2, TC.TILE.TALLGRASS);
  for (const k in cons) cons[k].observeAll(); // settle bookkeeping between builds
  w.set(x, y - 1, TC.TILE.AIR); // remove the anchor -> cascade pops the grass
  assert.strictEqual(w.get(x, y - 2), TC.TILE.AIR, 'tallgrass lost below-support');
  // everything the cascade touched is marked: the column's region
  const touched = cons.renderer.dirtyRegions();
  const expected = [TC.WorldRegions.chunkOf(x, y - 2)];
  for (const idx of expected) {
    assert.ok(touched.indexOf(idx) >= 0, 'cascade region invalidated: ' + idx);
  }
});

test('integration: raw/bulk paths maintain correctness (setRaw + markAllDirty)', () => {
  const g = boot(4);
  const TC = g.TC;
  const cons = consumers(TC);
  for (const k in cons) cons[k].observeAll();
  TC.world.setRaw(300, 120, TC.TILE.STONE);
  assert.ok(cons.renderer.dirtyRegions().length >= 1);
  for (const k in cons) cons[k].observeAll();
  TC.world.markAllDirty(); // bulk restore path used after diff application
  assert.strictEqual(cons.renderer.dirtyRegions().length, TC.WorldRegions.count);
});

test('determinism: same seed + command trace => identical world bytes regardless of presentation churn', () => {
  function run(withChurn) {
    const g = boot(777);
    const TC = g.TC;
    // identical command trace: place/mine around spawn via canonical commands
    const p = TC.player;
    const sx = Math.floor((p.x + p.w / 2) / 16), sy = Math.floor(p.y / 16);
    const trace = [];
    for (let k = 0; k < 12; k++) {
      trace.push({ name: 'PlaceTile', ctx: { tx: sx + 2 + (k % 5), ty: sy + 3, item: 'dirt', player: p } });
      trace.push({ name: 'MineTile', ctx: { tx: sx + 2 + (k % 5), ty: sy + 3, toolPower: 55, player: p, dt: 1 / 60 } });
    }
    if (withChurn) {
      // heavy presentation noise BEFORE the trace executes
      TC.Lighting.setQuality('low');
      for (let i = 0; i < 40; i++) {
        TC.Lighting.addDynamic(p.x + i * 7, p.y, 64, 0.9, 999, '#40a0ff');
      }
      TC.MiniMap.visible = true;
    }
    for (const cmd of trace) TC.Commands.submit(cmd.name, cmd.ctx);
    TC.camera.x = (sx - 20) * 16; TC.camera.y = (sy - 15) * 16;
    TC.Runtime.advanceTicks(60);
    // world fingerprint over tiles+walls+shapes
    let hT = 0x811c9dc5, hW = 0x811c9dc5;
    for (let i = 0; i < TC.world.tiles.length; i++) {
      hT ^= TC.world.tiles[i]; hT = Math.imul(hT, 0x01000193) >>> 0;
      hW ^= TC.world.walls[i]; hW = Math.imul(hW, 0x01000193) >>> 0;
    }
    return { tiles: hT >>> 0, walls: hW >>> 0, px: p.x.toFixed(3), py: p.y.toFixed(3), hp: p.hp };
  }
  const clean = run(false);
  const churned = run(true);
  assert.deepStrictEqual(churned, clean,
    'presentation invalidation must never perturb simulation');
});

test('save: round-trip stays exact while region/lighting/minimap state is hot', () => {
  const g = loadGame({ hash: '#test' });
  const TC = g.TC;
  TC.newGame(555);
  const w = TC.world;
  // make edits, stir up all presentation state
  w.set(400, w.surfaceY[400] - 1, TC.TILE.STONE);
  w.setWall(400, w.surfaceY[400] - 1, TC.WALL.STONE);
  TC.Lighting.addDynamic(TC.player.x, TC.player.y, 80, 0.9, 999, '#ff8800');
  TC.MiniMap.visible = true;
  TC.Runtime.advanceTicks(45);
  const ok = TC.Save.save();
  assert.strictEqual(ok, true);
  const seedBefore = TC.worldSeed;
  const tileBefore = Array.from(w.tiles.slice(0, 5000));
  TC.quitToTitle();
  TC.continueGame();
  assert.strictEqual(TC.worldSeed, seedBefore);
  const restored = Array.from(TC.world.tiles.slice(0, 5000));
  assert.deepStrictEqual(restored, tileBefore, 'tiles survive exactly');
  assert.strictEqual(TC.world.get(400, TC.world.surfaceY[400] === undefined ? 0 : findPlaced(TC)), TC.TILE.STONE,
    'the edited tile is present after reload');
  function findPlaced(tc) {
    for (let y = tc.world.surfaceY[400] - 4; y < tc.world.surfaceY[400] + 4; y++) {
      if (tc.world.get(400, y) === tc.TILE.STONE && y !== tc.world.surfaceY[400]) return y;
    }
    return tc.world.surfaceY[400];
  }
});
