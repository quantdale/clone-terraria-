/* npcs.js — TC.NPCs: town NPCs. Currently the Guide: wanders near his home
   spot, right-click him for progression tips. Never hostile, never despawns. */
'use strict';
(function () {
  window.TC = window.TC || {};
  const TC = window.TC;

  const NPC_W = 18, NPC_H = 40;
  const WALK_SPEED = 45;          // px/s stroll
  const HOP_VY = -330;            // 1-tile step auto-hop
  const HOME_SPAN_TILES = 8;      // wander radius around homeX
  const DIALOG_CD = 1;            // seconds between dialogs

  const COL = {
    skin: '#edb98a', hair: '#b9bdc9', robe: '#3f8f46', robeTrim: '#2e6e35',
    sleeve: '#357a3c', pants: '#4a3a28', shoe: '#33281c', rope: '#7a5a30',
    eyeW: '#f4f4f4', pupil: '#26262b'
  };

  // Progression tips shown one at a time on right-click.
  const TIPS = [
    'Progression: craft a Workbench from wood, then a Furnace, then an Anvil from iron bars.',
    'Torches need Gel - slimes drop it. One wood plus one gel crafts 3 torches.',
    'Armor reduces damage you take. Forge a Copper set at the Anvil and equip it.',
    'The Void Charm summons the Eye of the Void - use it only at night.',
    'Chests hold 20 stacks. Right-click to open one; mine it to spill the contents.',
    'Background walls need a pickaxe - aim at open tiles to pry them off.',
    'Press N to toggle the minimap.',
    'Press M to mute or unmute the sound.'
  ];

  // ---- small local helpers ----
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function approach(v, target, rate, dt) { return v + (target - v) * Math.min(1, rate * dt); }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }

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
  const list = [];

  function makeGuide(px, py) {
    return {
      type: 'guide', name: 'Guide',
      x: px, y: py, w: NPC_W, h: NPC_H,
      vx: 0, vy: 0, facing: 1, onGround: false,
      homeX: px,
      targetX: px,          // current wander destination
      wanderTimer: rand(1, 3),
      phase: 0,             // walk-cycle progress (visual only)
      hitWall: false,
      dialogTimer: 0
    };
  }

  // Scan down from (px,py) for standing room over solid ground; null if none.
  function findGroundSpot(px, py) {
    const w = TC.world;
    if (!w || typeof w.isSolid !== 'function') return null;
    const ts = TC.CONST.TS;
    const tx = clamp(Math.floor(px / ts), 1, w.width - 2);
    const surf = w.surfaceY ? (w.surfaceY[tx] || 0) : 0;
    const start = Math.min(surf, Math.floor(py / ts));
    const x = tx * ts + (ts - NPC_W) / 2;
    for (let i = 0; i < 24; i++) {
      const gy = start + i;                     // candidate ground row
      if (gy >= w.height) break;
      if (!solidAt(Math.floor((x + NPC_W / 2) / ts), gy)) continue;
      const y = gy * ts - NPC_H;                // need rows of headroom above
      if (rectSolid(x, y, NPC_W, NPC_H)) continue;
      return { x: x, y: y };
    }
    return null;
  }

  // Place the Guide on the ground at/nearest-to (px,py); replaces any previous.
  function spawnGuide(px, py) {
    list.length = 0;
    px = num(px) != null ? px : 0;
    py = num(py) != null ? py : 0;
    const spot = findGroundSpot(px, py);
    list.push(makeGuide(spot ? spot.x : px, spot ? spot.y : py));
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
      const span = HOME_SPAN_TILES * TC.CONST.TS;
      let t = n.homeX + rand(-span, span);
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

  // Right-click over his bbox (screen space via camera) opens a tip dialog.
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
    if (TC.UI && typeof TC.UI.showDialog === 'function') {
      try { TC.UI.showDialog(n.name, TIPS[(Math.random() * TIPS.length) | 0]); } catch (e) {}
    }
  }

  // ---- per-frame update ----
  function update(dt) {
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

  function drawGuide(c, n) {
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
    c.fillStyle = COL.pants;
    c.fillRect(bx + 6 + lb, by + 30, 4, 9);
    c.fillRect(bx + 11 + lf, by + 30, 4, 9);
    c.fillStyle = COL.shoe;
    c.fillRect(bx + 6 + lb, by + 39, 4, 3);
    c.fillRect(bx + 11 + lf, by + 39, 4, 3);

    // back arm
    c.fillStyle = COL.sleeve;
    c.fillRect(bx + 4, by + 14 + bob, 3, 8);
    c.fillStyle = COL.skin;
    c.fillRect(bx + 4, by + 22 + bob, 3, 3);

    // robe body with rope belt and hem trim
    c.fillStyle = COL.robe;
    c.fillRect(bx + 4, by + 13 + bob, 13, 18);
    c.fillStyle = COL.robeTrim;
    c.fillRect(bx + 4, by + 29 + bob, 13, 2);
    c.fillStyle = COL.rope;
    c.fillRect(bx + 4, by + 21 + bob, 13, 2);

    // front arm hanging at his side
    c.fillStyle = COL.sleeve;
    c.fillRect(bx + 13, by + 14 + bob, 3, 8);
    c.fillStyle = COL.skin;
    c.fillRect(bx + 13, by + 22 + bob, 3, 3);

    // head + gray hair
    c.fillStyle = COL.skin;
    c.fillRect(bx + 5, by + 3 + bob, 11, 10);
    c.fillStyle = COL.hair;
    c.fillRect(bx + 4, by + 1 + bob, 13, 4);
    c.fillRect(bx + 4, by + 3 + bob, 3, 8);
    c.fillRect(bx + 12, by + 5 + bob, 4, 2);

    // eye
    c.fillStyle = COL.eyeW;
    c.fillRect(bx + 12, by + 7 + bob, 3, 3);
    c.fillStyle = COL.pupil;
    c.fillRect(bx + 14, by + 7 + bob, 1, 3);

    c.restore();
  }

  // Name tag floats above him while the cursor hovers his bbox.
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
      drawGuide(ctx, n);
      drawNameTag(ctx, n, cam);
    }
    ctx.restore();
  }

  // ---- persistence ----
  function serialize() {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      out.push({ type: list[i].type, x: list[i].x, y: list[i].y });
    }
    return out;
  }

  // Restore positions from [{type,x,y}]; old saves without NPCs get a fresh
  // Guide near the middle of the surface.
  function load(data) {
    list.length = 0;
    let restored = false;
    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        const d = data[i];
        if (!d || typeof d !== 'object' || d.type !== 'guide') continue;
        const x = num(d.x), y = num(d.y);
        if (x === null || y === null) continue;
        const spot = findGroundSpot(x, y);
        list.push(makeGuide(spot ? spot.x : x, spot ? spot.y : y));
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
  }

  TC.NPCs = { list, spawnGuide, update, draw, clear, serialize, load };
})();
