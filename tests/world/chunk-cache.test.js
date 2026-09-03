/* tests/world/chunk-cache.test.js — the renderer's chunk canvas cache is
   BOUNDED. Long travel sessions used to retain every revealed 512x512
   canvas (~1MB each). Eviction must (a) cap memory, (b) never drop on-screen
   chunks, and (c) rebuild an evicted chunk synchronously when its area is
   drawn again. Eviction must NOT re-mark WorldRegions (other consumers keep
   their still-valid state) and must not create rebuild/evict churn. */
'use strict';
const test = require('node:test');
const assert = require('assert');
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', '..', 'tests', 'helpers', 'load-game.js'));

function makeCtxStub() {
  // draw() only needs drawImage + imageSmoothingEnabled from the context.
  return { canvas: { width: 1280, height: 720 }, imageSmoothingEnabled: true, drawImage() {} };
}

test('chunk canvas cache stays bounded and evicted chunks redraw cleanly', () => {
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  const SEED = 20260824;
  TC.Runtime.createWorld(SEED);
  const w = TC.world;
  const total = w.chunksX * w.chunksY;
  assert.ok(total > 200, 'world has enough chunks to exercise eviction');

  // Build EVERY chunk canvas directly (simulates a long journey's retention).
  for (let key = 0; key < total; key++) w.rebuildChunk(key);
  assert.strictEqual(w.chunks.size, total);

  // Camera sits at spawn; the update phase must cap the cache (eviction
  // lives in update(), not on the per-frame draw() path — W27 WS3) and
  // spare the screen. The ceiling is viewport-derived (see chunkCap()).
  const cam = TC.camera;
  cam.zoom = 2;
  for (let i = 0; i < 5; i++) w.update(1 / 60);
  const cap = w.chunkCap().cap;
  assert.ok(w.chunks.size <= cap, 'cache capped, size=' + w.chunks.size + ' cap=' + cap);
  const span = w.CHUNK * TC.CONST.TS;
  const ccx = Math.floor((cam.x + TC.canvas.width / (2 * cam.zoom)) / span);
  const ccy = Math.floor((cam.y + TC.canvas.height / (2 * cam.zoom)) / span);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ccx + dx, cy = ccy + dy;
      if (cx < 0 || cy < 0 || cx >= w.chunksX || cy >= w.chunksY) continue;
      assert.ok(w.chunks.has(cy * w.chunksX + cx), `on-screen chunk ${cx},${cy} kept`);
    }
  }
  const sizeAfterFirstEvict = w.chunks.size;

  // No churn: repeated draws at the same camera must not change the cache
  // (visible chunks are present and clean, so draw() repairs nothing).
  w.draw(makeCtxStub(), cam);
  w.draw(makeCtxStub(), cam);
  assert.strictEqual(w.chunks.size, sizeAfterFirstEvict, 'no rebuild/evict churn');

  // Reveal: move the camera over a missing chunk — draw() rebuilds it on the
  // spot without any WorldRegions traffic.
  const missing = [];
  for (let key = 0; key < total; key++) if (!w.chunks.has(key)) missing.push(key);
  assert.ok(missing.length > 0);
  const target = missing[0];
  const tcxPx = ((target % w.chunksX) * w.CHUNK + w.CHUNK / 2) * TC.CONST.TS;
  const tcyPx = (((target / w.chunksX) | 0) * w.CHUNK + w.CHUNK / 2) * TC.CONST.TS;
  cam.x = tcxPx - TC.canvas.width / (2 * cam.zoom);
  cam.y = tcyPx - TC.canvas.height / (2 * cam.zoom);
  w.draw(makeCtxStub(), cam);
  assert.ok(w.chunks.has(target), 'evicted chunk rebuilt when its area is drawn');
});

test('eviction does not disturb other region consumers', () => {
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  TC.Runtime.createWorld(20260825);
  const w = TC.world;
  for (let key = 0; key < w.chunksX * w.chunksY; key++) w.rebuildChunk(key);
  const cons = w._regions;
  const cam = TC.camera;
  cam.zoom = 2;
  // Eviction itself (direct call): caps the cache without touching any
  // region queue — it only drops canvases, never re-marks. consume() is
  // idempotent: returns the live lighting cursor when registered.
  const lighting = TC.WorldRegions.consume('lighting');
  const rpBefore = cons.pendingCount();
  const lpBefore = lighting.pendingCount();
  w.evictFarChunks();
  assert.ok(w.chunks.size <= w.chunkCap().cap, 'eviction ran');
  assert.strictEqual(cons.pendingCount(), rpBefore,
    'renderer consumer queue untouched by eviction');
  assert.strictEqual(lighting.pendingCount(), lpBefore,
    'lighting consumer queue untouched by eviction');
  // And the update phase drives eviction on its own once over capacity.
  for (let key = 0; key < w.chunksX * w.chunksY; key++) w.rebuildChunk(key);
  for (let i = 0; i < 5; i++) w.update(1 / 60);
  assert.ok(w.chunks.size <= w.chunkCap().cap, 'update-phase eviction capped the cache');
});
