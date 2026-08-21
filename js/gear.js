/* gear.js — TC.Gear: thrown & spun ranged weapons wired onto the shared
   TC.Projectiles pool (yoyos, boomerangs, grenades) plus night falling
   stars that occasionally shed a fallen_star material drop.

   Owns exactly this file. Foundation-contract edition: NO monkey patching.
   This module only EXTENDS the shared tables at load time and registers its
   content ids with TC.Registry; every former runtime wrap is now a plain
   exported function the lead calls from the game loop / useHeld switch.

   - Table extensions (promote into constants.js when convenient):
     TC.ITEM_DEFS: wooden_yoyo, metal_yoyo, wooden_boomerang, grenade,
                   fire_grenade, flint, fallen_star
     TC.RECIPES:   workbench/anvil recipes for all of the above

   - Exposed surface:
     TC.Gear.defs                       snapshot of the gear ITEM_DEFS entries
     TC.Gear.reset()                    clear watchers + star cadence (safe on
                                        title screens; update() also self-heals
                                        on world switches)
     TC.Gear.update(dt)                 per-frame tick: projectile death
                                        watchers + night falling-star spawner.
                                        Call AFTER TC.Combat.update so freshly
                                        spent pool slots are seen as dead.
     TC.Gear.draw(ctx, cam)             world-space molotov overlay on
                                        fire-tagged grenades. Call right after
                                        TC.Combat.draw (camera transform is
                                        applied inside, like the old wrap).
     TC.Gear.onUseHeld(player, def, dt) -> bool
                                        true when def.kind is 'yoyo' /
                                        'boomerang' / 'grenade' and the use was
                                        fully handled (even when the throw was
                                        skipped for cooldown/ammo reasons — the
                                        vanilla switch must not run either way).
     TC.Gear.iconFor(id) -> canvas|null hand-painted 16px icons for the gear
                                        ids only; null for anything else.

   INTEGRATION (one line each, lead-owned files):
     main.js step(), directly after `if (TC.Combat) TC.Combat.update(dt);`:
       if (TC.Gear) TC.Gear.update(dt);
     main.js draw(), directly after `if (TC.Combat) TC.Combat.draw(ctx, cam);`:
       if (TC.Gear) TC.Gear.draw(ctx, cam);
     player.js useHeld(), after resolving sel/def and BEFORE the kind switch:
       if (TC.Gear && def && TC.Gear.onUseHeld(this, def, dt)) return;
     items.js iconFor(), before its own painters:
       const gic = (TC.Gear && TC.Gear.iconFor(key)) ||
                   (TC.Loot && TC.Loot.iconFor(key));
       if (gic) return gic;

   Runtime randomness here (star timing, drop rolls) is gameplay-only,
   matching combat.js precedent; worldgen determinism is untouched. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Gear) return;                       // load-once guard

  // ======================================================================
  // Shared-table extensions (see header note; promote to constants.js).
  // ======================================================================

  function extendTables() {
    if (!TC.ITEM_DEFS) return;
    const I = (name, kind, o) => Object.assign({ name, kind, maxStack: 999 }, o);
    if (!TC.ITEM_DEFS.wooden_yoyo) {
      TC.ITEM_DEFS.wooden_yoyo = I('Wooden Yoyo', 'yoyo',
        { maxStack: 1, damage: 14, knockback: 2.5, useTime: 0.45 });
      TC.ITEM_DEFS.metal_yoyo = I('Metal Yoyo', 'yoyo',
        { maxStack: 1, damage: 22, knockback: 3, useTime: 0.38 });
      TC.ITEM_DEFS.wooden_boomerang = I('Wooden Boomerang', 'boomerang',
        { maxStack: 1, damage: 12, knockback: 3.5, useTime: 0.5 });
      TC.ITEM_DEFS.grenade = I('Grenade', 'grenade',
        { maxStack: 99, damage: 10, knockback: 6, useTime: 0.55 });
      TC.ITEM_DEFS.fire_grenade = I('Fire Grenade', 'grenade',
        { maxStack: 99, damage: 16, knockback: 5, useTime: 0.55 });
      TC.ITEM_DEFS.flint = I('Flint', 'material', {});
      TC.ITEM_DEFS.fallen_star = I('Fallen Star', 'material', {});
    }
    if (TC.RECIPES && !TC.RECIPES.some((r) => r && r.out === 'wooden_yoyo')) {
      TC.RECIPES.push(
        { out: 'flint',            n: 2, station: 'workbench', cost: { stone: 3 } },
        { out: 'wooden_yoyo',      n: 1, station: 'workbench', cost: { wood: 12 } },
        { out: 'wooden_boomerang', n: 1, station: 'workbench', cost: { wood: 10 } },
        { out: 'metal_yoyo',       n: 1, station: 'anvil',     cost: { iron_bar: 8, wood: 4 } },
        { out: 'grenade',          n: 5, station: 'workbench', cost: { iron_bar: 1, flint: 2 } },
        { out: 'fire_grenade',     n: 3, station: 'workbench', cost: { glass: 1, gel: 3, torch: 2 } }
      );
    }
  }
  extendTables();

  // ======================================================================
  // Tuning + palette
  // ======================================================================

  const TAU = Math.PI * 2;

  const STAR_DMG = 18;             // falling star hit damage
  const STAR_SPEED = 560;          // px/s entry speed
  const STAR_INTERVAL = 4;         // s between falls at night (plus variance)
  const STAR_INTERVAL_VAR = 5;
  const STAR_FIRST = 1.5;          // s into a night before the first fall
  const STAR_SPREAD_X = 380;       // px around the player stars can land in
  const STAR_ABOVE_SURFACE = 36;   // tiles above the surface line they spawn
  const STAR_SURFACE_BAND = 30;    // player must be within this of the surface
  const STAR_ANGLE_VAR = 0.18;     // rad of entry-angle wobble around straight down
  const STAR_DROP_CHANCE = 0.35;   // chance a spent star sheds a fallen_star
  const MAX_LIVE_STARS = 5;        // gear-spawned stars in flight at once
  const WATCH_CAP = 24;            // pooled projectiles tracked for death events

  const C = {
    wood: '#a97d4b', woodDark: '#7a5230', woodLite: '#c99b62',
    metal: '#c0c0cc', metalDark: '#6a6a74',
    gem: '#b07ae8', shell: '#3d4436', shellDark: '#20261c',
    fire: '#ff8c3a', fireLite: '#ffd76a', glass: '#bcd9e8',
    flint: '#4a4a52', flintLite: '#8a8a94', star: '#ffe98a'
  };

  // ======================================================================
  // Guarded cross-module helpers
  // ======================================================================

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') {
      try { TC.Audio.play(name); } catch (e) {}
    }
  }

  function projSpawn(type, x, y, ang, opts) {
    if (!TC.Projectiles || typeof TC.Projectiles.spawn !== 'function') return null;
    try { return TC.Projectiles.spawn(type, x, y, ang, opts); } catch (e) { return null; }
  }

  // ======================================================================
  // Death watchers — pooled projectiles are recycled, so their last live
  // position is mirrored here and the callback fires when the slot dies.
  // ======================================================================

  const watched = [];            // { p, lx, ly, onEnd, star }
  let curWorld = null;

  function watch(p, onEnd, isStar) {
    if (watched.length >= WATCH_CAP) return;
    watched.push({ p, lx: p.x, ly: p.y, onEnd, star: !!isStar });
  }

  function sweepWatched() {
    for (let i = watched.length - 1; i >= 0; i--) {
      const w = watched[i];
      if (w.p.active) { w.lx = w.p.x; w.ly = w.p.y; continue; }
      watched.splice(i, 1);
      try { w.onEnd(w.lx, w.ly); } catch (e) {}
    }
  }

  function emberBurst(x, y) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try {
        TC.Particles.burst(x, y, 10, {
          colors: [C.fire, C.fireLite, '#e85a1a'],
          speed: 90, life: 0.5, size: 2.5, gravity: 120
        });
      } catch (e) {}
    }
  }

  function dropFallenStar(x, y) {
    if (!TC.world) return;
    if (TC.Items && typeof TC.Items.spawnDrop === 'function') {
      try { TC.Items.spawnDrop(x, y, 'fallen_star', 1, true); } catch (e) {}
    }
  }

  // ======================================================================
  // Falling stars — night-only sky drops near the (surface-level) player.
  // Damage/hit handling rides the pool's falling_star type; only the spawn
  // cadence and the occasional material drop are owned here.
  // ======================================================================

  let starTimer = STAR_FIRST;

  function starTick(dt) {
    const pl = TC.player;
    if (!TC.world || !pl || pl.dead) return;
    const dl = (TC.Sky && typeof TC.Sky.daylight === 'function') ? TC.Sky.daylight() : 1;
    if (dl >= 0.5) {                          // day: hold the timer primed
      starTimer = Math.max(starTimer, STAR_FIRST);
      return;
    }
    starTimer -= dt;
    if (starTimer > 0) return;
    starTimer = STAR_INTERVAL + Math.random() * STAR_INTERVAL_VAR;
    spawnStar(pl);
  }

  function spawnStar(pl) {
    let liveStars = 0;
    for (let i = 0; i < watched.length; i++) if (watched[i].star) liveStars++;
    if (liveStars >= MAX_LIVE_STARS) return;

    const world = TC.world;
    const TS = TC.CONST.TS;
    const px = pl.x + pl.w / 2 + (Math.random() * 2 - 1) * STAR_SPREAD_X;
    const tx = clamp(Math.floor(px / TS), 0, world.width - 1);
    const surf = world.surfaceY ? world.surfaceY[tx] : null;
    if (surf == null) return;
    if (Math.abs(pl.y / TS - surf) > STAR_SURFACE_BAND) return;   // underground: skip
    const py = Math.max(2, surf - STAR_ABOVE_SURFACE) * TS;
    const ang = Math.PI / 2 + (Math.random() * 2 - 1) * STAR_ANGLE_VAR;

    const p = projSpawn('falling_star', px, py, ang,
      { speed: STAR_SPEED, dmg: STAR_DMG, kb: 5 });
    if (!p) return;
    if (Math.random() < STAR_DROP_CHANCE) watch(p, dropFallenStar, true);
  }

  // ======================================================================
  // Weapon use — called from the lead's useHeld routing (was a Player
  // prototype wrap). Cooldowns reuse the vanilla swing record so the arm
  // animation runs.
  // ======================================================================

  const GEAR_KINDS = { yoyo: 1, boomerang: 1, grenade: 1 };

  function startSwing(player, def) {
    const ut = def.useTime || 0.4;
    player.swingSeq = (player.swingSeq || 0) + 1;
    player.swing = {
      item: def, timer: ut, dur: ut,
      swung: true, loop: false, bow: false, id: player.swingSeq
    };
  }

  // True while `player` already has a yoyo in flight (one string at a time).
  function liveYoyo(player) {
    if (!TC.Projectiles || typeof TC.Projectiles.viewOf !== 'function') return false;
    const live = TC.Projectiles.viewOf('yoyo');   // scratch array: read now
    for (let i = 0; i < live.length; i++) {
      if (live[i] && live[i].owner === player) return true;
    }
    return false;
  }

  function useGear(player, def, itemId) {
    const m = (TC.Input && TC.Input.mouse) ? TC.Input.mouse : null;
    if (!m || !isFinite(m.worldX)) return;
    const cx = player.x + player.w / 2, cy = player.y + player.h / 2;
    player.facing = m.worldX >= cx ? 1 : -1;
    if (player.swing && player.swing.item === def) return;   // useTime cooldown
    const ang = Math.atan2(m.worldY - cy, m.worldX - cx);

    if (def.kind === 'yoyo') {
      if (liveYoyo(player)) return;
      const p = projSpawn('yoyo', cx, cy, ang, {
        dmg: def.damage, kb: def.knockback,
        speed: itemId === 'metal_yoyo' ? 400 : undefined
      });                                      // tethered: owner defaults to the player
      if (!p) return;
      sfx('swing');
      startSwing(player, def);
      return;
    }

    if (def.kind === 'boomerang') {
      const p = projSpawn('boomerang', cx, cy, ang, { dmg: def.damage, kb: def.knockback });
      if (!p) return;
      sfx('swing');
      startSwing(player, def);
      return;
    }

    // Grenades: stackable consumables; the pool's fuse/detonate path does
    // the radial TC.Enemies.damageEnemy work on expiry or enemy contact.
    const inv = player.inventory;
    if (!inv || typeof inv.count !== 'function' ||
        typeof inv.remove !== 'function' || !(inv.count(itemId) > 0)) return;
    if (!inv.remove(itemId, 1)) return;
    const p = projSpawn('grenade', cx, cy, ang, { dmg: def.damage, kb: def.knockback });
    if (!p) {                                  // pool full: refund the throw
      if (typeof inv.add === 'function') { try { inv.add(itemId, 1); } catch (e) {} }
      return;
    }
    // fire flag is set on BOTH variants: pool slots are recycled without a
    // reset, so leaving it untouched would flame a plain grenade that later
    // reuses this slot
    p.fire = (itemId === 'fire_grenade');
    if (p.fire) watch(p, emberBurst);          // molotov styling + ember burst
    sfx('swing');
    startSwing(player, def);
  }

  // Lead-facing hook: resolve the selected slot's id against the def (the id
  // is needed for grenade consumption), run the gear throw, report handling.
  function onUseHeld(player, def, dt) {
    if (!player || !def || !GEAR_KINDS[def.kind]) return false;
    const sel = (typeof player.selectedSlot === 'function') ? player.selectedSlot() : null;
    const itemId = (sel && TC.ITEM_DEFS && TC.ITEM_DEFS[sel.id] === def) ? sel.id : null;
    if (!itemId) return false;
    useGear(player, def, itemId);              // dt unused: throws are click-paced
    return true;
  }

  // ---- per-frame tick (lead calls from step(), after Combat.update) ----
  function update(dt) {
    const w = TC.world;
    if (w !== curWorld) { curWorld = w; watched.length = 0; }   // fresh world
    sweepWatched();
    starTick(dt);
  }

  // ======================================================================
  // Molotov overlay — lead calls draw(ctx, cam) after Combat.draw. The pool
  // paints every grenade with one painter, so fire-tagged instances get a
  // flame halo + burning rag drawn on top here.
  // ======================================================================

  function drawFireGrenades(ctx, cam) {
    if (!ctx || !TC.Projectiles || typeof TC.Projectiles.viewOf !== 'function') return;
    const live = TC.Projectiles.viewOf('grenade');   // scratch array: read now
    let any = false;
    for (let i = 0; i < live.length; i++) {
      if (live[i] && live[i].fire) { any = true; break; }
    }
    if (!any) return;

    ctx.save();
    if (typeof TC.applyCam === 'function') TC.applyCam(ctx);
    else if (cam) ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      if (!p || !p.fire) continue;
      const fl = 0.6 + 0.4 * Math.sin(p.age * 22);           // flicker
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 10);
      g.addColorStop(0, 'rgba(255,140,58,' + (0.5 * fl).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,140,58,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 10, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = C.fireLite;                            // rag flame
      ctx.beginPath();
      ctx.arc(p.x, p.y - 7, 2.2 + fl, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#e85a1a';
      ctx.fillRect(p.x - 1, p.y - 8, 2, 2);
    }
    ctx.restore();
  }

  // ======================================================================
  // Item icons — iconFor paints blanks for unknown kinds, so gear items get
  // hand-painted 16px canvases here; the lead's items.js iconFor consults
  // TC.Gear.iconFor first.
  // ======================================================================

  function mkIcon(paint) {
    const cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 16;
    paint(cv.getContext('2d'));
    return cv;
  }

  function disc(g, cx, cy, r, fill, rim) {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.fill();
    g.strokeStyle = rim;
    g.lineWidth = 1.5;
    g.stroke();
  }

  function slots(g, cx, cy, col) {           // spinning cross slots
    g.strokeStyle = col;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx - 4.5, cy); g.lineTo(cx + 4.5, cy);
    g.moveTo(cx, cy - 4.5); g.lineTo(cx, cy + 4.5);
    g.stroke();
  }

  const ICON_PAINTERS = {
    wooden_yoyo(g) {
      disc(g, 8, 8, 6, C.wood, C.woodDark);
      slots(g, 8, 8, C.woodDark);
      g.fillStyle = C.woodLite;
      g.beginPath(); g.arc(8, 8, 2, 0, TAU); g.fill();
    },
    metal_yoyo(g) {
      disc(g, 8, 8, 6, C.metal, C.metalDark);
      slots(g, 8, 8, C.metalDark);
      g.fillStyle = C.gem;                   // enchanter's gem hub
      g.beginPath(); g.arc(8, 8, 2.4, 0, TAU); g.fill();
      g.fillStyle = '#ffffff';
      g.fillRect(7, 6, 1, 1);
    },
    wooden_boomerang(g) {
      g.strokeStyle = C.wood;
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();                         // curved returning arm
      g.moveTo(3, 3);
      g.quadraticCurveTo(14, 5, 12, 13);
      g.stroke();
      g.strokeStyle = C.woodLite;            // leading-edge highlight
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(4, 3.5);
      g.quadraticCurveTo(13, 5.5, 11.5, 12);
      g.stroke();
    },
    grenade(g) {
      g.fillStyle = C.shell;
      g.beginPath(); g.arc(8, 9.5, 5, 0, TAU); g.fill();
      g.strokeStyle = C.shellDark;
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = C.shellDark;
      g.fillRect(7, 2.5, 2, 3);              // fuse cap
      g.fillStyle = C.fireLite;
      g.fillRect(7, 1.5, 2, 1.5);            // lit fuse tip
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(5, 6.5, 2, 2);              // glint
    },
    fire_grenade(g) {
      g.fillStyle = C.glass;
      g.fillRect(5, 6, 6, 8);                // bottle
      g.fillStyle = C.fire;
      g.fillRect(5, 9, 6, 5);                // fuel
      g.fillStyle = C.fireLite;
      g.fillRect(5, 9, 6, 1);
      g.fillStyle = C.glass;
      g.fillRect(7, 3, 2, 3);                // neck
      g.fillStyle = '#8a5a32';
      g.fillRect(6, 1, 4, 2);                // rag wick
      g.fillStyle = C.fireLite;
      g.fillRect(7, 0, 2, 1.5);              // flame
    },
    flint(g) {
      g.fillStyle = C.flint;
      g.beginPath();
      g.moveTo(3, 11); g.lineTo(6, 3); g.lineTo(11, 5); g.lineTo(13, 12); g.lineTo(7, 14);
      g.closePath();
      g.fill();
      g.strokeStyle = C.flintLite;           // knapped edge
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(6, 3);
      g.lineTo(11, 5);
      g.stroke();
    },
    fallen_star(g) {
      g.fillStyle = C.star;
      g.beginPath();
      for (let k = 0; k < 8; k++) {          // 4-point star silhouette
        const rr = (k % 2 === 0) ? 6.5 : 2.5;
        const a = k * Math.PI / 4 - Math.PI / 2;
        const fx = 8 + Math.cos(a) * rr, fy = 8 + Math.sin(a) * rr;
        if (k === 0) g.moveTo(fx, fy); else g.lineTo(fx, fy);
      }
      g.closePath();
      g.fill();
      g.fillStyle = '#fff6c8';
      g.beginPath(); g.arc(8, 8, 1.6, 0, TAU); g.fill();
    }
  };

  const iconCache = new Map();

  // Canvas for a gear item id, or null when the id is not ours.
  function iconFor(id) {
    const paint = id && ICON_PAINTERS[id];
    if (!paint) return null;
    let cv = iconCache.get(id);
    if (!cv) { cv = mkIcon(paint); iconCache.set(id, cv); }
    return cv;
  }

  // ======================================================================
  // Public API
  // ======================================================================

  // Clear runtime state (watchers, star cadence). Safe on title screens.
  function reset() {
    starTimer = STAR_FIRST;
    watched.length = 0;
    curWorld = TC.world || null;
  }

  const GEAR_IDS = ['wooden_yoyo', 'metal_yoyo', 'wooden_boomerang',
                    'grenade', 'fire_grenade', 'flint', 'fallen_star'];
  const defs = {};
  for (let i = 0; i < GEAR_IDS.length; i++) {
    const d = TC.ITEM_DEFS ? TC.ITEM_DEFS[GEAR_IDS[i]] : null;
    if (d) defs[GEAR_IDS[i]] = d;
  }

  // Stable content ids under this module's own namespace (the shared-table
  // auto-mirror separately records them as core:* — both may coexist).
  if (TC.Registry && typeof TC.Registry.define === 'function') {
    for (let i = 0; i < GEAR_IDS.length; i++) {
      const d = TC.ITEM_DEFS ? TC.ITEM_DEFS[GEAR_IDS[i]] : null;
      if (!d) continue;
      try { TC.Registry.define('item', 'gear:' + GEAR_IDS[i], d); }
      catch (e) { /* duplicate or rejected: content still ships via tables */ }
    }
  }

  TC.Gear = { defs, reset, update, draw: drawFireGrenades, onUseHeld, iconFor };
})();
