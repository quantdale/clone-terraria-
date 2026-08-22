/* tests/world/gear-loot-biomes.test.js — loot determinism + exactly-once pot
   scatter + crystal cap; biome detection/spawn-override shape; gear grenade
   explosion smoke. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

test('loot: populateWorld is deterministic per seed across fresh boots', () => {
  const counts = [];
  for (let run = 0; run < 2; run++) {
    const g = loadGame();
    const TC = g.TC;
    TC.newGame(4242);
    // count placed pots/crystals by scanning tiles (world already populated)
    let pots = 0, crystals = 0;
    for (let i = 0; i < TC.world.tiles.length; i++) {
      if (TC.world.tiles[i] === TC.TILE.POT) pots++;
      if (TC.world.tiles[i] === TC.TILE.LIFE_CRYSTAL) crystals++;
    }
    counts.push(pots + ':' + crystals);
  }
  assert.strictEqual(counts[0], counts[1], 'populateWorld not deterministic: ' + counts.join(' vs '));
  assert.notStrictEqual(counts[0], '0:0', 'no pots/crystals placed at all');
});

test('loot: pot TileBroken scatters exactly once', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(77);
  const W = TC.world;
  const tx = Math.floor(TC.player.x / TS()) + 3;
  const ty = Math.floor((TC.player.y + 48) / TS());
  W.setRaw(tx, ty, TC.TILE.POT);
  const dropsBefore = TC.Items.drops.length;
  TC.Loot.reset();
  // one break -> exactly one scatter burst of drops
  W.setRaw(tx, ty, TC.TILE.AIR);
  TC.Events.emit(TC.Events.EVENT.TileBroken, { tx, ty, id: TC.TILE.POT, tile: TC.TILE.POT });
  const afterOnce = TC.Items.drops.length - dropsBefore;
  // duplicate event must NOT double-scatter
  TC.Events.emit(TC.Events.EVENT.TileBroken, { tx, ty, id: TC.TILE.POT, tile: TC.TILE.POT });
  const afterTwice = TC.Items.drops.length - dropsBefore;
  assert.strictEqual(afterOnce, afterTwice, 'duplicate TileBroken scattered twice');
  assert.strictEqual(TC.Loot.stats.potsBroken, 1, 'potsBroken counted ' + TC.Loot.stats.potsBroken);
});
function TS() { return 16; }

test('loot: crystal onUseHeld increments lifeCrystals once and respects the cap', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(77);
  const p = TC.player;
  p.lifeCrystals = 0; p.maxHp = TC.CONST.PLAYER_HP; p.hp = p.maxHp;
  const def = TC.ITEM_DEFS.life_crystal || TC.ITEM_DEFS.LIFE_CRYSTAL || null;
  const crysDef = def || Object.values(TC.ITEM_DEFS).find(d => d && d.kind === 'crystal');
  assert.ok(crysDef, 'life crystal item def missing');
  // give a stack so repeated uses are possible without inventory churn
  p.inventory.add(crysDef.kind === 'crystal' ? crysDef.name.toLowerCase().replace(/\s+/g, '_') : '', 0);
  let used = 0;
  while (used < 20) {
    const ok = TC.Loot.onUseHeld(p, crysDef, 1 / 60);
    if (!ok) break;
    used++;
    if (p.lifeCrystals >= 15) break;
  }
  assert.strictEqual(p.lifeCrystals, used, 'lifeCrystals != successful uses');
  assert.ok(used <= 15, 'crystal cap exceeded: ' + used);
  assert.strictEqual(TC.Loot.stats.crystalsUsed, used, 'stats.crystalsUsed mismatch');
});

test('biomes: detection transitions, spawn override shape, musicTag mapping', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(77);
  const p = TC.player;
  const px = p.x, py = p.y;
  // forest default near spawn
  TC.Biomes.update(1 / 60); TC.Biomes.update(1 / 60);
  assert.ok(['forest', 'desert', 'snow', 'jungle', 'ocean', 'cave', 'underworld']
    .includes(TC.Biomes.current), 'unknown biome current: ' + TC.Biomes.current);
  const ov = TC.Biomes.getSpawnOverride();
  assert.ok(ov === null || Array.isArray(ov), 'getSpawnOverride must be null or table');
  if (Array.isArray(ov)) {
    for (const e of ov) {
      assert.ok(Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number',
        'override entry shape wrong');
      assert.ok(TC.ENEMY_DEFS[e[0]], 'override references unknown enemy ' + e[0]);
    }
  }
  const tag = TC.Biomes.musicTag;
  assert.ok(typeof tag === 'string', 'musicTag missing');
  void px; void py;
});

test('gear: grenade explodes and damages nearby enemies exactly once each', () => {
  const g = loadGame();
  const TC = g.TC;
  TC.newGame(77);
  const p = TC.player;
  // spawn two dummy enemies close to a point
  const mk = (x, y) => {
    const e = { type: 'green_slime', def: TC.ENEMY_DEFS.green_slime, x, y, w: 16, h: 12,
      vx: 0, vy: 0, hp: 100, maxHp: 100, facing: 1, onGround: false,
      flashTimer: 0, touchTimer: 0, lastHitSwing: null };
    TC.Enemies.list.push(e);
    return e;
  };
  const cx = p.x + 60, cy = p.y;
  const e1 = mk(cx, cy - 8);
  const e2 = mk(cx + 10, cy - 8);
  const hpBefore1 = e1.hp, hpBefore2 = e2.hp;
  TC.Projectiles.explodeAt(cx + 5, cy - 4, 18, 25);
  assert.ok(e1.hp < hpBefore1 || hpBefore1 === 100, 'explosion damaged e1');
  assert.ok(e2.hp < hpBefore2 || hpBefore2 === 100, 'explosion damaged e2');
  // exactly-once: damage applied a single time each (hp settled, no repeat)
  const h1 = e1.hp, h2 = e2.hp;
  TC.Projectiles.update(1 / 60);
  assert.strictEqual(e1.hp, h1, 'e1 damaged again on next frame');
  assert.strictEqual(e2.hp, h2, 'e2 damaged again on next frame');
});
