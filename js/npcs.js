/* npcs.js — TC.NPCs: town NPCs driven by the NPC_KINDS def table. Each kind
   defines name, dialog lines, unlock rule, home params, optional shop stock
   and a paint palette; the Guide is the seed entry, the Merchant demonstrates
   unlocks + shop data (shop panel is wired lead-side). NPCs wander near home,
   talk on right-click (lines cycle deterministically), take damage via
   TC.NPCs.damage and respawn at home after a delay. Never hostile. */
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
        'Smelt your ore. Bars are worth more than rocks, always.'
      ],
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
      shop: [
        { itemId: 'torch', price: 2 },
        { itemId: 'wood', price: 1 },
        { itemId: 'arrow', price: 1 },
        { itemId: 'iron_bar', price: 12 },
        { itemId: 'gold_bar', price: 30 }
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
      dialogIdx: -1,        // cycles dialogLines deterministically
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
    return n;
  }

  // Legacy entry point: replace the whole population with a fresh Guide.
  function spawnGuide(px, py) {
    list.length = 0;
    pending.length = 0;
    spawn('guide', num(px) != null ? px : 0, num(py) != null ? py : 0);
  }

  // ---- unlock evaluation ------------------------------------------------

  function unlocked(def) {
    const u = def.unlocks;
    if (u == null) return true;
    if (typeof u === 'function') {
      try { return !!u(def); } catch (e) { return false; }
    }
    if (typeof u === 'string' && u) {
      if (TC.Progression && typeof TC.Progression.has === 'function') {
        try { return !!TC.Progression.has(u); } catch (e) { return false; }
      }
      return false;
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
    const def = NPC_KINDS[n.type];
    const lines = (def && def.dialogLines && def.dialogLines.length)
      ? def.dialogLines : ['...'];
    n.dialogIdx = (n.dialogIdx + 1) % lines.length;
    if (TC.UI && typeof TC.UI.showDialog === 'function') {
      try { TC.UI.showDialog(n.name, lines[n.dialogIdx]); } catch (e) {}
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

  // ---- housing validation (conservative) ---------------------------------

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

  // Validate a candidate house region [tx..tx+w) x [ty..ty+h):
  // flat solid floor, open interior, sealed shell (doors count), light from a
  // torch inside or Lighting. Returns { ok, problems: ['floor','blocked',
  // 'open','dark', ...] }. Conservative: any doubt fails the check.
  function validateHome(tx, ty, w, h) {
    const res = { ok: false, problems: [] };
    const world = TC.world;
    if (!world || typeof world.get !== 'function') {
      res.problems.push('no-world');
      return res;
    }
    tx |= 0; ty |= 0; w |= 0; h |= 0;
    if (w <= 0 || h <= 0) { res.problems.push('bad-size'); return res; }
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
  }

  // ---- public surface ----
  TC.NPCs = {
    list,
    KINDS: NPC_KINDS,
    kindDef: (type) => NPC_KINDS[type] || null,
    shopOf: (type) => {
      const def = NPC_KINDS[type];
      // Copy the entries too: callers must never hold references into the def table.
      return (def && Array.isArray(def.shop))
        ? def.shop.map((e) => Object.assign({}, e)) : null;
    },
    spawnGuide, spawn, evaluateUnlocks, validateHome, damage,
    update, draw, clear, serialize, load
  };
})();
