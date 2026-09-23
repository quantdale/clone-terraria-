'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadGame } = require(path.join(__dirname, '..', '..', 'tests', 'helpers', 'load-game.js'));

function storageWithActivePacks(ids) {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    get length() { return values.size; },
    seed(key, value) { values.set(key, value); },
  };
}

test('headless pack boot waits for every script in index order', () => {
  const storage = storageWithActivePacks(['testpack']);
  storage.seed('tc_settings_v1', JSON.stringify({ v: 1, values: { activePacks: ['testpack'] } }));
  const g = loadGame({ frames: 0, storage });
  const TC = g.TC;
  assert.strictEqual(TC._bootDone, true);
  assert.strictEqual(TC.Packs.active().join(','), 'testpack');
  const tempest = TC.Registry.stableToIndex('tile', 'testpack:tempest_brick');
  assert.ok(tempest > TC.TILE.WIRE,
    `pack tile ${tempest} must append after late built-in ${TC.TILE.WIRE}`);
  assert.doesNotThrow(() => TC.Registry.validate());
  assert.ok(g.scriptOrderRun.indexOf('js/main.js') < g.scriptOrderRun.indexOf('js/wiring.js'));
});
