/* W17 Wall-of-Flesh perf probe (W19 refresh): exercises the Underworld
   encounter under representative worst-case load — live wall + hungry
   servants + hostile projectile volley + underworld spawn zoning.

   The encounter is TERMINAL by design (a direction-locked sweep ends at the
   world edge), so long benches re-establish a live wall via ensureWall();
   otherwise later benches would silently measure an empty enemy list. */
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
  console.log(name.padEnd(46), (ms / iters * 1000).toFixed(3), 'us/op', '(' + iters + ' iters, ' + ms.toFixed(1) + ' ms total)');
}

// put player deep in underworld for realistic band
const TS = TC.CONST.TS;
const UW_START = TC.CONST.GEN.underworld.startY;
const p = TC.player;
p.x = (TC.world.width / 2) * TS;
p.y = (UW_START + 12) * TS;
for (let i = 0; i < 20; i++) TC.Biomes.update(0.25);

// Carve an open encounter pocket (as the browser journey does) so servant
// placement finds free space instead of bouncing off raw ashstone.
{
  const cxT = Math.floor(p.x / TS);
  const y0 = UW_START + 6, y1 = UW_START + 22;
  for (let y = y0; y <= y1; y++) {
    for (let x = cxT - 45; x <= cxT + 45; x++) TC.world.setRaw(x, y, TC.TILE.AIR);
    TC.world.setRaw(cxT - 46, y1 + 1, TC.TILE.STONE);
  }
  for (let x = cxT - 47; x <= cxT + 47; x++) TC.world.setRaw(x, y1 + 1, TC.TILE.STONE);
  if (TC.Liquids && typeof TC.Liquids.displace === 'function') {
    for (let y = y0 - 2; y <= y1 + 2; y++)
      for (let x = cxT - 47; x <= cxT + 47; x++) TC.Liquids.displace(x, y);
  }
}

const BAND = { minY: UW_START * TS + TS, maxY: (UW_START + 18) * TS, centerY: p.y };
function ensureWall() {
  let w = TC.Enemies.list.find((e) => e.type === 'wof');
  if (!w) {
    w = TC.Enemies.spawnBoss('wof', p.x - 600, p.y, { dir: 1, band: BAND });
    if (w) w.x = p.x - 600; // park behind the player so the sweep outlives the bench
  }
  return w;
}
function rewind(w) {
  if (w && w.x > p.x + 400) w.x = p.x - 600; // keep the terminal edge far away
}

let wof = ensureWall();
if (!wof) {
  console.log('wof spawn failed');
  process.exit(1);
}
console.log('wof spawned', wof.x, wof.y, 'dir', wof.wofDir, 'band', JSON.stringify(wof.wofBand));
console.log('enemies', TC.Enemies.list.length, 'projectiles', TC.Projectiles.activeCount());

bench('WOF AI update (single wall, no servants)', () => {
  rewind(ensureWall());
  TC.Enemies.update(1 / 60);
}, 6000);

wof = ensureWall();
for (let i = 0; i < 8 && wof && wof.servants < 6; i++) {
  TC.Enemies.spawnServantOf(wof, 'hungry', wof.x + 20, wof.y + 30);
}
wof = TC.Enemies.list.find((e) => e.type === 'wof');
console.log('after servants', TC.Enemies.list.length, 'servants', wof ? wof.servants : 'wall gone');

bench('WOF AI + hungry servants (cap 6)', () => {
  rewind(ensureWall());
  TC.Enemies.update(1 / 60);
}, 6000);

// fire a fan of 5 hostile bolts
function fireFan(w) {
  const sx = w.x + w.w / 2, sy = w.y + w.h * 0.32;
  for (let k = 0; k < 5; k++) {
    const pr = TC.Projectiles.spawn('magic_bolt', sx, sy, (Math.random() - 0.5) * 0.6, { owner: null, speed: 320, dmg: 12, hitRadius: 9 });
    if (pr && TC.Enemies.trackHostileShot) TC.Enemies.trackHostileShot(pr, w, 12);
  }
}
if (wof) fireFan(wof);
console.log('after fan projectiles', TC.Projectiles.activeCount());

bench('hostile volley update (5 bolts, wof+hungry)', () => {
  const w = ensureWall();
  if (!w || !TC.Enemies.list.some((e) => e.master === w)) return;
  rewind(w);
  TC.Enemies.update(1 / 60);
  TC.Projectiles.update(1 / 60);
}, 4000);

bench('full Enemies.update under encounter load', () => {
  const w = ensureWall();
  if (!w || !TC.Enemies.list.some((e) => e.master === w)) return;
  rewind(w);
  if (TC.Projectiles.activeCount() < 5) fireFan(w);
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

bench('shared underworld query isUnderworldAt', () => {
  TC.Biomes.isUnderworldAt(p.x, p.y + p.h / 2);
}, 500000);

bench('spawn zoning: zoneOf + zoneTable(underworld)', () => {
  const z = TC.EnemySpawn.zoneOf(p, TC.world, 0.5);
  const col = Math.max(0, Math.min(TC.world.width - 1, Math.floor((p.x + p.w / 2) / TS)));
  void TC.EnemySpawn.zoneTable(z, col);
}, 100000);

bench('spawnDirector tick (underworld zoning live)', () => {
  TC.EnemySpawn.spawnDirector(1); // large dt keeps attempts flowing
}, 20000);

bench('currentBiomeTag (summon gate)', () => {
  // real gate path: shared pure query first, then biome string fallback
  const inUw = TC.Biomes.isUnderworldAt(p.x, p.y + p.h / 2);
  const cur = inUw ? 'underworld' : ((TC.Biomes && TC.Biomes.current) || 'forest');
  void cur;
}, 500000);

console.log('\nWOF metrics', TC.Enemies.getWofEncounter ? TC.Enemies.getWofEncounter() : 'n/a');
console.log('\nframe budget check: worst op above vs 16.6ms/frame');
wof = TC.Enemies.list.find((e) => e.type === 'wof');
console.log('note: wof sweeps at ' + (wof && wof.wofPhase === 1 ? 72 : wof && wof.wofPhase === 2 ? 96 : 124) + ' px/s, servants capped ' + (wof && wof.wofPhase === 1 ? 4 : wof && wof.wofPhase === 2 ? 5 : 6) + ', projectile cap 12');
