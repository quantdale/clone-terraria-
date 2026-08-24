/* tests/core/localization-persistence.test.js — locale preference isolation (W20).
   Proves the campaign's save/settings separation:
     - locale persists across a simulated reload via TC.Settings, OUTSIDE
       tc_save_v1/v2 world/character payloads;
     - switching locale never mutates the saved world payload;
     - deleting the world save keeps the locale;
     - corrupt/unknown stored preferences fall back safely. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');
const { quietConsole } = require('./helpers.js');

// Compare save envelopes while ignoring the save-action timestamp (every
// save() legitimately stamps its own wall-clock moment).
function semanticSave(TC) {
  const ok = TC.Save.save();
  assert.ok(ok, 'save flushed');
  const env = JSON.parse(TC.Save.exportSave());
  if (env.metadata) delete env.metadata.savedAt;
  return JSON.stringify(env);
}

test('persistence: locale survives reload; world payload unaffected by switches', () => {
  const g = loadGame({ hash: '#test' });
  const TC = g.TC;
  TC.Registry.syncFromTables();
  TC.newGame(777);
  const before = semanticSave(TC);

  // switch locale INSIDE the live session, then save again
  TC.Localization.registerPseudoLocale('en-XA');
  assert.ok(TC.Localization.setLocale('en-XA'));
  assert.ok(g.storage.getItem('tc_settings_v1').includes('"locale":"en-XA"'),
    'preference written to the settings key');
  const after = semanticSave(TC);
  assert.equal(after, before,
    'world/character save payload must not change when locale changes');

  // "reload": a fresh boot whose persisted preference says en-XA. The full
  // cross-PAGE-reload proof lives in the Playwright journey (real localStorage
  // lifecycle); here we prove the same restore() contract headlessly: an
  // available stored locale applies on the next restore pass.
  const g2 = loadGame({ hash: '#test' });
  const TC2 = g2.TC;
  assert.equal(TC2.Localization.getLocale(), 'en',
    'fresh boot starts on fallback');
  TC2.Localization.registerPseudoLocale('en-XA');   // as a shipped locale file would
  TC2.Settings.set('locale', 'en-XA');              // the persisted preference
  TC2.Localization.restore.done = false;            // simulate the next boot's pass
  TC2.Localization.restore();
  assert.equal(TC2.Localization.getLocale(), 'en-XA',
    'stored locale applied once its catalog exists');
});

test('persistence: deleting the world save keeps the locale preference', () => {
  const g = loadGame({ hash: '#test' });
  const TC = g.TC;
  TC.Registry.syncFromTables();
  TC.newGame(778);
  TC.Save.save();
  TC.Localization.registerPseudoLocale('en-XA');
  TC.Localization.setLocale('en-XA');

  TC.Save.deleteSave();
  assert.equal(TC.Save.hasSave(), false, 'world save gone');
  assert.equal(TC.Localization.getLocale(), 'en-XA',
    'locale preference survives world deletion');

  // and import/export of worlds does not carry or clobber locale
  const blob = '{"v":2,"seed":1,"diffs":[],"wallDiffs":[],"player":{},"chests":[],"npcs":[]}';
  TC.Save.importSave(blob);
  assert.equal(TC.Localization.getLocale(), 'en-XA',
    'importing a foreign world leaves locale untouched');
});

test('persistence: malformed + unknown stored locales fall back safely', () => {
  quietConsole(() => {
    // unknown-but-well-formed locale id
    let g = loadGame({ hash: '#test' });
    g.storage.setItem('tc_settings_v1', JSON.stringify({ v: 1, values: { locale: 'xx-XX' } }));
    assert.equal(g.TC.Localization.getLocale(), 'en',
      'unregistered stored locale falls back to English');

    // truncated/corrupt JSON must not break boot
    g = loadGame({ hash: '#test' });
    g.storage.setItem('tc_settings_v1', '{"v":1,"values":{"loc');
    assert.ok(g.TC.Localization, 'boot survived corrupt settings');
    assert.equal(g.TC.Localization.getLocale(), 'en');

    // wrong envelope shape tolerated
    g = loadGame({ hash: '#test' });
    g.storage.setItem('tc_settings_v1', JSON.stringify({ v: 1, values: 'nope' }));
    assert.equal(g.TC.Localization.getLocale(), 'en');

    // valid stored locale still wins
    g = loadGame({ hash: '#test' });
    g.storage.setItem('tc_settings_v1', JSON.stringify({ v: 1, values: { locale: 'en', futurePref: 42 } }));
    assert.equal(g.TC.Localization.getLocale(), 'en');
  });
});
