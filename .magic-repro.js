/* Minimal repro: idle regen from mana=5 to full, with tracing. */
'use strict';
global.window = global;
const TC = window.TC = {};
TC.CONST = { TS: 16, DMG_VARIANCE: 0.12, CRIT_CHANCE: 0.08 };
TC.ITEM_DEFS = { wood: {} };
TC.RECIPES = [];
TC.Audio = { play() {} };
TC.Particles = { spawn() { return {}; }, burst() {}, floatText() {} };
TC.Enemies = { list: [], damageEnemy() {} };
class Player {
  constructor() { this.x = 100; this.y = 100; this.w = 18; this.h = 40; this.dead = false; }
}
Player.deserialize = function () { return null; };
TC.Player = Player;
TC.Combat = { update() {}, draw() {}, clear() {} };
TC.UI = { draw() {} };
TC.world = { solidAtPixel() { return false; } };
TC.Input = { mouse: { down: false, clicked: false, worldX: 0, worldY: 0 }, uiHover: false };
TC.state = 'playing';
TC.player = new Player();

require('./js/magic.js');
const M = TC.Magic;
const p = TC.player;
M.ensureMana(p);
p.mana = 5; p.maxMana = 20; p.manaRegenDelay = 0;

for (let f = 1; f <= 600; f++) {
  TC.Combat.update(1 / 60);
  if (f % 30 === 0 || p.mana >= p.maxMana) {
    console.log('f=' + f,
      'mana=' + p.mana.toFixed(2),
      'accum=' + (p.manaAccum || 0).toFixed(2),
      'delay=' + (p.manaRegenDelay || 0).toFixed(2),
      'regenT=' + (p.manaRegenT || 0).toFixed(2),
      'stars=' + M.stars.length,
      'starPos=' + (M.stars[0] ? M.stars[0].x.toFixed(0) + ',' + M.stars[0].y.toFixed(0) : '-'));
  }
  if (p.mana >= p.maxMana) { console.log('FULL at frame ' + f); break; }
}
