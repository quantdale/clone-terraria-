/* tests/save/persistence-failures.test.js — F-07: save-write outcome
   accounting, failure classification, reclaim-before-fail recovery, and the
   rate-limited autosave notice. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeGame } = require('./helpers.js');

const V2 = 'tc_save_v2';

// Storage stub whose setItem throws a real capacity error on chosen keys.
function quotaFail(storage, opts) {
  opts = opts || {};
  const orig = storage.setItem.bind(storage);
  let calls = 0;
  storage.setItem = function (k, v) {
    calls++;
    const onMainFirstOnly = opts.mainFirstOnly && k === V2 && calls <= 2;
    if (opts.failTmp && k === V2 + '.tmp') {
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      throw e;
    }
    if (opts.failMain && (k === V2 || !opts.failTmp) && !onMainFirstOnly) {
      if (!opts.failTmp && k === V2 + '.bak') return orig(k, v);
      const e = new Error('quota');
      e.name = 'QuotaExceededError';
      throw e;
    }
    return orig(k, v);
  };
  return function restore() { storage.setItem = orig; };
}

test('failure counters increment and classify a storage error', () => {
  const g = makeGame(701);
  assert.equal(g.TC.Save.save(), true);
  const before = g.TC.Save.stats();
  const realSet = g.storage.setItem.bind(g.storage);
  g.storage.setItem = function () { throw new Error('disk smoke'); };
  try {
    assert.equal(g.TC.Save.save(), false);
  } finally {
    g.storage.setItem = realSet;
  }
  const after = g.TC.Save.stats();
  assert.equal(after.attempts, before.attempts + 1);
  assert.equal(after.failures, before.failures + 1);
  assert.equal(after.successes, before.successes);
  assert.equal(after.lastFailure.reason, 'storage');
  assert.equal(g.storage.getItem(V2 + '.tmp'), null, 'no tmp left behind');
});

test('capacity failure releases bak, retries once, preserves main', () => {
  const g = makeGame(702);
  assert.equal(g.TC.Save.save(), true);
  const mainBefore = g.storage.getItem(V2);
  const restore = quotaFail(g.storage, { failMain: true });
  let ok;
  try { ok = g.TC.Save.save(); } finally { restore(); }
  assert.equal(ok, false);
  assert.equal(g.storage.getItem(V2), mainBefore, 'previous good main intact');
  assert.equal(g.TC.Save.stats().lastFailure.reason, 'capacity');
});

test('reclaim-before-fail succeeds when freeing the backup helps', () => {
  const g = makeGame(703);
  assert.equal(g.TC.Save.save(), true);
  // a quota that fails the first main write only, then accepts the retry
  const orig = g.storage.setItem.bind(g.storage);
  let mainWrites = 0;
  g.storage.setItem = function (k, v) {
    if (k === V2) {
      mainWrites++;
      if (mainWrites === 1) {
        const e = new Error('first write hits quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
    }
    return orig(k, v);
  };
  let ok;
  try { ok = g.TC.Save.save(); } finally { g.storage.setItem = orig; }
  assert.equal(ok, true, 'backup release freed the retry');
  assert.equal(g.storage.getItem(V2 + '.tmp'), null);
  assert.equal(g.TC.Save.stats().lastFailure, null, 'successful write clears last failure');
});

test('recovery clears the failure state', () => {
  const g = makeGame(704);
  assert.equal(g.TC.Save.save(), true);
  const realSet = g.storage.setItem.bind(g.storage);
  g.storage.setItem = function () { throw new Error('boom'); };
  let ok1;
  try { ok1 = g.TC.Save.save(); } finally { g.storage.setItem = realSet; }
  assert.equal(ok1, false);
  assert.equal(g.TC.Save.stats().lastFailure.reason, 'storage');
  assert.equal(g.TC.Save.save(), true);
  assert.equal(g.TC.Save.stats().lastFailure, null, 'failure state cleared');
  const st = g.TC.Save.stats();
  assert.equal(st.successes, 2, 'both successes counted (setup save + recovery)');
});

test('autosave notice: once on first failure, bounded while failing, silent for mirrors', () => {
  const g = makeGame(705);
  const toasts = [];
  g.TC.UI.toast = function (m) { toasts.push(String(m)); };
  g.TC.Save._resetAutoFail();

  const realSet = g.storage.setItem.bind(g.storage);
  g.storage.setItem = function () { throw new Error('disk full'); };
  try {
    g.TC.Save.autosave(60);
    g.TC.Save.autosave(60);
    g.TC.Save.autosave(60);
    assert.equal(toasts.length, 1, 'one notice on first failure, not a storm');
    assert.match(toasts[0], /utosave/);
  } finally {
    g.storage.setItem = realSet;
  }

  // recovery then failure again reports normally
  g.TC.Save.autosave(60);
  assert.equal(toasts.length, 1, 'recovery does not toast');
  g.storage.setItem = function () { throw new Error('disk full again'); };
  try {
    g.TC.Save.autosave(60);
    assert.equal(toasts.length, 2, 'next failure after recovery reports normally');
  } finally {
    g.storage.setItem = realSet;
  }

  // joined mirrors skip autosave without any notice
  g.TC.NetClient = { drivesTick: () => true };
  try {
    toasts.length = 0;
    g.TC.Save.autosave(60);
    assert.equal(toasts.length, 0, 'mirror raises no notice');
  } finally {
    delete g.TC.NetClient;
  }
});

test('counters stay bounded after many writes', () => {
  const g = makeGame(706);
  for (let i = 0; i < 10; i++) assert.equal(g.TC.Save.save(), true);
  const st = g.TC.Save.stats();
  assert.equal(st.attempts, 10);
  assert.equal(st.successes, 10);
  assert.equal(st.failures, 0);
  assert.deepStrictEqual(Object.keys(st).sort(), ['attempts', 'failures', 'lastFailure', 'successes']);
});
