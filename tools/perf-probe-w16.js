/* One-off W16 performance sanity probe (ad-hoc; not part of the suite). */
'use strict';
const { loadGame } = require('../tests/helpers/load-game.js');

const g = loadGame();
g.TC.newGame(4242);
const TC = g.TC;

function bench(name, fn, iters) {
  // warmup
  for (let i = 0; i < Math.min(1000, iters); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log(name.padEnd(34), (ms / iters * 1000).toFixed(3), 'us/op', '(' + iters + ' iters, ' + ms.toFixed(1) + ' ms total)');
}

const p = TC.player;
const e = TC.Enemies.spawnEnemy('blue_slime', p.x + 40, p.y - 20);
TC.Enemies.list.push(e);

bench('Combat.resolveHit (player melee)', () => {
  TC.Combat.resolveHit({ base: 10, cls: 'melee', attacker: TC.player, target: e, kb: 3 });
}, 200000);

bench('Combat.hitEnemy (resolve+apply)', () => {
  e.hp = 100000;
  TC.Combat.hitEnemy(e, 1, { base: 10, cls: 'melee', attacker: TC.player, kb: 3 });
}, 100000);

bench('Progression.test compound', () => {
  TC.Progression.test({ all: [{ boss: 'storm_jelly' }, { any: [{ biome: 'snow' }, 'event.blood_moon.completed'] }, { not: { boss: 'skeletron' } }] });
}, 500000);

bench('Crafting.available (all recipes)', () => {
  TC.Crafting.available(TC.player.inventory, new Set(['anvil', 'workbench']));
}, 20000);

bench('LootTables.roll king_slime', () => {
  TC.LootTables.roll(TC.ENEMY_DEFS.king_slime.drops);
}, 200000);

bench('EnemySpawn.zoneTable day', () => {
  TC.EnemySpawn.zoneTable('day', Math.floor(TC.world.width / 2));
}, 50000);

// enemy update cost with a realistic population
for (let i = 0; i < 7 && TC.Enemies.list.length < 8; i++) {
  TC.Enemies.spawnEnemy('green_slime', p.x + (i + 2) * 30, p.y - 4);
}
bench('Enemies.update dt=1/60 (8 entities)', () => {
  TC.Enemies.update(1 / 60);
}, 6000);

console.log('\nframe budget check: worst op above vs 16.6ms/frame');
