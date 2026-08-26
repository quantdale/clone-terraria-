/* tests/world/liquids-determinism.test.js — save/load must CONTINUE the
   liquid settle deterministically. The provider persists the active set
   (v2) and the settle pass processes cells in ascending index order, so a
   reload mid-drain reproduces the live session's future evolution exactly.
   Guards against regressions like journey-L's fingerprint race, where a
   rebuilt active set resolved pending water×lava contacts differently. */
'use strict';
const test = require('node:test');
const assert = require('assert');
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', 'helpers', 'load-game.js'));

const SEED = 212121;

function liquidsEnvelope(TC) {
  // Pull the payload through SaveCore itself so shape/versioning stays honest.
  const env = TC.SaveCore.buildEnvelope();
  return env.world['core.liquids'];
}

test('reload mid-drain continues the settle deterministically (active set persisted)', () => {
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  TC.Runtime.createWorld(SEED);
  TC.Runtime.advanceTicks(700); // deep into the ambient drain, still active

  const savedEntry = liquidsEnvelope(TC);
  assert.ok(savedEntry && savedEntry.v >= 2, 'liquids provider payload is v2+');
  assert.ok(Array.isArray(savedEntry.data.active), 'active set persisted');
  assert.ok(savedEntry.data.active.length > 0, 'mid-drain save has live cells');
  const digestAtSave = TC.Liquids.digest();
  const activeAtSave = JSON.stringify(savedEntry.data.active);

  // session A continues from the save point
  TC.Runtime.advanceTicks(150);
  const digestA = TC.Liquids.digest();

  // session B "reloads": fresh world (import runs), then provider restore
  TC.Runtime.reset();
  TC.Runtime.createWorld(SEED);
  const res = TC.SaveCore.restore({ world: { 'core.liquids': savedEntry } });
  assert.ok(res.restored.includes('world.core.liquids'), 'liquids restore ok: ' + JSON.stringify(res));
  assert.strictEqual(TC.Liquids.digest(), digestAtSave, 'restore reproduces saved layer bytes');
  assert.strictEqual(JSON.stringify(liquidsEnvelope(TC).data.active), activeAtSave,
    'restored active set matches the persisted one');

  TC.Runtime.advanceTicks(150);
  const digestB = TC.Liquids.digest();
  assert.strictEqual(digestB, digestA,
    'post-reload evolution diverged from the continued session');
});

test('legacy v1 bare-array liquid payloads still load', () => {
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  TC.Runtime.createWorld(777);
  TC.Runtime.advanceTicks(10);
  // hand-built v1 entry: [idx, type, amount] with a 2-cell run of water
  const W = TC.world.width;
  const i0 = 200 * W + 100;
  const legacy = { v: 1, data: [[i0, 1, 255, 2]] };
  const res = TC.SaveCore.restore({ world: { 'core.liquids': legacy } });
  assert.ok(res.restored.includes('world.core.liquids'), 'v1 array accepted');
  const q = TC.Liquids.queryAt(100, 200);
  assert.strictEqual(q.type, 1);
  assert.strictEqual(q.amount, 255);
  const q2 = TC.Liquids.queryAt(101, 200);
  assert.strictEqual(q2.amount, 255, 'run length honored');
});
