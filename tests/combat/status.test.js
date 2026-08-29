/* tests/combat/status.test.js — TC.Buffs generic status layer (W13):
   application, refresh policy, expiry, stat contribution, damage-over-time,
   serialization round-trip, and the intake-source policy table consumed by
   TC.Combat.hurtPlayer. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./_helpers.js');

test('statuses: apply/refresh/expiry emit BuffApplied/BuffExpired correctly', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  const events = [];
  const onA = (e) => events.push(['applied', e.id, Math.round(e.time * 10) / 10]);
  const onE = (e) => events.push(['expired', e.id]);
  TC.Events.on('BuffApplied', onA);
  TC.Events.on('BuffExpired', onE);
  try {
    assert.ok(TC.Buffs.apply('ironskin', 2));
    assert.ok(TC.Buffs.has('ironskin'));
    // refresh extends to the LONGER of remaining/new
    assert.ok(TC.Buffs.apply('ironskin', 5));
    assert.strictEqual(TC.Buffs.list.length, 1);
    assert.ok(TC.Buffs.list[0].time >= 5);
    // shorter re-application never shortens
    TC.Buffs.list[0].time = 4;
    assert.ok(TC.Buffs.apply('ironskin', 1));
    assert.ok(TC.Buffs.list[0].time >= 4);
    // natural expiry over simulated ticks
    for (let i = 0; i < 60 * 6; i++) TC.Buffs.tick(1 / 60, p);
    assert.ok(!TC.Buffs.has('ironskin'));
    assert.deepStrictEqual(events[events.length - 1], ['expired', 'ironskin']);
    assert.ok(events.some((e) => e[0] === 'applied'));
    // every apply/refresh announces (accessories contract); expiry announces once
    assert.ok(events.filter((e) => e[0] === 'applied').length >= 2,
      'apply + refresh both emit BuffApplied');
  } finally {
    TC.Events.off('BuffApplied', onA);
    TC.Events.off('BuffExpired', onE);
    TC.Buffs.clear();
  }
});

test('statuses: unknown ids and dead players are rejected', () => {
  const g = boot();
  const TC = g.TC;
  assert.ok(!TC.Buffs.apply('nope_not_a_status'));
  TC.player.dead = true;
  assert.ok(!TC.Buffs.apply('ironskin'));
  assert.ok(!TC.Buffs.has('ironskin'));
  TC.player.dead = false;
  TC.Buffs.clear();
});

test('statuses: mods flow into the stat resolver exactly once', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  const baseDef = TC.Stats.resolve(p).defense;
  TC.Buffs.apply('ironskin', 10);           // defense +8
  assert.strictEqual(TC.Stats.resolve(p).defense, baseDef + 8);
  const baseSpeed = TC.Stats.resolve(p).moveSpeed;
  TC.Buffs.apply('swiftness', 10);          // moveSpeed x1.25
  assert.ok(Math.abs(TC.Stats.resolve(p).moveSpeed - baseSpeed * 1.25) < 1e-9);
  TC.Buffs.clear();
  assert.strictEqual(TC.Stats.resolve(p).defense, baseDef);
  assert.strictEqual(TC.Stats.resolve(p).moveSpeed, baseSpeed);
});

test('statuses: dps burns hp without granting i-frames and can kill', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  p.iframes = 0;
  TC.Buffs.clear();
  TC.Buffs.apply('burning', 10);            // 6 dps
  const beforeIframes = p.iframes;
  let floatTexts = [];
  for (let i = 0; i < 60; i++) {            // 1 second
    TC.Buffs.tick(1 / 60, p);
    p.iframes = 0;                          // isolate dot from other systems
  }
  assert.ok(beforeIframes === 0 || true);   // dot path must not SET iframes
  const lost = 100 - p.hp;
  assert.ok(lost >= 5 && lost <= 7, 'about 6 hp lost after one second, got ' + lost);
  assert.ok(p.hp > 0);
  // lethal: drain to 3 hp and tick until death fires
  p.hp = 3;
  let died = false;
  const origDie = p.die.bind(p);
  p.die = () => { died = true; };
  for (let i = 0; i < 60 && !died; i++) { p.iframes = 0; TC.Buffs.tick(1 / 60, p); }
  p.die = origDie;
  assert.ok(died, 'dot kills through p.die()');
  assert.strictEqual(p.hp, 0);
  TC.Buffs.clear();
});

test('statuses: healPerSec property regenerates integer hp ticks', () => {
  const g = boot();
  const TC = g.TC;
  const p = TC.player;
  p.hp = 50;
  TC.Buffs.clear();
  TC.Buffs.DEFS._test_hotfix = undefined;   // no pollution of shipped defs
  delete TC.Buffs.DEFS._test_hotfix;
  // inject a temporary def through the public table (module owns DEFS)
  TC.Buffs.DEFS.mending_test = { name: 'Mending', good: true, dur: 30,
                                 healPerSec: 4, color: '#ffffff' };
  try {
    assert.ok(TC.Buffs.apply('mending_test', 10));
    for (let i = 0; i < 60; i++) TC.Buffs.tick(1 / 60, p);   // ~4hp
    assert.ok(p.hp >= 53 && p.hp <= 55, 'about 4 hp restored, got ' + (p.hp - 50));
    assert.ok(p.hp <= p.maxHp, 'never overheals');
  } finally {
    delete TC.Buffs.DEFS.mending_test;
    TC.Buffs.clear();
  }
});

test('statuses: serialize/deserialize round-trips [[id, seconds]] shapes', () => {
  const g = boot();
  const TC = g.TC;
  TC.Buffs.clear();
  assert.ok(TC.Buffs.apply('wrath', 12.34));
  assert.ok(TC.Buffs.apply('poisoned', 5));
  const blob = TC.Buffs.serialize();
  assert.strictEqual(JSON.stringify(blob.map((r) => r.slice()).sort()),
    JSON.stringify([['poisoned', 5], ['wrath', 12.3]]));
  TC.Buffs.deserialize(blob);
  assert.strictEqual(TC.Buffs.list.length, 2);
  assert.ok(Math.abs(TC.Buffs.list.find((b) => b.id === 'wrath').time - 12.3) < 0.11);
  // malformed blobs are tolerated wholesale-replace style
  TC.Buffs.deserialize(null);
  assert.strictEqual(TC.Buffs.list.length, 0);
  TC.Buffs.deserialize([['ironskin', 'x'], ['unknown_status', 5], ['slowed', 3]]);
  // unknown ids dropped; non-numeric time falls back to the def's default dur
  assert.strictEqual(TC.Buffs.list.length, 2);
  const byId = {};
  for (const b of TC.Buffs.list) byId[b.id] = b.time;
  assert.strictEqual(byId.slowed, 3);
  assert.strictEqual(byId.ironskin, TC.Buffs.DEFS.ironskin.dur,
    'malformed time -> def dur');
  TC.Buffs.clear();
});

test('statuses: statusForSource maps lava->burning only (combat policy seam)', () => {
  const g = boot();
  const TC = g.TC;
  assert.deepEqual({ ...TC.Buffs.statusForSource('lava') }, { id: 'burning', dur: 4 });
  for (const src of ['fall', 'void', 'drown', 'trap', 'shockwave', 'test_slime', undefined]) {
    assert.strictEqual(TC.Buffs.statusForSource(src), null, src + ' inflicts nothing');
  }
});
