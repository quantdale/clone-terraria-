/* tests/core/systems.test.js — TC.Systems phase ordering, after/before
   constraints + cycle detection, initAll isolation, duplicate replace-in-place,
   boot-task registry; TC.RenderLayers basics. Each test gets a fresh VM via
   loadGame, so registrations never leak between tests. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');
const { quietConsole } = require('./helpers.js');

test('systems: updateAll walks phases exactly in declared PHASES order', () => {
  const g = loadGame();
  const TC = g.TC;
  const ran = [];
  for (const phase of TC.Systems.PHASES) {
    TC.Systems.register(phase, 'probe_' + phase, { update: () => ran.push(phase) });
  }
  TC.Systems.updateAll(1 / 60);
  assert.deepStrictEqual(Array.from(ran), Array.from(TC.Systems.PHASES),
    'execution order must match the declared PHASES array');
});

test('systems: after/before constrain order within a phase; unknown names ignored', () => {
  const g = loadGame();
  const TC = g.TC;
  const ran = [];
  const mk = (n) => ({ update: () => ran.push(n) });
  // Registered deliberately scrambled; constraints must dominate.
  TC.Systems.register('combat', 'zeta', mk('zeta'));
  TC.Systems.register('combat', 'alpha', mk('alpha'), { after: ['zeta', 'no-such-sys'] });
  TC.Systems.register('combat', 'mid', mk('mid'), { before: ['omega'] });
  TC.Systems.register('combat', 'omega', mk('omega'), { after: ['alpha'] });
  const order = TC.Systems.resolveOrder('combat').map((e) => e.name);
  const idx = (n) => order.indexOf(n);
  assert.ok(idx('zeta') < idx('alpha'), 'after must place alpha behind zeta');
  assert.ok(idx('alpha') < idx('mid') && idx('mid') < idx('omega'),
    'before/after chain must hold: alpha -> mid -> omega');
  assert.strictEqual(order.includes('no-such-sys'), false,
    'unknown constraint names must not materialize as systems');
});

test('systems: constraint cycle makes resolveOrder throw and updateAll skip the phase', () => {
  const g = loadGame();
  const TC = g.TC;
  let ran = 0;
  quietConsole(() => {
    TC.Systems.register('items', 'u', { update: () => { ran += 1; }, init: () => {} },
      { before: ['v'] });
    TC.Systems.register('items', 'v', { update: () => { ran += 10; } }, { before: ['u'] });
    assert.throws(() => TC.Systems.resolveOrder('items'), /cycle/i);
    TC.Systems.updateAll(1 / 60);               // must not throw
    TC.Systems.initAll();                       // cyclic phase skipped too
  });
  assert.strictEqual(ran, 0, 'cyclic phase systems must not run');
  // Other phases still run.
  let other = 0;
  TC.Systems.register('ai', 'w', { update: () => { other = 1; } });
  TC.Systems.updateAll(1 / 60);
  assert.strictEqual(other, 1, 'unrelated phases keep running despite one cyclic phase');
});

test('systems: duplicate registration replaces in place, keeping the original slot', () => {
  const g = loadGame();
  const TC = g.TC;
  const ran = [];
  // Production owns some input-phase registrations (ui); assert only the
  // probe trio's relative order.
  TC.Systems.register('input', 'first', { update: () => ran.push('first') });
  TC.Systems.register('input', 'dup-me', { update: () => ran.push('old-dup') });
  TC.Systems.register('input', 'last', { update: () => ran.push('last') });
  TC.Systems.register('input', 'dup-me', { update: () => ran.push('new-dup') });
  const order = Array.from(TC.Systems.resolveOrder('input'), (e) => e.name)
    .filter((n) => ['first', 'dup-me', 'last'].includes(n));
  assert.deepStrictEqual(order, ['first', 'dup-me', 'last'], 'slot preserved on replace');
  TC.Systems.updateAll(1 / 60);
  assert.ok(ran.includes('new-dup') && !ran.includes('old-dup'),
    'replacement system function is the one that runs');
});

test('systems: initAll runs every init once, isolates throws, and is idempotent', () => {
  const g = loadGame();
  const TC = g.TC;
  const inited = [];
  quietConsole(() => {
    TC.Systems.register('movement', 'bad-init', { init: () => { throw new Error('init boom'); } });
    TC.Systems.register('movement', 'good-init', { init: () => inited.push('good') });
    const r1 = TC.Systems.initAll();
    assert.strictEqual(r1.failed, 1, 'the throwing init is reported failed');
    assert.ok(inited.includes('good'), 'a throwing sibling does not stop other inits');
    const r2 = TC.Systems.initAll();
    assert.strictEqual(r2.ran, 0, 'initAll is idempotent within an armed lifetime');
  });
  assert.deepStrictEqual(inited, ['good']);
});

test('systems: rejected registrations return null (bad phase/name/empty sys)', () => {
  const g = loadGame();
  const TC = g.TC;
  quietConsole(() => {
    assert.strictEqual(TC.Systems.register('not-a-phase', 'x', { update() {} }), null);
    assert.strictEqual(TC.Systems.register('ai', '', { update() {} }), null);
    assert.strictEqual(TC.Systems.register('ai', 'y', {}), null,
      'sys needs init or update');
  });
});

test('systems: boot tasks run once per arming; re-register re-arms; invalid rejected', () => {
  const g = loadGame();
  const TC = g.TC;
  let n = 0;
  assert.ok(TC.Systems.boot('t1', { init: () => n++ }));
  quietConsole(() => {
    assert.strictEqual(TC.Systems.boot('bad', {}), null, 'task needs {init}');
    assert.strictEqual(TC.Systems.boot('', { init() {} }), null);
  });
  const r1 = TC.Systems.runBoot();
  assert.strictEqual(n, 1);
  assert.strictEqual(r1.ran >= 1, true);        // real modules also register boot tasks
  TC.Systems.runBoot();                          // already done — stays put
  assert.strictEqual(n, 1);
  TC.Systems.boot('t1', { init: () => n += 100 }); // replaces + re-arms
  TC.Systems.runBoot();
  assert.strictEqual(n, 101);
});

test('renderLayers: unknown layer rejected; throwing drawer isolated; clear() removes', () => {
  const g = loadGame();
  const TC = g.TC;
  const canvasCtx = TC.canvas.getContext('2d');
  const drew = [];
  quietConsole(() => {
    assert.strictEqual(TC.RenderLayers.register('no-such-layer', 'x', () => {}), null);
    // Real game drawers are already registered by boot; wipe to control the run.
    TC.RenderLayers.clear(null);
    TC.RenderLayers.register('particles', 'bad', () => { throw new Error('x'); });
    TC.RenderLayers.register('particles', 'ok-world', () => drew.push('w'));
    TC.RenderLayers.register('hud', 'hud-draw', () => drew.push('s'));
    try {
      TC.RenderLayers.drawWorld(canvasCtx, { x: 0, y: 0, zoom: 1 });
      TC.RenderLayers.drawScreen(canvasCtx, 100, 100);
    } catch (e) {
      assert.fail('a throwing drawer must be isolated, not propagate: ' + e.message);
    }
  });
  assert.deepStrictEqual(drew, ['w', 's'], 'world layers then screen layers, isolation intact');
  const listed = TC.RenderLayers.list().map((e) => e.name);
  assert.ok(listed.includes('ok-world') && listed.includes('hud-draw'));
  const n = TC.RenderLayers.clear('particles');
  assert.strictEqual(n, 2);
});
