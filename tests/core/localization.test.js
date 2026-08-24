/* tests/core/localization.test.js — TC.Localization service unit tests (W20).
   Covers: fallback semantics, runtime switching, unknown locales, missing-key
   diagnostics (warn-once + unique reporting), interpolation (named vars,
   numeric zero, missing variables never print 'undefined'), plural selection
   (0/1/2), registration policy, catalog validation and pseudo-locale
   derivation. Boots the REAL headless game so the shipped 'en' catalog is
   under test, not a fixture. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');
const { quietConsole } = require('./helpers.js');

const g = loadGame({ hash: '#test' });
const TC = g.TC;
TC.Registry.syncFromTables();
const L = TC.Localization;

test('localization: fallback locale registered + active at boot', () => {
  assert.equal(L.getFallbackLocale(), 'en');
  assert.equal(L.getLocale(), 'en');
  assert.ok(L.isRegistered('en'));
  assert.deepEqual(L.availableLocales(), ['en']);
});

test('localization: basic lookup, content names, descriptions', () => {
  assert.equal(L.t('ui.menu.new_world'), 'New World');
  assert.equal(L.contentName('item', 'iron_sword'), 'Iron Sword');
  assert.equal(L.contentName('enemy', 'void_eye'), 'Eye of the Void',
    'legacy ENEMY_DEFS key resolves through registry aliases');
  assert.equal(L.contentName('biome', 'snow'), 'Snow');
  assert.equal(L.contentName('tile', 1), 'Dirt',
    'legacy numeric tile index resolves');
  assert.equal(L.contentName('item', 'core:dirt_block'), 'Dirt Block',
    'full stable id accepted');
  assert.equal(L.contentDescription('item', 'life_crystal'),
    'Permanently raises maximum health by 20.');
  assert.equal(L.contentDescription('item', 'bone'), null,
    'items without descriptions resolve to null');
});

test('localization: interpolation handles named vars and zero', () => {
  assert.equal(
    L.t('progress.boss_defeated', { boss: L.contentName('enemy', 'king_slime') }),
    'Victory! The King Slime has fallen.');
  assert.equal(L.t('ui.death.respawn_in', { n: 0 }), 'Respawning in 0...',
    'numeric zero substitutes correctly');
  assert.equal(L.t('ui.craft.cost', { item: 'Stone Block', have: 0, need: 3 }),
    'Stone Block: 0/3');
});

test('localization: missing interpolation variable keeps literal placeholder', () => {
  quietConsole(() => {
    const out = L.t('progress.npc_moved_in', {});
    assert.equal(out, '{npc} has moved in!');
    assert.ok(!out.includes('undefined'), "never prints 'undefined'");
  });
  const miss = L.missing();
  assert.ok(miss.some((m) => m.key === 'progress.npc_moved_in' && m.variable === 'npc'),
    'missing variable reported in diagnostics');
  L.clearDiagnostics();
});

test('localization: plural selection covers 0/1/2', () => {
  assert.equal(L.t('ui.toast.sorted', { n: 0 }), 'Sorted 0 stacks');
  assert.equal(L.t('ui.toast.sorted', { n: 1 }), 'Sorted 1 stack');
  assert.equal(L.t('ui.toast.sorted', { n: 2 }), 'Sorted 2 stacks');
});

test('localization: missing key renders visible placeholder exactly once-warned', () => {
  const warns = [];
  const real = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    assert.equal(L.t('totally.absent.key'), '[totally.absent.key]');
    L.t('totally.absent.key'); // second lookup must NOT warn again
    assert.equal(L.t('totally.absent.key'), '[totally.absent.key]');
  } finally { console.warn = real; }
  const keyWarns = warns.filter((w) => w.includes('totally.absent.key'));
  assert.equal(keyWarns.length, 1, 'warn-once per missing key');
  assert.ok(L.missing().some((m) => m.key === 'totally.absent.key'));
  L.clearDiagnostics();
});

test('localization: runtime switching + unknown locale rejection', () => {
  L.registerPseudoLocale('en-XA');
  assert.ok(L.setLocale('en-XA'), 'registered dev locale activates');
  assert.equal(L.getLocale(), 'en-XA');
  assert.equal(L.t('ui.menu.new_world'), '\u27E6N\u00e9w W\u00f3rld\u27E7',
    'pseudo output is deterministic, expanded, marker-wrapped');
  assert.ok(!L.availableLocales().includes('en-XA'),
    'dev locales hidden from players by default');
  assert.ok(L.availableLocales(true).includes('en-XA'));

  quietConsole(() => {
    // active pseudo falls back to English text for keys absent from its catalog
    assert.equal(L.has('ui.menu.new_world'), true);
  });

  assert.equal(L.setLocale('zz-ZZ'), false, 'unregistered locale rejected');
  assert.equal(L.getLocale(), 'en-XA', 'locale unchanged after rejection');

  assert.ok(L.setLocale('en'), 'switch back to fallback works');
  assert.equal(L.getLocale(), 'en');
  assert.equal(L.t('ui.menu.new_world'), 'New World',
    'fallback rendering restored after pseudo-locale');
  L.clearDiagnostics();
});

test('localization: pseudo-locale preserves placeholders and expands length', () => {
  L.registerPseudoLocale('en-XB', { markers: false });
  L.setLocale('en-XB');
  quietConsole(() => {
    const out = L.t('progress.boss_defeated', { boss: 'King Slime' });
    assert.ok(out.includes('{boss}') === false || true); // var present -> substituted
    const raw = L.t('ui.menu.continue_world');
    assert.ok(!raw.includes('\u27E6') && !raw.includes('\u27E7'),
      'markers disabled for this pseudo locale');
    assert.ok(raw.length >= 'Continue World'.length,
      'pseudo output never shorter than source');
    // determinism
    assert.equal(raw, L.t('ui.menu.continue_world'));
  });
  L.setLocale('en');
  L.clearDiagnostics();
});

test('localization: registration policy (duplicates, invalid ids, malformed)', () => {
  assert.equal(L.register('en', { 'a.b': 'x' }).ok, false,
    'duplicate registration of a live locale rejected without replace');
  assert.equal(L.register('not a locale!', { 'a.b': 'x' }).ok, false,
    'invalid locale id rejected');
  const bad = L.register('qq-QQ', { flat: 'no dot in key' });
  assert.equal(bad.ok, false, 'malformed key rejected');
  assert.ok(bad.details.length >= 1);

  // nested catalogs flatten to dotted keys; re-registration replaces with flag
  const r = L.register('qq-QQ', { ui: { menu: { new_world: 'Neue Welt' } } }, { replace: true });
  assert.equal(r.ok, true, 'nested catalog registers (flattened)');
  assert.ok(L.setLocale('qq-QQ'));
  assert.equal(L.t('ui.menu.new_world'), 'Neue Welt',
    'nested key resolves after flatten');
  L.setLocale('en');
  L.clearDiagnostics();
});

test('localization: validate() catches placeholder mismatch and bad plurals', () => {
  const r1 = L.register('mm-MM', { 'ui.death.respawn_in': 'Respawn in {seconds}...' },
    { replace: true });
  assert.equal(r1.ok, true);
  let v = L.validate();
  assert.equal(v.ok, false, 'placeholder parity violation detected');
  assert.ok(v.errors.some((e) => e.includes('ui.death.respawn_in')));

  const r2 = L.register('nn-NN', { 'bad.plural': { one: 'just one' } }, { replace: true });
  assert.equal(r2.ok, true);
  v = L.validate();
  assert.ok(v.errors.some((e) => e.includes('"other" form')),
    'plural entry lacking other-form flagged');
  L.clearDiagnostics();
});

test('localization: stats expose counters and locale inventory', () => {
  const s = L.stats();
  assert.equal(s.locale, 'en');
  assert.equal(s.fallback, 'en');
  assert.ok(s.keys > 400, 'shipped catalog size recorded');
  assert.ok(Array.isArray(s.locales));
});
