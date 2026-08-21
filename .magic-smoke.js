/* Temporary smoke test for js/magic.js — deleted after use. */
'use strict';
global.window = global;
const TC = window.TC = {};

// ---- minimal lead-module stubs ----
TC.CONST = { TS: 16, DMG_VARIANCE: 0.12, CRIT_CHANCE: 0.08 };
TC.ITEM_DEFS = {
  wood: { name: 'Wood', kind: 'block' }, gel: {}, glass: {},
  copper_bar: {}, iron_bar: {}, gold_bar: {}, torch: {}
};
TC.RECIPES = [{ out: 'workbench' }];
TC.Audio = { play(name) { log.push(['sfx', name]); } };
TC.Particles = {
  spawn(o) { return {}; }, burst() {}, floatText(x, y, s) { log.push(['text', s]); },
  update() {}, draw() {}
};
const log = [];
const hits = [];
TC.Enemies = {
  list: [],
  damageEnemy(e, dmg, dir, kb, crit) { hits.push({ dmg, crit }); e.hp -= dmg; }
};
class Player {
  constructor() {
    this.x = 100; this.y = 100; this.w = 18; this.h = 40;
    this.inventory = { remove(id, n) { log.push(['remove', id, n]); return true; } };
    this.hotbarIndex = 0; this.swingSeq = 0; this.dead = false;
    this._sel = null;
  }
  selectedSlot() { return this._sel; }
  serialize() { return { x: this.x }; }
  respawn() { this.dead = false; }
}
Player.deserialize = function (data) { return data ? Object.assign(new Player(), data) : null; };
TC.Player = Player;
let combatUpdated = 0, combatDrawn = 0, combatCleared = 0, uiDrawn = 0;
TC.Combat = {
  update(dt) { combatUpdated++; },
  draw(ctx, cam) { combatDrawn++; },
  clear() { combatCleared++; }
};
TC.UI = { draw(ctx, w, h) { uiDrawn++; } };
TC.Items = {};                       // no iconFor: icon extension skips cleanly
TC.applyCam = function () {}; TC.clearCam = function () {};
TC.world = { solidAtPixel(x, y) { return false; } };
TC.Input = { mouse: { x: 200, y: 0, down: false, clicked: false, worldX: 300, worldY: 100 }, uiHover: false };
TC.state = 'playing';
TC.player = new Player();

require('./js/magic.js');

const M = TC.Magic;
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('ok   - ' + msg); }
  else { fail++; console.log('FAIL - ' + msg); }
}

// 1. registration
ok(TC.ITEM_DEFS.water_bolt && TC.ITEM_DEFS.mana_potion && TC.ITEM_DEFS.demon_scythe, 'items registered');
ok(TC.RECIPES.some(r => r.out === 'water_bolt') && TC.RECIPES.length === 13, 'recipes appended');
ok(TC.ITEM_DEFS.wood.name === 'Wood', 'existing defs untouched');

// 2. hooks installed
ok(TC.Combat.update.__magicWrapped && TC.Combat.draw.__magicWrapped &&
   TC.Combat.clear.__magicWrapped && TC.UI.draw.__magicWrapped &&
   TC.Player.prototype.serialize.__magicWrapped && TC.Player.prototype.respawn.__magicWrapped,
   'wraps installed');

// 3. lazy mana init
M.ensureMana(TC.player);
ok(TC.player.mana === 20 && TC.player.maxMana === 20, 'mana initialized to base 20');

// 4. casting spends mana and spawns a bolt
const p = TC.player;
p._sel = { id: 'wand_sparking', count: 1 };
TC.Input.mouse.down = true;
TC.Combat.update(1 / 60);
ok(p.mana === 17, 'cast spent 3 mana (' + p.mana + ')');
ok(M.bolts.length === 1 && M.bolts[0].type === 'spark', 'spark bolt spawned');
ok(typeof p.swing === 'object' && p.swing.bow === true, 'swing pose set');

// 5. projectile flies and hits an enemy
TC.Enemies.list.push({ x: 280, y: 90, w: 26, h: 26, hp: 50 });
for (let i = 0; i < 60; i++) TC.Combat.update(1 / 60);
ok(hits.length >= 1 && hits[0].dmg >= 5 && hits[0].dmg <= 9, 'bolt damaged enemy (dmg ' + (hits[0] && hits[0].dmg) + ')');
ok(M.bolts.length === 0, 'non-piercing bolt died on hit');

// 6. insufficient mana blocks casting with throttled message
p.mana = 1; p.magicCd = 0;
log.length = 0;
TC.Combat.update(1 / 60);
ok(M.bolts.length === 0 && log.some(l => l[0] === 'text' && l[1] === 'Not enough mana!'), 'no-mana message shown');
TC.Combat.update(1 / 60); TC.Combat.update(1 / 60);
ok(log.filter(l => l[0] === 'text').length === 1, 'no-mana message throttled');

// 7. regen: idle refill through payload stars
TC.Input.mouse.down = false;
p.mana = 5; p.manaRegenDelay = 0;
let frames = 0;
while (p.mana < p.maxMana && frames < 60 * 10) { TC.Combat.update(1 / 60); frames++; }
ok(p.mana === p.maxMana, 'regen reached full mana in ' + (frames / 60).toFixed(1) + 's');
ok(frames > 60, 'regen was delayed/ramped, not instant');

// 8. mana potion + sickness
p.mana = 10;
p._sel = { id: 'mana_potion', count: 5 };
TC.Input.mouse.clicked = true;
TC.Combat.update(1 / 60);
TC.Input.mouse.clicked = false;
ok(p.mana === 100, 'potion restored mana to 100 (' + p.mana + ')');
ok(p.potionSickness > 55, 'potion sickness applied (' + p.potionSickness.toFixed(0) + 's)');
log.length = 0;
TC.Input.mouse.clicked = true;
TC.Combat.update(1 / 60);
TC.Input.mouse.clicked = false;
ok(!log.some(l => l[0] === 'remove'), 'sick potion drink consumed nothing');

// 9. mana crystal raises cap, respects MANA_CAP
p._sel = { id: 'mana_crystal', count: 99 };
for (let i = 0; i < 15; i++) {
  TC.Input.mouse.clicked = true;
  TC.Combat.update(1 / 60);
  TC.Input.mouse.clicked = false;
}
ok(p.maxMana === 200, 'crystals raised max mana to cap (' + p.maxMana + ')');
ok(p.mana <= p.maxMana, 'mana clamped to new cap');

// 10. persistence round-trip
p.mana = 123; p.potionSickness = 33;
const data = p.serialize();
ok(data.mana === 123 && data.maxMana === 200 && data.potionSickness === 33, 'serialize carries mana fields');
const p2 = TC.Player.deserialize(JSON.parse(JSON.stringify(data)));
ok(p2.mana === 123 && p2.maxMana === 200 && p2.potionSickness === 33, 'deserialize restores mana fields');
const p3 = TC.Player.deserialize({ x: 1, y: 1 });   // legacy save without mana
ok(p3.mana === 20 && p3.maxMana === 20, 'legacy save defaults to base pool');

// 11. respawn refills
p2.mana = 0; p2.respawn();
ok(p2.mana === p2.maxMana && p2.potionSickness === 0, 'respawn refilled mana and cleared sickness');

// 12. every weapon type fires and draws without throwing
const ctxStub = new Proxy({}, {
  get(t, k) { return (typeof t[k] === 'function') ? t[k] : function () {}; },
  set(t, k, v) { t[k] = v; return true; }
});
const weapons = ['wand_sparking', 'amethyst_staff', 'topaz_staff', 'emerald_staff',
  'sapphire_staff', 'ruby_staff', 'diamond_staff', 'water_bolt', 'flower_of_fire', 'demon_scythe'];
p.maxMana = 999; p.mana = 999; p.magicCd = 0;
let allFired = true;
for (const id of weapons) {
  const before = M.bolts.length;
  p._sel = { id, count: 1 };
  TC.Input.mouse.down = true;
  TC.Combat.update(1 / 60);
  TC.Input.mouse.down = false;
  if (M.bolts.length !== before + 1) { allFired = false; console.log('  did not fire: ' + id); }
}
ok(allFired, 'all 10 magic weapons fired');
const b0 = M.bolts[M.bolts.length - 1];
TC.Combat.draw(ctxStub, {});            // exercises spark/bolt/orb/scythe + star paths
ok(combatDrawn === 1, 'wrapped draw ran once');
M.bolts.forEach(b => { b.age = b.life + 1; });   // force expiry cleanup
TC.Combat.update(1 / 60);
ok(M.bolts.length === 0, 'expired bolts cleaned up');

// 13. clear resets everything
M.bolts.push({}); M.stars.push({});
TC.Combat.clear();
ok(M.bolts.length === 0 && M.stars.length === 0 && combatCleared === 1, 'Combat.clear also clears magic state');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
