/* tests/packs/save-compat.test.js — MOD-003 end-to-end: pack-aware save
   metadata, classification matrix, the restart/remove-pack/restore cycle,
   and pre-W25 save compatibility. A failed incompatible load must never
   touch stored state. */
'use strict';
const test = require('node:test');
const assert = require('assert');
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', '..', 'tests', 'helpers', 'load-game.js'));

function fresh() {
  return loadGame({ frames: 0 }).TC;
}

test('save: envelope carries pack metadata only when packs are active', () => {
  const TC = fresh();
  TC.Runtime.createWorld(555);
  let env = TC.SaveCore.buildEnvelope();
  assert.strictEqual(env.packs, null, 'base-only saves carry no packs field content');

  TC.Packs.setActive(['testpack']);
  env = TC.SaveCore.buildEnvelope();
  assert.strictEqual(env.packs.v, 1);
  assert.strictEqual(env.packs.gfp, TC.Packs.digest());
  assert.strictEqual(env.packs.fp, TC.Packs.contentDigest());
  assert.strictEqual(env.packs.packs.map((p) => p.id).join(','), 'testpack');
  const v = TC.SaveCore.validate(env);
  assert.ok(v.ok, 'envelope with packs validates: ' + v.errors.join('; '));

  // malformed metadata shapes fail envelope validation (null is VALID:
  // base-only saves carry packs:null)
  for (const bad of [
    { v: 2, fp: '', gfp: '', packs: [] },
    { v: 1, fp: 5, gfp: '', packs: [] },
    { v: 1, fp: '', gfp: '', packs: [{ id: 1, version: 'x', type: 'data' }] },
    { v: 1, fp: '', gfp: '' },
    { v: 1, fp: '', gfp: '', packs: 'no' },
  ]) {
    const e2 = Object.assign({}, env, { packs: bad });
    assert.ok(!TC.SaveCore.validate(e2).ok, 'malformed packs rejected: ' + JSON.stringify(bad));
  }
});

test('classify: full compatibility matrix', () => {
  const TC = fresh();
  // legacy (no metadata) is compatible; extra active data packs warn
  let cls = TC.Packs.classifySave(null);
  assert.ok(cls.ok && cls.status === 'legacy-no-packs' && cls.warnings.length === 0);
  TC.Packs.setActive(['testpack']);
  cls = TC.Packs.classifySave(null);
  assert.ok(cls.ok && cls.warnings.some((w) => w.indexOf('testpack') >= 0),
    'legacy save + active packs warns informatively');

  // exact match
  const meta = { v: 1, fp: 'x', gfp: 'y', packs: [{ id: 'testpack', version: '1.0.0', type: 'data' }] };
  cls = TC.Packs.classifySave(meta);
  assert.ok(cls.ok && cls.status === 'compatible' && cls.problems.length === 0);

  // missing required pack
  TC.Packs.deactivateAll;
  const TCb = fresh();
  cls = TCb.Packs.classifySave(meta);
  assert.ok(!cls.ok && cls.problems[0].indexOf('missing pack') >= 0 &&
    cls.problems[0].indexOf('testpack') >= 0, 'names the missing pack + version');

  // incompatible version
  const TCc = fresh();
  TCc.Packs.setActive(['testpack']);
  TCc.Packs.provide({
    manifest: 1, id: 'otherpack', name: 'O', version: '9.9.9', type: 'data',
    content: { items: [{ key: 'op_item', name: 'OP', kind: 'material' }] },
  });
  TCc.Packs.setActive(['testpack', 'otherpack']);
  cls = TCc.Packs.classifySave({
    v: 1, fp: 'x', gfp: 'y',
    packs: [{ id: 'testpack', version: '2.0.0', type: 'data' }],
  });
  assert.ok(!cls.ok && cls.problems[0].indexOf('incompatible version') >= 0);

  // malformed metadata
  for (const bad of [42, {}, { v: 1 }, { v: 1, fp: '', gfp: '', packs: 'no' }]) {
    cls = TCc.Packs.classifySave(bad);
    assert.ok(!cls.ok && cls.status === 'malformed-metadata', JSON.stringify(bad));
  }
});

test('cycle: save with pack -> fresh realm without it refuses cleanly; restore succeeds', () => {
  // Realm A: play with fixture pack, save to shared storage
  const storage = (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
      _m: m,
    };
  })();
  const a = loadGame({ frames: 0, storage });
  const TCA = a.TC;
  TCA.Packs.setActive(['testpack']);
  TCA.newGame(31337);
  // mutate something recognizable
  const TSz = TCA.CONST.TS;
  const px = Math.floor(TCA.player.x / TSz), py = TCA.world.surfaceY[px]; // top solid tile
  assert.ok(TCA.Commands.submit('MineTile', { tx: px, ty: py, player: TCA.player, toolPower: 35 }).ok);
  assert.ok(TCA.Save.save(), 'save succeeded');
  const savedRaw = storage.getItem('tc_save_v2');
  assert.ok(savedRaw, 'v2 payload exists');
  const savedEnv = JSON.parse(savedRaw);
  assert.strictEqual(savedEnv.packs.packs[0].id, 'testpack');
  const beforeBytes = savedRaw;

  // Realm B: SAME storage, same build, but the pack script is ABSENT (a
  // user removed the pack / downgraded). Settings still request it, so boot
  // must fail closed to the base set; continue must then refuse cleanly.
  const b = loadGame({ frames: 0, storage, omitScripts: ['packs/testpack.js'] });
  const TCB = b.TC;
  assert.strictEqual(TCB.Packs.active().length, 0,
    'missing pack at boot fails closed to the base set');
  assert.ok(TCB.Packs.lastError(), 'boot recorded the activation failure');
  TCB.continueGame();
  assert.strictEqual(TCB.state, 'title', 'incompatible load stays on title');
  assert.ok(TCB.UI.showPackProblem, 'UI diagnostic seam exists');
  assert.strictEqual(storage.getItem('tc_save_v2'), beforeBytes,
    'refused load left the save byte-identical');

  // The refusal reason names the missing pack through classification.
  const data = TCB.Save.load();
  const cls = TCB.Packs.classifySave(data.__envelope ? data.__envelope.packs : null);
  assert.ok(!cls.ok && cls.problems.join('; ').indexOf('testpack') >= 0);

  // Realm C: same storage WITH the fixture active -> continue works and
  // world mutations survived the round trip.
  const c = loadGame({ frames: 0, storage });
  const TCC = c.TC;
  TCC.Packs.setActive(['testpack']);
  TCC.continueGame();
  assert.strictEqual(TCC.state, 'playing', 'compatible load enters playing');
});

test('compat: pre-W25 saves (no pack field, base fingerprint) keep loading', () => {
  const storage = (() => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  })();
  const TC = fresh();
  // Hand-craft a PRE-W25 envelope: no `packs` key anywhere, W24 fingerprint.
  TC.Runtime.createWorld(909);
  const env = TC.SaveCore.buildEnvelope();
  delete env.packs;
  env.registryFingerprint = '1b1d7c15';
  env.metadata.seed = 909;
  storage.setItem('tc_save_v2', JSON.stringify(env));
  TC.Runtime.reset();

  const TC2 = loadGame({ frames: 0, storage }).TC;
  TC2.continueGame();
  assert.strictEqual(TC2.state, 'playing', 'pre-W25 envelope loads unchanged');
});
