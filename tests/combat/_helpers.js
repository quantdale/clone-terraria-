/* tests/combat/_helpers.js — shared setup for the combat-domain suites.
   Not a test file (underscore prefix keeps node --test from executing it). */
'use strict';
const { loadGame } = require('../helpers/load-game.js');

// Boot the REAL scripts and start a fresh deterministic world+player.
function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 4242 : seed);
  return g;
}

// Deterministic damage rolls: Math.random()->0.5 makes the DMG_VARIANCE
// factor exactly 1 and never rolls a crit (0.5 >= CRIT_CHANCE 0.08), so
// every rollDamage site yields Math.round(base) exactly. The vm sandbox
// shares the host Math object, so this reaches inside the game code.
function deterministicRolls(fn) {
  const real = Math.random;
  Math.random = function () { return 0.5; };
  try { return fn(); } finally { Math.random = real; }
}

let enemySeq = 0;

// Synthetic enemy shaped for TC.Enemies.damageEnemy/killEnemy and the
// projectile hit tests. kbResist 1 => no knockback movement in tests.
function makeEnemy(x, y, defOver, fieldsOver) {
  const e = Object.assign({
    type: 'test_dummy_' + (++enemySeq),
    x: x, y: y, w: 16, h: 16,
    vx: 0, vy: 0,
    hp: 100, maxHp: 100,
    flashTimer: 0,
    lastHitSwing: 0,
    master: null
  }, fieldsOver || {});
  e.def = Object.assign({
    name: 'Test Dummy', ai: 'slime', hp: 100,
    defense: 0, kbResist: 1, drops: []
  }, defOver || {});
  return e;
}

// Attach counting listeners to canonical events; returns live counts + off().
function countEvents(TC, names) {
  const counts = {};
  const fns = {};
  for (const n of names) {
    counts[n] = 0;
    fns[n] = function () { counts[n]++; };
    TC.Events.on(n, fns[n]);
  }
  return {
    counts: counts,
    off: function () { for (const n in fns) TC.Events.off(n, fns[n]); }
  };
}

module.exports = { boot, deterministicRolls, makeEnemy, countEvents };
