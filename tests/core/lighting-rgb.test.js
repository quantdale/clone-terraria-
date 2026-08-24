/* tests/core/lighting-rgb.test.js — W21 / LGT-001: the RGB lighting model.
   Proves scalar backward compatibility, independent RGB propagation and
   attenuation, colored emissive + dynamic sources, source expiry, the hard
   pool cap, world-reset hygiene, quality-profile presentation-only semantics
   and deterministic recomputation. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 4242 : seed);
  return g;
}

// Advance ticks with the PLAYER parked at (tx,ty) so the camera-follow
// carries the light window there (pinning TC.camera directly fights the
// runtime camera follow).
function settle(TC, tx, ty, ticks) {
  const p = TC.player;
  p.x = tx * 16 + 8;
  p.y = ty * 16;
  p.vx = 0; p.vy = 0;
  TC.camera.x = p.x - 300;
  TC.camera.y = p.y - 200;
  TC.Runtime.advanceTicks(ticks == null ? 30 : ticks);
}

// Sealed dark room underground: STONE shell, AIR interior, returns center.
function buildRoom(TC, bx, by) {
  const w = TC.world;
  for (let y = by - 1; y <= by + 7; y++)
    for (let x = bx - 1; x <= bx + 11; x++) w.setRaw(x, y, TC.TILE.STONE);
  for (let y = by; y <= by + 5; y++)
    for (let x = bx; x <= bx + 10; x++) w.setRaw(x, y, TC.TILE.AIR);
  return { x: bx + 5, y: by + 2 };
}

test('lighting: sky daylight is warm white; lightAt keeps scalar luminance', () => {
  const g = boot(7);
  const TC = g.TC;
  const w = TC.world;
  // find an open-sky column at noon: Sky.reset starts at day
  settle(TC, Math.floor(w.width / 2), w.surfaceY[Math.floor(w.width / 2)] - 6);
  const tx = Math.floor(w.width / 2), ty = w.surfaceY[tx] - 3;
  const rgb = TC.Lighting.lightRgbAt(tx, ty);
  assert.ok(rgb[0] > 0.9 && rgb[1] > 0.85 && rgb[2] > 0.75,
    'daylight must be warm white-ish, got ' + rgb.join(','));
  const lum = TC.Lighting.lightAt(tx, ty);
  assert.ok(lum > 0.9, 'scalar luminance stays high in daylight');
});

test('lighting: solid rock attenuates all channels toward darkness', () => {
  const g = boot(7);
  const TC = g.TC;
  const w = TC.world;
  // deep underground far from any opening
  let tx = -1, ty = -1;
  for (let x = 600; x < 700 && tx < 0; x++) {
    for (let y = 200; y < 260; y++) {
      if (TC.TILE_DEFS[w.get(x, y)].opaque &&
          TC.TILE_DEFS[w.get(x, y - 1)].opaque &&
          TC.TILE_DEFS[w.get(x, y + 1)].opaque) { tx = x; ty = y; break; }
    }
  }
  assert.ok(tx > 0, 'test fixture needs deep solid rock');
  settle(TC, tx, ty, 40);
  const rgb = TC.Lighting.lightRgbAt(tx, ty);
  assert.ok(Math.max(rgb[0], rgb[1], rgb[2]) < 0.25,
    'deep rock must be dark, got ' + rgb.join(','));
});

test('lighting: torch is a colored emitter (warm flame), not neutral', () => {
  const g = boot(7);
  const TC = g.TC;
  const room = buildRoom(TC, 700, 220);
  TC.world.set(room.x, room.y + 3, TC.TILE.TORCH); // stands on stone below
  settle(TC, room.x, room.y, 40);
  const litR = TC.Lighting.lightRgbAt(room.x, room.y);
  assert.ok(litR[0] > litR[2] + 0.15,
    'torch field must be warm (r >> b), got ' + litR.join(','));
  assert.ok(Math.max(...litR) > 0.3, 'torch must light its room');
});

test('lighting: independent RGB propagation (colored dynamic source)', () => {
  const g = boot(7);
  const TC = g.TC;
  const room = buildRoom(TC, 800, 230);
  settle(TC, room.x, room.y, 20);
  // pure violet transient light in the sealed room
  TC.Lighting.addDynamic(room.x * 16 + 8, room.y * 16 + 8, 80, 1.0, 999, '#7030f0');
  TC.Lighting.update(1 / 60, TC.camera);
  const c = TC.Lighting.lightRgbAt(room.x, room.y);
  assert.ok(c[2] > c[1] + 0.2 && c[0] < c[2],
    'violet source: b dominant, g lowest, got ' + c.join(','));
  // channels propagate INDEPENDENTLY: green channel stays low while blue is high
  assert.ok(c[1] < 0.45, 'green must not leak from a violet source');
});

test('lighting: dynamic sources expire and leave no residue', () => {
  const g = boot(7);
  const TC = g.TC;
  const p = TC.player;
  settle(TC, Math.floor(p.x / 16), Math.floor(p.y / 16), 10);
  const tx = Math.floor(p.x / 16), ty = Math.floor(p.y / 16);
  TC.Lighting.addDynamic(p.x, p.y, 96, 0.9, 0.05, '#ff0000');
  TC.Lighting.update(1 / 60, TC.camera); // ttl decays to ~0.033
  const during = TC.Lighting.lightRgbAt(tx, ty).slice();
  TC.Runtime.advanceTicks(6); // ttl fully elapsed + merge resets residue
  const after = TC.Lighting.lightRgbAt(tx, ty).slice();
  assert.ok(after[0] <= during[0] + 0.02, 'red glow must not persist after expiry');
});

test('lighting: dynamic pool is hard-capped at 64 slots with reuse', () => {
  const g = boot(7);
  const TC = g.TC;
  assert.strictEqual(TC.Lighting.dyn.length, 64);
  settle(TC, Math.floor(TC.player.x / 16), Math.floor(TC.player.y / 16), 5);
  for (let i = 0; i < 200; i++) {
    TC.Lighting.addDynamic(TC.player.x + i, TC.player.y, 32, 0.5, 999);
  }
  let alive = 0;
  for (const s of TC.Lighting.dyn) if (s.ttl > 0) alive++;
  assert.strictEqual(alive, 64, 'pool never grows beyond DYN_MAX');
});

test('lighting: legacy addDynamic signature maps to neutral white', () => {
  const g = boot(7);
  const TC = g.TC;
  const room = buildRoom(TC, 900, 240); // darkness: daylight cannot mask the glow
  settle(TC, room.x, room.y, 20);
  TC.Lighting.addDynamic(room.x * 16 + 8, room.y * 16 + 8, 80, 1.0, 999); // no color
  TC.Lighting.update(1 / 60, TC.camera);
  const c = TC.Lighting.lightRgbAt(room.x, room.y);
  assert.ok(Math.abs(c[0] - c[1]) < 0.05 && Math.abs(c[1] - c[2]) < 0.05,
    'no color argument must behave as neutral white, got ' + c.join(','));
  assert.ok(c[0] > 0.3, 'and it must actually glow in the dark');
});

test('lighting: world reset reinitializes window, pool and staleness', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(5);
  settle(TC, 100, 60, 10);
  TC.Lighting.addDynamic(TC.player.x, TC.player.y, 64, 0.8, 999);
  TC.newGame(6);
  assert.strictEqual(TC.Lighting.w, 0, 'window closed until next update');
  let alive = 0;
  for (const s of TC.Lighting.dyn) if (s.ttl > 0) alive++;
  assert.strictEqual(alive, 0, 'dynamic pool cleared');
  assert.strictEqual(TC.Lighting.fullDirty, true, 'next update reseeds');
});

test('lighting: quality profiles change presentation cost, not queried values', () => {
  const g = loadGame({ hash: '#test' });
  const TC = g.TC;
  TC.newGame(9);
  const p = TC.player;
  settle(TC, Math.floor(p.x / 16), Math.floor(p.y / 16), 30);
  const tx = Math.floor(p.x / 16), ty = Math.floor(p.y / 16);
  const read = () => {
    const rgb = TC.Lighting.lightRgbAt(tx, ty).slice();
    return [rgb[0].toFixed(4), rgb[1].toFixed(4), rgb[2].toFixed(4)].join(',');
  };
  TC.Lighting._quality = null; // fall back to stored/default ('high')
  const hi = read();
  TC.Lighting.setQuality('low');
  const lo = read();
  TC.Lighting.setQuality('medium');
  const med = read();
  assert.strictEqual(hi, lo, 'field values identical across profiles');
  assert.strictEqual(hi, med, 'medium identical too');
  assert.strictEqual(TC.Lighting.quality(), 'medium');
  assert.strictEqual(g.storage.getItem('tc_settings_v1').indexOf('"lightingQuality":"medium"') >= 0, true,
    'quality persists via TC.Settings, outside world saves');
  assert.strictEqual(TC.Lighting.setQuality('bogus'), false);
});

test('lighting: recompute is deterministic for identical inputs', () => {
  const run = () => {
    const g = boot(31);
    const TC = g.TC;
    const w = TC.world;
    // fixed edit pattern near spawn
    for (let k = 0; k < 40; k++) {
      const ex = 50 + k;
      const ey = w.surfaceY[ex] - 1 - (k % 3);
      w.setRaw(ex, ey, k % 2 ? TC.TILE.TORCH : TC.TILE.AIR);
    }
    settle(TC, 60, w.surfaceY[60] - 4, 40);
    const out = [];
    for (let ty = TC.Lighting.y0; ty < Math.min(TC.Lighting.y0 + TC.Lighting.h, TC.Lighting.y0 + 40); ty += 3) {
      for (let tx = TC.Lighting.x0; tx < Math.min(TC.Lighting.x0 + TC.Lighting.w, TC.Lighting.x0 + 60); tx += 3) {
        const c = TC.Lighting.lightRgbAt(tx, ty);
        out.push(c[0].toFixed(3) + ':' + c[1].toFixed(3) + ':' + c[2].toFixed(3));
      }
    }
    return out.join('|');
  };
  assert.strictEqual(run(), run(), 'identical seed + edits + camera => identical RGB field');
});
