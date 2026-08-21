/* tests/core/events.test.js — TC.Events semantics: on/off/once/emit, queue+flush
   FIFO, listener exception isolation, wildcard, mutation-during-dispatch safety,
   nested emit, and that the main loop's flush() actually drains the queue. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');
const { boot, spyEvents, quietConsole } = require('./helpers.js');

test('events: on/emit delivers payload + name immediately, in registration order', () => {
  const g = boot();
  const TC = g.TC;
  const seen = [];
  const offA = TC.Events.on('Ping', (p, n) => seen.push(['a', n, p]));
  TC.Events.on('Ping', (p, n) => seen.push(['b', n, p]));
  const payload = { k: 1 };
  TC.Events.emit('Ping', payload);
  assert.deepStrictEqual(seen, [['a', 'Ping', payload], ['b', 'Ping', payload]]);
  offA();                                       // unsubscribe fn returned by on()
  seen.length = 0;
  TC.Events.emit('Ping', {});
  assert.deepStrictEqual(seen.map((e) => e[0]), ['b']);
});

test('events: off removes the listener; unknown/mismatched off is a no-op', () => {
  const g = boot();
  const TC = g.TC;
  let n = 0;
  const fn = () => n++;
  TC.Events.on('E1', fn);
  TC.Events.off('E1', fn);
  TC.Events.off('E1', fn);                      // double-off safe
  TC.Events.off('NeverHeardOf', fn);
  TC.Events.emit('E1');
  assert.strictEqual(n, 0);
});

test('events: once fires exactly once, even when the handler re-emits', () => {
  const g = boot();
  const TC = g.TC;
  let n = 0;
  TC.Events.once('R', function () {             // eslint-disable-line prefer-arrow-callback
    n++;
    TC.Events.emit('R');                        // re-entrant during its own dispatch
  });
  TC.Events.emit('R');
  TC.Events.emit('R');
  assert.strictEqual(n, 1, 'once listener must not re-arm via re-entrant emit');
});

test('events: queue + flush drains FIFO; events queued during flush wait for next flush', () => {
  const g = boot();
  const TC = g.TC;
  const order = [];
  TC.Events.on('Q', (p) => order.push(p.n));
  TC.Events.on('X', () => { TC.Events.queue('Q', { n: 'deferred' }); });
  TC.Events.queue('Q', { n: 1 });
  TC.Events.queue('Q', { n: 2 });
  TC.Events.queue('X', {});
  TC.Events.flush();
  assert.deepStrictEqual(order, [1, 2], 'FIFO within one flush');
  assert.deepStrictEqual(order, [1, 2], 'queued-during-flush event stays pending');
  TC.Events.flush();
  assert.deepStrictEqual(order, [1, 2, 'deferred'], 'drained by the NEXT flush');
});

test('events: main loop step() flush actually drains queued events', () => {
  // Several frames: the first frame is a negative-dt warmup (harness starts
  // timestamps at 0 while main.js seeds `last` from performance.now()).
  const g = loadGame({ frames: 10 });            // frame loop steps real main.js
  const TC = g.TC;
  TC.newGame(7);
  const s = spyEvents(TC, ['FlushPing']);
  TC.Events.queue('FlushPing', { n: 1 });
  g.startFrameLoop();
  assert.strictEqual(s.count('FlushPing'), 1,
    'main.js step() must call TC.Events.flush() so queued events deliver');
});

test('events: a throwing listener neither breaks siblings nor the bus', () => {
  const g = boot();
  const TC = g.TC;
  const got = [];
  quietConsole(() => {
    TC.Events.on('Boom', () => { throw new Error('listener exploded'); });
    TC.Events.on('Boom', (p) => got.push(p));
    TC.Events.emit('Boom', { ok: true });       // must not throw
    TC.Events.emit('Boom', { ok: true });       // and the bus stays usable
  });
  assert.deepStrictEqual(got, [{ ok: true }, { ok: true }]);
});

test('events: wildcard listeners see named events with name + payload', () => {
  const g = boot();
  const TC = g.TC;
  const seen = [];
  TC.Events.on('*', (p, n) => seen.push(n));
  TC.Events.emit('Alpha', {});
  TC.Events.emit('Beta', {});
  assert.deepStrictEqual(seen, ['Alpha', 'Beta']);
});

test('events: direct emit of the wildcard name delivers exactly once to wildcard listeners', () => {
  const g = boot();
  const TC = g.TC;
  let n = 0;
  TC.Events.on('*', () => n++);
  TC.Events.emit('*', {});                      // degenerate but must not double-fire
  assert.strictEqual(n, 1, "emit('*') ran '*' listeners twice");
});

test('events: mutation during dispatch is safe (unsubscribe a later listener mid-flight)', () => {
  const g = boot();
  const TC = g.TC;
  const got = [];
  let offB = () => {};
  const offA = TC.Events.on('M', () => offB()); // A removes B before B runs
  offB = TC.Events.on('M', (p) => got.push(p));
  TC.Events.emit('M', { v: 1 });
  assert.deepStrictEqual(got, [], 'unsubscribed listener must be skipped in the same dispatch');
  offA();
});

test('events: listeners added during dispatch are deferred to the next emit', () => {
  const g = boot();
  const TC = g.TC;
  const got = [];
  const offAdder = TC.Events.on('D', () => { TC.Events.on('D', (p) => got.push(p)); });
  TC.Events.emit('D', { i: 1 });                // adder runs; new listener not in snapshot
  assert.deepStrictEqual(got, []);
  TC.Events.emit('D', { i: 2 });                // from here on it participates
  assert.deepStrictEqual(got, [{ i: 2 }]);
  offAdder();
});

test('events: nested emit of a different event completes without recursion issues', () => {
  const g = boot();
  const TC = g.TC;
  const seen = [];
  const offA = TC.Events.on('Outer', () => { seen.push('outer'); TC.Events.emit('Inner', {}); });
  const offB = TC.Events.on('Inner', () => seen.push('inner'));
  TC.Events.emit('Outer', {});
  assert.deepStrictEqual(seen, ['outer', 'inner']);
  offA(); offB();
});

test('events: malformed calls are rejected without throwing', () => {
  const g = boot();
  const TC = g.TC;
  quietConsole(() => {
    TC.Events.on('', () => {});
    TC.Events.on(null, () => {});
    TC.Events.on('ValidName', 'not-a-function');
    TC.Events.emit('');
    TC.Events.queue(42, {});
    TC.Events.off('ValidName', undefined);
    TC.Events.emit('ValidName', {});            // bus still healthy
  });
});
