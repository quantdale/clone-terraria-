/* wiring.js — TC.Wiring: wire + mechanisms (switches, levers, pressure plates,
   timers, dart traps, actuators). Signal propagation is a BFS flood across
   WIRE tiles from a source cell; receivers (doors, dart traps, actuators)
   react once per pulse.

   Owns exactly this file. constants.js / main.js / index.html are lead-owned,
   so this module EXTENDS the shared tables at load time and PATCHES existing
   prototypes/functions at runtime instead of editing them:

   - Table extensions (promote into constants.js when convenient):
     TC.TILE:      WIRE, SWITCH_OFF, SWITCH_ON, LEVER_OFF, LEVER_ON,
                   PRESSURE_PLATE, TIMER, DART_TRAP  (ids after LAVA)
     TC.TILE_DEFS: matching defs appended
     TC.ITEM_DEFS: wire, switch, lever, pressure_plate, timer, dart_trap,
                   actuator
     TC.RECIPES:   workbench/anvil recipes for all of the above
   - Runtime hooks (all guarded + idempotent):
     World.prototype.set/setRaw        -> registry maintenance notifications
     World.prototype.applyMineDamage   -> completes the break by writing AIR
                                          (the vanilla mine path drops the item
                                          but never clears the tile; remove
                                          this shim if player.js is fixed to
                                          call world.set(tx,ty,AIR) itself)
     World.prototype.isSolid           -> actuator "ghost" cells pass through
     World.prototype.update/draw       -> per-frame tick + wire overlay render
     Player.prototype.interact         -> right-click toggles devices /
                                          attaches & detaches actuators
     Player.prototype.doPlace          -> actuator placement onto solid blocks
     Items.iconFor                     -> procedural icons for wiring items
     Save.save                         -> splices a `wiring` blob into the
                                          stored record (timer run-state +
                                          actuator attachments; placements
                                          themselves persist via tile diffs)
     newGame / continueGame            -> reset / restore wiring state

   REQUIRES one line in index.html (lead-owned, not added here), AFTER main.js
   so the flow wrappers can bind:
     <script src="js/main.js"></script>
     <script src="js/wiring.js"></script>

   Exposed API: TC.Wiring.{init,update,draw,pulse,toggleDevice,placeWire,
   removeWire,interact,onTileChanged,serialize,load,reset}. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Wiring) return;                       // load-once guard

  // ======================================================================
  // Shared-table extensions (see header note; promote to constants.js).
  // ======================================================================

  // Mirrors the D() helper in constants.js so appended defs have the full shape.
  function mkDef(name, o) {
    return Object.assign({
      name, solid: false, opaque: false, hardness: 0, tool: null, minPower: 0,
      drop: null, light: 0, pattern: 'empty', needsSupport: null,
      replaceable: false, colors: []
    }, o);
  }

  function extendTables() {
    const T = TC.TILE;
    const defs = TC.TILE_DEFS;
    if (!T || !defs) return;
    if (T.WIRE == null) {
      let n = defs.length;
      T.WIRE = n++;
      T.SWITCH_OFF = n++; T.SWITCH_ON = n++;
      T.LEVER_OFF = n++; T.LEVER_ON = n++;
      T.PRESSURE_PLATE = n++;
      T.TIMER = n++;
      T.DART_TRAP = n++;
      defs.push(
        /* WIRE           */ mkDef('wire', { hardness: 0.05, tool: 'any', drop: 'wire', pattern: 'wire', colors: ['#d0342c'] }),
        /* SWITCH_OFF     */ mkDef('switch', { hardness: 0.08, tool: 'any', drop: 'switch', pattern: 'switch', needsSupport: 'any', colors: ['#8a5a32', '#c0c0cc'] }),
        /* SWITCH_ON      */ mkDef('switch (on)', { hardness: 0.08, tool: 'any', drop: 'switch', pattern: 'switch', needsSupport: 'any', colors: ['#8a5a32', '#c0c0cc'] }),
        /* LEVER_OFF      */ mkDef('lever', { hardness: 0.08, tool: 'any', drop: 'lever', pattern: 'lever', needsSupport: 'any', colors: ['#6a6a74', '#c0c0cc'] }),
        /* LEVER_ON       */ mkDef('lever (on)', { hardness: 0.08, tool: 'any', drop: 'lever', pattern: 'lever', needsSupport: 'any', colors: ['#6a6a74', '#c0c0cc'] }),
        /* PRESSURE_PLATE */ mkDef('pressure plate', { hardness: 0.05, tool: 'any', drop: 'pressure_plate', pattern: 'plate', needsSupport: 'below', colors: ['#9a9aa2'] }),
        /* TIMER          */ mkDef('timer', { hardness: 0.1, tool: 'any', drop: 'timer', pattern: 'timer', needsSupport: 'below', colors: ['#4a4a52', '#ffd24a'] }),
        /* DART_TRAP      */ mkDef('dart trap', { solid: true, hardness: 0.35, tool: 'any', drop: 'dart_trap', pattern: 'dart', needsSupport: 'any', colors: ['#3d3d3d', '#6a6a74'] })
      );
    }
    if (TC.ITEM_DEFS && !TC.ITEM_DEFS.wire) {
      const I = (name, kind, o) => Object.assign({ name, kind, maxStack: 999 }, o);
      TC.ITEM_DEFS.wire = I('Wire', 'block', { tile: T.WIRE });
      TC.ITEM_DEFS.switch = I('Switch', 'block', { tile: T.SWITCH_OFF });
      TC.ITEM_DEFS.lever = I('Lever', 'block', { tile: T.LEVER_OFF });
      TC.ITEM_DEFS.pressure_plate = I('Pressure Plate', 'block', { tile: T.PRESSURE_PLATE });
      TC.ITEM_DEFS.timer = I('Timer', 'block', { tile: T.TIMER });
      TC.ITEM_DEFS.dart_trap = I('Dart Trap', 'block', { tile: T.DART_TRAP });
      // Actuators attach onto existing solid blocks (metadata layer), so the
      // item has no tile of its own; placement is intercepted in doPlace.
      TC.ITEM_DEFS.actuator = I('Actuator', 'block', { tile: null });
    }
    if (TC.RECIPES && !TC.RECIPES.some((r) => r && r.out === 'wire')) {
      TC.RECIPES.push(
        { out: 'wire', n: 10, station: 'workbench', cost: { iron_bar: 1 } },
        { out: 'switch', n: 1, station: 'workbench', cost: { wood: 5, wire: 2 } },
        { out: 'lever', n: 1, station: 'workbench', cost: { wood: 3, iron_bar: 1, wire: 2 } },
        { out: 'pressure_plate', n: 2, station: 'workbench', cost: { stone: 5, wire: 2 } },
        { out: 'timer', n: 1, station: 'workbench', cost: { iron_bar: 3, glass: 1, wire: 2 } },
        { out: 'dart_trap', n: 1, station: 'anvil', cost: { iron_bar: 5, stone: 5, wire: 2 } },
        { out: 'actuator', n: 3, station: 'workbench', cost: { iron_bar: 1, wire: 5 } }
      );
    }
  }
  extendTables();

  // ======================================================================
  // Tuning + palette
  // ======================================================================

  const TS = TC.CONST.TS;
  const T = TC.TILE;

  const PULSE_CAP = 4096;        // max wire cells flooded per signal
  const FLASH_TIME = 0.22;       // seconds a powered wire stays lit
  const TIMER_PERIOD = 1;        // seconds between timer pulses (fixed v1)
  const DART_SPEED = 340;        // px/s
  const DART_LIFE = 3;           // seconds before despawn
  const DART_DMG_ENEMY = 14;
  const DART_DMG_PLAYER = 18;

  const C = {
    wire: '#b3261e', wireHot: '#ff7a52', wireGlow: 'rgba(255,122,82,0.35)',
    wood: '#8a5a32', woodDark: '#5f3f22',
    metal: '#c0c0cc', metalDark: '#6a6a74', iron: '#4a4a52',
    plate: '#9a9aa2', plateDown: '#76767e',
    ledOn: '#57e389', ledOff: '#c04a4a',
    act: '#ff8c3a', ghost: 'rgba(255,140,58,0.22)',
    dart: '#d8d8e0', dartDark: '#585866'
  };

  // ======================================================================
  // State (one live world at a time; reset() clears everything)
  // ======================================================================

  let plates = new Map();        // tileIdx -> { pressed: bool }
  let timers = new Map();        // tileIdx -> { t: seconds, running: bool }
  let actuated = new Set();      // host-cell idx with an actuator attached
  let ghosts = new Set();        // host-cell idx currently pass-through
  let flashes = new Map();       // wire/receiver idx -> seconds of glow left
  let darts = [];                // { x, y, vx, vy, age }

  function reset() {
    plates = new Map();
    timers = new Map();
    actuated = new Set();
    ghosts = new Set();
    flashes = new Map();
    darts.length = 0;
  }

  function inB(world, x, y) {
    return world && x >= 0 && y >= 0 && x < world.width && y < world.height;
  }

  // Rebuild contact registries from the grid (world load / programmatic init).
  function rescanGrid() {
    const world = TC.world;
    if (!world || !world.tiles) return;
    plates.clear();
    timers.clear();
    for (let i = 0; i < world.tiles.length; i++) {
      const id = world.tiles[i];
      if (id === T.PRESSURE_PLATE) plates.set(i, { pressed: false });
      else if (id === T.TIMER) timers.set(i, { t: 0, running: false });
    }
  }

  // ======================================================================
  // Guarded cross-module helpers
  // ======================================================================

  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') {
      try { TC.Audio.play(name); } catch (e) {}
    }
  }
  function pBurst(x, y, n, colors, spd) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try { TC.Particles.burst(x, y, n, { colors: colors, speed: spd }); } catch (e) {}
    }
  }
  function hash2(x, y, s) {
    return (TC.Utils && TC.Utils.hash2) ? TC.Utils.hash2(x, y, s) : 0.5;
  }
  function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }
  function spawnDrop(x, y, id, count) {
    if (TC.Items && typeof TC.Items.spawnDrop === 'function') {
      try { TC.Items.spawnDrop(x, y, id, count); } catch (e) {}
    }
  }

  // ======================================================================
  // Registry maintenance — called from the patched World.set/setRaw
  // ======================================================================

  function onTileChanged(x, y, before, after) {
    const world = TC.world;
    if (!world) return;
    const i = y * world.width + x;
    if (before !== after) {
      if (before === T.PRESSURE_PLATE) plates.delete(i);
      if (after === T.PRESSURE_PLATE) plates.set(i, { pressed: false });
      if (before === T.TIMER) timers.delete(i);
      if (after === T.TIMER) timers.set(i, { t: 0, running: false });
    }
    flashes.delete(i);
    // A broken host block releases its actuator.
    if ((actuated.has(i) || ghosts.has(i)) && after === T.AIR && before !== T.AIR) {
      actuated.delete(i);
      ghosts.delete(i);
      spawnDrop((x + 0.5) * TS, (y + 0.5) * TS, 'actuator', 1);
      sfx('break');
    }
  }

  // ======================================================================
  // Signal core — BFS flood across wire, receivers fire once per pulse
  // ======================================================================

  function isReceiver(id) {
    return id === T.DOOR_CLOSED || id === T.DOOR_OPEN || id === T.DART_TRAP;
  }

  function toggleGhost(i) {
    if (ghosts.has(i)) ghosts.delete(i);
    else ghosts.add(i);
    sfx('place');
  }

  // Signal-actuated doors mirror player.interact's rule: never shut a door
  // into the player hitbox. Enemies may be crushed.
  function toggleDoor(x, y, id) {
    const world = TC.world;
    const next = id === T.DOOR_CLOSED ? T.DOOR_OPEN : T.DOOR_CLOSED;
    if (next === T.DOOR_CLOSED && TC.player && !TC.player.dead) {
      const p = TC.player;
      if (aabb(p.x, p.y, p.w, p.h, x * TS, y * TS, TS, TS)) return;
    }
    try { world.set(x, y, next); } catch (e) {}
  }

  // Fire direction: toward whichever horizontal side is open; ties break
  // deterministically from hash2 (never Math.random). Returns 0 when boxed in.
  function trapFacing(world, tx, ty) {
    const lOpen = !world.isSolid(tx - 1, ty);
    const rOpen = !world.isSolid(tx + 1, ty);
    if (lOpen && rOpen) return hash2(tx, ty, 12345) < 0.5 ? -1 : 1;
    if (lOpen) return -1;
    if (rOpen) return 1;
    return 0;
  }

  function fireDart(tx, ty) {
    const dir = trapFacing(TC.world, tx, ty);
    if (!dir) return;
    darts.push({
      x: (tx + 0.5) * TS + dir * (TS / 2 + 2),
      y: (ty + 0.5) * TS,
      vx: dir * DART_SPEED,
      vy: 0,
      age: 0
    });
    sfx('swing');
  }

  function fireReceiver(x, y, id) {
    flashes.set(y * TC.world.width + x, FLASH_TIME);
    if (id === T.DOOR_CLOSED || id === T.DOOR_OPEN) toggleDoor(x, y, id);
    else if (id === T.DART_TRAP) fireDart(x, y);
  }

  // Emit a signal from device cell (sx, sy): flood adjacent wire, then fire
  // every receiver / actuator touching any powered cell (or the source).
  function pulse(sx, sy) {
    const world = TC.world;
    if (!world || typeof world.get !== 'function') return 0;
    const W = world.width;
    const seen = new Set();
    const q = [];
    const triggered = new Set();
    let fired = 0;

    const triggerAround = (x, y) => {
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (!inB(world, nx, ny)) continue;
        const ni = ny * W + nx;
        if (triggered.has(ni)) continue;
        const id = world.tiles[ni];
        if (isReceiver(id)) {
          triggered.add(ni);
          fired++;
          fireReceiver(nx, ny, id);
        } else if (actuated.has(ni)) {
          triggered.add(ni);
          fired++;
          flashes.set(ni, FLASH_TIME);
          toggleGhost(ni);
        }
      }
    };
    const visit = (x, y) => {
      if (!inB(world, x, y)) return;
      const i = y * W + x;
      if (seen.has(i) || world.tiles[i] !== T.WIRE) return;
      seen.add(i);
      q.push(i);
      flashes.set(i, FLASH_TIME);
    };

    triggerAround(sx, sy);
    visit(sx + 1, sy); visit(sx - 1, sy); visit(sx, sy + 1); visit(sx, sy - 1);
    for (let h = 0; h < q.length && seen.size < PULSE_CAP; h++) {
      const i = q[h];
      const x = i % W, y = (i / W) | 0;
      triggerAround(x, y);
      visit(x + 1, y); visit(x - 1, y); visit(x, y + 1); visit(x, y - 1);
    }
    return fired;
  }

  // ======================================================================
  // Devices
  // ======================================================================

  function isToggleDevice(id) {
    return id === T.SWITCH_OFF || id === T.SWITCH_ON ||
           id === T.LEVER_OFF || id === T.LEVER_ON;
  }

  // Flip a switch/lever tile and emit its signal.
  function toggleDevice(tx, ty) {
    const world = TC.world;
    if (!inB(world, tx, ty)) return false;
    const id = world.get(tx, ty);
    let next;
    if (id === T.SWITCH_OFF) next = T.SWITCH_ON;
    else if (id === T.SWITCH_ON) next = T.SWITCH_OFF;
    else if (id === T.LEVER_OFF) next = T.LEVER_ON;
    else if (id === T.LEVER_ON) next = T.LEVER_OFF;
    else return false;
    try { world.set(tx, ty, next); } catch (e) { return false; }
    flashes.set(ty * world.width + tx, FLASH_TIME);
    pulse(tx, ty);
    sfx('place');
    return true;
  }

  function toggleTimer(tx, ty) {
    const world = TC.world;
    if (!inB(world, tx, ty) || world.get(tx, ty) !== T.TIMER) return false;
    const i = ty * world.width + tx;
    let st = timers.get(i);
    if (!st) { st = { t: 0, running: false }; timers.set(i, st); }
    st.running = !st.running;
    sfx('place');
    return true;
  }

  function updateTimers(dt) {
    if (!timers.size) return;
    const world = TC.world;
    if (!world) return;
    const W = world.width;
    timers.forEach((st, i) => {
      if (!st.running) return;
      st.t += dt;
      if (st.t >= TIMER_PERIOD) {
        st.t -= TIMER_PERIOD;
        if (world.tiles[i] === T.TIMER) pulse(i % W, (i / W) | 0);
        else st.running = false;             // tile vanished without a notice
      }
    });
  }

  function collectEntities(out) {
    out.length = 0;
    const p = TC.player;
    if (p && !p.dead && typeof p.x === 'number') out.push(p);
    const add = (list) => {
      if (!list || !list.length) return;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e && typeof e.x === 'number' && typeof e.y === 'number' &&
            e.w > 0 && e.h > 0 && !(e.hp <= 0)) out.push(e);
      }
    };
    if (TC.Enemies) add(TC.Enemies.list);
    if (TC.NPCs) add(TC.NPCs.list);
    return out;
  }

  const entBuf = [];
  function updatePlates() {
    if (!plates.size) return;
    const world = TC.world;
    if (!world) return;
    const W = world.width;
    const ents = collectEntities(entBuf);
    plates.forEach((st, i) => {
      if (world.tiles[i] !== T.PRESSURE_PLATE) return;   // stale entry
      const rx = (i % W) * TS, ry = ((i / W) | 0) * TS;
      let hit = false;
      for (let k = 0; k < ents.length; k++) {
        const e = ents[k];
        if (aabb(e.x, e.y, e.w, e.h, rx, ry, TS, TS)) { hit = true; break; }
      }
      if (hit && !st.pressed) {                          // rising edge fires
        st.pressed = true;
        pulse(i % W, (i / W) | 0);
        sfx('place');
      } else if (!hit && st.pressed) {
        st.pressed = false;
      }
    });
  }

  // ======================================================================
  // Darts
  // ======================================================================

  function solidPx(x, y) {
    const w = TC.world;
    return !!(w && typeof w.solidAtPixel === 'function' && w.solidAtPixel(x, y));
  }

  function updateDarts(dt) {
    if (!darts.length) return;
    const world = TC.world;
    for (let i = darts.length - 1; i >= 0; i--) {
      const d = darts[i];
      d.age += dt;
      if (d.age >= DART_LIFE) { darts.splice(i, 1); continue; }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      if (solidPx(d.x, d.y)) {                           // thunks into a wall
        pBurst(d.x, d.y, 3, [C.metal, C.dartDark], 60);
        sfx('dig');
        darts.splice(i, 1);
        continue;
      }
      if (hitEnemies(d, i)) continue;
      hitPlayer(d, i);
    }
  }

  function hitEnemies(d, di) {
    if (!TC.Enemies || !TC.Enemies.list || !TC.Enemies.damageEnemy) return false;
    const list = TC.Enemies.list;
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      if (!e || e.hp <= 0) continue;
      if (!aabb(d.x - 2, d.y - 2, 4, 4, e.x, e.y, e.w, e.h)) continue;
      try { TC.Enemies.damageEnemy(e, DART_DMG_ENEMY, d.vx >= 0 ? 1 : -1, 2, false); } catch (err) {}
      pBurst(d.x, d.y, 4, [C.metal, '#c93a3a'], 80);
      sfx('hit');
      darts.splice(di, 1);
      return true;
    }
    return false;
  }

  function hitPlayer(d, di) {
    const p = TC.player;
    if (!p || p.dead || p.iframes > 0) return;
    if (!TC.Combat || typeof TC.Combat.hurtPlayer !== 'function') return;
    if (!aabb(d.x - 2, d.y - 2, 4, 4, p.x, p.y, p.w, p.h)) return;
    try { TC.Combat.hurtPlayer(DART_DMG_PLAYER, d.vx >= 0 ? 3 : -3, -1.5, 'trap'); } catch (e) {}
    darts.splice(di, 1);
  }

  // ======================================================================
  // Actuators — metadata attachments on solid host blocks
  // ======================================================================

  function attachActuator(player, m) {
    const world = TC.world;
    if (!world || typeof world.get !== 'function' || typeof world.set !== 'function') return false;
    const TSv = TS;
    const tx = Math.floor(m.worldX / TSv), ty = Math.floor(m.worldY / TSv);
    if (typeof player.inReach === 'function' && !player.inReach(tx, ty)) return false;
    const id = world.get(tx, ty);
    const td = TC.TILE_DEFS[id];
    if (!td || !td.solid || id === T.BEDROCK || id === T.CHEST) return false;
    const i = ty * world.width + tx;
    if (actuated.has(i)) return false;
    const inv = player.inventory;
    if (!inv || typeof inv.remove !== 'function' ||
        (typeof inv.count === 'function' && !(inv.count('actuator') > 0))) return false;
    try { inv.remove('actuator', 1); } catch (e) { return false; }
    actuated.add(i);
    sfx('place');
    return true;
  }

  function detachActuator(tx, ty) {
    const world = TC.world;
    if (!world) return false;
    const i = ty * world.width + tx;
    if (!actuated.has(i)) return false;
    actuated.delete(i);
    ghosts.delete(i);
    spawnDrop((tx + 0.5) * TS, (ty + 0.5) * TS, 'actuator', 1);
    sfx('dig');
    return true;
  }

  // ======================================================================
  // Public API
  // ======================================================================

  // Programmatic wire placement (no item cost); returns bool.
  function placeWire(tx, ty) {
    const world = TC.world;
    if (!inB(world, tx, ty) || typeof world.set !== 'function') return false;
    if (world.get(tx, ty) !== T.AIR) return false;
    try { world.set(tx, ty, T.WIRE); } catch (e) { return false; }
    return true;
  }

  // Cut a wire cell, dropping the item; returns bool.
  function removeWire(tx, ty) {
    const world = TC.world;
    if (!inB(world, tx, ty) || typeof world.set !== 'function') return false;
    if (world.get(tx, ty) !== T.WIRE) return false;
    try { world.set(tx, ty, T.AIR); } catch (e) { return false; }
    spawnDrop((tx + 0.5) * TS, (ty + 0.5) * TS, 'wire', 1);
    sfx('break');
    return true;
  }

  // Right-click handler layered in front of Player.interact. Returns true
  // when the click was consumed by a wiring surface.
  function interact(player, m) {
    const world = TC.world;
    if (!world || typeof world.get !== 'function' || !m || !isFinite(m.worldX)) return false;
    const tx = Math.floor(m.worldX / TS), ty = Math.floor(m.worldY / TS);
    if (typeof player.inReach === 'function' && !player.inReach(tx, ty)) return false;
    const id = world.get(tx, ty);

    if (isToggleDevice(id)) return toggleDevice(tx, ty);
    if (id === T.TIMER) return toggleTimer(tx, ty);

    const i = ty * world.width + tx;
    if (actuated.has(i)) return detachActuator(tx, ty);

    // Holding an actuator over a plain solid block attaches one.
    const sel = (typeof player.selectedSlot === 'function') ? player.selectedSlot() : null;
    if (sel && sel.id === 'actuator' && !actuated.has(i)) {
      return attachActuator(player, m);
    }
    return false;
  }

  // ---- per-frame tick (driven via patched World.update) ----
  function update(dt) {
    const world = TC.world;
    if (!world || TC.state !== 'playing') return;
    updateTimers(dt);
    updatePlates();
    updateDarts(dt);
    if (flashes.size) {
      flashes.forEach((t, i) => {
        const left = t - dt;
        if (left > 0) flashes.set(i, left);
        else flashes.delete(i);
      });
    }
  }

  // Bind to whatever world is current; safe to call again (rescans).
  function init() {
    reset();
    rescanGrid();
  }

  // ---- persistence ----
  // Placements persist through the normal tile-diff system; this blob only
  // carries what the grid cannot express: timer run-state, actuator hosts,
  // and which hosts are currently ghosted.
  function serialize() {
    const out = {};
    const running = [];
    timers.forEach((st, i) => { if (st.running) running.push(i); });
    if (running.length) out.timers = running;
    if (actuated.size) out.actuators = Array.from(actuated);
    if (ghosts.size) out.ghosts = Array.from(ghosts);
    return out;
  }

  function validIdxArray(arr, maxIdx) {
    if (!Array.isArray(arr)) return false;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (typeof v !== 'number' || (v | 0) !== v || v < 0 || v >= maxIdx) return false;
    }
    return true;
  }

  function load(blob) {
    const world = TC.world;
    const maxIdx = world ? world.width * world.height : TC.CONST.WORLD_W * TC.CONST.WORLD_H;
    if (blob == null) return true;                     // nothing stored: clean slate
    if (typeof blob !== 'object') return false;
    if (blob.timers != null) {
      if (!validIdxArray(blob.timers, maxIdx)) return false;
      for (let i = 0; i < blob.timers.length; i++) {
        if (timers.has(blob.timers[i])) timers.get(blob.timers[i]).running = true;
      }
    }
    if (blob.actuators != null) {
      if (!validIdxArray(blob.actuators, maxIdx)) return false;
      for (let i = 0; i < blob.actuators.length; i++) actuated.add(blob.actuators[i]);
    }
    if (blob.ghosts != null) {
      if (!validIdxArray(blob.ghosts, maxIdx)) return false;
      for (let i = 0; i < blob.ghosts.length; i++) {
        if (actuated.has(blob.ghosts[i])) ghosts.add(blob.ghosts[i]);
      }
    }
    return true;
  }

  TC.Wiring = { init, update, draw, pulse, toggleDevice, toggleTimer, placeWire, removeWire, interact, onTileChanged, serialize, load, reset };

  // ======================================================================
  // Rendering — world-space overlay; main.js applies the camera transform
  // around World.draw, which this is chained onto.
  // ======================================================================

  function drawWire(ctx, world, tx, ty, px, py) {
    const hot = flashes.get(ty * world.width + tx) > 0;
    ctx.strokeStyle = hot ? C.wireHot : C.wire;
    ctx.lineWidth = hot ? 2 : 1.5;
    const cx = px + TS / 2, cy = py + TS / 2;
    if (hot) {                                         // soft under-glow
      ctx.strokeStyle = C.wireGlow;
      ctx.lineWidth = 4;
      strokeLinks(ctx, world, tx, ty, cx, cy);
      ctx.strokeStyle = C.wireHot;
      ctx.lineWidth = 2;
    }
    strokeLinks(ctx, world, tx, ty, cx, cy);
    ctx.fillStyle = hot ? C.wireHot : C.wire;          // junction node
    ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
  }

  // Each cell draws its east/south links so pairs render exactly once.
  function strokeLinks(ctx, world, tx, ty, cx, cy) {
    ctx.beginPath();
    if (tx + 1 < world.width && world.tiles[ty * world.width + tx + 1] === T.WIRE) {
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + TS / 2, cy);
    }
    if (ty + 1 < world.height && world.tiles[(ty + 1) * world.width + tx] === T.WIRE) {
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy + TS / 2);
    }
    ctx.stroke();
  }

  function drawSwitch(ctx, px, py, on) {
    ctx.fillStyle = C.woodDark;
    ctx.fillRect(px + 3, py + 12, 10, 3);              // mounting foot
    ctx.fillStyle = C.wood;
    ctx.fillRect(px + 4, py + 5, 8, 8);                // plate
    ctx.fillStyle = C.woodDark;
    ctx.fillRect(px + 4, py + 12, 8, 1);
    ctx.fillStyle = C.metal;
    ctx.fillRect(px + (on ? 9 : 5), py + 7, 3, 4);     // slid nub
    ctx.fillStyle = on ? C.ledOn : C.ledOff;
    ctx.fillRect(px + 7, py + 3, 2, 2);                // state lamp
  }

  function drawLever(ctx, px, py, on) {
    ctx.fillStyle = C.metalDark;
    ctx.fillRect(px + 4, py + 11, 8, 4);               // base
    ctx.fillStyle = C.iron;
    ctx.fillRect(px + 3, py + 14, 10, 1);
    const ang = on ? 0.65 : -0.65;                     // stick pivots at base top
    const hx = px + 8 + Math.sin(ang) * 7;
    const hy = py + 11 - Math.cos(ang) * 7;
    ctx.strokeStyle = C.metal;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + 8, py + 11);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = on ? C.ledOn : C.ledOff;           // knob shows circuit state
    ctx.fillRect(hx - 1.5, hy - 1.5, 3, 3);
  }

  function drawPlate(ctx, px, py, pressed) {
    ctx.fillStyle = pressed ? C.plateDown : C.plate;
    ctx.fillRect(px + 2, py + (pressed ? 13 : 12), 12, pressed ? 2 : 3);
    ctx.fillStyle = C.metalDark;
    ctx.fillRect(px + 2, py + (pressed ? 15 : 15), 12, 1);
    if (!pressed) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(px + 3, py + 12, 10, 1);
    }
  }

  function drawTimer(ctx, px, py, st) {
    ctx.fillStyle = C.iron;
    ctx.fillRect(px + 2, py + 3, 12, 10);              // housing
    ctx.fillStyle = '#23232a';
    ctx.fillRect(px + 3, py + 4, 10, 8);               // face
    const ang = st ? (st.t / TIMER_PERIOD) * Math.PI * 2 - Math.PI / 2 : -Math.PI / 2;
    ctx.strokeStyle = C.wireHot;
    ctx.lineWidth = 1;
    ctx.beginPath();                                   // dial hand
    ctx.moveTo(px + 8, py + 8);
    ctx.lineTo(px + 8 + Math.cos(ang) * 3.5, py + 8 + Math.sin(ang) * 3.5);
    ctx.stroke();
    ctx.fillStyle = (st && st.running) ? C.ledOn : C.ledOff;
    ctx.fillRect(px + 12, py + 2, 3, 3);               // run LED
  }

  function drawTrap(ctx, world, tx, ty, px, py) {
    ctx.fillStyle = C.iron;
    ctx.fillRect(px + 1, py + 4, 14, 8);               // body
    ctx.fillStyle = '#2b2b31';
    ctx.fillRect(px + 2, py + 5, 12, 6);
    ctx.fillStyle = C.metalDark;
    ctx.fillRect(px + 1, py + 4, 14, 1);               // top lip
    const dir = trapFacing(world, tx, ty);
    if (dir !== 0) {                                   // nozzle + loaded glint
      const nx = dir > 0 ? px + 15 : px - 1;
      ctx.fillStyle = C.metalDark;
      ctx.fillRect(nx, py + 7, 2, 2);
      ctx.fillStyle = C.metal;
      ctx.fillRect(dir > 0 ? px + 12 : px + 3, py + 7, 2, 2);
    }
  }

  function drawActuatorMarks(ctx, world, i) {
    const W = world.width;
    const px = (i % W) * TS, py = ((i / W) | 0) * TS;
    if (ghosts.has(i)) {                               // ghosted host block
      ctx.fillStyle = C.ghost;
      ctx.fillRect(px, py, TS, TS);
      ctx.strokeStyle = C.act;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(px + 0.5, py + 0.5, TS - 1, TS - 1);
      ctx.setLineDash([]);
      ctx.beginPath();                                 // diagonal hatch
      ctx.moveTo(px + 2, py + TS - 2);
      ctx.lineTo(px + TS - 2, py + 2);
      ctx.stroke();
    } else {                                           // idle corner brackets
      ctx.strokeStyle = C.act;
      ctx.lineWidth = 1;
      const b = 4;
      ctx.beginPath();
      ctx.moveTo(px + 1, py + 1 + b); ctx.lineTo(px + 1, py + 1); ctx.lineTo(px + 1 + b, py + 1);
      ctx.moveTo(px + TS - 1 - b, py + 1); ctx.lineTo(px + TS - 1, py + 1); ctx.lineTo(px + TS - 1, py + 1 + b);
      ctx.moveTo(px + TS - 1, py + TS - 1 - b); ctx.lineTo(px + TS - 1, py + TS - 1); ctx.lineTo(px + TS - 1 - b, py + TS - 1);
      ctx.moveTo(px + 1 + b, py + TS - 1); ctx.lineTo(px + 1, py + TS - 1); ctx.lineTo(px + 1, py + TS - 1 - b);
      ctx.stroke();
    }
  }

  function drawDarts(ctx) {
    ctx.lineCap = 'round';
    for (let i = 0; i < darts.length; i++) {
      const d = darts[i];
      const tx = d.vx / DART_SPEED, ty = 0;
      ctx.strokeStyle = C.dartDark;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(d.x - tx * 6, d.y - ty * 6);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();
      ctx.fillStyle = C.dart;                          // steel tip
      ctx.fillRect(d.x + tx * 2 - 1, d.y - 1, 3, 2);
    }
  }

  function draw(ctx, cam) {
    const world = TC.world;
    if (!world || !ctx || !cam || TC.state === 'title') return;
    const vw = ctx.canvas.width / cam.zoom, vh = ctx.canvas.height / cam.zoom;
    const tx0 = Math.max(0, Math.floor(cam.x / TS) - 1);
    const ty0 = Math.max(0, Math.floor(cam.y / TS) - 1);
    const tx1 = Math.min(world.width - 1, Math.ceil((cam.x + vw) / TS) + 1);
    const ty1 = Math.min(world.height - 1, Math.ceil((cam.y + vh) / TS) + 1);
    const W = world.width;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const id = world.tiles[ty * W + tx];
        if (id === T.AIR) continue;
        const px = tx * TS, py = ty * TS;
        if (id === T.WIRE) drawWire(ctx, world, tx, ty, px, py);
        else if (id === T.SWITCH_OFF) drawSwitch(ctx, px, py, false);
        else if (id === T.SWITCH_ON) drawSwitch(ctx, px, py, true);
        else if (id === T.LEVER_OFF) drawLever(ctx, px, py, false);
        else if (id === T.LEVER_ON) drawLever(ctx, px, py, true);
        else if (id === T.PRESSURE_PLATE) {
          const st = plates.get(ty * W + tx);
          drawPlate(ctx, px, py, !!(st && st.pressed));
        } else if (id === T.TIMER) drawTimer(ctx, px, py, timers.get(ty * W + tx));
        else if (id === T.DART_TRAP) drawTrap(ctx, world, tx, ty, px, py);
      }
    }
    if (actuated.size) {                               // few entries; filter by view
      actuated.forEach((i) => {
        const tx = i % W, ty = (i / W) | 0;
        if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) drawActuatorMarks(ctx, world, i);
      });
    }
    drawDarts(ctx);
    ctx.restore();
  }

  // ======================================================================
  // Item icons — iconFor paints blanks for unknown tile patterns, so wiring
  // items get hand-painted 16px canvases here.
  // ======================================================================

  function mkIcon(paint) {
    const cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 16;
    const g = cv.getContext('2d');
    paint(g);
    return cv;
  }

  const ICON_PAINTERS = {
    wire(g) {
      g.strokeStyle = C.wire;
      g.lineWidth = 2;
      g.beginPath();                                   // coiled spool
      for (let k = 0; k < 3; k++) {
        g.moveTo(4 + k * 3, 3);
        g.quadraticCurveTo(8 + k * 3, 8, 4 + k * 3, 13);
      }
      g.stroke();
      g.fillStyle = C.woodDark;                        // spool ends
      g.fillRect(2, 2, 2, 12);
      g.fillRect(13, 2, 2, 12);
    },
    switch(g) {
      g.fillStyle = C.woodDark;
      g.fillRect(3, 11, 10, 3);
      g.fillStyle = C.wood;
      g.fillRect(4, 4, 8, 8);
      g.fillStyle = C.metal;
      g.fillRect(5, 6, 3, 4);
      g.fillStyle = C.ledOff;
      g.fillRect(7, 2, 2, 2);
    },
    lever(g) {
      g.fillStyle = C.metalDark;
      g.fillRect(4, 11, 8, 4);
      g.strokeStyle = C.metal;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(8, 11);
      g.lineTo(12, 4);
      g.stroke();
      g.fillStyle = C.ledOff;
      g.fillRect(11, 2, 3, 3);
    },
    pressure_plate(g) {
      g.fillStyle = C.plate;
      g.fillRect(2, 10, 12, 3);
      g.fillStyle = C.metalDark;
      g.fillRect(2, 13, 12, 1);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(3, 10, 10, 1);
    },
    timer(g) {
      g.fillStyle = C.iron;
      g.fillRect(2, 3, 12, 10);
      g.fillStyle = '#23232a';
      g.fillRect(3, 4, 10, 8);
      g.strokeStyle = C.wireHot;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(8, 8);
      g.lineTo(11, 6);
      g.stroke();
      g.fillStyle = C.ledOn;
      g.fillRect(12, 2, 3, 3);
    },
    dart_trap(g) {
      g.fillStyle = C.iron;
      g.fillRect(1, 5, 14, 7);
      g.fillStyle = '#2b2b31';
      g.fillRect(2, 6, 12, 5);
      g.fillStyle = C.metalDark;
      g.fillRect(14, 7, 2, 3);
      g.fillStyle = C.metal;
      g.fillRect(4, 8, 2, 2);
    },
    actuator(g) {
      g.strokeStyle = C.act;                           // bracket
      g.lineWidth = 2;
      g.strokeRect(3, 3, 10, 10);
      g.fillStyle = C.metalDark;                       // piston arm
      g.fillRect(7, 1, 2, 6);
      g.fillStyle = C.metal;
      g.fillRect(6, 6, 4, 4);
    }
  };

  function patchIcons() {
    if (!TC.Items || typeof TC.Items.iconFor !== 'function' || TC.Items.__wiringIcons) return;
    const orig = TC.Items.iconFor;
    const cache = new Map();
    const wrapped = function (id) {
      const paint = id && ICON_PAINTERS[id];
      if (paint) {
        let cv = cache.get(id);
        if (!cv) { cv = mkIcon(paint); cache.set(id, cv); }
        return cv;
      }
      return orig.call(TC.Items, id);
    };
    wrapped.__wiring = true;
    TC.Items.__wiringIcons = true;
    TC.Items.iconFor = wrapped;
  }

  // ======================================================================
  // Runtime patches (guarded, idempotent)
  // ======================================================================

  function patchWorld() {
    const WP = TC.World && TC.World.prototype;
    if (!WP || WP.__wiringPatched) return;
    WP.__wiringPatched = true;

    // Registry maintenance on full edits.
    const origSet = WP.set;
    WP.set = function (x, y, id) {
      const before = this.get(x, y);
      const r = origSet.call(this, x, y, id);
      if (TC.Wiring) TC.Wiring.onTileChanged(x, y, before, id);
      return r;
    };

    // Same maintenance for raw writes (save-load diffs, tree felling).
    const origSetRaw = WP.setRaw;
    WP.setRaw = function (x, y, id) {
      const before = this.get(x, y);
      const r = origSetRaw.call(this, x, y, id);
      if (TC.Wiring) TC.Wiring.onTileChanged(x, y, before, id);
      return r;
    };

    // Compatibility shim: the vanilla mine path drops the item but never
    // writes AIR back (applyMineDamage's contract says "the caller can break
    // it" — it doesn't). Complete the break here so mined tiles, cut wire and
    // released actuators actually disappear. Remove if player.js is fixed.
    const origAmd = WP.applyMineDamage;
    WP.applyMineDamage = function (tx, ty, amt) {
      const broke = origAmd.call(this, tx, ty, amt);
      if (broke && this.inB(tx, ty) && this.tiles[this.idx(tx, ty)] !== T.AIR) {
        this.set(tx, ty, T.AIR);
      }
      return broke;
    };

    // Ghosted (actuated) cells stop colliding while powered.
    const origIsSolid = WP.isSolid;
    WP.isSolid = function (x, y) {
      if (TC.Wiring && ghosts.size && ghosts.has(y * this.width + x)) return false;
      return origIsSolid.call(this, x, y);
    };

    // Per-frame tick + overlay render ride on the world's own loop slots.
    const origUpdate = WP.update;
    WP.update = function (dt) {
      origUpdate.call(this, dt);
      if (TC.Wiring) TC.Wiring.update(dt);
    };
    const origDraw = WP.draw;
    WP.draw = function (ctx, cam) {
      origDraw.call(this, ctx, cam);
      if (TC.Wiring) TC.Wiring.draw(ctx, cam);
    };
  }

  function patchPlayer() {
    const PP = TC.Player && TC.Player.prototype;
    if (!PP || PP.__wiringPatched) return;
    PP.__wiringPatched = true;

    // Right-click: wiring surfaces first, vanilla doors/chests otherwise.
    const origInteract = PP.interact;
    PP.interact = function (m) {
      if (TC.Wiring && TC.Wiring.interact(this, m)) return;
      origInteract.call(this, m);
    };

    // Left-click with an actuator selected attaches it to a solid block
    // instead of the generic block placement path (which would no-op).
    const origDoPlace = PP.doPlace;
    PP.doPlace = function (def, itemId, m) {
      if (itemId === 'actuator' && TC.Wiring) {
        TC.Wiring.attachActuatorAt(this, m);
        return;
      }
      origDoPlace.call(this, def, itemId, m);
    };
  }

  // Left-click attach shares the same rules as right-click attach.
  TC.Wiring.attachActuatorAt = function (player, m) {
    const world = TC.world;
    if (!world || !m || !isFinite(m.worldX)) return false;
    const tx = Math.floor(m.worldX / TS), ty = Math.floor(m.worldY / TS);
    if (typeof player.inReach === 'function' && !player.inReach(tx, ty)) return false;
    const i = ty * world.width + tx;
    if (actuated.has(i)) return detachActuator(tx, ty);   // toggle off on reuse
    return attachActuator(player, m);
  };

  // Save integration: splice the wiring blob into the record Save.save wrote.
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
    } catch (e) { /* persistence stays best-effort, like save.js */ }
  }

  function readStoredWiring() {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return (data && typeof data === 'object') ? data.wiring || null : null;
    } catch (e) { return null; }
  }

  function patchSave() {
    if (!TC.Save || TC.Save.__wiringPatched) return;
    TC.Save.__wiringPatched = true;
    const origSave = TC.Save.save;
    TC.Save.save = function () {
      const ok = origSave ? !!origSave.call(TC.Save) : false;
      if (ok && TC.Wiring) {
        const blob = TC.Wiring.serialize();
        const hasAny = blob.timers || blob.actuators || blob.ghosts;
        if (hasAny) spliceStored((data) => { data.wiring = blob; });
        else spliceStored((data) => { delete data.wiring; });   // keep records clean
      }
      return ok;
    };
  }

  function patchFlow() {
    if (TC.__wiringFlowPatched) return;

    if (typeof TC.newGame === 'function') {
      TC.__wiringFlowPatched = true;
      const origNew = TC.newGame;
      TC.newGame = function (seed) {
        const r = origNew.call(TC, seed);
        if (TC.Wiring) TC.Wiring.reset();              // fresh world: no devices
        return r;
      };
    }
    if (typeof TC.continueGame === 'function') {
      TC.__wiringFlowPatchedContinue = true;
      const origCont = TC.continueGame;
      TC.continueGame = function () {
        const r = origCont.call(TC);
        if (TC.Wiring) {
          TC.Wiring.init();                            // rescan placed devices
          TC.Wiring.load(readStoredWiring());          // restore run-state
        }
        return r;
      };
    }
  }

  // ======================================================================
  // Install
  // ======================================================================

  function install() {
    patchWorld();
    patchPlayer();
    patchIcons();
    patchSave();
    patchFlow();
  }

  // Prototype patches are always safe; the global-flow wrappers need main.js
  // to have run first. If wiring.js ever loads before main.js, defer until
  // DOMContentLoaded (sync scripts have all executed by then).
  if (typeof TC.newGame === 'function' || typeof document === 'undefined' ||
      document.readyState !== 'loading') {
    install();
  } else {
    document.addEventListener('DOMContentLoaded', install);
  }
})();
