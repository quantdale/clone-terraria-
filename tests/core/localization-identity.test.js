/* tests/core/localization-identity.test.js — REGISTRY IDENTITY REGRESSION (W20).
   BLOCKER test: localization metadata must NEVER mutate machine identity.
   Asserts the live registry fingerprint, per-kind counts and every stable id
   equal the W20 baseline snapshot captured before any localization change
   (tests/fixtures/registry-baseline-w20.json). Also proves translated text
   can never leak into identity: switching locales does not move ids. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { loadGame } = require('../helpers/load-game.js');

const BASELINE = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'registry-baseline-w20.json'), 'utf8'));

test('identity: registry fingerprint matches the pre-campaign baseline', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.Registry.syncFromTables();
  assert.equal(TC.Registry.fingerprint(), BASELINE.fingerprint,
    'fingerprint drift means stable identity changed — STOP and investigate');
});

test('identity: per-kind counts + every dense index -> stable id unchanged', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.Registry.syncFromTables();
  for (const k of TC.Registry.KINDS) {
    assert.equal(TC.Registry.count(k), BASELINE.counts[k],
      'kind count drift for ' + k);
    for (let i = 0; i < TC.Registry.count(k); i++) {
      const id = TC.Registry.stableOfIndex(k, i);
      assert.equal(id, BASELINE.stable[k + ':' + i],
        'stable id moved at ' + k + ':' + i);
    }
  }
});

test('identity: locale switches never alter registry ids or aliases', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.Registry.syncFromTables();
  const L = TC.Localization;
  const before = {
    fp: TC.Registry.fingerprint(),
    itemIron: TC.Registry.legacyToStable('item', 'iron_sword'),
    enemyEye: TC.Registry.legacyToStable('enemy', 'void_eye'),
    tileDirtIdx: TC.Registry.stableToIndex('tile', 'core:dirt'),
  };
  L.registerPseudoLocale('en-XA');
  L.setLocale('en-XA');
  // render some localized names to prove presentation is active
  assert.notEqual(L.t('ui.menu.new_world'), 'New World');
  assert.equal(TC.Registry.fingerprint(), before.fp,
    'fingerprint invariant under locale switch');
  assert.equal(TC.Registry.legacyToStable('item', 'iron_sword'), before.itemIron);
  assert.equal(TC.Registry.legacyToStable('enemy', 'void_eye'), before.enemyEye);
  assert.equal(TC.Registry.stableToIndex('tile', 'core:dirt'), before.tileDirtIdx);
  L.setLocale('en');
});

test('identity: def.name metadata untouched (frozen compatibility contract)', () => {
  const g = loadGame();
  const TC = g.TC;
  // spot-check frozen English identity metadata against known values
  assert.equal(TC.ITEM_DEFS.iron_sword.name, 'Iron Sword');
  assert.equal(TC.ENEMY_DEFS.king_slime.name, 'King Slime');
  assert.equal(TC.WALL_DEFS[1].name, 'dirt wall');
});
