/* projectiles.js — TC.Projectiles: unified pooled projectile system.
   One pre-allocated pool (MAX_PROJECTILES slots) drives every ranged
   projectile: arrows, magic bolts, yoyos, boomerangs, grenades, falling
   stars and wire darts. Per-type motion, pierce, bounce, homing, tile
   collision, enemy hits with the shared variance/crit roll, explosions,
   and lighting hooks (TC.Projectiles.lights rebuilt each frame for a
   future dynamic-light pass; glow is also rendered additively here).

   Integration: TC.Combat delegates its arrow lifecycle here and drives
   update/draw/clear from its own hooks (see combat.js), so main.js needs
   no changes. Projectiles are transient — not part of save data, same as
   the old arrow array. All cross-module calls are guarded.

   Events: every successful spawn emits TC.Events.EVENT.ProjectileSpawned
   with { type, x, y, angle } (guarded — a missing bus never blocks a shot).

   Lighting hook: after each update(), TC.Projectiles.lights (same array via
   getLights()) holds one { x, y, intensity, radius } entry for every live
   projectile whose def.light > 0 plus decaying explosion flashes. A lighting
   pass can consume it directly; entries are world-pixel coordinates.

   Spawn options (per-call overrides of the TYPES def; all optional):
     speed      launch speed px/s          dmg        damage (def fallback 5)
     kb         knockback power            pierce     extra enemies (-1 infinite)
     owner      tether/homing anchor       life       maxAge override in s
     gravity    px/s^2 (ballistic)         bounce     initial tile-bounce budget
     crit       crit-chance bonus 0..1     hitRadius  enemy-hit test radius px
     accel      straight-motion accel      maxSpeed   straight-motion cap
     color      '#rrggbb' render tint      colors     array (first entry used)
   These align with magic.js weapon defs (speed/damage/knockback/pierce/life/
   gravity/bounce/crit/accel/maxSpeed/colors) so magic weapons can delegate
   onto 'magic_bolt', and with gear.js's falling_star usage. Per-spawn visual
   style (orb/scythe/spark painters) is NOT pooled yet — delegation today
   maps every bolt onto the standard bolt painter tinted by colors[0].

   Tuning lives in TYPES below. constants.js is lead-owned, so stable
   values should be promoted into TC.CONST.PROJECTILE by lead decision;
   wiring new items to these types needs ITEM_DEFS entries there too, e.g.
   TC.Items.spawnDrop-style usage: TC.Projectiles.spawn('grenade', x, y,
   angle, { speed: 300, dmg: 12 }).

   Runtime gameplay randomness (damage rolls) uses Math.random, matching
   combat.js/enemies.js precedent; only worldgen must be seed-deterministic. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  // ---- tuning (module-local; see header note about TC.CONST) ----
  const MAX_PROJECTILES = 128;   // hard pool cap (spec: 100+)
  const TAU = Math.PI * 2;
  const PROBE = 4;               // tile-collision probe radius in px
  const CULL = 96;               // draw culling margin in px
  const BOUND_MARGIN = 120;      // world-bounds grace before force-despawn

  // def fields:
  //   motion     'ballistic' | 'straight' | 'yoyo' | 'boomerang'
  //   gravity    px/s^2 (ballistic)
  //   speed      default launch speed px/s (overridable per spawn)
  //   maxAge     s before despawn (grenade: fuse length)
  //   hitRadius  px around the test point that damages an enemy
  //   len        tip offset along velocity (arrow feel); 0 = test center
  //   kb         knockback power
  //   pierce     extra enemies after the first (-1 = infinite)
  //   bounce     tile bounces before dying (grenades ignore: fuse-bound)
  //   restitution bounce energy kept per bounce 0..1
  //   homing     turn rate rad/s toward nearest enemy (0 = off)
  //   homingRange px acquisition radius for homing
  //   light      0..1 light emission (lighting hook + glow render)
  //   stick      s a dart stays stuck in a wall before fading
  //   rehit      yoyo: s before its hit memory clears (re-hit window)
  //   explode    { radius, dmgMul } grenade detonation
  //   color      procedural render tint
  const TYPES = {
    arrow: {
      motion: 'ballistic', gravity: 900, speed: 520, maxAge: 3,
      hitRadius: 12, len: 13, kb: 3, pierce: 0, bounce: 0, restitution: 0,
      light: 0, color: '#8a5a32'
    },
    magic_bolt: {
      motion: 'straight', speed: 380, maxAge: 2.2,
      hitRadius: 10, len: 0, kb: 4, pierce: 1, bounce: 1, restitution: 0.85,
      homing: 5.5, homingRange: 150, light: 0.75, color: '#7a5af5'
    },
    yoyo: {
      motion: 'yoyo', speed: 340, maxDist: 150, maxAge: 12,
      hitRadius: 14, len: 0, kb: 2.5, pierce: -1, bounce: 0, restitution: 0,
      rehit: 0.45, light: 0.35, color: '#e05a8a'
    },
    boomerang: {
      motion: 'boomerang', speed: 330, accel: 280, maxAge: 4,
      hitRadius: 12, len: 0, kb: 3.5, pierce: 2, bounce: 2, restitution: 0.6,
      light: 0, color: '#a97d4b'
    },
    grenade: {
      motion: 'ballistic', gravity: 1100, speed: 300, maxAge: 2.0,
      hitRadius: 10, len: 0, kb: 6, pierce: 0, bounce: 99, restitution: 0.45,
      light: 0.15, explode: { radius: 52, dmgMul: 1.6 }, color: '#3d4436'
    },
    falling_star: {
      motion: 'ballistic', gravity: 620, speed: 560, maxAge: 2.5,
      hitRadius: 13, len: 0, kb: 5, pierce: 2, bounce: 0, restitution: 0,
      light: 0.95, color: '#ffe98a'
    },
    wire_dart: {
      motion: 'straight', speed: 620, maxAge: 1.2,
      hitRadius: 9, len: 0, kb: 2, pierce: 1, bounce: 0, restitution: 0,
      stick: 0.35, light: 0.25, color: '#c04ac0'
    }
  };

  // ---- shared helpers ----
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function solidPx(x, y) {
    const w = TC.world;
    return !!(w && typeof w.solidAtPixel === 'function' && w.solidAtPixel(x, y));
  }

  // Distance from a point to an axis-aligned rect (0 when inside).
  function distToRect(px, py, rx, ry, rw, rh) {
    const nx = Math.max(rx, Math.min(rx + rw, px));
    const ny = Math.max(ry, Math.min(ry + rh, py));
    const dx = px - nx, dy = py - ny;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function hexA(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') { try { TC.Audio.play(name); } catch (e) {} }
  }

  function pBurst(x, y, n, colors, opts) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try { TC.Particles.burst(x, y, n, Object.assign({ colors: colors }, opts || {})); } catch (e) {}
    }
  }

  // Apply DMG_VARIANCE then CRIT_CHANCE (+ per-projectile bonus) double-damage
  // roll. Shared shape with combat.js/magic.js so melee, arrows and pooled
  // projectiles crit identically.
  function rollDamage(base, critBonus) {
    const v = TC.CONST.DMG_VARIANCE || 0;
    let d = base * (1 - v + Math.random() * 2 * v);
    const crit = Math.random() < ((TC.CONST.CRIT_CHANCE || 0) + (critBonus || 0));
    if (crit) d *= 2;
    return { dmg: Math.max(1, Math.round(d)), crit };
  }

  function sparks(x, y) {
    pBurst(x, y, 6, ['#ffd76a', '#e8a53a'], { speed: 110 });
  }

  // Nearest living enemy center within range of (x, y), or null. `skip`
  // lists enemies to ignore — homing passes its projectile's hit list so a
  // piercing bolt keeps flying toward fresh targets instead of U-turning
  // back into one it already struck.
  function nearestEnemy(x, y, range, skip) {
    if (!TC.Enemies || !TC.Enemies.list) return null;
    const list = TC.Enemies.list;
    let best = null, bestD2 = range * range;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.hp <= 0) continue;
      if (skip && skip.indexOf(e) >= 0) continue;
      const dx = e.x + e.w / 2 - x, dy = e.y + e.h / 2 - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    }
    return best;
  }

  // ---- pool state ----
  function blank() {
    return {
      active: false, type: null, def: null,
      x: 0, y: 0, vx: 0, vy: 0,
      age: 0, dmg: 0, kb: 3, pierce: 0, bounces: 0,
      owner: null,
      state: 0,        // motion phase: 0 out / 1 returning / 2 stuck
      timer: 0,        // secondary timer: rehit window, trail throttle
      spin: 0,         // visual rotation (boomerang, yoyo)
      hits: [],        // enemy refs already damaged by this projectile
      // per-spawn overrides resolved in spawn() (def values when unset)
      maxAge: 0, gravity: 0, accel: 0, maxSpeed: 0,
      hitRadius: 10, critBonus: 0, color: null,
      fire: false      // foreign decoration (gear.js molotov); reset on reuse
    };
  }

  const pool = new Array(MAX_PROJECTILES);
  for (let i = 0; i < MAX_PROJECTILES; i++) pool[i] = blank();
  let cursor = 0;          // rolling spawn scan start
  let liveCount = 0;

  // Lighting hook: rebuilt every update(). Each entry is
  //   { x, y, intensity 0..1+, radius px } in world pixels — one per live
  //  projectile with def.light > 0, plus decaying explosion flashes.
  // getLights() hands back the same live array for a lighting pass to consume.
  const lights = [];
  const flashes = [];      // transient explosion flashes feeding `lights`
  const viewScratch = [];  // reused by viewOf()

  function deactivate(p) {
    if (!p.active) return;
    p.active = false;
    p.hits.length = 0;
    liveCount--;
  }

  // ---- spawning ----
  // Spawn projectile `type` from (x, y) along `angle` (radians). opts:
  //   { speed, dmg, kb, pierce, owner, life, gravity, bounce, crit,
  //     hitRadius, accel, maxSpeed, color, colors } — see the header table.
  // Returns the pooled projectile or null when the pool is exhausted or the
  // type is unknown.
  function spawn(type, x, y, angle, opts) {
    const def = TYPES[type];
    if (!def) return null;
    const o = opts || {};
    let p = null;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const cand = pool[cursor];
      cursor = (cursor + 1) % MAX_PROJECTILES;
      if (!cand.active) { p = cand; break; }
    }
    if (!p) return null;                       // pool full: drop silently
    const sp = (typeof o.speed === 'number' && isFinite(o.speed)) ? o.speed : (def.speed || 300);
    p.active = true;
    p.type = type;
    p.def = def;
    p.x = x; p.y = y;
    p.vx = Math.cos(angle) * sp;
    p.vy = Math.sin(angle) * sp;
    p.age = 0; p.state = 0; p.timer = 0;
    p.spin = angle;
    p.dmg = (typeof o.dmg === 'number' && o.dmg > 0) ? o.dmg : (def.dmg || 5);
    p.kb = (typeof o.kb === 'number') ? o.kb : (def.kb || 3);
    p.pierce = (typeof o.pierce === 'number') ? o.pierce : (def.pierce || 0);
    p.bounces = (typeof o.bounce === 'number' && o.bounce > 0) ? o.bounce : (def.bounce || 0);
    p.owner = (o.owner !== undefined) ? o.owner : (TC.player || null);
    // per-spawn overrides (def value when unset); slots are recycled, so
    // every one of these is re-resolved on each spawn — nothing leaks across
    // lives, including foreign decorations like gear.js's `fire` flag.
    p.maxAge = (typeof o.life === 'number' && o.life > 0) ? o.life : (def.maxAge || 3);
    p.gravity = (typeof o.gravity === 'number') ? o.gravity : (def.gravity || 0);
    p.accel = (typeof o.accel === 'number') ? o.accel : (def.accel || 0);
    p.maxSpeed = (typeof o.maxSpeed === 'number') ? o.maxSpeed : (def.maxSpeed || 0);
    p.hitRadius = (typeof o.hitRadius === 'number' && o.hitRadius > 0)
      ? o.hitRadius : (def.hitRadius || 10);
    p.critBonus = (typeof o.crit === 'number' && o.crit > 0) ? o.crit : 0;
    p.color = (typeof o.color === 'string' && o.color) ? o.color
            : (Array.isArray(o.colors) && typeof o.colors[0] === 'string') ? o.colors[0]
            : def.color;
    p.fire = false;
    p.hits.length = 0;
    liveCount++;
    if (TC.Events && typeof TC.Events.emit === 'function' &&
        TC.Events.EVENT && TC.Events.EVENT.ProjectileSpawned) {
      try { TC.Events.emit(TC.Events.EVENT.ProjectileSpawned, { type: type, x: x, y: y, angle: angle }); } catch (e) {}
    }
    return p;
  }

  // ---- tile collision ----
  // Axis-separated integration with optional bouncing. Returns false when
  // the projectile died this step. Grenades never die from tiles (fuse-bound).
  function moveWithTiles(p, dt) {
    const rest = p.def.restitution || 0;

    if (p.vx !== 0) {
      const nx = p.x + p.vx * dt;
      const probeX = nx + (p.vx > 0 ? PROBE : -PROBE);
      if (solidPx(probeX, p.y)) {
        if (p.bounces > 0) { p.bounces--; p.vx = -p.vx * rest; }
        else if (p.def.stick) { stickDart(p); return true; }
        else if (p.type === 'yoyo') { p.state = 1; p.hits.length = 0; } // wall: reel back
        else { deactivate(p); return false; }
      } else {
        p.x = nx;
      }
    }

    if (p.vy !== 0) {
      const ny = p.y + p.vy * dt;
      const probeY = ny + (p.vy > 0 ? PROBE : -PROBE);
      if (solidPx(p.x, probeY)) {
        if (p.bounces > 0) { p.bounces--; p.vy = -p.vy * rest; }
        else if (p.def.stick) { stickDart(p); return true; }
        else if (p.type === 'yoyo') { p.state = 1; p.hits.length = 0; }
        else { deactivate(p); return false; }
      } else {
        p.y = ny;
      }
    }
    return true;
  }

  // Wire dart nails into the wall it struck; keeps damaging while stuck.
  function stickDart(p) {
    p.state = 2;
    p.timer = p.def.stick || 0.3;
    p.vx = 0; p.vy = 0;
    sparks(p.x, p.y);
  }

  // ---- explosions ----
  // Radial damage with linear falloff, particles, flash + light hook.
  // Deliberately hits enemies only (no player damage, no tile destruction —
  // world.set cascades are too risky from a projectile pass).
  function detonate(cx, cy, dmg, kb, ex, critBonus) {
    const radius = ex ? ex.radius : 48;
    const mul = ex ? ex.dmgMul : 1;

    if (TC.Enemies && TC.Enemies.list && typeof TC.Enemies.damageEnemy === 'function') {
      const list = TC.Enemies.list;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e.hp <= 0) continue;
        const dx = e.x + e.w / 2 - cx, dy = e.y + e.h / 2 - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius + Math.max(e.w, e.h) / 2) continue;
        const falloff = 1 - clamp(dist / radius, 0, 1) * 0.6;
        const roll = rollDamage(dmg * mul * falloff, critBonus);
        TC.Enemies.damageEnemy(e, roll.dmg, dx >= 0 ? 1 : -1, kb, roll.crit);
      }
    }

    pBurst(cx, cy, 24, ['#ff8c3a', '#ffd76a', '#e85a1a'],
      { speed: 190, life: 0.6, size: 3.5, gravity: 260 });
    flashes.push({ x: cx, y: cy, t: 0, dur: 0.28, intensity: 1, radius: radius });
    sfx('break');                              // closest existing noise burst
  }

  function explode(p) {
    detonate(p.x, p.y, p.dmg, p.kb, p.def.explode, p.critBonus);
    deactivate(p);
  }

  // Public variant for callers that just want a detonation at a spot.
  function explodeAt(x, y, dmg, radius) {
    detonate(x, y, dmg || 10, 6, { radius: radius || 52, dmgMul: 1 });
  }

  // ---- enemy hits ----
  // Test point trails the velocity for tipped types (arrow), else the center.
  function hitEnemies(p) {
    if (!TC.Enemies || !TC.Enemies.list ||
        typeof TC.Enemies.damageEnemy !== 'function') return;
    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
    const ux = p.vx / sp, uy = p.vy / sp;
    const tx = p.x + ux * (p.def.len || 0);
    const ty = p.y + uy * (p.def.len || 0);

    // purge dead refs so pierce budgets free up as enemies die
    for (let k = p.hits.length - 1; k >= 0; k--) {
      if (!p.hits[k] || p.hits[k].hp <= 0) p.hits.splice(k, 1);
    }

    const list = TC.Enemies.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.hp <= 0) continue;
      if (p.hits.indexOf(e) >= 0) continue;
      if (distToRect(tx, ty, e.x, e.y, e.w, e.h) > p.hitRadius) continue;

      if (p.type === 'grenade') { explode(p); return; }   // contact detonation
      const roll = rollDamage(p.dmg, p.critBonus);
      TC.Enemies.damageEnemy(e, roll.dmg, p.vx >= 0 ? 1 : -1, p.kb, roll.crit);
      p.hits.push(e);

      if (p.pierce === 0) {
        if (p.def.len > 0) sparks(tx, ty);
        deactivate(p);
        return;
      }
      if (p.pierce > 0) p.pierce--;
    }
  }

  // ---- per-type motion ----
  function stepBallistic(p, dt) {
    p.vy += p.gravity * dt;
    moveWithTiles(p, dt);
  }

  function stepStraight(p, dt) {
    if (p.state === 2) {                          // stuck dart: quiver out
      p.timer -= dt;
      if (p.timer <= 0) deactivate(p);
      return;
    }
    if (p.def.homing > 0) {
      const target = nearestEnemy(p.x, p.y, p.def.homingRange || 140, p.hits);
      if (target) {
        const cur = Math.atan2(p.vy, p.vx);
        let da = Math.atan2(target.y + target.h / 2 - p.y,
                            target.x + target.w / 2 - p.x) - cur;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        const turn = clamp(da, -p.def.homing * dt, p.def.homing * dt);
        const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        p.vx = Math.cos(cur + turn) * spd;
        p.vy = Math.sin(cur + turn) * spd;
      }
    }
    if (p.accel > 0) {                            // scythe-style speed-up along heading
      const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
      const ns = Math.min(p.maxSpeed || sp, sp + p.accel * dt);
      p.vx = p.vx / sp * ns;
      p.vy = p.vy / sp * ns;
    }
    moveWithTiles(p, dt);
  }

  function stepYoyo(p, dt) {
    const owner = p.owner;
    if (!owner || owner.dead) { deactivate(p); return; }
    const ox = owner.x + owner.w / 2, oy = owner.y + owner.h / 2;

    if (p.state === 0) {                          // extending
      const dx = p.x - ox, dy = p.y - oy;
      if (dx * dx + dy * dy >= p.def.maxDist * p.def.maxDist) {
        p.state = 1;                              // string taut: reel back
        p.hits.length = 0;
      } else {
        moveWithTiles(p, dt);                     // wall hit flips state to 1
        if (!p.active) return;
        if (p.state === 1) p.hits.length = 0;     // fresh hits on the way home
      }
    } else {                                      // returning (ignores tiles)
      const dx = ox - p.x, dy = oy - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 14) { deactivate(p); return; }
      const spd = p.def.speed * 1.15;
      p.vx = dx / dist * spd;
      p.vy = dy / dist * spd;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // periodic re-hit: clear hit memory on the yoyo cadence
    p.timer += dt;
    if (p.timer >= (p.def.rehit || 0.45)) {
      p.timer = 0;
      p.hits.length = 0;
    }
  }

  function stepBoomerang(p, dt) {
    if (p.state === 0) {                          // outbound: decelerate
      const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const next = spd - (p.accel || 900) * dt;
      if (next <= 40) {
        p.state = 1;                              // stall: come back
        p.hits.length = 0;                        // can hit again on return
      } else {
        p.vx *= next / spd;
        p.vy *= next / spd;
      }
      if (p.active && !moveWithTiles(p, dt)) return;
    } else {                                      // returning (ignores tiles)
      const owner = p.owner;
      if (!owner || owner.dead) { deactivate(p); return; }
      const dx = owner.x + owner.w / 2 - p.x;
      const dy = owner.y + owner.h / 2 - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const spd = Math.min((p.def.speed || 330) * 1.15,
                           Math.sqrt(p.vx * p.vx + p.vy * p.vy) + (p.accel || 900) * dt);
      p.vx = dx / dist * spd;
      p.vy = dy / dist * spd;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (dist < 16) { deactivate(p); return; }
    }
  }

  // ---- per-frame update ----
  function update(dt) {
    lights.length = 0;

    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const p = pool[i];
      if (!p.active) continue;
      const def = p.def;

      p.age += dt;
      p.spin += dt * (p.type === 'boomerang' ? 18 : p.type === 'yoyo' ? 10 : 0);

      // lifetime / fuse (yoyo maxAge is a wedge-safety net only)
      if (p.type === 'grenade') {
        if (p.age >= p.maxAge) { explode(p); continue; }
      } else if (p.age > p.maxAge) {
        deactivate(p);
        continue;
      }

      // motion + tiles
      if (def.motion === 'ballistic') stepBallistic(p, dt);
      else if (def.motion === 'straight') stepStraight(p, dt);
      else if (def.motion === 'yoyo') stepYoyo(p, dt);
      else if (def.motion === 'boomerang') stepBoomerang(p, dt);
      if (!p.active) continue;

      // world-bounds safety net
      const w = TC.world;
      if (w) {
        const hiX = w.width * TC.CONST.TS + BOUND_MARGIN;
        const hiY = w.height * TC.CONST.TS + BOUND_MARGIN;
        if (p.x < -BOUND_MARGIN || p.x > hiX || p.y < -800 || p.y > hiY) {
          deactivate(p);
          continue;
        }
      }

      // enemy hits
      hitEnemies(p);
      if (!p.active) continue;

      // glowing trails (throttled; timer stays owned by the motion code)
      if (def.light > 0 && p.state !== 2) {
        if (Math.random() < 0.35) {
          pBurst(p.x, p.y, 1, [p.color, '#ffffff'],
            { speed: 18, life: 0.3, size: 2, gravity: 0 });
        }
      }

      // lighting hook entry
      if (def.light > 0) {
        lights.push({
          x: p.x, y: p.y,
          intensity: def.light,
          radius: 40 + def.light * 70
        });
      }
    }

    // explosion flashes decay and feed the same light hook
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.t += dt;
      if (f.t >= f.dur) { flashes.splice(i, 1); continue; }
      lights.push({
        x: f.x, y: f.y,
        intensity: f.intensity * (1 - f.t / f.dur),
        radius: f.radius
      });
    }
  }

  // ---- drawing ----
  function drawArrow(c, p) {
    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
    const ux = p.vx / sp, uy = p.vy / sp;
    const tipX = p.x + ux * 13, tipY = p.y + uy * 13;
    const px = -uy, py = ux;                     // perpendicular

    c.strokeStyle = '#8a5a32';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(p.x, p.y);
    c.lineTo(tipX, tipY);
    c.stroke();

    c.fillStyle = '#c0c0cc';
    c.beginPath();
    c.moveTo(tipX + ux * 3, tipY + uy * 3);
    c.lineTo(tipX + px * 2, tipY + py * 2);
    c.lineTo(tipX - px * 2, tipY - py * 2);
    c.closePath();
    c.fill();

    c.strokeStyle = '#d84a4a';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(p.x + px * 2.5, p.y + py * 2.5);
    c.lineTo(p.x - ux * 3, p.y - uy * 3);
    c.lineTo(p.x - px * 2.5, p.y - py * 2.5);
    c.stroke();
  }

  function drawGlow(c, p) {
    const col = p.color || p.def.color;
    const r = 9 + p.def.light * 22;
    c.save();
    c.globalCompositeOperation = 'lighter';
    const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    g.addColorStop(0, hexA(col, 0.5));
    g.addColorStop(1, hexA(col, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(p.x, p.y, r, 0, TAU);
    c.fill();
    c.restore();
  }

  function drawBolt(c, p) {
    const ang = Math.atan2(p.vy, p.vx);
    c.save();
    c.translate(p.x, p.y);
    c.rotate(ang);
    c.fillStyle = p.color || p.def.color;
    c.beginPath();
    c.ellipse(0, 0, 8, 3.2, 0, 0, TAU);
    c.fill();
    c.fillStyle = '#ffffff';
    c.beginPath();
    c.arc(2, 0, 2.2, 0, TAU);
    c.fill();
    c.restore();
  }

  function drawYoyo(c, p) {
    const owner = p.owner;
    if (owner) {                                 // string
      c.strokeStyle = 'rgba(230,225,210,0.85)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(owner.x + owner.w / 2, owner.y + owner.h / 2);
      c.lineTo(p.x, p.y);
      c.stroke();
    }
    c.save();
    c.translate(p.x, p.y);
    c.rotate(p.spin);
    c.fillStyle = p.color || p.def.color;
    c.beginPath();
    c.arc(0, 0, 7, 0, TAU);
    c.fill();
    c.fillStyle = '#f2e8ee';
    c.beginPath();
    c.arc(0, 0, 3, 0, TAU);
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 1.5;
    c.beginPath();                               // spinning cross slots
    c.moveTo(-6, 0); c.lineTo(6, 0);
    c.moveTo(0, -6); c.lineTo(0, 6);
    c.stroke();
    c.restore();
  }

  function drawBoomerang(c, p) {
    c.save();
    c.translate(p.x, p.y);
    c.rotate(p.spin);
    c.fillStyle = p.color || p.def.color;
    c.fillRect(-11, -2.5, 22, 5);                // two crossed wooden arms
    c.fillRect(-2.5, -11, 5, 22);
    c.fillStyle = '#c99b62';                     // leading-edge highlight
    c.fillRect(-11, -2.5, 22, 1.5);
    c.fillRect(-2.5, -11, 1.5, 22);
    c.restore();
  }

  function drawGrenade(c, p) {
    c.fillStyle = p.color || p.def.color;
    c.beginPath();
    c.arc(p.x, p.y, 5, 0, TAU);
    c.fill();
    c.strokeStyle = '#20261c';
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = '#20261c';
    c.fillRect(p.x - 1, p.y - 7, 2, 3);          // fuse cap
    const blink = 0.5 + 0.5 * Math.sin(p.age * (10 + p.age * 14));
    c.fillStyle = 'rgba(255,' + (120 + blink * 100 | 0) + ',40,' + (0.4 + blink * 0.6) + ')';
    c.beginPath();
    c.arc(p.x, p.y - 7, 1.8, 0, TAU);            // sparking fuse
    c.fill();
  }

  function drawStar(c, p) {
    const ang = Math.atan2(p.vy, p.vx);
    c.save();
    c.translate(p.x, p.y);
    // streak opposite travel
    c.strokeStyle = hexA(p.color || p.def.color, 0.55);
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-Math.cos(ang) * 16, -Math.sin(ang) * 16);
    c.lineTo(0, 0);
    c.stroke();
    c.rotate(p.age * 9);
    const r = 7 + Math.sin(p.age * 20) * 1.2;    // twinkle
    c.fillStyle = '#fff6c8';
    c.beginPath();
    for (let k = 0; k < 8; k++) {                // 4-point star path
      const rr = (k % 2 === 0) ? r : r * 0.38;
      const a = k * Math.PI / 4;
      const fx = Math.cos(a) * rr, fy = Math.sin(a) * rr;
      if (k === 0) c.moveTo(fx, fy); else c.lineTo(fx, fy);
    }
    c.closePath();
    c.fill();
    c.restore();
  }

  function drawDart(c, p) {
    const ang = (p.state === 2) ? p.spin : Math.atan2(p.vy, p.vx);
    c.save();
    c.translate(p.x, p.y);
    c.rotate(ang);
    c.strokeStyle = hexA(p.color || p.def.color, 0.5);      // energy trail
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-14, 0);
    c.lineTo(-4, 0);
    c.stroke();
    c.fillStyle = '#d8d8e2';
    c.fillRect(-4, -1.5, 8, 3);                  // needle body
    c.fillStyle = p.color || p.def.color;
    c.fillRect(4, -1.5, 3, 3);                   // tip
    c.restore();
  }

  const PAINTERS = {
    arrow: drawArrow,
    magic_bolt: drawBolt,
    yoyo: drawYoyo,
    boomerang: drawBoomerang,
    grenade: drawGrenade,
    falling_star: drawStar,
    wire_dart: drawDart
  };

  // World-space; main.js calls Combat.draw inside the camera transform, and
  // combat.js forwards here. Applies its own transform like other drawers.
  function draw(ctx, cam) {
    if (!liveCount) return;
    ctx.save();
    if (typeof TC.applyCam === 'function') TC.applyCam(ctx);
    else if (cam) ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);

    let vw = 0, vh = 0;
    if (TC.canvas) {
      const z = cam ? cam.zoom : 1;
      vw = TC.canvas.width / z;
      vh = TC.canvas.height / z;
    }
    const vx0 = (cam ? cam.x : 0) - CULL, vy0 = (cam ? cam.y : 0) - CULL;
    const vx1 = vx0 + vw + CULL * 2, vy1 = vy0 + vh + CULL * 2;

    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const p = pool[i];
      if (!p.active) continue;
      if (vw && (p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1)) continue;
      if (p.def.light > 0) drawGlow(ctx, p);
      const paint = PAINTERS[p.type];
      if (paint) paint(ctx, p);
    }

    // explosion flash rings
    for (let i = 0; i < flashes.length; i++) {
      const f = flashes[i];
      const k = f.t / f.dur;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = '#ffb03a';
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.radius * (0.4 + k * 0.6), 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();
  }

  // ---- misc API ----

  // O(1) active count maintained by spawn/deactivate.
  function activeCount() { return liveCount; }

  // Backward-compat view: live projectiles of `type`, sharing pool objects.
  // The returned scratch array is reused between calls — read it, don't hold it.
  function viewOf(type) {
    viewScratch.length = 0;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const p = pool[i];
      if (p.active && p.type === type) viewScratch.push(p);
    }
    return viewScratch;
  }

  function clear() {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const p = pool[i];
      p.active = false;
      p.hits.length = 0;
    }
    liveCount = 0;
    lights.length = 0;
    flashes.length = 0;
    cursor = 0;
  }

  // Canonical "wipe every projectile" entry point (world transitions,
  // player death). Alias of clear(); kept as a distinct name so callers can
  // express intent and legacy arrow arrays can be flushed alongside.
  const clearAll = clear;

  TC.Projectiles = {
    MAX: MAX_PROJECTILES,
    pool: pool,
    list: pool,          // parity with Enemies.list; entries carry .active
    TYPES: TYPES,
    lights: lights,      // dynamic-light hook; prefer getLights()
    getLights: function () { return lights; },
    spawn: spawn,
    update: update,
    draw: draw,
    clear: clear,
    clearAll: clearAll,
    activeCount: activeCount,
    viewOf: viewOf,
    rollDamage: rollDamage,
    explodeAt: explodeAt
  };
})();
