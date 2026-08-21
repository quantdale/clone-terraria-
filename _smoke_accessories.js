/* Headless smoke test for js/accessories.js (temporary; deleted after run). */
'use strict';
const fs = require('fs');
global.window = global;
const src = (f) => fs.readFileSync('js/' + f, 'utf8');

eval(src('constants.js'));
eval(src('utils.js'));
eval(src('particles.js'));
eval(src('items.js'));
eval(src('player.js'));
eval(src('combat.js'));
eval(src('crafting.js'));
eval(src('accessories.js'));

const T = window.TC;
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ok  ' + msg); }
  else { fail++; console.log('FAIL  ' + msg); }
}
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, msg + ' (' + a + ' ~ ' + b + ')'); }

// 1. defs + recipes installed
ok(T.ITEM_DEFS.guard_ring && T.ITEM_DEFS.guard_ring.kind === 'accessory', 'accessory defs appended');
ok(T.ITEM_DEFS.ironskin_potion && T.ITEM_DEFS.ironskin_potion.kind === 'potion', 'potion defs appended');
ok(T.RECIPES.some(r => r.out === 'guard_ring') && T.RECIPES.some(r => r.out === 'ironskin_potion'), 'recipes appended');

// 2. hooks installed
ok(T.Player.prototype.totalDefense.__accWrap, 'totalDefense wrapped');
ok(T.Player.prototype.update.__accWrap, 'update wrapped');
ok(T.Player.prototype.useHeld.__accWrap, 'useHeld wrapped');
ok(T.Combat.meleeStrike.__accWrap && T.Combat.shootArrow.__accWrap && T.Combat.hurtPlayer.__accWrap, 'combat fns wrapped');

// 3. defense aggregation: armor + accessory + buff
const p = new T.Player(100, 100);
p.equipment.body = 'iron_mail';                       // defense 3
ok(p.totalDefense() === 3, 'armor-only defense = 3');
T.Accessories.slotsOf(p)[0] = { id: 'guard_ring', prefix: null }; // +2
ok(p.totalDefense() === 5, 'with ring defense = 5');
T.Buffs.apply('ironskin', 10, p);                    // +8
ok(T.Buffs.has('ironskin'), 'ironskin applied');
ok(p.totalDefense() === 13, 'with ironskin defense = 13');
T.Buffs.tick(1, p);
near(T.Buffs.list[0].time, 9, 1e-9, 'buff timer ticks down');

// 4. update wrap: regen bonus, CONST restore
function regenDelta(dt) {
  p.hp = 50; p.regenTimer = -1;
  const before = p.hp;
  p.update(dt);
  return p.hp - before;
}
const d0 = regenDelta(0.5);                            // base 1.6*0.5 = 0.8
T.Buffs.apply('regeneration', 20, p);                 // +2 hp/s
const d1 = regenDelta(0.5);                            // (1.6+2)*0.5 = 1.8
near(d0, 0.8, 1e-6, 'base regen delta');
near(d1 - d0, 1.0, 1e-6, 'regeneration adds +1 hp per 0.5s');
ok(T.CONST.RUN_MAX === 185 && T.CONST.RUN_ACCEL === 1500 && T.CONST.REGEN_RATE === 1.6,
   'CONST restored after update');

// 5. maxHp sync via vital amulet
T.Accessories.slotsOf(p)[1] = { id: 'vital_amulet', prefix: null };
p.hp = 100;
p.update(0.01);
ok(p.maxHp === 120, 'maxHp raised to 120 by amulet');
T.Accessories.slotsOf(p)[1] = null;
p.hp = 110;
p.update(0.01);
ok(p.maxHp === 100 && p.hp <= 100, 'maxHp restored and overflow clamped');

// 6. melee scaling (variance/crit zeroed for determinism)
const savedV = T.CONST.DMG_VARIANCE, savedC = T.CONST.CRIT_CHANCE;
T.CONST.DMG_VARIANCE = 0; T.CONST.CRIT_CHANCE = 0;
let captured = -1;
const realEnemies = T.Enemies;
T.Enemies = { list: [{ x: -50, y: -50, w: 20, h: 20, hp: 999, lastHitSwing: null }],
               damageEnemy: (e, dmg) => { captured = dmg; } };
T.player = p;
Combat_melee(10);
ok(captured === 10, 'melee base damage passes through (' + captured + ')');
T.Accessories.slotsOf(p)[2] = { id: 'power_glove', prefix: null };  // x1.15 melee
Combat_melee(10);
ok(captured === Math.round(10 * 1.15), 'power glove scales melee to 12 (' + captured + ')');
T.Accessories.slotsOf(p)[2] = null;

// 7. arrow scaling
T.Combat.arrows.length = 0;
T.Combat.shootArrow(0, 0, 0, 100, 8);
ok(T.Combat.arrows[0].dmg === 8, 'arrow base damage passes through');
T.Accessories.slotsOf(p)[3] = { id: 'aimer_lens', prefix: null };   // x1.15 ranged
T.Combat.arrows.length = 0;
T.Combat.shootArrow(0, 0, 0, 100, 8);
ok(T.Combat.arrows[0].dmg === Math.round(8 * 1.15), 'aimer lens scales arrow to 9');
T.Accessories.slotsOf(p)[3] = null;
T.Enemies = realEnemies;
T.CONST.DMG_VARIANCE = savedV; T.CONST.CRIT_CHANCE = savedC;

// 8. lava -> burning debuff via hurtPlayer
p.iframes = 0;
const hpBefore = p.hp;
T.Combat.hurtPlayer(10, 0, 0, 'lava');
ok(T.Buffs.has('burning'), 'lava hit applies burning');
ok(p.hp < hpBefore, 'lava hit damaged player');
T.Buffs.remove('burning');

// 9. potion consumption through useHeld
p.inventory.add('regen_potion', 2);
p.hotbarIndex = 0;
ok(p.inventory.get(0) && p.inventory.get(0).id === 'regen_potion', 'potion in hotbar slot 0');
p.useHeld(0.016);
ok(p.inventory.count('regen_potion') === 1, 'one potion consumed');
ok(T.Buffs.has('regeneration'), 'regeneration buff granted by potion');
ok((p._potionCd || 0) > 0, 'potion cooldown started');
p.useHeld(0.016);
ok(p.inventory.count('regen_potion') === 1, 'cooldown blocks double-drink');

// 10. equip / unequip flow
const q = new T.Player(0, 0);
q.inventory.add('guard_ring', 1);
ok(T.Accessories.equip(q, 0, 0), 'equip guard_ring from slot 0');
ok(T.Accessories.slotsOf(q)[0] && T.Accessories.slotsOf(q)[0].id === 'guard_ring' && !q.inventory.get(0),
   'ring worn, bag slot emptied');
q.inventory.add('vital_amulet', 1);
ok(T.Accessories.equip(q, 0, 0), 'swap-wear vital_amulet');
ok(T.Accessories.slotsOf(q)[0].id === 'vital_amulet' &&
   q.inventory.get(0) && q.inventory.get(0).id === 'guard_ring',
   'old ring stowed back into bag slot 0');
q.inventory.add('dirt', 1);              // lands in first free slot (1)
ok(!T.Accessories.equip(q, 1, 0), 'non-accessory refused');
ok(T.Accessories.slotsOf(q)[0].id === 'vital_amulet', 'worn piece untouched after refusal');
ok(T.Accessories.unequip(q, 0, 2), 'unequip to explicit free slot');
ok(T.Accessories.slotsOf(q)[0] === null && q.inventory.get(2) && q.inventory.get(2).id === 'vital_amulet',
   'amulet back in bag');

// 11. serialize round trip
T.Buffs.clear();
T.Buffs.apply('swiftness', 30, q);
T.Accessories.slotsOf(q)[4] = { id: 'regen_band', prefix: 'quick' };
const data = q.serialize();
ok(Array.isArray(data.accessories) && data.accessories.length === 5 &&
   data.accessories[4].id === 'regen_band' && data.accessories[4].prefix === 'quick',
   'serialize carries accessories + prefix');
ok(Array.isArray(data.buffs) && data.buffs[0][0] === 'swiftness', 'serialize carries buffs');
T.Buffs.clear();
const q2 = T.Player.deserialize(JSON.parse(JSON.stringify(data)));
ok(q2 && q2.accessories[4].id === 'regen_band', 'deserialize restores accessories');
ok(T.Buffs.has('swiftness'), 'deserialize restores buffs');
ok(T.Accessories.modsOf(q2).regen > 0 && T.Accessories.modsOf(q2).moveSpeed > 1,
   'prefix mods merge into stat mods');

// 12. rollPrefix determinism + spread
const r1 = T.Accessories.rollPrefix('guard_ring', 'seed-A');
ok(r1 === T.Accessories.rollPrefix('guard_ring', 'seed-A'), 'rollPrefix deterministic');
const seen = new Set();
for (let i = 0; i < 60; i++) seen.add(T.Accessories.rollPrefix('iron_bar', 's' + i));
ok(seen.has('none'), 'prefix pool includes none');
ok([...seen].every(k => !!T.Accessories.PREFIX_DEFS[k]), 'all rolled prefixes are known');
ok([...seen].size > 3, 'prefix rolls vary across seeds');

// 13. clear-on-death semantics
T.Buffs.clear();
T.Buffs.apply('wrath', 10, q);
q.dead = true;
T.Buffs.tick(0.016, q);
ok(T.Buffs.list.length === 0, 'buffs cleared when player dies');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

// helper defined last (hoisted)
function Combat_melee(dmg) {
  T.Combat.meleeStrike(0, 0, 200, -10, 10, dmg, 3, null);
}
