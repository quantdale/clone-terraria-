/* tests/player/enemy-expansion.test.js — Waves 6-7: enemy ecosystem
   expansion + the Storm Jelly / Moss Mother bosses.

   Contract under test (js/enemies.js):
     - new regular defs (dune_stalker, frost_wolf, snapvine, rock_charger,
       void_wisp, gloom_bat) plus minion defs registered with AI fields and
       coins ranges; coins retrofit landed on the previously bare defs
     - spawnBoss('storm_jelly'/'moss_mother') creates living boss entities
       and CONST.MAX_BOSSES stays authoritative
     - killing a spawned boss removes it, emits BossDefeated {type} exactly
       once, and TC.Progression records boss.<type>.defeated via its generic
       fallback
     - def.coins rides rollDrops -> TC.Economy.dropCoins -> coin_* drops
     - new archetype AIs actually do their thing (snapvine bites, void wisp
       blinks) and boss attacks fire pooled projectiles */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');

function boot(seed) {
  const g = loadGame();
  g.TC.newGame(seed == null ? 20260822 : seed);
  return g;
}

test('expansion: new enemy defs registered with ai + coins ranges', () => {
  const { TC } = boot(301);
  const D = TC.ENEMY_DEFS;
  const regulars = {
    dune_stalker: 'walker',
    frost_wolf: 'walker',
    snapvine: 'stationary',
    rock_charger: 'walker',
    void_wisp: 'teleporter',
    gloom_bat: 'bat',
  };
  for (const [id, ai] of Object.entries(regulars)) {
    const d = D[id];
    assert.ok(d, id + ' def missing');
    assert.strictEqual(d.ai, ai, id + ' ai mismatch');
    assert.ok(
      Array.isArray(d.coins) && d.coins.length === 2 && d.coins[0] <= d.coins[1],
      id + ' needs a sane coins range'
    );
  }
  assert.ok(D.frost_wolf.lunge, 'frost_wolf must declare a lunge');
  assert.ok(D.rock_charger.charge, 'rock_charger must declare a charge');

  // minion sheds are plain enemies (no boss/part flag)
  for (const id of ['jelly_minion', 'sporeling']) {
    assert.ok(D[id], id + ' minion def missing');
    assert.ok(!D[id].boss && !D[id].part, id + ' must be a normal enemy');
  }

  // bosses flagged so MAX_BOSSES + UI health bar apply; core material loot
  for (const [id, core] of [['storm_jelly', 'storm_core'], ['moss_mother', 'moss_core']]) {
    const d = D[id];
    assert.ok(d, id + ' boss def missing');
    assert.strictEqual(d.boss, true, id + ' must be flagged boss');
    assert.strictEqual(typeof d.defense, 'number', id + ' needs defense');
    assert.ok(d.hp >= 1800 && d.dmg >= 26, id + ' tuning below spec');
    assert.ok(
      Array.isArray(d.drops) && d.drops.some((x) => x.id === core),
      id + ' must drop ' + core
    );
    assert.ok(Array.isArray(d.coins) && d.coins[0] >= 800, id + ' boss-tier coins');
    // summon items are lead-owned (constants.js) and pre-wired to these ids
    const item = id === 'storm_jelly' ? TC.ITEM_DEFS.storm_bell : TC.ITEM_DEFS.moss_heart;
    assert.ok(item, id + ' summon item must exist');
    assert.strictEqual(item.kind, 'summon', id + ' summon item kind');
    assert.strictEqual(item.boss, id, 'summon item must target EXACT boss id ' + id);
  }

  // coins retrofit landed on every previously bare module-owned def
  for (const id of [
    'harpy', 'vulture', 'eater_of_souls', 'ice_slime', 'sand_slime',
    'jungle_bat', 'skeleton', 'granite_golem', 'blood_crawler',
    'crimson_slime', 'king_slime', 'skeletron', 'wof',
  ]) {
    assert.ok(
      Array.isArray(D[id].coins) && D[id].coins[0] <= D[id].coins[1],
      id + ' missing coins retrofit'
    );
  }
});

test('expansion: spawnBoss creates living bosses and honors MAX_BOSSES', () => {
  const { TC } = boot(302);
  const origCap = TC.CONST.MAX_BOSSES;
  TC.CONST.MAX_BOSSES = 2;
  try {
    TC.Enemies.clear();
    const a = TC.Enemies.spawnBoss('storm_jelly', 500, 200);
    assert.ok(a, 'storm_jelly summon failed');
    assert.strictEqual(a.type, 'storm_jelly');
    assert.ok(a.hp > 0 && a.hp === a.maxHp && a.def.boss, 'boss must spawn alive');
    const b = TC.Enemies.spawnBoss('moss_mother', 700, 200);
    assert.ok(b, 'moss_mother summon failed');
    assert.strictEqual(b.type, 'moss_mother');
    assert.ok(TC.Enemies.list.includes(a) && TC.Enemies.list.includes(b),
      'both bosses must be living list members');
    assert.strictEqual(TC.Enemies.spawnBoss('king_slime', 400, 200), null,
      'third concurrent boss must be refused at MAX_BOSSES=2');
  } finally {
    TC.CONST.MAX_BOSSES = origCap;
    TC.Enemies.clear();
  }

  // stock cap of 1: a second concurrent summon is refused
  const first = TC.Enemies.spawnBoss('storm_jelly', 500, 200);
  assert.ok(first, 'stock cap allows one boss');
  assert.strictEqual(TC.Enemies.spawnBoss('moss_mother', 500, 200), null,
    'stock MAX_BOSSES=1 must refuse a concurrent second boss');
});

test('expansion: boss death removes entity, emits BossDefeated, records progression', () => {
  const { TC } = boot(303);
  const EV = TC.Events.EVENT;
  const bossDown = [];
  TC.Events.on(EV.BossDefeated, (p) => bossDown.push(JSON.parse(JSON.stringify(p))));

  const jelly = TC.Enemies.spawnBoss('storm_jelly', 500, 200);
  assert.ok(jelly, 'storm_jelly summon failed');
  TC.Enemies.damageEnemy(jelly, jelly.hp + 9999, 1, 0);
  assert.equal(TC.Enemies.list.indexOf(jelly), -1, 'dead boss must leave the list');
  assert.equal(bossDown.length, 1, 'BossDefeated must fire exactly once');
  assert.equal(bossDown[0].type, 'storm_jelly', 'payload.type must be the DEFS key');
  assert.ok(TC.Progression.has('boss.storm_jelly.defeated'),
    'generic fallback must record boss.storm_jelly.defeated');

  // sequential second boss (the cap slot was freed by the kill above)
  const mom = TC.Enemies.spawnBoss('moss_mother', 500, 200);
  assert.ok(mom, 'moss_mother summon failed after the first kill');
  TC.Enemies.damageEnemy(mom, mom.hp + 9999, 1, 0);
  assert.equal(bossDown.length, 2);
  assert.equal(bossDown[1].type, 'moss_mother');
  assert.ok(TC.Progression.has('boss.moss_mother.defeated'),
    'generic fallback must record boss.moss_mother.defeated');
});

test('expansion: rollDrops scatters zombie coins through Economy.dropCoins', () => {
  const { TC } = boot(304);
  TC.Items.clearDrops();
  const z = TC.Enemies.spawnEnemy('zombie', TC.player.x + 200, TC.player.y);
  assert.ok(z, 'zombie spawn failed');
  assert.ok(Array.isArray(z.def.coins), 'zombie must carry a coins range');
  TC.Enemies.damageEnemy(z, 99999, 1, 0); // kill before any update tick
  assert.equal(TC.Enemies.list.indexOf(z), -1, 'zombie must die');
  const coinDrops = TC.Items.drops.filter((d) => String(d.id).indexOf('coin_') === 0);
  assert.ok(coinDrops.length > 0,
    'a zombie kill must scatter coin_* drops via Economy.dropCoins');
});

test('expansion: biome override table surfaces the new biome enemy', () => {
  const { TC } = boot(306);
  const origGet = TC.Biomes.getSpawnOverride;
  const origMult = TC.Progression.spawnMultiplier;
  TC.Biomes.getSpawnOverride = () => [['dune_stalker', 1]]; // becomes the day base table
  TC.Progression.spawnMultiplier = () => 8;                 // fast director cycles
  try {
    TC.Enemies.clear();
    const DT = 0.25;
    let t = 0, found = false;
    while (t < 90 && !found) {
      TC.Enemies.spawnDirector(DT);
      t += DT;
      found = TC.Enemies.list.some((e) => e.type === 'dune_stalker');
      if (!found) TC.Enemies.list.length = 0; // keep the population cap from blocking rerolls
    }
    assert.ok(found, 'override table never produced dune_stalker in 90 s sim');
  } finally {
    TC.Biomes.getSpawnOverride = origGet;
    TC.Progression.spawnMultiplier = origMult;
    TC.Enemies.clear();
  }
});

test('expansion: snapvine archetype bites players in reach', () => {
  const { TC } = boot(307);
  const p = TC.player;
  p.vx = 0; p.vy = 0;
  const vine = TC.Enemies.spawnEnemy('snapvine', p.x + 44, p.y - 4);
  assert.ok(vine, 'snapvine spawn failed');
  // adjacent but NOT overlapping: contact damage is off, only the bite hurts
  assert.ok(vine.x > p.x + p.w, 'keep the vine out of contact range');
  let bitten = false;
  for (let i = 0; i < 900 && !bitten; i++) {
    p.vx = 0; p.vy = 0;
    TC.Enemies.update(1 / 60);
    if (p.hp < p.maxHp) bitten = true;
  }
  assert.ok(bitten, 'snapvine never bit an in-reach player within 15 s');
});

test('expansion: void wisp teleports toward the player', () => {
  const { TC } = boot(308);
  const p = TC.player;
  const wisp = TC.Enemies.spawnEnemy('void_wisp', p.x + 6 * 16, p.y - 40);
  assert.ok(wisp, 'void_wisp spawn failed');
  let sawBlink = false;
  for (let i = 0; i < 900 && !sawBlink; i++) {
    const px = wisp.x, py = wisp.y;
    TC.Enemies.update(1 / 60);
    // drift caps at 150 px/s (~2.5 px/frame); a blink jumps far farther
    if (Math.hypot(wisp.x - px, wisp.y - py) > 30) sawBlink = true;
  }
  assert.ok(sawBlink, 'void_wisp never blinked within 15 s');
});

test('expansion: bosses fight — pooled attack projectiles spawn', () => {
  const { TC } = boot(305);
  const EV = TC.Events.EVENT;
  const shotTypes = [];
  TC.Events.on(EV.ProjectileSpawned, (p) => shotTypes.push(p.type));
  const p = TC.player;

  const jelly = TC.Enemies.spawnBoss('storm_jelly', p.x, p.y - 10 * 16);
  assert.ok(jelly, 'storm_jelly summon failed');
  let sawStar = false;
  for (let i = 0; i < 1200 && !sawStar; i++) {
    p.hp = p.maxHp; // immortal training dummy
    TC.Enemies.update(1 / 60);
    if (shotTypes.indexOf('falling_star') >= 0) sawStar = true;
  }
  assert.ok(sawStar, 'storm_jelly never dropped a lightning bolt in 20 s');

  TC.Enemies.clear();
  shotTypes.length = 0;
  const mom = TC.Enemies.spawnBoss('moss_mother', p.x + 6 * 16, p.y);
  assert.ok(mom, 'moss_mother summon failed');
  let sawSpore = false;
  for (let i = 0; i < 1200 && !sawSpore; i++) {
    p.hp = p.maxHp;
    TC.Enemies.update(1 / 60);
    if (shotTypes.indexOf('magic_bolt') >= 0) sawSpore = true;
  }
  assert.ok(sawSpore, 'moss_mother never breathed spores in 20 s');
});
