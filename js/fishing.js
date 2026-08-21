/* fishing.js — TC.Fishing: rods, bobber casting, bite rolls + reel timing,
   per-zone loot tables, crates, daily quest fish.
   Self-integrates without touching lead-owned files:
   - extends TC.ITEM_DEFS / TC.RECIPES at load (rods, bait, fish, crates)
   - decorates TC.Player.prototype (useHeld intercepts rods/crates; update
     drives the sim; draw renders line + bobber in world space)
   - wraps TC.Items.iconFor for fishing-item icons (falls back to items.js)
   Load order: after player.js/items.js/ui.js, before main.js (see index.html).
   Save integration: TC.Fishing.serialize()/load(data) are provided but not
   yet wired into save.js's fixed data blob; quest/catch stats reset on reload. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  // ---- tuning (module-local; candidates to promote into TC.CONST) ----
  const F = {
    BOBBER_SPEED: 430,        // cast launch speed px/s
    BOBBER_GRAVITY: 1100,
    MAX_LINE_LEN: 340,        // px between player and bobber before auto-reel
    BITE_ROLL_EVERY: 0.5,     // seconds between bite-chance rolls
    BITE_CHANCE_MAX: 0.45,    // per-roll cap
    BITE_CHANCE_DIV: 260,     // chance = power / this
    REEL_WINDOW: 0.95,        // seconds to hook a bite
    HARD_LIQUID_WINDOW: 0.8,  // reel-window scale in lava/honey
    PERFECT_FRAC: 0.45,       // hooking within this early fraction = perfect
    CRATE_BASE: 0.05,         // crate chance per catch at power 0
    CRATE_PER_POWER: 0.0011,  // extra crate chance per power point
    UNDERGROUND_DEPTH: 14,    // tiles below surfaceY that count as underground
    OCEAN_EDGE: 55,           // tiles from a world edge that count as ocean
    LAVA_POWER_MULT: 0.5,
    HONEY_POWER_MULT: 0.7,
    UNDERGROUND_POWER_MULT: 0.85,
    OCEAN_POWER_MULT: 1.15,
    POWER_CAP: 120,
    QUEST_REWARD_ID: 'gold_bar',
    QUEST_REWARD_N: 2
  };

  // TILE.HONEY does not exist in constants.js yet; when it is added there this
  // module picks it up automatically (proposed: TILE.HONEY = 27 plus a
  // TILE_DEFS entry with pattern 'liquid', replaceable, warm light colors).
  const HONEY_ID = (TC.TILE && TC.TILE.HONEY != null) ? TC.TILE.HONEY : -1;

  // ---- runtime item definitions (merged into TC.ITEM_DEFS once) ----
  const FISH_ITEMS = {
    wooden_fishing_rod: { name: 'Wooden Fishing Rod', kind: 'fishing_rod', power: 15, useTime: 0.35 },
    iron_fishing_rod:   { name: 'Iron Fishing Rod',   kind: 'fishing_rod', power: 32, useTime: 0.32 },
    gold_fishing_rod:   { name: 'Gold Fishing Rod',   kind: 'fishing_rod', power: 52, useTime: 0.28 },
    worm:               { name: 'Worm',  kind: 'bait', power: 5,  maxStack: 999 },
    grub:               { name: 'Grub',  kind: 'bait', power: 12, maxStack: 999 },
    minnow:             { name: 'Minnow',    kind: 'material', maxStack: 999 },
    trout:              { name: 'Trout',     kind: 'material', maxStack: 999 },
    perch:              { name: 'Perch',     kind: 'material', maxStack: 999 },
    icefish:            { name: 'Icefish',   kind: 'material', maxStack: 999 },
    seabass:            { name: 'Seabass',   kind: 'material', maxStack: 999 },
    catfish:            { name: 'Catfish',   kind: 'material', maxStack: 999 },
    lavafish:           { name: 'Lavafish',  kind: 'material', maxStack: 999 },
    honeyfish:          { name: 'Honeyfish', kind: 'material', maxStack: 999 },
    wooden_crate:       { name: 'Wooden Crate', kind: 'crate', maxStack: 999 },
    iron_crate:         { name: 'Iron Crate',   kind: 'crate', maxStack: 999 },
    golden_crate:       { name: 'Golden Crate', kind: 'crate', maxStack: 999 }
  };

  const FISH_RECIPES = [
    { out: 'wooden_fishing_rod', n: 1, station: 'workbench', cost: { wood: 8 } },
    { out: 'iron_fishing_rod',   n: 1, station: 'anvil',     cost: { iron_bar: 6, wood: 3 } },
    { out: 'gold_fishing_rod',   n: 1, station: 'anvil',     cost: { gold_bar: 6, wood: 3 } },
    { out: 'worm',               n: 3, station: null,        cost: { gel: 1 } }
  ];

  // ---- loot tables (weight-based; bait entries restock the angler) ----
  const LOOT = {
    ocean: [
      { id: 'seabass', min: 1, max: 1, w: 38 }, { id: 'trout', min: 1, max: 1, w: 24 },
      { id: 'minnow', min: 1, max: 1, w: 18 },  { id: 'worm', min: 1, max: 2, w: 12 },
      { id: 'grub', min: 1, max: 1, w: 8 }
    ],
    surface: [
      { id: 'minnow', min: 1, max: 1, w: 30 }, { id: 'trout', min: 1, max: 1, w: 28 },
      { id: 'perch', min: 1, max: 1, w: 14 },  { id: 'worm', min: 1, max: 2, w: 16 },
      { id: 'grub', min: 1, max: 1, w: 8 }
    ],
    snow: [
      { id: 'icefish', min: 1, max: 1, w: 42 }, { id: 'trout', min: 1, max: 1, w: 20 },
      { id: 'minnow', min: 1, max: 1, w: 16 },  { id: 'worm', min: 1, max: 2, w: 12 },
      { id: 'grub', min: 1, max: 1, w: 8 }
    ],
    jungle: [
      { id: 'perch', min: 1, max: 1, w: 40 },  { id: 'minnow', min: 1, max: 1, w: 18 },
      { id: 'trout', min: 1, max: 1, w: 14 },  { id: 'grub', min: 1, max: 2, w: 16 },
      { id: 'worm', min: 1, max: 2, w: 10 }
    ],
    underground: [
      { id: 'catfish', min: 1, max: 1, w: 36 },      { id: 'minnow', min: 1, max: 1, w: 14 },
      { id: 'trout', min: 1, max: 1, w: 10 },        { id: 'grub', min: 1, max: 2, w: 16 },
      { id: 'worm', min: 1, max: 2, w: 12 },         { id: 'copper_ore', min: 2, max: 4, w: 7 },
      { id: 'iron_ore', min: 1, max: 3, w: 5 }
    ],
    lava: [
      { id: 'lavafish', min: 1, max: 1, w: 55 }, { id: 'grub', min: 1, max: 1, w: 15 },
      { id: 'iron_ore', min: 2, max: 4, w: 15 }, { id: 'gold_ore', min: 1, max: 3, w: 10 }
    ],
    honey: [
      { id: 'honeyfish', min: 1, max: 1, w: 60 }, { id: 'grub', min: 1, max: 2, w: 20 },
      { id: 'worm', min: 1, max: 2, w: 12 }
    ]
  };

  const CRATE_LOOT = {
    wooden_crate: [
      { id: 'wood', min: 4, max: 8, w: 30 },      { id: 'torch', min: 3, max: 6, w: 15 },
      { id: 'copper_ore', min: 3, max: 6, w: 20 }, { id: 'arrow', min: 5, max: 12, w: 15 },
      { id: 'worm', min: 1, max: 2, w: 10 },       { id: 'copper_bar', min: 1, max: 2, w: 10 }
    ],
    iron_crate: [
      { id: 'iron_ore', min: 3, max: 6, w: 22 }, { id: 'iron_bar', min: 1, max: 3, w: 18 },
      { id: 'wood', min: 4, max: 8, w: 14 },     { id: 'torch', min: 3, max: 6, w: 10 },
      { id: 'arrow', min: 5, max: 12, w: 12 },   { id: 'grub', min: 1, max: 2, w: 10 },
      { id: 'gold_ore', min: 2, max: 4, w: 9 }
    ],
    golden_crate: [
      { id: 'gold_ore', min: 3, max: 5, w: 20 }, { id: 'gold_bar', min: 1, max: 2, w: 18 },
      { id: 'iron_bar', min: 2, max: 4, w: 14 }, { id: 'grub', min: 1, max: 3, w: 14 },
      { id: 'arrow', min: 8, max: 16, w: 12 },   { id: 'torch', min: 4, max: 8, w: 10 },
      { id: 'gel', min: 3, max: 6, w: 8 }
    ]
  };

  const QUEST_POOL = ['minnow', 'trout', 'perch', 'icefish', 'seabass', 'catfish'];

  const FISH_COLORS = {
    minnow: '#9ab8d0', trout: '#a5793f', perch: '#4a9e5a', icefish: '#a8dbe8',
    seabass: '#5a7a9e', catfish: '#7a6a52', lavafish: '#e85a1a', honeyfish: '#e8b23a'
  };
  const CRATE_COLORS = { wooden_crate: ['#8a5a32', '#a97d4b'], iron_crate: ['#5a5a64', '#8a8a96'], golden_crate: ['#a8862a', '#ffd24a'] };

  // ---- guarded cross-module helpers ----
  function iDef(id) { return TC.ITEM_DEFS ? TC.ITEM_DEFS[id] : null; }
  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') { try { TC.Audio.play(name); } catch (e) {} }
  }
  function toast(msg) {
    if (TC.UI && typeof TC.UI.toast === 'function') { try { TC.UI.toast(msg); } catch (e) {} }
  }
  function fText(x, y, str, color) {
    if (TC.Particles && typeof TC.Particles.floatText === 'function') {
      try { TC.Particles.floatText(x, y, str, color || '#ffffff'); } catch (e) {}
    }
  }
  function pBurst(x, y, n, colors, spd) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try { TC.Particles.burst(x, y, n, { colors: colors, speed: spd }); } catch (e) {}
    }
  }
  function U() { return TC.Utils; }

  // ---- seeded rng stream (no Math.random anywhere in this module) ----
  let rng = null;
  function ensureRng() {
    if (rng) return;
    const u = U();
    const seed = ((TC.worldSeed | 0) ^ 0xF15EBA11) >>> 0;
    if (u && typeof u.mulberry32 === 'function') rng = u.mulberry32(seed);
    else {                        // tiny LCG fallback so the module still runs
      let a = seed || 1;
      rng = function () { a = (Math.imul(a, 1664525) + 1013904223) | 0; return (a >>> 0) / 4294967296; };
    }
  }
  function randInt(a, b) {        // inclusive, via the seeded stream
    const u = U();
    if (u && typeof u.randInt === 'function') return u.randInt(rng, a, b);
    return a + Math.floor(rng() * (b - a + 1));
  }
  function pickWeighted(table) {
    let total = 0;
    for (let i = 0; i < table.length; i++) total += table[i].w;
    let r = rng() * total;
    for (let i = 0; i < table.length; i++) {
      r -= table[i].w;
      if (r <= 0) return table[i];
    }
    return table[table.length - 1];
  }

  // ---- state ----
  const S = {
    world: null,        // world ref last seen; change triggers hardReset
    mode: 'idle',       // idle | flying | waiting | biting
    bobber: null,       // {x,y,vx,tx,ty,zone,liquid}
    rodId: null,        // item id of the rod the bobber belongs to
    power: 0,           // computed fishing power of the active cast
    rollT: 0,           // accumulator toward the next bite roll
    biteT: 0,           // seconds left in the reel window
    windowT: 1,         // full reel-window length (for the perfect fraction)
    prevDown: false,    // own mouse-edge tracking (survives multi-step frames)
    clock: 0,           // visual time for bob/line animation
    quest: null,        // {day, fish, done}
    catches: {}         // fish id -> lifetime count
  };

  function hardReset(world) {
    S.world = world || null;
    S.mode = 'idle';
    S.bobber = null;
    S.rodId = null;
    S.power = 0;
    S.rollT = 0;
    S.biteT = 0;
    S.prevDown = false;
    S.quest = null;
    S.catches = {};
    rng = null;                    // reseed the stream for the new world
  }

  // ---- liquid + zone detection (the "world liquid check") ----
  function liquidAt(tx, ty) {
    const w = TC.world;
    if (!w || typeof w.get !== 'function') return null;
    const id = w.get(tx, ty);
    if (id === TC.TILE.WATER) return 'water';
    if (id === TC.TILE.LAVA) return 'lava';
    if (id === HONEY_ID) return 'honey';
    return null;
  }

  // Zone from the bobber tile: lava/honey by liquid, then depth vs surfaceY,
  // then map-edge ocean, then surface biome read off the ground tile.
  function zoneFor(tx, ty) {
    const w = TC.world;
    if (!w || typeof w.get !== 'function') return { zone: 'surface', liquid: 'water' };
    const liq = liquidAt(tx, ty) || 'water';
    if (liq === 'lava') return { zone: 'lava', liquid: liq };
    if (liq === 'honey') return { zone: 'honey', liquid: liq };
    const surf = (w.surfaceY && tx >= 0 && tx < w.width) ? w.surfaceY[tx] : 0;
    if (ty > surf + F.UNDERGROUND_DEPTH) return { zone: 'underground', liquid: liq };
    if (tx < F.OCEAN_EDGE || tx >= w.width - F.OCEAN_EDGE) return { zone: 'ocean', liquid: liq };
    const g = w.get(tx, surf);
    if (g === TC.TILE.SNOW) return { zone: 'snow', liquid: liq };
    if (g === TC.TILE.JGRASS) return { zone: 'jungle', liquid: liq };
    return { zone: 'surface', liquid: liq };
  }

  // Best bait currently carried (not consumed until a catch lands).
  function bestBait(inv) {
    if (!inv || !inv.slots || !TC.ITEM_DEFS) return null;
    let best = null;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i];
      const d = s ? iDef(s.id) : null;
      if (d && d.kind === 'bait' && (!best || (d.power || 0) > (best.power || 0))) best = d;
    }
    return best;
  }

  // Fishing power: rod + bait, scaled by liquid type and zone.
  function powerFor(rodDef, baitDef, zone, liquid) {
    let p = (rodDef && rodDef.power) || 10;
    if (baitDef && baitDef.kind === 'bait') p += baitDef.power || 0;
    if (liquid === 'lava') p *= F.LAVA_POWER_MULT;
    else if (liquid === 'honey') p *= F.HONEY_POWER_MULT;
    if (zone === 'underground') p *= F.UNDERGROUND_POWER_MULT;
    else if (zone === 'ocean') p *= F.OCEAN_POWER_MULT;
    const u = U();
    p = u && typeof u.clamp === 'function' ? u.clamp(Math.round(p), 1, F.POWER_CAP)
                                           : Math.max(1, Math.min(F.POWER_CAP, Math.round(p)));
    return p;
  }

  // ---- daily quest fish (deterministic from seed + day index) ----
  function dayIndex() {
    const cycle = ((TC.CONST && TC.CONST.DAY_LENGTH) || 420) + ((TC.CONST && TC.CONST.NIGHT_LENGTH) || 240);
    const t = (TC.Sky && typeof TC.Sky.time === 'number') ? TC.Sky.time : 0;
    return Math.floor(t / cycle);
  }
  function ensureQuest() {
    const d = dayIndex();
    if (S.quest && S.quest.day === d) return;
    const u = U();
    const h = (u && typeof u.hash2 === 'function') ? u.hash2(TC.worldSeed | 0, d, 0xF155) : 0.5;
    const fish = QUEST_POOL[Math.floor(h * QUEST_POOL.length) % QUEST_POOL.length];
    S.quest = { day: d, fish: fish, done: false };
    const def = iDef(fish);
    toast('New fishing quest: ' + ((def && def.name) || fish));
  }

  // ---- inventory helpers (slot-index consume with id fallback) ----
  function consumeFromSlot(inv, slotIdx, id, n) {
    if (!inv || typeof inv.remove !== 'function') return false;
    const read = () => {
      if (typeof inv.get !== 'function') return -1;
      const s = inv.get(slotIdx);
      return (s && s.id === id) ? s.count : 0;
    };
    const before = read();
    if (before <= 0) return false;
    try { inv.remove(slotIdx, n); } catch (e) {}
    if (read() === before) { try { inv.remove(id, n); } catch (e) {} }
    return read() < before;
  }
  function findBaitSlot(inv) {
    if (!inv || typeof inv.get !== 'function' || !TC.ITEM_DEFS) return -1;
    const n = (inv.slots && inv.slots.length) ? inv.slots.length : 50;
    for (let i = 0; i < n; i++) {
      const s = inv.get(i);
      const d = s ? iDef(s.id) : null;
      if (s && s.count > 0 && d && d.kind === 'bait') return i;
    }
    return -1;
  }
  function findItemSlot(inv, id) {
    if (!inv || typeof inv.get !== 'function') return -1;
    const n = (inv.slots && inv.slots.length) ? inv.slots.length : 50;
    for (let i = 0; i < n; i++) {
      const s = inv.get(i);
      if (s && s.id === id && s.count > 0) return i;
    }
    return -1;
  }
  function give(player, id, count) {
    const inv = player && player.inventory;
    let left = count;
    if (inv && typeof inv.add === 'function') {
      try { left = inv.add(id, count); } catch (e) { left = count; }
    }
    if (left > 0 && TC.Items && typeof TC.Items.spawnDrop === 'function' && player) {
      try {
        TC.Items.spawnDrop(player.x + player.w / 2, player.y + player.h / 2, id, left, true);
      } catch (e) {}
    }
  }
  function swing(player, def) {
    if (player && typeof player.startSwing === 'function') {
      try { player.startSwing(def, false); } catch (e) {}
    }
  }

  // ---- casting / waiting / biting ----
  function solidPx(x, y) {
    const w = TC.world;
    return !!(w && typeof w.solidAtPixel === 'function' && w.solidAtPixel(x, y));
  }

  function cast(player, def, itemId) {
    const m = TC.Input ? TC.Input.mouse : null;
    if (!m || !isFinite(m.worldX)) return;
    const cx = player.x + player.w / 2, cy = player.y + 10;
    let dx = m.worldX - cx, dy = m.worldY - cy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    S.bobber = {
      x: cx + dx * 10, y: cy + dy * 10,
      vx: dx * F.BOBBER_SPEED, vy: dy * F.BOBBER_SPEED - 120,
      tx: 0, ty: 0, zone: 'surface', liquid: 'water'
    };
    S.mode = 'flying';
    S.rodId = itemId;
    swing(player, def);
    sfx('swing');
  }

  function land(liquid) {
    const b = S.bobber;
    const TS = TC.CONST.TS;
    const tx = Math.floor(b.x / TS), ty = Math.floor(b.y / TS);
    b.tx = tx; b.ty = ty;
    b.x = tx * TS + TS / 2;
    b.y = ty * TS + TS / 2;
    const z = zoneFor(tx, ty);
    b.zone = z.zone;
    b.liquid = z.liquid;
    const rodDef = iDef(S.rodId);
    const inv = TC.player ? TC.player.inventory : null;
    S.power = powerFor(rodDef, bestBait(inv), z.zone, z.liquid);
    S.mode = 'waiting';
    S.rollT = 0;
    splash(z.liquid);
    sfx('dig');
  }

  function splash(liquid) {
    const cols = liquid === 'lava' ? ['#e85a1a', '#ffb03a']
      : liquid === 'honey' ? ['#e8b23a', '#d8942a'] : ['#5a8ec8', '#bcd9e8'];
    if (S.bobber) pBurst(S.bobber.x, S.bobber.y + 4, 6, cols, 70);
  }

  function startBite() {
    const b = S.bobber;
    const hard = (b.liquid === 'lava' || b.liquid === 'honey');
    S.windowT = F.REEL_WINDOW * (hard ? F.HARD_LIQUID_WINDOW : 1);
    S.biteT = S.windowT;
    S.mode = 'biting';
    fText(b.x, b.y - 10, '!', '#ffd24a');
    sfx('pickup');
    pBurst(b.x, b.y, 4, ['#ffffff', '#bcd9e8'], 50);
  }

  function recall(silent) {
    if (!silent && S.bobber) splash(S.bobber.liquid);
    S.mode = 'idle';
    S.bobber = null;
    S.rodId = null;
  }

  // Second click while the bobber is out: hook a bite, or pull back early.
  function hook(player, def) {
    if (S.mode === 'biting') {
      const perfect = S.biteT >= S.windowT * (1 - F.PERFECT_FRAC);
      catchSomething(player, perfect);
      swing(player, def);
      recall(true);
    } else if (S.mode === 'waiting') {
      fText(S.bobber.x, S.bobber.y - 10, 'Too soon...', '#c0c0cc');
      recall(true);
    } else {
      recall(true);                // cancel mid-air casts
    }
  }

  function crateFor(zone, liquid) {
    if (liquid === 'lava' || liquid === 'honey') return 'golden_crate';
    if (zone === 'underground') return 'iron_crate';
    return 'wooden_crate';
  }

  function grantFromTable(player, table) {
    const e = pickWeighted(table);
    const n = randInt(e.min, e.max);
    give(player, e.id, n);
    const d = iDef(e.id);
    fText(S.bobber.x, S.bobber.y - 8, '+' + n + ' ' + ((d && d.name) || e.id), '#ffffff');
    if (d && d.kind === 'material') {          // track fish catches + quest flag
      S.catches[e.id] = (S.catches[e.id] || 0) + n;
      const q = S.quest;
      if (q && !q.done && e.id === q.fish) {
        q.done = true;
        give(player, F.QUEST_REWARD_ID, F.QUEST_REWARD_N);
        toast('Fishing quest complete! +' + F.QUEST_REWARD_N + ' ' +
          ((iDef(F.QUEST_REWARD_ID) || {}).name || F.QUEST_REWARD_ID));
        fText(player.x + player.w / 2, player.y - 8, 'Quest!',
          (TC.CONST.COLORS && TC.CONST.COLORS.gold) || '#ffd24a');
        sfx('craft');
      }
    }
  }

  function catchSomething(player, perfect) {
    const b = S.bobber;
    const inv = player.inventory;
    const slot = findBaitSlot(inv);            // one bait per catch, if any
    if (slot >= 0) {
      const s = inv.get(slot);
      consumeFromSlot(inv, slot, s.id, 1);
    }
    const rolls = perfect ? 2 : 1;             // perfect hooks land two picks
    const crateChance = Math.min(0.25, F.CRATE_BASE + S.power * F.CRATE_PER_POWER);
    for (let i = 0; i < rolls; i++) {
      if (rng() < crateChance) {
        const crate = crateFor(b.zone, b.liquid);
        give(player, crate, 1);
        toast('Caught a ' + ((iDef(crate) || {}).name || 'crate') + '!');
      } else {
        grantFromTable(player, LOOT[b.zone] || LOOT.surface);
      }
    }
    splash(b.liquid);
    sfx('pickup');
  }

  // Crates open from anywhere in the inventory: select one and click.
  function openCrate(player, def, itemId) {
    const slot = findItemSlot(player.inventory, itemId);
    if (slot < 0 || !consumeFromSlot(player.inventory, slot, itemId, 1)) return;
    const table = CRATE_LOOT[itemId] || CRATE_LOOT.wooden_crate;
    const rolls = 2 + randInt(0, 1);
    for (let i = 0; i < rolls; i++) {
      const e = pickWeighted(table);
      give(player, e.id, randInt(e.min, e.max));
    }
    swing(player, def);
    sfx('craft');
    fText(player.x + player.w / 2, player.y - 8, 'Crate opened!',
      (TC.CONST.COLORS && TC.CONST.COLORS.heal) || '#7dff7d');
  }

  // Entry point used by the useHeld decorator (and callable directly).
  function onUseItem(player, def, itemId) {
    if (!player || player.dead || !def) return;
    if (def.kind === 'fishing_rod') {
      if (S.mode === 'idle') cast(player, def, itemId);
      else hook(player, def);
    } else if (def.kind === 'crate') {
      openCrate(player, def, itemId);
    }
  }

  // ---- per-frame simulation (driven by the Player.update decorator) ----
  function stepFlying(dt) {
    const b = S.bobber;
    const TS = TC.CONST.TS;
    b.vy += F.BOBBER_GRAVITY * dt;
    const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
    if (solidPx(nx, ny)) { pBurst(b.x, b.y, 3, ['#cccccc'], 40); recall(true); return; }
    b.x = nx; b.y = ny;
    const w = TC.world;
    if (!w || b.x < 0 || b.y < 0 || b.x > w.width * TS || b.y > w.height * TS) {
      recall(true);
      return;
    }
    const liq = liquidAt(Math.floor(b.x / TS), Math.floor(b.y / TS));
    if (liq) land(liq);
  }

  function stepWaiting(dt) {
    const b = S.bobber;
    if (!liquidAt(b.tx, b.ty)) { recall(true); return; }   // pool drained/blocked
    S.rollT += dt;
    while (S.rollT >= F.BITE_ROLL_EVERY && S.mode === 'waiting') {
      S.rollT -= F.BITE_ROLL_EVERY;
      const chance = Math.min(F.BITE_CHANCE_MAX, Math.max(0.03, S.power / F.BITE_CHANCE_DIV));
      if (rng() < chance) startBite();
    }
  }

  function stepBiting(dt) {
    const b = S.bobber;
    if (!liquidAt(b.tx, b.ty)) { recall(true); return; }
    S.biteT -= dt;
    if (S.biteT <= 0) {                        // missed the window; keep fishing
      S.mode = 'waiting';
      S.rollT = 0;
    }
  }

  function update(dt) {
    S.clock += dt;
    decorate();                                // cheap no-op once wrapped
    mergeItems();                              // no-op once merged

    const w = TC.world;
    if (w !== S.world) hardReset(w);
    if (TC.state !== 'playing' || !w || !TC.player) return;
    ensureRng();
    ensureQuest();

    const p = TC.player;

    // own click-edge tracking: one press = one action even across sub-steps
    const inp = TC.Input;
    const down = !!(inp && inp.mouse && inp.mouse.down);
    const clicked = down && !S.prevDown && !(inp && inp.uiHover);
    S.prevDown = down;

    const sel = (typeof p.selectedSlot === 'function') ? p.selectedSlot() : null;
    const def = sel ? iDef(sel.id) : null;

    if (clicked && !p.dead && def &&
        (def.kind === 'fishing_rod' || def.kind === 'crate')) {
      onUseItem(p, def, sel.id);
    }

    if (S.mode === 'flying') stepFlying(dt);
    else if (S.mode === 'waiting') stepWaiting(dt);
    else if (S.mode === 'biting') stepBiting(dt);

    // safety recalls: death, line stretched too far, or rod unselected
    if (S.mode !== 'idle') {
      const dx = p.x + p.w / 2 - S.bobber.x, dy = p.y + p.h / 2 - S.bobber.y;
      if (p.dead || sel == null || sel.id !== S.rodId ||
          dx * dx + dy * dy > F.MAX_LINE_LEN * F.MAX_LINE_LEN) {
        recall(true);
      }
    }
  }

  // ---- world-space rendering (camera transform already applied) ----
  function draw(ctx) {
    if (!ctx || TC.state !== 'playing') return;
    const p = TC.player;
    if (!p || p.dead || !S.bobber) return;
    ctx.save();
    const b = S.bobber;
    const hx = p.x + p.w / 2 + p.facing * 5;
    const hy = p.y + 13;
    const bobbing = (S.mode === 'waiting' || S.mode === 'biting');
    const bx = b.x;
    const by = b.y + (bobbing ? Math.sin(S.clock * 3) * 1.5 : 0);

    ctx.strokeStyle = 'rgba(240,240,240,0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.quadraticCurveTo((hx + bx) / 2, Math.max(hy, by) + (bobbing ? 7 : 3), bx, by);
    ctx.stroke();

    ctx.fillStyle = '#d84a4a';                 // classic red-over-white float
    ctx.fillRect(bx - 3, by - 3, 6, 3);
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(bx - 3, by, 6, 3);

    if (S.mode === 'biting') {
      ctx.fillStyle = '#ffd24a';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('!', bx, by - 9);
      const frac = Math.max(0, S.biteT / S.windowT);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(bx - 11, by - 15, 22, 3);
      ctx.fillStyle = frac > 0.3 ? '#ffd24a' : '#ff5a48';
      ctx.fillRect(bx - 11, by - 15, 22 * frac, 3);
    }
    ctx.restore();
  }

  // ---- persistence API (ready for save.js wiring; not auto-called) ----
  function serialize() {
    return {
      quest: S.quest ? { day: S.quest.day, fish: S.quest.fish, done: !!S.quest.done } : null,
      catches: Object.assign({}, S.catches)
    };
  }
  function load(data) {
    if (!data || typeof data !== 'object') return false;
    S.catches = {};
    if (data.catches && typeof data.catches === 'object') {
      for (const k in data.catches) {
        const n = data.catches[k] | 0;
        if (n > 0 && iDef(k)) S.catches[k] = n;
      }
    }
    S.quest = null;
    const q = data.quest;
    if (q && typeof q === 'object' && typeof q.day === 'number' && iDef(q.fish)) {
      S.quest = { day: q.day, fish: q.fish, done: !!q.done };
    }
    return true;
  }

  // ---- icons for fishing items (decorates TC.Items.iconFor) ----
  const ICON_CACHE = new Map();
  function px(g, c, x, y, w, h) { g.fillStyle = c; g.fillRect(x, y, w, h); }
  function paintMyIcon(g, id) {
    const d = FISH_ITEMS[id];
    if (!d) return;
    if (d.kind === 'fishing_rod') {
      const metal = /^iron_/.test(id) ? '#c0c0cc' : (/^gold_/.test(id) ? '#ffd24a' : null);
      g.strokeStyle = metal || '#8a5a32';      // diagonal handle
      g.lineWidth = 2;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(3, 13);
      g.lineTo(11, 4);
      g.stroke();
      g.strokeStyle = '#e8e2d0';               // line + hook curve
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(11, 4);
      g.quadraticCurveTo(14, 8, 12, 12);
      g.stroke();
      px(g, '#d84a4a', 11, 12, 3, 2);
    } else if (d.kind === 'bait') {
      g.strokeStyle = id === 'grub' ? '#d88a4a' : '#e89aa8';
      g.lineWidth = 2;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(3, 11);
      g.quadraticCurveTo(8, 4, 13, 10);
      g.stroke();
      px(g, '#26262b', 12, 9, 1, 1);
    } else if (d.kind === 'crate') {
      const cc = CRATE_COLORS[id] || CRATE_COLORS.wooden_crate;
      px(g, cc[0], 2, 4, 12, 9);
      px(g, cc[1], 2, 4, 12, 2);
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(2, 8.5);
      g.lineTo(14, 8.5);
      g.moveTo(8, 6);
      g.lineTo(8, 13);
      g.stroke();
    } else {                                   // fish
      const body = FISH_COLORS[id] || '#9ab8d0';
      g.fillStyle = body;
      g.beginPath();
      g.ellipse(7, 8, 5, 3, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(11, 8);
      g.lineTo(15, 5);
      g.lineTo(15, 11);
      g.closePath();
      g.fill();
      px(g, '#ffffff', 4, 7, 2, 2);
      px(g, '#26262b', 5, 7, 1, 2);
    }
  }
  function myIcon(id) {
    let cv = ICON_CACHE.get(id);
    if (cv) return cv;
    cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 16;
    paintMyIcon(cv.getContext('2d'), id);
    ICON_CACHE.set(id, cv);
    return cv;
  }

  // ---- load-time merges + prototype decoration (all idempotent) ----
  let itemsMerged = false;
  function mergeItems() {
    if (itemsMerged || !TC.ITEM_DEFS) return;
    for (const id in FISH_ITEMS) {
      if (!TC.ITEM_DEFS[id]) TC.ITEM_DEFS[id] = Object.assign({}, FISH_ITEMS[id]);
    }
    itemsMerged = true;
  }
  function mergeRecipes() {
    if (!TC.RECIPES || !Array.isArray(TC.RECIPES)) return;
    const have = {};
    for (let i = 0; i < TC.RECIPES.length; i++) have[TC.RECIPES[i].out] = true;
    for (let i = 0; i < FISH_RECIPES.length; i++) {
      if (!have[FISH_RECIPES[i].out]) TC.RECIPES.push(FISH_RECIPES[i]);
    }
  }

  let decorated = false;
  function decorate() {
    if (decorated || !TC.Player || !TC.Player.prototype) return;
    const proto = TC.Player.prototype;
    decorated = true;

    const origUseHeld = proto.useHeld;
    proto.useHeld = function (dt) {
      const sel = (typeof this.selectedSlot === 'function') ? this.selectedSlot() : null;
      const def = sel ? iDef(sel.id) : null;
      if (def && (def.kind === 'fishing_rod' || def.kind === 'crate')) {
        return;                    // handled by TC.Fishing.update click edges
      }
      return origUseHeld.call(this, dt);
    };

    const origUpdate = proto.update;
    proto.update = function (dt) {
      const r = origUpdate.apply(this, arguments);
      try { update(dt); } catch (e) {}
      return r;
    };

    const origDraw = proto.draw;
    proto.draw = function (ctx, cam) {
      const r = origDraw.call(this, ctx, cam);
      try { draw(ctx); } catch (e) {}
      return r;
    };

    if (TC.Items && typeof TC.Items.iconFor === 'function' && !TC.Items.__fishingIcons) {
      const origIcon = TC.Items.iconFor;
      TC.Items.iconFor = function (id) {
        if (FISH_ITEMS[id]) {
          try { return myIcon(id); } catch (e) {}
        }
        return origIcon(id);
      };
      TC.Items.__fishingIcons = true;
    }
  }

  mergeItems();
  mergeRecipes();
  decorate();
  // If player.js somehow loads after this module, keep retrying briefly
  // (the normal index.html order decorates immediately above).
  if (!decorated) {
    let tries = 0;
    const t = setInterval(function () {
      decorate();
      if (decorated || ++tries > 50) clearInterval(t);
    }, 200);
  }

  // ---- public surface ----
  TC.Fishing = {
    update: update,
    draw: draw,
    onUseItem: onUseItem,
    reelIn: function () { recall(true); },
    zoneFor: zoneFor,
    powerFor: powerFor,
    getQuest: function () { return S.quest; },
    questPool: QUEST_POOL.slice(),
    serialize: serialize,
    load: load,
    reset: function () { hardReset(TC.world); },
    _debug: function () {                     // test/inspection aid, not a contract
      return {
        mode: S.mode, power: S.power, rodId: S.rodId,
        bobber: S.bobber, quest: S.quest, catches: S.catches
      };
    }
  };

  // ---- save integration ----
  // Splice the fishing blob into the stored record (same pattern as wiring.js):
  // placements persist via tile diffs; this carries quest/catch state only.
  // KEY must stay in sync with save.js ('tc_save_v1').
  const SAVE_KEY = 'tc_save_v1';

  function spliceStored(mutate) {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      mutate(data);
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) { /* best-effort, like save.js */ }
  }

  function readStoredFishing() {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return (data && typeof data === 'object') ? data.fishing || null : null;
    } catch (e) { return null; }
  }

  function patchSaveFlow() {
    if (TC.__fishingSavePatched) return;
    if (TC.Save && typeof TC.Save.save === 'function') {
      TC.__fishingSavePatched = true;
      const origSave = TC.Save.save;
      TC.Save.save = function () {
        const ok = origSave ? !!origSave.call(TC.Save) : false;
        if (ok && TC.Fishing && typeof TC.Fishing.serialize === 'function') {
          const blob = TC.Fishing.serialize();
          const hasAny = blob && Object.keys(blob).length > 0;
          if (hasAny) spliceStored((data) => { data.fishing = blob; });
          else spliceStored((data) => { delete data.fishing; });
        }
        return ok;
      };
    }
    if (typeof TC.continueGame === 'function') {
      TC.__fishingContinuePatched = true;
      const origCont = TC.continueGame;
      TC.continueGame = function () {
        const r = origCont.call(TC);
        if (TC.Fishing && typeof TC.Fishing.load === 'function') {
          try { TC.Fishing.load(readStoredFishing()); } catch (e) {}
        }
        return r;
      };
    }
    if (typeof TC.newGame === 'function') {
      TC.__fishingNewPatched = true;
      const origNew = TC.newGame;
      TC.newGame = function (seed) {
        const r = origNew.call(TC, seed);
        if (TC.Fishing && typeof TC.Fishing.reset === 'function') TC.Fishing.reset();
        return r;
      };
    }
  }
  patchSaveFlow();
})();
