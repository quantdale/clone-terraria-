/* tests/save/corruption.test.js — TARGET 3: the storage-level corruption
   matrix. main → .bak → legacy → null recovery ladder, future-format
   rejection, leftover .tmp handling, and "no crash, no silent wipe" for
   every case. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeGame } = require('./helpers.js');

const V2 = 'tc_save_v2';

// Boot + two distinguishable saves: bak holds savedAt[0], main holds savedAt[1].
function bootWithBackup(seed) {
  const g = makeGame(seed);
  const TC = g.TC;
  assert.equal(TC.Save.save(), true);
  const firstRaw = g.storage.getItem(V2);
  TC.Sky.time += 111;
  assert.equal(TC.Save.save(), true);
  const secondRaw = g.storage.getItem(V2);
  const bakRaw = g.storage.getItem(V2 + '.bak');
  assert.ok(bakRaw, 'bak not promoted on second save');
  return { g, TC, firstRaw, secondRaw, bakRaw };
}

test('corruption: truncated JSON main recovers from a good .bak', () => {
  const { g, TC, secondRaw, bakRaw } = bootWithBackup(555);
  const truncated = secondRaw.slice(0, Math.floor(secondRaw.length * 0.6));
  g.storage.setItem(V2, truncated);

  const env = TC.SaveCore.loadFrom(V2);
  assert.ok(env, 'loadFrom returned null despite a good bak');
  assert.equal(env.metadata.savedAt, JSON.parse(bakRaw).metadata.savedAt,
    'recovered envelope is not the bak copy');
  // Save.load flattens the recovered envelope too.
  const flat = TC.Save.load();
  assert.ok(flat && Array.isArray(flat.diffs), 'Save.load lost the bak fallback');
});

test('corruption: structurally invalid JSON falls back to bak (or null alone)', () => {
  const { g, TC, bakRaw } = bootWithBackup(556);
  g.storage.setItem(V2, JSON.stringify({ formatVersion: 2, gameVersion: 'x' }));
  let env = TC.SaveCore.loadFrom(V2);
  assert.ok(env, 'invalid structure did not fall back to bak');
  assert.equal(env.metadata.savedAt, JSON.parse(bakRaw).metadata.savedAt);

  // Same garbage with no bak at all -> clean null.
  const g2 = makeGame(557);
  g2.storage.setItem(V2, '{"formatVersion":2,"gameVersion":"x"}');
  assert.equal(g2.TC.SaveCore.loadFrom(V2), null);
  assert.equal(g2.TC.Save.load(), null);
});

test('corruption: future formatVersion fails explicitly and is never wiped', () => {
  const { g, TC, secondRaw } = bootWithBackup(558);
  const futureEnv = JSON.parse(secondRaw);
  futureEnv.formatVersion = 99;

  // Alone (no usable bak): explicit failure — null, bytes untouched.
  g.storage.setItem(V2, JSON.stringify(futureEnv));
  g.storage.removeItem(V2 + '.bak');
  assert.equal(TC.SaveCore.loadFrom(V2), null, 'future format silently loaded');
  assert.equal(TC.Save.load(), null);
  assert.equal(g.storage.getItem(V2), JSON.stringify(futureEnv),
    'failed load mutated the stored future save');
  assert.equal(TC.Save.hasSave(), true, 'unreadable save should still be discoverable');

  // With a good bak underneath: the bak wins.
  g.storage.setItem(V2 + '.bak', secondRaw);
  const env = TC.SaveCore.loadFrom(V2);
  assert.ok(env && env.formatVersion === 2, 'good bak not used under a future main');
});

test('corruption: leftover .tmp is ignored by loads and cleaned by the next save', () => {
  const { g, TC, secondRaw } = bootWithBackup(559);
  g.storage.setItem(V2 + '.tmp', '{"interrupted":tru');
  const env = TC.SaveCore.loadFrom(V2);
  assert.ok(env, 'leftover tmp broke loadFrom');
  assert.equal(env.metadata.seed, 559);
  assert.equal(g.storage.getItem(V2), secondRaw, 'load touched main');
  assert.equal(TC.Save.save(), true, 'save after interrupted run failed');
  assert.equal(g.storage.getItem(V2 + '.tmp'), null, 'tmp not cleaned after successful save');
});

test('corruption: main and bak both bad -> null, never a crash', () => {
  const { g, TC } = bootWithBackup(560);
  g.storage.setItem(V2, '{"a":1');
  g.storage.setItem(V2 + '.bak', '<not json at all>');
  let out;
  assert.doesNotThrow(() => { out = TC.SaveCore.loadFrom(V2); });
  assert.equal(out, null);
  assert.doesNotThrow(() => { out = TC.Save.load(); });
  assert.equal(out, null);          // no legacy v1 blob present either
});

test('legacy blob parked under the v2 key converts but does not flatten', () => {
  const { g, TC } = bootWithBackup(561);
  const legacy = {
    v: 1, seed: 42, time: 10, diffs: [], player: null
  };
  g.storage.setItem(V2, JSON.stringify(legacy));
  g.storage.removeItem(V2 + '.bak');
  const env = TC.SaveCore.loadFrom(V2);
  assert.ok(env, 'legacy blob under v2 key rejected outright');
  assert.equal(env.formatVersion, 2);
  assert.equal(env.systems.legacy.data.v, 1);
  assert.equal(env.metadata.convertedFrom, 1);
  // Without world.core there is nothing to flatten; Save.load must say so.
  assert.equal(TC.Save.load(), null);
});
