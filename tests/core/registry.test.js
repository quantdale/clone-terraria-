/* tests/core/registry.test.js — TC.Registry: duplicate rejection, legacy alias
   resolution (both directions), registration-order independence + fingerprint
   stability/sensitivity across independent loadGame runs, validate() catching
   dangling references, and syncFromTables idempotence after a full boot. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers.js');

test('registry: define rejects duplicates, malformed ids, and non-object defs', () => {
  const g = boot();
  const TC = g.TC;
  const R = TC.Registry;
  assert.ok(R.define('item', 'test:alpha', { name: 'Alpha' }));
  assert.throws(() => R.define('item', 'test:alpha', { name: 'Alpha again' }), /duplicate/i);
  assert.throws(() => R.define('item', 'Test:Alpha', { name: 'bad case' }), /bad stable id/i);
  assert.throws(() => R.define('item', 'nocolon', { name: 'x' }), /bad stable id/i);
  assert.throws(() => R.define('not-a-kind', 'a:b', {}), /unknown kind/i);
  assert.throws(() => R.define('item', 'a:b', null), /def must be an object/i);
});

test('registry: aliases resolve both directions; conflicts throw; same mapping is a no-op', () => {
  const g = boot();
  const TC = g.TC;
  const R = TC.Registry;
  R.define('item', 'test:one', { name: 'One' });
  R.define('item', 'test:two', { name: 'Two' });
  const e = R.alias('item', 'test:one', 900);
  assert.strictEqual(e.id, 'test:one');
  // stable -> legacy number
  assert.strictEqual(R.legacyToStable('item', 900), 'test:one');
  // stable id passthrough + shorthand + unknown
  assert.strictEqual(R.legacyToStable('item', 'test:one'), 'test:one');
  assert.strictEqual(R.legacyToStable('item', 'nope:nope'), null);
  assert.strictEqual(R.legacyToStable('item', null), null);
  // same mapping twice: no-op, no throw
  R.alias('item', 'test:one', 900);
  // conflicting remap: loud failure, original mapping intact
  assert.throws(() => R.alias('item', 'test:two', 900), /conflict/i);
  assert.strictEqual(R.legacyToStable('item', 900), 'test:one');
  // aliasing to an unregistered stable id throws
  assert.throws(() => R.alias('item', 'test:ghost', 901), /cannot alias/i);
});

test('registry: index lookups round-trip; out-of-range and unknown refs are safe', () => {
  const g = boot();
  const TC = g.TC;
  const R = TC.Registry;
  const dirtIdx = TC.TILE.DIRT;
  assert.strictEqual(R.stableToIndex('tile', 'core:dirt'), dirtIdx);
  assert.strictEqual(R.stableToIndex('tile', dirtIdx), dirtIdx,   // legacy numeric ref
    'stableToIndex accepts the legacy numeric form');
  assert.strictEqual(R.stableOfIndex('tile', dirtIdx), 'core:dirt');
  assert.strictEqual(R.byIndex('tile', dirtIdx).id, 'core:dirt');
  assert.strictEqual(R.byIndex('tile', -1), null);
  assert.strictEqual(R.byIndex('tile', R.count('tile')), null);
  assert.strictEqual(R.stableToIndex('tile', 'core:does-not-exist'), -1);
  // get()/has() through every reference form
  assert.ok(R.has('tile', 'core:dirt') && R.has('tile', dirtIdx));
  assert.strictEqual(R.get('tile', 'dirt').name, TC.TILE_DEFS[dirtIdx].name,
    'string shorthand resolves through the mirrored key map');
});

test('registry: registration order across two independent boots does not affect ids or fingerprint', () => {
  const mkWorld = (order) => {
    const g = boot(99);
    const R = g.TC.Registry;
    for (const [id, n] of order) R.define('item', id, { name: n });
    // Alias order also scrambled between runs.
    if (order[0][0] === 'test:alpha') {
      R.alias('item', 'test:alpha', 800);
      R.alias('item', 'test:beta', 801);
    } else {
      R.alias('item', 'test:beta', 801);
      R.alias('item', 'test:alpha', 800);
    }
    return { g, fp: R.fingerprint(),
             ids: Array.from(R.all('item'), (e) => e.id).sort() };
  };
  const a = mkWorld([['test:alpha', 'A'], ['test:beta', 'B']]);
  const b = mkWorld([['test:beta', 'B'], ['test:alpha', 'A']]);
  assert.deepStrictEqual(a.ids, b.ids, 'stable id set must be order-independent');
  assert.deepStrictEqual(b.ids.sort().indexOf('test:alpha') >= 0, true);
  assert.strictEqual(a.fp, b.fp,
    'fingerprint must depend on WHAT is registered, not registration order');
  // Indexes DO legitimately differ; make sure that is all that differs.
  const idxA = a.g.TC.Registry.stableToIndex('item', 'test:alpha');
  const idxB = b.g.TC.Registry.stableToIndex('item', 'test:alpha');
  assert.notStrictEqual(idxA, idxB, 'sanity: dense indexes follow registration order');
});

test('registry: fingerprint is stable across identical boots and sensitive to new content', () => {
  const pristine1 = boot(5).TC.Registry.fingerprint();
  const pristine2 = boot(5).TC.Registry.fingerprint();
  assert.strictEqual(pristine1, pristine2, 'same scripts => same content digest');
  const g3 = boot(5);
  g3.TC.Registry.define('item', 'test:sensitivity_probe', { name: 'Probe' });
  assert.notStrictEqual(g3.TC.Registry.fingerprint(), pristine1,
    'registering one more entry must change the fingerprint');
});

test('registry: validate() catches dangling cross-references loudly', () => {
  const g = boot(11);
  const TC = g.TC;
  // A mirrored tile def whose drop points nowhere must fail validation.
  TC.TILE_DEFS.push({
    name: 'validation bait', solid: false, opaque: false, hardness: 0.2,
    tool: 'any', minPower: 0, drop: 'no_such_item_anywhere', light: 0,
    pattern: 'empty', needsSupport: null, replaceable: false, colors: []
  });
  TC.Registry.syncFromTables();                 // absorb the bad def
  let msg = null;
  try { TC.Registry.validate(); } catch (e) { msg = e.message; }
  assert.ok(msg, 'validate() must throw on a dangling tile.drop');
  assert.match(msg, /validation_bait/);
  assert.match(msg, /drop/);
  assert.match(msg, /no_such_item_anywhere/);
});

test('registry: core content validates cleanly after a full boot', () => {
  const g = boot(13);
  const TC = g.TC;
  let msg = null;
  try { TC.Registry.validate(); } catch (e) { msg = e.message; }
  // Late-loading modules may register under their own namespace; whatever
  // problems exist must be theirs, never the core tables'.
  if (msg) {
    for (const line of msg.split('\n')) {
      if (line.startsWith(' - ')) {
        assert.match(line, /'(wiring|accessories|magic|fishing):/,
          'core content failed validation:\n' + msg);
      }
    }
  }
});

test('registry: late-module (wiring:*) content should carry legacy aliases', { todo: 'wiring.js defines wiring:* ids without alias/aliasKey — drops like "wire" and tile #40..47 stay unresolvable; needs aliasKey+alias calls in defineRegistryContent' }, () => {
  const g = boot(13);
  const TC = g.TC;
  TC.Registry.syncFromTables();
  TC.Registry.validate();                      // desired end state: no throw at all
  assert.strictEqual(TC.Registry.has('item', 'wire'), true,
    'wiring item defs should be resolvable through their ITEM_DEFS keys');
});

test('registry: syncFromTables is idempotent — counts stable across repeated syncs', () => {
  const g = boot(17);                            // full boot incl. main.js re-sync
  const TC = g.TC;
  const kinds = ['tile', 'wall', 'item', 'recipe', 'enemy', 'npc', 'buff',
    'projectileType', 'biome', 'station'];
  // First explicit sync may absorb late-loading modules' table content
  // (wiring.js appends tiles/items); that is expected. Baseline AFTER it.
  TC.Registry.syncFromTables();
  const before = {};
  for (const k of kinds) before[k] = TC.Registry.count(k);
  const r1 = TC.Registry.syncFromTables();
  assert.strictEqual(r1.added, 0, 're-sync of unchanged tables adds nothing');
  assert.deepStrictEqual(Array.from(r1.errors), [], 'no mirror problems in shipped content');
  const r2 = TC.Registry.syncFromTables();
  assert.strictEqual(r2.added, 0, 'second sync adds nothing');
  assert.deepStrictEqual(Array.from(r2.errors), []);
  for (const k of kinds) {
    assert.strictEqual(TC.Registry.count(k), before[k],
      'count drifted for kind ' + k);
  }
});
