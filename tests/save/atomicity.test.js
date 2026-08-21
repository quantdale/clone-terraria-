/* tests/save/atomicity.test.js — TARGET 4: saveNow's tmp → bak → main write
   sequence under failing storage. A mid-save setItem throw must leave the
   previous main/bak byte-identical and never strand a .tmp. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeGame } = require('./helpers.js');

const V2 = 'tc_save_v2';

// Wrap storage.setItem so one key (or all) throws like a full quota.
function breakSetItem(storage, failKey) {
  const orig = storage.setItem.bind(storage);
  storage.setItem = function (k, v) {
    if (!failKey || k === failKey) throw new Error('QuotaExceededError');
    return orig(k, v);
  };
  return function restore() { storage.setItem = orig; };
}

test('atomicity: tmp write failure leaves previous main and bak intact', () => {
  const g = makeGame(601);
  assert.equal(g.TC.Save.save(), true);
  const mainBefore = g.storage.getItem(V2);
  const bakBefore = g.storage.getItem(V2 + '.bak');

  g.TC.Sky.time += 5;                       // state changes; the save must not land
  const restore = breakSetItem(g.storage, V2 + '.tmp');
  let ok;
  try { ok = g.TC.SaveCore.saveNow(V2); } finally { restore(); }

  assert.equal(ok, false, 'saveNow reported success through a throwing tmp write');
  assert.equal(g.storage.getItem(V2), mainBefore, 'main was touched');
  assert.equal(g.storage.getItem(V2 + '.bak'), bakBefore, 'bak was touched');
  assert.equal(g.storage.getItem(V2 + '.tmp'), null, 'tmp left behind');
});

test('atomicity: main write failure rolls back cleanly (tmp removed, main intact)', () => {
  const g = makeGame(602);
  assert.equal(g.TC.Save.save(), true);
  const mainBefore = g.storage.getItem(V2);

  g.TC.Sky.time += 7;
  const restore = breakSetItem(g.storage, V2);
  let ok;
  try { ok = g.TC.SaveCore.saveNow(V2); } finally { restore(); }

  assert.equal(ok, false, 'saveNow reported success through a throwing main write');
  assert.equal(g.storage.getItem(V2), mainBefore, 'main changed despite the failure');
  assert.equal(g.storage.getItem(V2 + '.tmp'), null, '.tmp not cleaned up');
});

test('atomicity: successful save promotes the previous main to .bak', () => {
  const g = makeGame(603);
  assert.equal(g.TC.Save.save(), true);
  const firstRaw = g.storage.getItem(V2);

  g.TC.Sky.time += 9;
  assert.equal(g.TC.SaveCore.saveNow(V2), true);
  assert.equal(g.storage.getItem(V2 + '.bak'), firstRaw, 'previous main not backed up');
  assert.notEqual(g.storage.getItem(V2), firstRaw, 'main did not change');
  assert.equal(g.storage.getItem(V2 + '.tmp'), null);
});
