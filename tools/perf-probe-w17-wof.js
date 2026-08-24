/* W17 Wall-of-Flesh perf probe: exercises the new Underworld encounter. */
'use strict';
const { loadGame } = require('../tests/helpers/load-game.js');

const g = loadGame();
g.TC.newGame(424242);
const TC = g.TC;

function bench(name, fn, iters) {
  for (let i = 0; i < Math.min(1000, iters); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log(name.padEnd(40), (ms / iters * 1000).toFixed(3), 'us/op', '(' + iters + ' iters, ' + ms.toFixed(1) + ' ms total)');
}

// put player deep in underworld for realistic band
const TS = TC.CONST.TS;
const UW_START = TC.CONST.GEN.underworld.startY;
const p = TC.player;
p.x = (TC.world.width / 2) * TS;
p.y = (UW_START + 12) * TS;
TC.Biomes.update(1);
TC.Biomes.update(1);

// force wof placement in underworld
const before = TC.Enemies.list.length;
const wof = TC.Enemies.spawnBoss('wof', p.x + 200, p.y, { dir: 1, band: { minY: UW_START * TS + TS, maxY: (UW_START + 18) * TS, centerY: p.y } });
if (!wof) {
  console.log('wof spawn failed');
  process.exit(1);
}
console.log('wof spawned', wof.x, wof.y, 'dir', wof.wofDir, 'band', JSON.stringify(wof.wofBand));
console.log('enemies', TC.Enemies.list.length, 'projectiles', TC.Projectiles.activeCount());

bench('WOF AI update (single wall, no servants)', () => {
  TC.Enemies.update(1 / 60);
}, 6000);

// add 5 hungry servants
for (let i = 0; i < 5 && wof.servants < 6; i++) TC.Enemies.spawnServantOf(wof, 'hungry', wof.x + 20, wof.y + 30);
console.log('after servants', TC.Enemies.list.length, 'servants', wof.servants);

bench('WOF AI + 5 hungry servants', () => {
  TC.Enemies.update(1 / 60);
}, 6000);

// fire a fan of 5 hostile bolts
function fireFan() {
  const sx = wof.x + wof.w / 2, sy = wof.y + wof.h * 0.32;
  for (let k = 0; k < 5; k++) {
    const pr = TC.Projectiles.spawn('magic_bolt', sx, sy, (Math.random() - 0.5) * 0.6, { owner: null, speed: 320, dmg: 12, hitRadius: 9 });
    if (pr && TC.Enemies.trackHostileShot) TC.Enemies.trackHostileShot(pr, wof, 12);
  }
}
fireFan();
console.log('after fan projectiles', TC.Projectiles.activeCount());

bench('hostile projectile load (5 bolts, wof+hungry)', () => {
  TC.Enemies.update(1 / 60);
  TC.Projectiles.update(1 / 60);
}, 4000);

bench('full Enemies.update under encounter (wof+5 hungry+5 bolts)', () => {
  TC.Enemies.update(1 / 60);
}, 6000);

bench('arena placement compute', () => {
  // simulate summon placement query
  const pl = TC.player;
  const w = TC.world;
  const def = TC.ENEMY_DEFS.wof;
  const dir = pl.x < w.width * TS / 2 ? 1 : -1;
  const spawnX = dir === 1 ? 4 * TS : w.width * TS - def.w - 4 * TS;
  // minimal band scan check
  let wantY = pl.y;
  wantY = Math.max(UW_START * TS + TS, Math.min(w.height * TS - def.h - 4 * TS, wantY));
  // dummy solidity check
  void (spawnX + wantY);
}, 100000);

bench('biomes getSpawnOverride (underworld post-wall)', () => {
  TC.Biomes.getSpawnOverride();
}, 100000);

bench('currentBiomeTag (summon gate)', () => {
  // emulate player.doSummon biome check
  const cur = (TC.Biomes && TC.Biomes.current) ? TC.Biomes.current : 'forest';
  void cur;
}, 500000);

console.log('\nWOF metrics', TC.Enemies.getWofEncounter ? TC.Enemies.getWofEncounter() : 'n/a');
console.log('\nframe budget check: worst op above vs 16.6ms/frame');
console.log('note: wof sweeps at ' + (wof.wofPhase === 1 ? 72 : wof.wofPhase === 2 ? 96 : 124) + ' px/s, servants capped ' + (wof.wofPhase === 1 ? 4 : wof.wofPhase === 2 ? 5 : 6) + ', projectile cap 12');
