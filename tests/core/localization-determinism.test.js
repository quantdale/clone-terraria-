/* tests/core/localization-determinism.test.js — simulation is locale-blind (W20).
   The same seed + initial state + command trace must produce identical world
   digests, player state, inventory, progression flags and enemy counts under
   the fallback locale AND under an active synthetic locale. Locale switching
   may only affect presentation. Also proves NPC dialog selection picks the
   same catalog KEY in every locale (rendering differs, meaning never does). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');
const { quietConsole } = require('./helpers.js');

function runScriptedWorld(hashLocale) {
  const g = loadGame({ hash: '#test' });
  const TC = g.TC;
  TC.Registry.syncFromTables();
  if (hashLocale) {
    TC.Localization.registerPseudoLocale('en-XA');
    assert.ok(TC.Localization.setLocale('en-XA'));
  }
  TC.newGame(31337);
  const p = TC.player;
  p.x = p.sx; p.y = p.sy; p.vx = 0; p.vy = 0;

  const sx = (p.x / 16) | 0;
  const ty = TC.world.surfaceY[sx];
  const r1 = TC.Commands.submit('MineTile',
    { tx: sx, ty: ty, toolPower: 10000, tool: 'pick', player: p, dt: 1 });
  assert.ok(r1.ok && r1.result.broken, 'mine broke surface tile');

  TC.Runtime.advanceTicks(45); // magnet collects the drop
  const placeTy = ty - 1;
  const rp = TC.Commands.submit('PlaceTile',
    { tx: sx + 2, ty: placeTy, itemId: 'dirt', player: p });
  void rp;
  TC.Runtime.advanceTicks(120);

  // deterministic digest over tiles/walls/surface
  let h1 = 2166136261 >>> 0;
  const mix = (v) => {
    h1 ^= v & 0xff; h1 = Math.imul(h1, 16777619) >>> 0;
    h1 ^= (v >> 8) & 0xff; h1 = Math.imul(h1, 16777619) >>> 0;
  };
  for (let i = 0; i < TC.world.tiles.length; i += 7) mix(TC.world.tiles[i]);
  for (let i = 0; i < TC.world.walls.length; i += 11) mix(TC.world.walls[i]);

  const inv = [];
  for (let i = 0; i < p.inventory.slots.length; i++) {
    const s = p.inventory.get(i);
    inv.push(s ? [s.id, s.count] : null);
  }

  // NPC dialog selection must be key-identical across locales
  const guide = TC.NPCs.list[0];
  const keys = [];
  for (let i = 0; i < 8; i++) keys.push(TC.NPCs.dialogLineFor(guide));

  return {
    digest: h1.toString(16),
    pos: { x: p.x, y: p.y, hp: p.hp },
    maxHp: p.maxHp,
    inv: JSON.stringify(inv),
    flags: (TC.Progression.all ? TC.Progression.all() : []).slice().sort(),
    enemies: TC.Enemies.list.length,
    drops: TC.Items.drops.length,
    dialogKeys: JSON.stringify(keys),
  };
}

test('determinism: identical sim under English and synthetic locale', () => {
  quietConsole(() => {
    const a = runScriptedWorld(false);
    const b = runScriptedWorld(true);
    assert.equal(a.digest, b.digest, 'world digest locale-invariant');
    assert.deepEqual(a.pos, b.pos, 'player state locale-invariant');
    assert.equal(a.maxHp, b.maxHp);
    assert.equal(a.inv, b.inv, 'inventory locale-invariant');
    assert.deepEqual(a.flags, b.flags, 'progression flags locale-invariant');
    assert.equal(a.enemies, b.enemies);
    assert.equal(a.drops, b.drops);
  });
});

test('determinism: dialog KEY sequence identical; rendered text differs', () => {
  quietConsole(() => {
    const a = runScriptedWorld(false);
    const b = runScriptedWorld(true);
    assert.equal(a.dialogKeys, b.dialogKeys,
      'same dialogue entries selected under every locale');

    // and rendering: en text vs pseudo text for the SAME selected key
    const g = loadGame({ hash: '#test' });
    const TC = g.TC;
    const L = TC.Localization;
    const key = JSON.parse(a.dialogKeys)[0];
    const enText = L.t(key);
    L.registerPseudoLocale('en-XA');
    L.setLocale('en-XA');
    const xaText = L.t(key);
    assert.notEqual(enText, xaText, 'presentation actually changes');
    assert.ok(xaText.length >= enText.length);
    L.setLocale('en');
  });
});
