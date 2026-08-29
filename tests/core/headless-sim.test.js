/* tests/core/headless-sim.test.js — the headless simulation boundary proof.

   Deterministic simulation runs WITHOUT Canvas rendering, DOM layout, or
   requestAnimationFrame: worlds are created through TC.Runtime.createWorld,
   advanced with advanceTicks, mutated via TC.Commands, persisted through
   SaveCore providers and restored through the real continueGame path.
   Two independent VM boots must reach byte-identical outcomes for identical
   seeds + command scripts. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');
const { quietConsole } = require('./helpers.js');

// Cheap deterministic digest over the live world (tiles + walls + surfaceY).
function worldDigest(TC) {
  const w = TC.world;
  let h1 = 2166136261 >>> 0;
  const mix = (v) => {
    h1 ^= v & 0xff; h1 = Math.imul(h1, 16777619) >>> 0;
    h1 ^= (v >> 8) & 0xff; h1 = Math.imul(h1, 16777619) >>> 0;
  };
  for (let i = 0; i < w.tiles.length; i += 7) mix(w.tiles[i]);
  for (let i = 0; i < w.walls.length; i += 11) mix(w.walls[i]);
  for (let i = 0; i < w.surfaceY.length; i += 5) mix(w.surfaceY[i]);
  return h1.toString(16);
}

function invSnapshot(inv) {
  const out = [];
  for (let i = 0; i < inv.slots.length; i++) {
    const s = inv.get(i);
    out.push(s ? [s.id, s.count] : null);
  }
  return JSON.stringify(out);
}

// The scripted simulation both boots run: mine a tile, place it elsewhere,
// craft nothing (no station), then free-run. Identical inputs -> identical
// outputs, or the runtime is not deterministic.
function scriptedSim(TC) {
  TC.Runtime.createWorld(90210);
  const p = TC.player;
  p.x = p.sx; p.y = p.sy;      // pin to spawn (no input)
  p.vx = 0; p.vy = 0;
  const sx = (p.x / 16) | 0;
  const ty = TC.world.surfaceY[sx];

  // one full-power pick hit breaks the grass tile
  const r1 = TC.Commands.submit('MineTile',
    { tx: sx, ty: ty, toolPower: 10000, tool: 'pick', player: p, dt: 1 });
  assert.ok(r1.ok && r1.result.broken, 'scripted mine broke the surface tile');

  // let the item magnet pull the drop in before continuing the script
  TC.Runtime.advanceTicks(45);
  const dirtSlot = (() => {
    for (let i = 0; i < p.inventory.slots.length; i++) {
      const s = p.inventory.get(i);
      if (s && s.id === 'dirt') return i;
    }
    return -1;
  })();
  assert.ok(dirtSlot >= 0, 'mined tile produced its drop into the inventory');

  // place the dirt back into the hole it came from (anchored by neighbours)
  const r2 = TC.Commands.submit('PlaceTile',
    { tx: sx, ty: ty, item: 'dirt', player: p, slot: dirtSlot });
  assert.ok(r2.ok, 'scripted placement succeeded');

  // give a known stack and move it (command-path inventory mutation)
  p.inventory.add('stone', 10);
  const from = (() => {
    for (let i = 0; i < p.inventory.slots.length; i++) {
      const s = p.inventory.get(i);
      if (s && s.id === 'stone') return i;
    }
    return -1;
  })();
  const r3 = TC.Commands.submit('MoveItem',
    { fromInv: p.inventory, fromSlot: from, toInv: p.inventory, toSlot: 40 });
  assert.ok(r3.ok, 'scripted move succeeded');

  TC.Runtime.advanceTicks(30);   // half a second of free-run
  return {
    digest: worldDigest(TC),
    pos: { x: p.x, y: p.y },
    skyTime: TC.Sky.time,
    inv: invSnapshot(p.inventory),
    flags: TC.Progression.all().slice().sort(),
    ticks: TC.Runtime.getTickCount()
  };
}

test('headless sim: identical seed + command script -> identical state across boots', () => {
  const a = scriptedSim(loadGame().TC);
  const b = scriptedSim(loadGame().TC);
  assert.strictEqual(a.digest, b.digest, 'world digest diverged — nondeterministic tick');
  assert.strictEqual(a.ticks, b.ticks);
  assert.strictEqual(a.skyTime, b.skyTime, 'day/night clock diverged');
  assert.deepStrictEqual(a.pos, b.pos, 'player physics diverged');
  assert.strictEqual(a.inv, b.inv, 'inventory outcome diverged');
  assert.deepStrictEqual(a.flags, b.flags, 'progression diverged');
});

test('headless sim: createWorld needs no Canvas/DOM/rAF beyond the existing stubs', () => {
  const g = loadGame({ frames: 0 });   // never pump a frame
  const TC = g.TC;
  const info = TC.Runtime.createWorld(1234);
  assert.ok(info.world && info.player, 'world + player exist before any render');
  assert.strictEqual(TC.state, 'playing');
  TC.Runtime.advanceTicks(120);
  assert.strictEqual(TC.Runtime.getTickCount(), 120);
  assert.ok(TC.Systems.getCounts()['movement/player'] >= 100,
    'simulation advanced purely by ticking');
});

test('headless sim: save -> reset -> continue restores mined state through real paths', () => {
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  const info = TC.Runtime.createWorld(555);
  const sx = (info.player.x / 16) | 0;
  const ty = TC.world.surfaceY[sx];
  const before = TC.world.get(sx, ty);
  quietConsole(() => {
    TC.Commands.submit('MineTile',
      { tx: sx, ty: ty, toolPower: 10000, tool: 'pick', player: TC.player, dt: 1 });
  });
  assert.strictEqual(TC.world.get(sx, ty), TC.TILE.AIR);
  assert.strictEqual(TC.Save.save(), true, 'save persisted');
  const seedSaved = TC.worldSeed;

  TC.Runtime.reset();                    // teardown to title
  assert.strictEqual(TC.state, 'title');
  assert.strictEqual(TC.world, null);
  assert.strictEqual(TC.Commands.pending(), 0, 'queue empty after reset');

  TC.continueGame();                     // real load path (SaveCore envelope)
  assert.strictEqual(TC.state, 'playing');
  assert.strictEqual(TC.worldSeed, seedSaved);
  assert.strictEqual(TC.world.get(sx, ty), TC.TILE.AIR,
    'mined tile stays mined after save/continue');
  assert.notStrictEqual(before, TC.TILE.AIR);
  assert.strictEqual(TC.Runtime.getTickCount(), 0, 'tick count restarts on WorldLoaded');
});
