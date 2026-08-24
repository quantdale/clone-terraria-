/* npcs.js — TC.NPCs: town NPCs driven by the NPC_KINDS def table. Each kind
   defines name, dialog lines, unlock rule, home params, optional shop stock
   and a paint palette; the Guide is the seed entry, the Merchant demonstrates
   unlocks + shop data (shop panel is wired lead-side). NPCs wander near home,
   talk on right-click (night/biome-aware pools, each cycled deterministically),
   take damage via TC.NPCs.damage and respawn at home after a delay. Never
   hostile. On move-in each NPC runs an incremental housing scan (claimHouse)
   for the smallest valid room nearby; claims persist in npc.state.home and
   re-anchor homeX to the plot center. TC.NPCs.houseOf exposes the plot. */
'use strict';
(function () {
  window.TC = window.TC || {};
  const TC = window.TC;

  const NPC_W = 18, NPC_H = 40;
  const WALK_SPEED = 45;          // px/s stroll
  const HOP_VY = -330;            // 1-tile step auto-hop
  const DIALOG_CD = 1;            // seconds between dialogs
  const BASE_HP = 250;
  const RESPAWN_SECONDS = 45;     // dead -> back at home after this long
  const DEFAULT_SPAN_TILES = 8;   // default wander radius around homeX

  // Housing bounds (tiles) for validateHome / claiming.
  const HOME_MIN_W = 4, HOME_MIN_H = 3;
  const HOME_MAX_W = 14, HOME_MAX_H = 10;
  const HOME_WALL_COVER = 0.6;    // min fraction of wall-backed interior cells

  // Home-claiming scan: bounded spiral around the arrival spot, sampled at
  // stride 2, smallest footprints first. Work is spread across frames —
  // CLAIM_BUDGET validateHome calls per update tick, CLAIM_MAX_CALLS hard
  // cap per NPC so a scan can never spin forever.
  const CLAIM_RADIUS = 48;
  const CLAIM_BUDGET = 40;
  const CLAIM_MAX_CALLS = 6000;
  const CLAIM_SIZES = (function () {
    const out = [];
    for (let hh = 4; hh <= 6; hh++)
      for (let ww = 5; ww <= 9; ww++) out.push([ww, hh]);
    return out;                   // ascending area: smallest valid wins
  })();

  const DEFAULT_LOOK = {
    skin: '#edb98a', hair: '#b9bdc9', robe: '#3f8f46', robeTrim: '#2e6e35',
    sleeve: '#357a3c', pants: '#4a3a28', shoe: '#33281c', rope: '#7a5a30',
    eyeW: '#f4f4f4', pupil: '#26262b'
  };

  // ---- kind registry ---------------------------------------------------
  // unlocks: null/undefined = always available; string = TC.Progression.has
  // (guarded); function(def) -> bool for custom rules. home.spanTiles is the
  // wander radius in tiles; home.{tx,ty} optionally pins a plot (tile coords).
  // shop: [{itemId, price}] exposed for the lead's shop panel.
  const NPC_KINDS = {
    guide: {
      type: 'guide', nameKey: 'npc.guide', name: 'Guide',
      hp: BASE_HP,
      dialogLines: [
        'Progression: craft a Workbench from wood, then a Furnace, then an Anvil from iron bars.',
        'Torches need Gel - slimes drop it. One wood plus one gel crafts 3 torches.',
        'Armor reduces damage you take. Forge a Copper set at the Anvil and equip it.',
        'The Void Charm summons the Eye of the Void - use it only at night.',
        'Chests hold 20 stacks. Right-click to open one; mine it to spill the contents.',
        'Background walls need a pickaxe - aim at open tiles to pry them off.',
        'Press N to toggle the minimap.',
        'Press M to mute or unmute the sound.'
      ],
      dialogNight: [
        'Grappling hooks and buckets, friend: the hook carries you over pits, the bucket carries water and lava away.',
        'Nights run long. Seal the door, keep a torch lit, and craft something useful while you wait.',
        'The dark bites hardest after sundown. A closed door beats a hero\'s luck.'
      ],
      dialogBiome: {
        snow: [
          'Snow packs hard underfoot and the caves below freeze solid. Carry spare torches.',
          'Ice over water holds right up until it does not. Rope and a bucket, always.'
        ],
        desert: [
          'Sand pours like water when you dig it. Shore the walls or swim in dunes.'
        ],
        jungle: [
          'The canopy eats torchlight here. Mark your trail with rope or torches.'
        ],
        corruption: [
          'This purple rot spreads after dark. Do not build your house on cursed ground.'
        ],
        underworld: [
          'It only gets hotter below this line. A full bucket outvalues any sword down there.'
        ],
        cave: [
          'Listen for drips when you dig - moving water means ore nearby, or trouble ahead.'
        ]
      },
      unlocks: null,
      home: { spanTiles: DEFAULT_SPAN_TILES },
      shop: null,
      look: { hair: '#b9bdc9', robe: '#3f8f46', robeTrim: '#2e6e35', sleeve: '#357a3c' }
    },
    merchant: {
      type: 'merchant', nameKey: 'npc.merchant', name: 'Merchant',
      hp: BASE_HP,
      dialogLines: [
        'Bars, torches, arrows - everything a delver needs, at honest prices.',
        'Give me a house with a door, a light and a flat floor and I will stay.',
        'Smelt your ore. Bars are worth more than rocks, always.',
        'Surplus gear weighing you down? Right-click a bag slot while browsing my stock to sell it for coins.'
      ],
      dialogNight: [
        'My stall stays lit after dark - honest coin spends exactly the same by moonlight.',
        'Lamp-lit stalls draw fewer slimes. Trust me, I have counted.'
      ],
      dialogBiome: {
        snow: [
          'Cold thickens the oil in my scales. Warm customers get warm prices.'
        ],
        desert: [
          'Sand gets into everything, even the coin purse. Rare goods turn up near dunes, though.'
        ],
        jungle: [
          'Jungle fruit ferments on the vine. I move it by the barrelful, quietly.'
        ],
        corruption: [
          'No stall stays open long in the rot. Buy what you need and keep moving.'
        ],
        underworld: [
          'Everything burns down there except a fair bargain. Fireproof your pockets first.'
        ],
        cave: [
          'Underground I sell rope, torches, and honest directions back to daylight.'
        ]
      },
      unlocks: function () {          // moves in once the player owns any metal bar
        const p = TC.player;
        const inv = p && p.inventory;
        if (!inv || !Array.isArray(inv.slots)) return false;
        for (let i = 0; i < inv.slots.length; i++) {
          const s = inv.slots[i];
          if (s && typeof s.id === 'string' && /_bar$/.test(s.id) && s.count > 0) return true;
        }
        return false;
      },
      home: { spanTiles: DEFAULT_SPAN_TILES },
      // Stock rows: {itemId, price?, requires?}. price is copper units
      // (TC.Economy); omitted prices fall back to the item's base value.
      // requires gates the row on TC.Progression flags / custom rules and
      // rows whose item def is missing never show (load-order safe).
      shop: [
        { itemId: 'torch', price: 2 },
        { itemId: 'wood', price: 1 },
        { itemId: 'stone', price: 1 },
        { itemId: 'arrow', price: 1 },
        { itemId: 'iron_bar', price: 12 },
        { itemId: 'gold_bar', price: 30 },
        { itemId: 'bucket', price: 25 },
        { itemId: 'regen_potion', price: 15 },
        { itemId: 'swiftness_potion', price: 15 },
        { itemId: 'ironskin_potion', price: 15 },
        { itemId: 'worm', price: 4 },
        { itemId: 'wooden_fishing_rod', price: 40 },
        { itemId: 'grenade', price: 40 },
        { itemId: 'guard_ring', price: 250,
          requires: 'boss.eye_of_void.defeated' },
        { itemId: 'vital_amulet', price: 300,
          requires: 'boss.king_slime.defeated' }
      ],
      look: { hair: '#5a4632', robe: '#8a5a2b', robeTrim: '#6a441f', sleeve: '#7a4e24' }
    }
  };

  // ---- small local helpers ----
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function approach(v, target, rate, dt) { return v + (target - v) * Math.min(1, rate * dt); }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

  // Emit a canonical event by EVENT key; events.js may be absent early.
  function emitSafe(key, payload) {
    try {
      if (TC.Events && typeof TC.Events.emit === 'function' &&
          TC.Events.EVENT && TC.Events.EVENT[key]) {
        TC.Events.emit(TC.Events.EVENT[key], payload);
      }
    } catch (e) { /* listeners must never break NPC flow */ }
  }

  // ---- world queries (same shape as enemies.js) ----
  function solidAt(tx, ty) {
    const w = TC.world;
    if (!w || typeof w.isSolid !== 'function') return false;
    return !!w.isSolid(tx, ty);
  }
  function rectSolid(x, y, w, h) {
    const ts = TC.CONST.TS;
    const x0 = Math.floor(x / ts), x1 = Math.floor((x + w - 0.01) / ts);
    const y0 = Math.floor(y / ts), y1 = Math.floor((y + h - 0.01) / ts);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++)
        if (solidAt(tx, ty)) return true;
    return false;
  }

  // ---- state ----
  const list = [];            // live NPCs
  const pending = [];         // dead NPCs awaiting respawn: {type,x,y,timer}

  function makeNpc(def, px, py) {
    const look = Object.assign({}, DEFAULT_LOOK, def.look || {});
    const hp = ((def.hp | 0) > 0) ? (def.hp | 0) : BASE_HP;
    return {
      type: def.type, name: def.name || def.type, nameKey: def.nameKey || null,
      x: px, y: py, w: NPC_W, h: NPC_H,
      vx: 0, vy: 0, facing: 1, onGround: false,
      homeX: px,
      spanPx: (((def.home && def.home.spanTiles) || DEFAULT_SPAN_TILES)) * TC.CONST.TS,
      targetX: px,          // current wander destination
      wanderTimer: rand(1, 3),
      phase: 0,             // walk-cycle progress (visual only)
      hitWall: false,
      dialogTimer: 0,
      dialogIdx: -1,        // cycles base dialogLines deterministically
      dialogPoolIdx: {},    // per-pool counters for night/biome pools
      hp: hp, maxHp: hp,
      look: look,
      state: {}             // type-specific extensible state (persisted)
    };
  }

  // Scan down from (px,py) for standing room over solid ground; null if none.
  // Falls back to the column's surface row when the drop point is high in the
  // sky, so spawns can never be left floating in the air.
  function findGroundSpot(px, py) {
    const w = TC.world;
    if (!w || typeof w.isSolid !== 'function') return null;
    const ts = TC.CONST.TS;
    const tx = clamp(Math.floor(px / ts), 1, w.width - 2);
    const surf = w.surfaceY ? (w.surfaceY[tx] || 0) : 0;
    const start = Math.min(surf, Math.floor(py / ts));
    // Prefer the EXACT requested x (respawn-at-home fidelity); fall back to
    // the cell-aligned safe spot only when the exact one is obstructed.
    const exact = scanDown(tx, start, px);
    if (exact != null) return exact;
    const hit = scanDown(tx, start);
    return hit != null ? hit : (start !== surf ? scanDown(tx, surf) : null);

    function scanDown(tx, start, wantX) {
      const x = (wantX != null) ? wantX
        : tx * TC.CONST.TS + (TC.CONST.TS - NPC_W) / 2;
      for (let i = 0; i < 24; i++) {
        const gy = start + i;                   // candidate ground row
        if (gy >= w.height) break;
        if (!solidAt(Math.floor((x + NPC_W / 2) / TC.CONST.TS), gy)) continue;
        const y = gy * TC.CONST.TS - NPC_H;     // need rows of headroom above
        if (rectSolid(x, y, NPC_W, NPC_H)) continue;
        return { x: x, y: y };
      }
      return null;
    }
  }

  // Home anchor for a kind: pinned plot when given, else world-spawn surface.
  function homeSpot(def) {
    const h = (def && def.home) || {};
    const w = TC.world;
    if (num(h.tx) != null && num(h.ty) != null && w) {
      return { x: h.tx * TC.CONST.TS, y: h.ty * TC.CONST.TS };
    }
    if (w && w.surfaceY) {
      const tx = clamp((w.width / 2) | 0, 0, w.width - 1);
      return { x: tx * TC.CONST.TS, y: (w.surfaceY[tx] || 0) * TC.CONST.TS };
    }
    return { x: 0, y: 0 };
  }

  // Generic spawn: place `type` on the ground at/nearest-to (px,py). Appends.
  // Returns the new NPC or null for an unknown kind.
  function spawn(type, px, py) {
    const def = NPC_KINDS[type];
    if (!def) return null;
    px = num(px) != null ? px : 0;
    py = num(py) != null ? py : 0;
    const spot = findGroundSpot(px, py);
    const n = makeNpc(def, spot ? spot.x : px, spot ? spot.y : py);
    list.push(n);
    emitSafe('EntitySpawned', { kind: 'npc', type: n.type, x: n.x, y: n.y });
    enqueueClaim(n);              // move-in housing scan (incremental)
    return n;
  }

  // Legacy entry point: replace the whole population with a fresh Guide.
  function spawnGuide(px, py) {
    list.length = 0;
    pending.length = 0;
    claimQueue.length = 0;
    spawn('guide', num(px) != null ? px : 0, num(py) != null ? py : 0);
  }

  // ---- unlock evaluation ------------------------------------------------

  function unlocked(def) {
    const u = def.unlocks;
    if (u == null) return true;
    if (typeof u === 'function') {
      try { return !!u(def); } catch (e) { return false; }
    }
    // W14: strings AND compound condition objects share the Progression
    // grammar; unknown shapes fail closed inside test().
    if (TC.Progression && typeof TC.Progression.test === 'function') {
      try { return !!TC.Progression.test(u); } catch (e) { return false; }
    }
    return false;
  }

  // One stock row's visibility rule: missing item defs never show;
  // `requires` shares the W14 condition grammar (flag string or compound
  // object) evaluated through TC.Progression.test.
  function stockUnlocked(e) {
    if (!e || typeof e.itemId !== 'string') return false;
    if (!TC.ITEM_DEFS || !TC.ITEM_DEFS[e.itemId]) return false;
    const r = e.requires;
    if (r == null || r === '') return true;
    if (typeof r === 'function') {
      try { return !!r(e); } catch (err) { return false; }
    }
    if (TC.Progression && typeof TC.Progression.test === 'function') {
      try { return !!TC.Progression.test(r); } catch (err) { return false; }
    }
    return false;
  }

  function countType(type, includePending) {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].type === type) n++;
    }
    if (includePending !== false) {
      for (let i = 0; i < pending.length; i++) {
        if (pending[i].type === type) n++;
      }
    }
    return n;
  }

  // Spawn one copy of every kind whose unlock rule passes and which is not
  // already present (population cap: one per kind). Not called automatically —
  // the lead hooks this after world load / progression changes. Returns the
  // array of types that moved in.
  function evaluateUnlocks() {
    const movedIn = [];
    Object.keys(NPC_KINDS).forEach((type) => {
      const def = NPC_KINDS[type];
      if (countType(type) > 0) return;
      if (!unlocked(def)) return;
      const spot = homeSpot(def);
      if (spawn(type, spot.x, spot.y)) {
        movedIn.push(type);
        emitSafe('NpcMovedIn', { type: type, name: def.name || type });
      }
    });
    return movedIn;
  }

  // ---- damage / death / respawn ------------------------------------------

  // Apply damage to an NPC (accepts the NPC object or a list index).
  // dir < 0 / > 0 knocks them away; returns true when the hit landed.
  function damage(npcOrIdx, dmg, dir) {
    const n = (typeof npcOrIdx === 'number') ? list[npcOrIdx] : npcOrIdx;
    if (!n || n.dead === true) return false;
    const amount = (typeof dmg === 'number' && isFinite(dmg))
      ? Math.max(0, Math.floor(dmg)) : 0;
    n.hp -= amount;
    if (typeof dir === 'number' && dir !== 0) n.vx += (dir > 0 ? 120 : -120);
    n.vy = Math.min(n.vy, -140);              // little hit pop
    if (n.hp <= 0) killNpc(n);
    return true;
  }

  function killNpc(n) {
    n.dead = true;                              // corpse refs must read as dead
    const idx = list.indexOf(n);
    if (idx >= 0) list.splice(idx, 1);
    pending.push({ type: n.type, x: n.homeX, y: n.y, timer: RESPAWN_SECONDS });
    emitSafe('EntityKilled', { kind: 'npc', type: n.type, name: n.name, x: n.x, y: n.y });
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try {
        TC.Particles.burst(n.x + n.w / 2, n.y + n.h / 2, 10,
          { colors: ['#e23b3b', '#ffffff'], speed: 90, life: 0.5, size: 2 });
      } catch (e) {}
    }
  }

  // ---- physics: integrate with tile collision (ground walker) ----
  function moveAndCollide(n, dt) {
    n.hitWall = false;
    const w = TC.world;
    if (!w || typeof w.isSolid !== 'function') {
      n.x += n.vx * dt; n.y += n.vy * dt;
      return;
    }
    const ts = TC.CONST.TS;

    // horizontal
    let nx = n.x + n.vx * dt;
    if (rectSolid(nx, n.y, n.w, n.h)) {
      if (n.vx > 0) nx = Math.floor((nx + n.w) / ts) * ts - n.w - 0.01;
      else nx = (Math.floor(nx / ts) + 1) * ts + 0.01;
      if (rectSolid(nx, n.y, n.w, n.h)) nx = n.x;
      n.hitWall = true;
      n.vx = 0;
    }
    n.x = nx;

    // vertical
    let ny = n.y + n.vy * dt;
    n.onGround = false;
    if (rectSolid(n.x, ny, n.w, n.h)) {
      if (n.vy > 0) {
        ny = Math.floor((ny + n.h) / ts) * ts - n.h - 0.01;
        n.onGround = true;
      } else {
        ny = (Math.floor(ny / ts) + 1) * ts + 0.01;
      }
      if (rectSolid(n.x, ny, n.w, n.h)) ny = n.y;
      n.vy = 0;
    }
    n.y = ny;

    // keep inside the world
    const maxX = w.width * ts - n.w, maxY = w.height * ts - n.h;
    n.x = clamp(n.x, 0, Math.max(0, maxX));
    n.y = clamp(n.y, 0, Math.max(0, maxY));
  }

  // ---- wander AI: amble between random spots near home ----
  function runAI(n, dt) {
    n.phase += (Math.abs(n.vx) * dt) / 48;
    n.wanderTimer -= dt;
    if (n.wanderTimer <= 0) {
      n.wanderTimer = rand(2, 5);
      let t = n.homeX + rand(-n.spanPx, n.spanPx);
      const w = TC.world;
      if (w) t = clamp(t, TC.CONST.TS, w.width * TC.CONST.TS - TC.CONST.TS);
      n.targetX = t;
    }
    const dx = n.targetX - (n.x + n.w / 2);
    if (Math.abs(dx) > 6) {
      const dir = dx > 0 ? 1 : -1;
      n.facing = dir;
      n.vx = approach(n.vx, dir * WALK_SPEED, 8, dt);
    } else {
      n.vx = approach(n.vx, 0, 10, dt);
    }
    if (n.onGround && n.hitWall) n.vy = HOP_VY;   // hop up 1-tile steps
  }

  // ---- dialog selection --------------------------------------------------
  // Context-aware pools without changing the def format: plain dialogLines
  // still work; optional def.dialogNight and def.dialogBiome.{biome}[]
  // entries win when they apply. Selection order: night pool > biome pool >
  // base cycle. Each pool cycles deterministically per NPC - no randomness.

  function isNight() {
    if (TC.Sky && typeof TC.Sky.isDay === 'function') {
      try { return !TC.Sky.isDay(); } catch (e) {}
    }
    if (TC.Sky && typeof TC.Sky.daylight === 'function') {
      try { return TC.Sky.daylight() < 0.5; } catch (e) {}
    }
    return false;
  }

  function biomeTag() {
    try {
      const b = (typeof TC.Biomes === 'object' && TC.Biomes)
        ? TC.Biomes.current : null;
      return (typeof b === 'string' && b) ? b : null;
    } catch (e) { return null; }
  }

  // Choose the pool for this moment: {pool, key}.
  function pickPool(def) {
    if (!def) return { pool: ['...'], key: 'base' };
    if (isNight() && Array.isArray(def.dialogNight) && def.dialogNight.length) {
      return { pool: def.dialogNight, key: 'night' };
    }
    const bio = biomeTag();
    if (bio && def.dialogBiome) {
      const p = def.dialogBiome[bio];
      if (Array.isArray(p) && p.length) return { pool: p, key: 'biome:' + bio };
    }
    return {
      pool: (Array.isArray(def.dialogLines) && def.dialogLines.length)
        ? def.dialogLines : ['...'],
      key: 'base'
    };
  }

  // Next line for an NPC from whichever pool applies right now.
  function dialogLineFor(n) {
    const pick = pickPool(NPC_KINDS[n.type]);
    const lines = pick.pool;
    let idx;
    if (pick.key === 'base') {
      const cur = (typeof n.dialogIdx === 'number') ? n.dialogIdx : -1;
      idx = (cur + 1) % lines.length;
      n.dialogIdx = idx;
    } else {
      const map = n.dialogPoolIdx || (n.dialogPoolIdx = {});
      const cur = (typeof map[pick.key] === 'number') ? map[pick.key] : -1;
      idx = (cur + 1) % lines.length;
      map[pick.key] = idx;
    }
    return lines[idx] || '...';
  }

  // Right-click over the bbox (screen space via camera) opens a tip dialog;
  // lines cycle in order so every line shows up without repeats.
  function handleClick(n) {
    if (n.dialogTimer > 0) return;
    const inp = TC.Input;
    if (!inp || !inp.mouse || !inp.mouse.rightClicked || inp.uiHover) return;
    const cam = TC.camera;
    const z = (cam && cam.zoom) ? cam.zoom : 1;
    const sx = (n.x - (cam ? cam.x : 0)) * z;
    const sy = (n.y - (cam ? cam.y : 0)) * z;
    const mx = inp.mouse.x, my = inp.mouse.y;
    if (mx < sx || mx > sx + n.w * z || my < sy || my > sy + n.h * z) return;
    n.dialogTimer = DIALOG_CD;
    const line = dialogLineFor(n);
    if (TC.UI && typeof TC.UI.showDialog === 'function') {
      try { TC.UI.showDialog(n.name, line); } catch (e) {}
    }
  }

  // ---- per-frame update (respawn ticks first, then live NPCs) ----
  function update(dt) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      p.timer -= dt;
      if (p.timer <= 0) {
        pending.splice(i, 1);
        spawn(p.type, p.x, p.y);              // findGroundSpot lands them safely
      }
    }
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      n.dialogTimer = Math.max(0, n.dialogTimer - dt);
      runAI(n, dt);
      n.vy = Math.min(n.vy + TC.CONST.GRAVITY * dt, TC.CONST.MAX_FALL);
      moveAndCollide(n, dt);
      handleClick(n);
    }
    processClaims();                // budgeted home-claim scans
  }

  // ---- drawing (world-space humanoid, player.js style) ----
  function walkFrame(n) {
    if (!n.onGround) return 1;
    if (Math.abs(n.vx) < 10) return 0;
    return Math.floor(n.phase * 4) % 4;
  }

  function drawHumanoid(c, n) {
    const L = n.look;
    const bx = n.x - 1, by = n.y - 2;           // 20x42 sprite box, like the player
    const f = walkFrame(n);
    const lf = [0, 3, 0, -3][f], lb = -lf;
    const bob = (f === 1 || f === 3) ? 1 : 0;
    const cx = n.x + n.w / 2;

    c.save();
    c.translate(cx, 0);
    c.scale(n.facing, 1);
    c.translate(-cx, 0);

    // lower legs + shoes peeking below the robe hem
    c.fillStyle = L.pants;
    c.fillRect(bx + 6 + lb, by + 30, 4, 9);
    c.fillRect(bx + 11 + lf, by + 30, 4, 9);
    c.fillStyle = L.shoe;
    c.fillRect(bx + 6 + lb, by + 39, 4, 3);
    c.fillRect(bx + 11 + lf, by + 39, 4, 3);

    // back arm
    c.fillStyle = L.sleeve;
    c.fillRect(bx + 4, by + 14 + bob, 3, 8);
    c.fillStyle = L.skin;
    c.fillRect(bx + 4, by + 22 + bob, 3, 3);

    // robe body with rope belt and hem trim
    c.fillStyle = L.robe;
    c.fillRect(bx + 4, by + 13 + bob, 13, 18);
    c.fillStyle = L.robeTrim;
    c.fillRect(bx + 4, by + 29 + bob, 13, 2);
    c.fillStyle = L.rope;
    c.fillRect(bx + 4, by + 21 + bob, 13, 2);

    // front arm hanging at his side
    c.fillStyle = L.sleeve;
    c.fillRect(bx + 13, by + 14 + bob, 3, 8);
    c.fillStyle = L.skin;
    c.fillRect(bx + 13, by + 22 + bob, 3, 3);

    // head + hair
    c.fillStyle = L.skin;
    c.fillRect(bx + 5, by + 3 + bob, 11, 10);
    c.fillStyle = L.hair;
    c.fillRect(bx + 4, by + 1 + bob, 13, 4);
    c.fillRect(bx + 4, by + 3 + bob, 3, 8);
    c.fillRect(bx + 12, by + 5 + bob, 4, 2);

    // eye
    c.fillStyle = L.eyeW;
    c.fillRect(bx + 12, by + 7 + bob, 3, 3);
    c.fillStyle = L.pupil;
    c.fillRect(bx + 14, by + 7 + bob, 1, 3);

    c.restore();
  }

  // Name tag floats above an NPC while the cursor hovers its bbox.
  function drawNameTag(c, n, cam) {
    const inp = TC.Input;
    if (!inp || !inp.mouse || !cam) return;
    const z = cam.zoom || 1;
    const sx = (n.x - cam.x) * z, sy = (n.y - cam.y) * z;
    const mx = inp.mouse.x, my = inp.mouse.y;
    if (mx < sx || mx > sx + n.w * z || my < sy || my > sy + n.h * z) return;
    c.save();
    c.font = '8px monospace';
    c.textAlign = 'center';
    const tx = n.x + n.w / 2, ty = n.y - 5;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillText(n.name, tx + 1, ty + 1);
    c.fillStyle = '#e8e2d0';
    c.fillText(n.name, tx, ty);
    c.restore();
  }

  function draw(ctx, cam) {
    if (!ctx || !list.length) return;
    ctx.save();
    if (typeof TC.applyCam === 'function') TC.applyCam(ctx);
    else if (cam) ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);

    // cheap view culling
    let vw = 0, vh = 0;
    if (TC.canvas) { const z = cam ? cam.zoom : 1; vw = TC.canvas.width / z; vh = TC.canvas.height / z; }
    const vx0 = (cam ? cam.x : 0) - 64, vy0 = (cam ? cam.y : 0) - 64;
    const vx1 = vx0 + vw + 128, vy1 = vy0 + vh + 128;

    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (vw && (n.x + n.w < vx0 || n.x > vx1 || n.y + n.h < vy0 || n.y > vy1)) continue;
      drawHumanoid(ctx, n);
      drawNameTag(ctx, n, cam);
    }
    ctx.restore();
  }

  // ---- housing validation -------------------------------------------------
  // A valid home: bounded footprint (4..14 x 3..10 tiles), flat solid floor,
  // open interior, sealed shell (doors count), a door anywhere on the border
  // ring, >=60% background-wall coverage across the footprint, no liquid
  // volume inside (TC.Liquids is the authority), and light from a torch
  // inside or TC.Lighting. Checks run cheap-first; problems come back as
  // descriptive keys: 'floor','blocked','open','dark' plus 'too-small',
  // 'too-large','no-walls','flooded','no-entrance'.

  function doorAt(tx, ty) {
    const w = TC.world;
    if (!w || typeof w.get !== 'function' || !TC.TILE) return false;
    const id = w.get(tx, ty);
    return id === TC.TILE.DOOR_CLOSED || id === TC.TILE.DOOR_OPEN;
  }

  // A border cell seals the room if it is outside the world (edges count as
  // walls), solid, or a door.
  function sealed(tx, ty, world) {
    if (tx < 0 || ty < 0 || tx >= world.width || ty >= world.height) return true;
    return solidAt(tx, ty) || doorAt(tx, ty);
  }

  // A door anywhere on the ring just outside the shell gives entrance.
  function entranceOnRing(world, tx, ty, w, h) {
    for (let x = tx - 1; x <= tx + w; x++) {
      if (doorAt(x, ty - 1) || doorAt(x, ty + h)) return true;
    }
    for (let y = ty - 1; y <= ty + h; y++) {
      if (doorAt(tx - 1, y) || doorAt(tx + w, y)) return true;
    }
    return false;
  }

  // Fraction of the footprint's cells backed by a background wall. Worlds
  // without a walls layer never get penalized by this check.
  function wallCoverage(world, tx, ty, w, h) {
    if (!world.walls || !world.walls.length || !(world.width > 0)) return 1;
    let filled = 0;
    const total = w * h;
    for (let y = ty; y < ty + h; y++) {
      const row = y * world.width;
      for (let x = tx; x < tx + w; x++) {
        if (world.walls[row + x]) filled++;
      }
    }
    return total ? filled / total : 1;
  }

  // True when the runtime liquid layer holds any volume in a cell.
  function liquidIn(tx, ty) {
    if (!TC.Liquids || typeof TC.Liquids.queryAt !== 'function') return false;
    try {
      const q = TC.Liquids.queryAt(tx, ty);
      return !!(q && q.type && q.amount > 0);
    } catch (e) { return false; }
  }

  // Validate a candidate house region [tx..tx+w) x [ty..ty+h).
  // Returns { ok, problems: [...] }. Conservative: any doubt fails the check.
  function validateHome(tx, ty, w, h) {
    const res = { ok: false, problems: [] };
    const world = TC.world;
    if (!world || typeof world.get !== 'function') {
      res.problems.push('no-world');
      return res;
    }
    tx |= 0; ty |= 0; w |= 0; h |= 0;
    if (w <= 0 || h <= 0) { res.problems.push('bad-size'); return res; }
    if (w < HOME_MIN_W || h < HOME_MIN_H) {
      res.problems.push('too-small');
      return res;
    }
    if (w > HOME_MAX_W || h > HOME_MAX_H) {
      res.problems.push('too-large');
      return res;
    }
    if (tx < 0 || ty < 0 || tx + w > world.width || ty + h > world.height) {
      res.problems.push('out-of-bounds');
      return res;
    }

    const floorY = ty + h - 1;
    for (let x = tx; x < tx + w; x++) {
      if (!solidAt(x, floorY)) { res.problems.push('floor'); break; }
    }
    outer:
    for (let y = ty; y < floorY; y++) {
      for (let x = tx; x < tx + w; x++) {
        if (solidAt(x, y)) { res.problems.push('blocked'); break outer; }
      }
    }

    if (!entranceOnRing(world, tx, ty, w, h)) res.problems.push('no-entrance');

    if (wallCoverage(world, tx, ty, w, h) < HOME_WALL_COVER) {
      res.problems.push('no-walls');
    }

    flood:
    for (let y = ty; y < ty + h; y++) {
      for (let x = tx; x < tx + w; x++) {
        if (liquidIn(x, y)) { res.problems.push('flooded'); break flood; }
      }
    }

    let gap = false;
    for (let x = tx - 1; x <= tx + w && !gap; x++) {
      if (!sealed(x, ty - 1, world) || !sealed(x, ty + h, world)) gap = true;
    }
    for (let y = ty - 1; y <= ty + h && !gap; y++) {
      if (!sealed(tx - 1, y, world) || !sealed(tx + w, y, world)) gap = true;
    }
    if (gap) res.problems.push('open');

    let lit = false;
    if (TC.TILE && TC.TILE.TORCH != null) {
      for (let y = ty; y < ty + h && !lit; y++) {
        for (let x = tx; x < tx + w; x++) {
          if (world.get(x, y) === TC.TILE.TORCH) { lit = true; break; }
        }
      }
    }
    if (!lit && TC.Lighting && typeof TC.Lighting.lightAt === 'function') {
      try {
        lit = TC.Lighting.lightAt(tx + ((w / 2) | 0), ty + (((h - 1) / 2) | 0)) >= 0.35;
      } catch (e) { lit = false; }
    }
    if (!lit) res.problems.push('dark');

    res.ok = res.problems.length === 0;
    return res;
  }

  // ---- home claiming ------------------------------------------------------
  // On move-in an NPC searches outward from its arrival spot for the smallest
  // valid room rectangle and claims it as a plot: npc.state.home = {tx,ty,w,h}
  // and homeX re-anchors to the plot center (wander span unchanged; the state
  // blob already serializes, so claims ride saves for free). The search is
  // incremental - at most CLAIM_BUDGET validateHome calls per update tick -
  // so a town full of move-ins can never spike a frame.

  const claimQueue = [];            // NPCs whose scans are unfinished
  const ringCache = {};             // radius -> [[dx,dy],...] stride-2 offsets

  // Deterministic square-ring offsets, nearest ring first, deduped corners.
  function ringOffsets(rad) {
    const hit = ringCache[rad];
    if (hit) return hit;
    const pts = [];
    if (rad <= 0) {
      pts.push([0, 0]);
    } else {
      const seen = {};
      const push = (dx, dy) => {
        const key = dx + ',' + dy;
        if (!seen[key]) { seen[key] = 1; pts.push([dx, dy]); }
      };
      for (let d = -rad; d <= rad; d += 2) {
        push(d, -rad); push(d, rad); push(-rad, d); push(rad, d);
      }
    }
    ringCache[rad] = pts;
    return pts;
  }

  function enqueueClaim(n) {
    if (!n || n.dead || n._claimScan) return;
    n._claimScan = {
      ax: Math.floor((n.x + n.w / 2) / TC.CONST.TS),   // arrival tile
      // air cell holding the feet (-0.5 guards exact-resting y values)
      ay: Math.floor((n.y + n.h - 0.5) / TC.CONST.TS),
      rad: 0, k: 0, calls: 0, done: false
    };
    claimQueue.push(n);
  }

  // Spend up to `maxCalls` validateHome calls advancing one scan. Returns the
  // claimed plot or null (spent count lands in st.callsUsed); st.done flips
  // once the spiral is exhausted.
  function advanceScan(st, maxCalls) {
    const world = TC.world;
    let used = 0;
    st.callsUsed = 0;
    while (!st.done && used < maxCalls) {
      if (st.rad > CLAIM_RADIUS || st.calls >= CLAIM_MAX_CALLS || !world) {
        st.done = true;
        break;
      }
      const ring = ringOffsets(st.rad);
      if (st.k >= ring.length) { st.rad += 2; st.k = 0; continue; }
      const off = ring[st.k++];
      // stride-2 rings plus both neighbour columns keep odd-parity plots
      // reachable without sampling every tile
      for (let side = -1; side <= 1 && used < maxCalls && !st.done; side++) {
        const ax = st.ax + off[0] + side, ay = st.ay + off[1];
        if (ax < 1 || ay < 1 || ax >= world.width - 1 || ay >= world.height - 1) {
          continue;
        }
        if (!solidAt(ax, ay + 1)) continue;               // needs floor below
        if (solidAt(ax, ay) || solidAt(ax, ay - 1)) continue; // standing room
        for (let si = 0; si < CLAIM_SIZES.length && used < maxCalls; si++) {
          const fw = CLAIM_SIZES[si][0], fh = CLAIM_SIZES[si][1];
          used++; st.calls++;
          const rx = ax - ((fw / 2) | 0), ry = ay + 2 - fh;
          const v = validateHome(rx, ry, fw, fh);
          if (v.ok) {
            st.callsUsed = used;
            return { tx: rx, ty: ry, w: fw, h: fh };
          }
        }
      }
    }
    st.callsUsed = used;
    return null;
  }

  // Budgeted per-tick pass over every queued scan.
  function processClaims() {
    if (!TC.world || !claimQueue.length) return;
    let budget = CLAIM_BUDGET;
    while (budget > 0 && claimQueue.length) {
      const n = claimQueue.shift();
      if (!n || n.dead || list.indexOf(n) < 0) continue;  // gone: drop quietly
      const st = n._claimScan;
      if (!st) continue;
      const plot = advanceScan(st, budget);
      budget -= st.callsUsed;
      if (plot) {
        n.state.home = plot;
        n.homeX = (plot.tx + plot.w / 2) * TC.CONST.TS;   // re-anchor to plot
        n._claimScan = null;
      } else if (st.done) {
        n._claimScan = null;
      } else {
        claimQueue.push(n);                               // resume next tick
      }
    }
  }

  // Start (or report) a housing scan for an NPC object or type string.
  // Already-claimed NPCs report true without rescanning.
  function claimHouse(npcOrType) {
    let n = npcOrType;
    if (typeof npcOrType === 'string') {
      n = null;
      for (let i = 0; i < list.length; i++) {
        if (list[i].type === npcOrType) { n = list[i]; break; }
      }
    }
    if (!n || typeof n !== 'object' || n.dead || list.indexOf(n) < 0) {
      return false;
    }
    if (n.state && n.state.home) return true;
    enqueueClaim(n);
    return true;
  }

  // Plot lookup for UI/tests/debug: NPC object, type string, or null.
  function houseOf(npcOrType) {
    let n = null;
    if (npcOrType && typeof npcOrType === 'object') n = npcOrType;
    else if (typeof npcOrType === 'string') {
      for (let i = 0; i < list.length; i++) {
        if (list[i].type === npcOrType) { n = list[i]; break; }
      }
    }
    const hm = (n && n.state && typeof n.state === 'object') ? n.state.home : null;
    if (!hm || typeof hm !== 'object') return null;
    const t = num(hm.tx), y = num(hm.ty), ww = num(hm.w), hh = num(hm.h);
    if (t == null || y == null || ww == null || hh == null) return null;
    return { tx: t | 0, ty: y | 0, w: ww | 0, h: hh | 0 };
  }

  // ---- persistence ----

  function serializeNpc(n) {
    const rec = { type: n.type, x: n.x, y: n.y };
    rec.homeX = n.homeX;
    rec.hp = n.hp;
    const st = n.state;
    if (st && typeof st === 'object' && Object.keys(st).length) {
      try { rec.state = JSON.parse(JSON.stringify(st)); } catch (e) { /* skip */ }
    }
    return rec;
  }

  function serialize() {
    const out = [];
    for (let i = 0; i < list.length; i++) out.push(serializeNpc(list[i]));
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      out.push({ type: p.type, x: p.x, y: p.y, respawnT: p.timer });
    }
    return out;
  }

  // Restore from [{type,x,y,...}]. Old saves carry only {type:'guide',x,y};
  // unknown kinds and malformed entries are skipped. With nothing restored a
  // fresh Guide spawns near the middle of the surface.
  function load(data) {
    list.length = 0;
    pending.length = 0;
    claimQueue.length = 0;
    let restored = false;
    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        const d = data[i];
        if (!d || typeof d !== 'object') continue;
        const def = NPC_KINDS[d.type];
        if (!def) continue;
        const rt = num(d.respawnT);
        if (rt != null && rt > 0) {           // dead: resume the respawn timer
          const hs = (num(d.x) != null && num(d.y) != null)
            ? { x: d.x, y: d.y } : homeSpot(def);
          pending.push({ type: def.type, x: hs.x, y: hs.y, timer: rt });
          restored = true;
          continue;
        }
        const x = num(d.x), y = num(d.y);
        if (x === null || y === null) continue;
        const spot = findGroundSpot(x, y);
        const n = makeNpc(def, spot ? spot.x : x, spot ? spot.y : y);
        const hp = num(d.hp);
        if (hp != null) n.hp = clamp(Math.max(1, hp), 1, n.maxHp);
        const hx = num(d.homeX);
        if (hx != null) n.homeX = hx;
        if (d.state && typeof d.state === 'object' && !Array.isArray(d.state)) {
          n.state = d.state;
        }
        list.push(n);
        restored = true;
      }
    }
    if (!restored) {
      const w = TC.world;
      if (w && w.surfaceY) {
        const tx = clamp((w.width / 2) | 0, 0, w.width - 1);
        spawnGuide(tx * TC.CONST.TS, (w.surfaceY[tx] || 0) * TC.CONST.TS);
      }
    }
  }

  function clear() {
    list.length = 0;
    pending.length = 0;
    claimQueue.length = 0;
  }

  // ---- public surface ----
  TC.NPCs = {
    list,
    KINDS: NPC_KINDS,
    kindDef: (type) => NPC_KINDS[type] || null,
    shopOf: (type) => {
      const def = NPC_KINDS[type];
      if (!def || !Array.isArray(def.shop)) return null;
      // Filter to visible rows and copy the entries: callers must never hold
      // references into the def table.
      const out = [];
      for (let i = 0; i < def.shop.length; i++) {
        const e = def.shop[i];
        if (!stockUnlocked(e)) continue;
        out.push(Object.assign({}, e));
      }
      return out.length ? out : null;
    },
    spawnGuide, spawn, evaluateUnlocks, validateHome, damage,
    claimHouse, houseOf, dialogLineFor,
    update, draw, clear, serialize, load
  };
})();
