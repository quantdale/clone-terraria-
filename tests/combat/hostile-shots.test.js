/* tests/combat/hostile-shots.test.js — F-09 identity separation: hostile
   shots are tracked by shooter reference + stable type key, never by display
   name. Two same-named entities must not clear each other's shots, and a
   recycled pool slot must not keep a stale entry alive. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot, makeEnemy } = require('./_helpers.js');

function fakeShot(type) {
  return { type: type || 'magic_bolt', active: true, age: 0, maxAge: 100, owner: null, hits: [] };
}

test('hostile shots: same display name does not cross-clear', () => {
  const g = boot(4242);
  const TC = g.TC;
  const a = makeEnemy(0, 0, { name: 'Same Name', boss: true }, { type: 'boss_a' });
  const b = makeEnemy(500, 0, { name: 'Same Name', boss: true }, { type: 'boss_b' });
  const prA = fakeShot(), prB = fakeShot();
  TC.Enemies.trackHostileShot(prA, a, 10);
  TC.Enemies.trackHostileShot(prB, b, 10);
  TC.Enemies.clearHostileShotsOf(a);
  assert.strictEqual(prA.age, 101, 'cleared boss shot expires');
  assert.strictEqual(prB.age, 0, 'same-named other boss shot untouched');
});

test('hostile shots: impostor with a built-in display name is not the built-in', () => {
  const g = boot(4242);
  const TC = g.TC;
  const real = TC.Enemies.spawnEnemy('green_slime', 100, 100);
  assert.ok(real, 'real enemy spawned');
  const impostor = makeEnemy(200, 200, { name: real.def.name }, { type: 'impostor_slime' });
  const prReal = fakeShot(), prFake = fakeShot();
  TC.Enemies.trackHostileShot(prReal, real, 5);
  TC.Enemies.trackHostileShot(prFake, impostor, 5);
  TC.Enemies.clearHostileShotsOf(real);
  assert.strictEqual(prReal.age, 101, 'real shot cleared');
  assert.strictEqual(prFake.age, 0, 'impostor shot survives under a shared display name');
});

test('hostile shots: recycled pool slot discards the stale entry', () => {
  const g = boot(4242);
  const TC = g.TC;
  const shooter = makeEnemy(0, 0, { name: 'Recycler', boss: true }, { type: 'recycler' });
  const pr = fakeShot('magic_bolt');
  TC.Enemies.trackHostileShot(pr, shooter, 10);
  // pool slot recycled for a different projectile kind
  pr.type = 'arrow';
  TC.Enemies.update(1 / 60);
  // the stale entry is already gone, so clearing expires nothing
  TC.Enemies.clearHostileShotsOf(shooter);
  assert.strictEqual(pr.age, 0, 'recycled slot was discarded by the type guard, not re-cleared');
});

test('hostile shots: Wall of Flesh magic_bolt clears own orphaned shots only', () => {
  const g = boot(4242);
  const TC = g.TC;
  const wof = makeEnemy(0, 0, { name: 'Wall of Flesh', boss: true }, { type: 'wall_of_flesh' });
  const other = makeEnemy(600, 0, { name: 'Wall of Flesh', boss: true }, { type: 'wall_of_flesh_2' });
  // owner:null orphaned shots attributed by stable type key
  const prWof = fakeShot('magic_bolt');
  const prOther = fakeShot('magic_bolt');
  TC.Enemies.trackHostileShot(prWof, wof, 20);
  TC.Enemies.trackHostileShot(prOther, other, 20);
  TC.Enemies.clearHostileShotsOf(wof);
  assert.strictEqual(prWof.age, 101, 'own orphaned bolt cleared');
  assert.strictEqual(prOther.age, 0, 'same-named other wall bolt survives');
});
