/* tests/npc/progression.test.js — TARGET 1: TC.Progression flag store.
   Covers set/has/all, transition-only WorldProgressChanged emission,
   BossDefeated auto-record (incl. void_eye canonical mapping), Blood Moon
   completion via Enemies.setBloodMoon(false) vs Enemies.clear(),
   spawnMultiplier math, SaveCore provider round-trip through
   continueGame, and resetForNewWorld. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

test('progression: set/has/all basics + invalid keys rejected', () => {
  const { TC } = loadGame();
  const P = TC.Progression;
  assert.equal(P.has('boss.king_slime.defeated'), false);
  assert.equal(P.set('boss.king_slime.defeated'), true, 'first set should return true');
  assert.equal(P.set('boss.king_slime.defeated'), false, 'duplicate set should return false');
  assert.equal(P.has('boss.king_slime.defeated'), true);
  // invalid keys are silently rejected
  assert.equal(P.set(''), false);
  assert.equal(P.set(null), false);
  assert.equal(P.set(42), false);
  assert.equal(P.has(''), false);
  assert.equal(P.has(null), false);
  // all() returns a sorted snapshot
  P.set('a.flag');
  P.set('b.flag');
  assert.deepStrictEqual(P.all(), ['a.flag', 'b.flag', 'boss.king_slime.defeated']);
  // snapshot: mutating the returned array must not touch the store
  const snap = P.all();
  snap.length = 0;
  assert.ok(P.all().length >= 3, 'all() returned a live reference');
});

test('progression: WorldProgressChanged fires only on unset->set transition', () => {
  const { TC } = loadGame();
  const P = TC.Progression;
  const seen = [];
  TC.Events.on(TC.Events.EVENT.WorldProgressChanged, (p) => seen.push(p && p.key));

  assert.equal(P.set('x.one'), true);
  assert.equal(P.set('x.one'), false);           // no-op
  assert.equal(P.set('x.one'), false);           // still a no-op
  assert.equal(P.set('x.two'), true);
  assert.deepStrictEqual(seen, ['x.one', 'x.two'],
    'expected exactly one event per new flag, got: ' + JSON.stringify(seen));
});

test('progression: BossDefeated auto-records flags incl. void_eye mapping', () => {
  const { TC } = loadGame();
  const P = TC.Progression;
  const EV = TC.Events.EVENT;

  TC.Events.emit(EV.BossDefeated, { type: 'void_eye' });
  assert.equal(P.has('boss.eye_of_void.defeated'), true,
    'void_eye must map to the canonical boss.eye_of_void.defeated');

  TC.Events.emit(EV.BossDefeated, { type: 'king_slime' });
  assert.equal(P.has('boss.king_slime.defeated'), true);

  // unknown future bosses derive a generic flag so they still count
  TC.Events.emit(EV.BossDefeated, { type: 'some_future_boss' });
  assert.equal(P.has('boss.some_future_boss.defeated'), true);

  // malformed payloads are ignored, not thrown on
  assert.doesNotThrow(() => TC.Events.emit(EV.BossDefeated, {}));
  assert.doesNotThrow(() => TC.Events.emit(EV.BossDefeated, null));
});

test('progression: blood moon end records event.blood_moon.completed; Enemies.clear() does not', () => {
  const { TC } = loadGame();
  const E = TC.Enemies, P = TC.Progression;
  const FLAG = P.FLAGS.eventBloodMoon;

  assert.equal(E.isBloodMoon(), false);
  E.setBloodMoon(true);
  assert.equal(E.isBloodMoon(), true);
  assert.equal(P.has(FLAG), false, 'starting the event must not record completion');

  E.setBloodMoon(false);
  assert.equal(E.isBloodMoon(), false);
  assert.equal(P.has(FLAG), true, 'ending the Blood Moon must record the completed flag');

  // ending again (no-op) must not duplicate or unrecord
  E.setBloodMoon(false);
  assert.equal(P.has(FLAG), true);

  // a second full cycle stays a single record (idempotent set)
  E.setBloodMoon(true);
  E.setBloodMoon(false);
  assert.equal(P.all().filter((k) => k === FLAG).length, 1,
    'flag store must never contain duplicates');
});

test('progression: Enemies.clear() resets blood moon WITHOUT recording completion', () => {
  const { TC } = loadGame();
  const E = TC.Enemies, P = TC.Progression;
  const FLAG = P.FLAGS.eventBloodMoon;

  E.setBloodMoon(true);
  E.clear();
  assert.equal(E.isBloodMoon(), false, 'clear() should reset the event state');
  assert.equal(P.has(FLAG), false,
    'Enemies.clear() (new world) must NOT record event.blood_moon.completed');
});

test('progression: spawnMultiplier math (0->1, 4->1.4, capped 1.5)', () => {
  const { TC } = loadGame();
  const P = TC.Progression;

  assert.equal(P.spawnMultiplier(), 1, 'no bosses -> 1x');

  for (let i = 1; i <= 4; i++) P.set('boss.t' + i + '.defeated');
  const m4 = P.spawnMultiplier();
  assert.ok(Math.abs(m4 - 1.4) < 1e-9, '4 bosses -> 1.4x, got ' + m4);

  for (let i = 5; i <= 12; i++) P.set('boss.t' + i + '.defeated');
  assert.equal(P.spawnMultiplier(), 1.5, 'many bosses must cap at 1.5x');

  // non-boss flags never contribute
  const m = P.spawnMultiplier();
  P.set('event.blood_moon.completed');
  P.set('boss.incomplete');            // does not match ^boss\..+\.defeated$
  assert.equal(P.spawnMultiplier(), m, 'non-matching flags changed the multiplier');
});

test('progression: SaveCore provider round-trips flags across fresh boot + continueGame', () => {
  const g1 = loadGame();
  const TC1 = g1.TC;
  TC1.newGame(4242);
  TC1.Progression.set(TC1.Progression.FLAGS.bossKingSlime);
  TC1.Progression.set(TC1.Progression.FLAGS.bossEyeOfVoid);
  TC1.Progression.set(TC1.Progression.FLAGS.eventBloodMoon);
  assert.equal(TC1.Save.save(), true, 'save failed');

  // Same browser profile: copy storage into a brand-new boot.
  const g2 = loadGame();
  g1.storage._map.forEach((v, k) => g2.storage.setItem(k, v));

  const loadedEvents = [];
  g2.TC.Events.on(g2.TC.Events.EVENT.WorldProgressChanged, (p) => loadedEvents.push(p && p.key));
  g2.TC.continueGame();

  const P2 = g2.TC.Progression;
  assert.equal(P2.has('boss.king_slime.defeated'), true, 'king_slime flag lost in round-trip');
  assert.equal(P2.has('boss.eye_of_void.defeated'), true, 'eye_of_void flag lost in round-trip');
  assert.equal(P2.has('event.blood_moon.completed'), true, 'blood moon flag lost in round-trip');
  assert.deepStrictEqual(loadedEvents, [],
    'deserialize must not emit WorldProgressChanged: ' + JSON.stringify(loadedEvents));
});

test('progression: resetForNewWorld clears everything', () => {
  const { TC } = loadGame();
  const P = TC.Progression;
  P.set('boss.king_slime.defeated');
  P.set('event.blood_moon.completed');
  P.resetForNewWorld();
  assert.deepStrictEqual(P.all(), []);
  assert.equal(P.has('boss.king_slime.defeated'), false);
  assert.equal(P.spawnMultiplier(), 1, 'multiplier must reset with the flags');
});
