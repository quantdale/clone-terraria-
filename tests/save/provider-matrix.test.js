/* tests/save/provider-matrix.test.js — TARGET 2: SaveCore.restore against
   malformed provider payloads and missing envelope sections. A broken
   provider must be reported in failed[], a missing one in missing[], and
   neither may corrupt or block the other providers.

   Envelope layout note: provider sub-keys keep their dots ('core.wiring'),
   so sections hold keys like env.systems['core.wiring'] — SaveCore splits
   provider keys on the FIRST dot only. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeGame, parseV2 } = require('./helpers.js');

// Boot, set one progression flag as "canary", save, hand back env + helpers.
function seededEnv() {
  const g = makeGame(4242);
  const TC = g.TC;
  TC.Progression.set(TC.Progression.FLAGS.bossKingSlime);
  assert.equal(TC.Save.save(), true);
  const env = parseV2(g.storage);
  assert.ok(env, 'no envelope after save');
  return { g, TC, env };
}

// 'systems.core.wiring' -> ['systems', 'core.wiring']
function splitProviderKey(key) {
  const dot = key.indexOf('.');
  return [key.slice(0, dot), key.slice(dot + 1)];
}

test('restore: malformed provider data is reported failed without corrupting others', () => {
  const { TC, env } = seededEnv();

  // wiring.deserialize rejects non-object blobs with false -> failed[]
  const bad1 = JSON.parse(JSON.stringify(env));
  bad1.systems['core.wiring'].data = 'garbage-string';
  let res = TC.SaveCore.restore(bad1);
  assert.ok(res.failed.some((f) => f.key === 'systems.core.wiring' && /reject/.test(f.error)),
    'wiring garbage-string not reported failed: ' + JSON.stringify(res));
  assert.ok(!res.restored.includes('systems.core.wiring'));
  assert.ok(res.restored.includes('systems.core.progression'),
    'progression restore blocked by wiring failure');
  assert.ok(TC.Progression.has(TC.Progression.FLAGS.bossKingSlime),
    'canary flag lost by failed provider');

  // fishing.load rejects junk with false too
  const bad2 = JSON.parse(JSON.stringify(env));
  bad2.systems['core.fishing'].data = 12345;
  res = TC.SaveCore.restore(bad2);
  assert.ok(res.failed.some((f) => f.key === 'systems.core.fishing'),
    'fishing numeric payload not reported failed');
  assert.ok(res.restored.includes('systems.core.wiring'));

  // A null payload is a legitimate empty section (buildEnvelope stores
  // data:null when a provider serializes nothing). The accessories provider
  // tolerates it as leave-as-is (deserializeAcc refuses non-array payloads
  // without touching slots) and reports success — pinned here as contract.
  const bad3 = JSON.parse(JSON.stringify(env));
  TC.Accessories.attachToPlayer(TC.player,
    [{ id: 'guard_ring', prefix: null }, null, null, null, null]);
  bad3.character['core.accessories'].data = null;
  res = TC.SaveCore.restore(bad3);
  assert.ok(res.restored.includes('character.core.accessories'),
    'accessories null payload should be tolerated');
  const slotsAfter = TC.Accessories.slotsOf(TC.player);
  assert.equal(slotsAfter[0] && slotsAfter[0].id, 'guard_ring',
    'null accessories payload must not corrupt live slots');

  // a deserialize that throws must land in failed[] instead of unwinding
  const bad4 = JSON.parse(JSON.stringify(env));
  bad4.world['core.liquids'].data = { notAnArray: true };
  assert.doesNotThrow(() => { TC.SaveCore.restore(bad4); });
});

test('restore: missing sections/entries are reported missing, others still restored', () => {
  const { TC, env } = seededEnv();

  const noFishing = JSON.parse(JSON.stringify(env));
  delete noFishing.systems['core.fishing'];
  let res = TC.SaveCore.restore(noFishing);
  // res arrays live in the vm realm: copy before structural comparison.
  assert.deepStrictEqual(Array.from(res.missing), ['systems.core.fishing']);
  assert.ok(res.restored.includes('systems.core.progression'));
  assert.equal(res.failed.length, 0);

  const noSystems = JSON.parse(JSON.stringify(env));
  delete noSystems.systems;
  res = TC.SaveCore.restore(noSystems);
  assert.deepStrictEqual(Array.from(res.missing).sort(),
    ['systems.core.fishing', 'systems.core.progression', 'systems.core.wiring']);
  assert.ok(res.restored.includes('world.core'));

  const noAcc = JSON.parse(JSON.stringify(env));
  delete noAcc.character['core.accessories'];
  res = TC.SaveCore.restore(noAcc);
  assert.deepStrictEqual(Array.from(res.missing), ['character.core.accessories']);
});

test('restore: never throws for arbitrary garbage in any entry', () => {
  const { TC, env } = seededEnv();
  const junk = [null, 42, 'x', [], [{}, 1], { deep: { nested: [] } }, true];
  for (const data of junk) {
    for (const key of TC.SaveCore.providerKeys()) {
      const copy = JSON.parse(JSON.stringify(env));
      const [sec, sub] = splitProviderKey(key);
      copy[sec][sub].data = data;
      let res;
      assert.doesNotThrow(() => { res = TC.SaveCore.restore(copy); },
        'restore threw for ' + key + ' data=' + JSON.stringify(data));
      assert.ok(res && Array.isArray(res.failed) && Array.isArray(res.restored),
        'restore returned malformed result for ' + key);
    }
  }
});

test('restore: newer provider data version fails explicitly', () => {
  const { TC, env } = seededEnv();
  const future = JSON.parse(JSON.stringify(env));
  future.systems['core.wiring'].v = 99;
  const res = TC.SaveCore.restore(future);
  assert.ok(res.failed.some((f) => f.key === 'systems.core.wiring' && /newer/.test(f.error)),
    'newer wiring version not rejected: ' + JSON.stringify(res));
  assert.ok(!res.restored.includes('systems.core.wiring'));
});
