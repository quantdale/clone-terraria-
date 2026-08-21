/* tests/save/export-import.test.js — TARGET 6: TC.Save.exportSave /
   importSave round-trip plus rejection of invalid imports, with the live
   storage untouched after every rejection. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeGame, cloneStorage, parseV2, loadGame } = require('./helpers.js');

function mutatedGame(seed) {
  const g = makeGame(seed);
  const TC = g.TC;
  TC.Sky.time = 1234;
  TC.player.inventory.add('wood', 11);
  TC.Progression.set(TC.Progression.FLAGS.bossSkeletron);
  TC.player.maxMana = 64;
  return g;
}

test('export/import: round-trip restores the exported state in a fresh boot', () => {
  const g1 = mutatedGame(31337);
  const exported = g1.TC.Save.exportSave();
  assert.equal(typeof exported, 'string', 'exportSave returned no string');
  const env = JSON.parse(exported);
  assert.equal(env.formatVersion, 2);
  assert.equal(env.metadata.seed, 31337);

  // Import into a *different* profile and boot from it.
  const staged = loadGame();
  assert.equal(staged.TC.Save.importSave(exported), true, 'valid export rejected');
  const envStored = parseV2(staged.storage);
  assert.ok(envStored && envStored.metadata.seed === 31337,
    'imported envelope not staged under tc_save_v2');

  staged.TC.continueGame();
  assert.equal(staged.TC.worldSeed, 31337);
  assert.equal(staged.TC.Sky.time, 1234);
  assert.equal(staged.TC.player.inventory.count('wood'), 11);
  assert.equal(staged.TC.player.maxMana, 64);
  assert.ok(staged.TC.Progression.has(staged.TC.Progression.FLAGS.bossSkeletron));
});

test('import/export: re-importing an export into the same profile is stable', () => {
  const g = mutatedGame(31338);
  const exported = g.TC.Save.exportSave();
  assert.equal(g.TC.Save.importSave(exported), true);
  const again = g.TC.Save.exportSave();
  assert.equal(JSON.parse(again).metadata.seed, 31338);
});

test('import: invalid strings are rejected without touching existing saves', () => {
  const g = mutatedGame(31339);
  assert.equal(g.TC.Save.save(), true);
  const before = g.storage.getItem('tc_save_v2');

  const rejects = [
    '',                                  // empty
    'not json at all',                   // unparsable
    'null',                              // parsable but not an object
    JSON.stringify({ formatVersion: 2 }),                    // invalid structure
    JSON.stringify({ formatVersion: 99, gameVersion: 'x',
      generationVersion: 1, metadata: { savedAt: 't' },
      world: {}, character: {}, systems: {} }),              // future format
    JSON.stringify(42)
  ];
  for (const bad of rejects) {
    assert.equal(g.TC.Save.importSave(bad), false,
      'invalid import accepted: ' + bad.slice(0, 40));
    assert.equal(g.storage.getItem('tc_save_v2'), before,
      'rejected import mutated storage');
  }
});

test('import: legacy v1 export strings land where loadLegacy can find them', () => {
  // Pre-SaveCore exports were plain v1 blobs; importing one must keep it
  // loadable (this pins save.js routing, not SaveCore internals).
  const g = mutatedGame(31340);
  const gen = g.TC.WorldGen.generate(31340);
  const blob = {
    v: 1, seed: 31340, time: 12, diffs: [],
    player: { x: gen.spawnX * 16, y: gen.spawnY * 16 - 40, hp: 100 },
    chests: {}, npcs: []
  };
  const str = JSON.stringify(blob);
  assert.equal(g.TC.Save.importSave(str), true, 'legacy v1 import rejected');
  const loaded = g.TC.Save.load();
  assert.ok(loaded && loaded.v === 1 && loaded.seed === 31340,
    'imported legacy blob not loadable afterwards: ' + JSON.stringify(loaded));
});
