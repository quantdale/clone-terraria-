/* combat.js — melee arc strikes, arrows (delegated to TC.Projectiles),
   player damage intake. The arrow lifecycle lives in projectiles.js's
   unified pool; the local array below is a fallback kept for the case
   where projectiles.js is absent, and Combat.arrows stays readable as a
   live view either way.

   Foundation contracts: Combat.clear() wipes the TC.Projectiles pool too
   (plus the legacy fallback), a WorldLoaded event subscription clears
   stale projectiles on world transitions, and the per-frame tick is
   registered with TC.Systems as phase 'combat' system 'core.combat'
   (guarded; main.js may keep calling Combat.update directly instead —
   never both). hurtPlayer returns { finalDamage, defenseApplied, crit }.
   Enemy-damage events (EntityDamaged/EntityKilled) belong at
   TC.Enemies.damageEnemy/killEnemy in enemies.js, where every source's
   damage funnels — not here, which only sees its own hits. */
'use strict';
(function () {
  const TC = window.TC;

  const TAU = Math.PI * 2;
  const ARROW_GRAVITY = 900;   // px/s^2 (legacy fallback only)
  const ARROW_MAX_AGE = 3;     // s before despawn
  const ARROW_HIT_RADIUS = 12; // px around tip that damages an enemy
  const ARROW_LEN = 13;        // visual px from tail to tip
  const ARROW_KB = 3;          // knockback power dealt by arrows

  const Combat = {};
  TC.Combat = Combat;

  // Legacy arrow storage. With TC.Projectiles present this is unused and
  // Combat.arrows resolves to a live view of pooled arrows instead.
  const legacyArrows = [];
  Object.defineProperty(Combat, 'arrows', {
    enumerable: true,
    get: function () {
      if (TC.Projectiles && typeof TC.Projectiles.viewOf === 'function') {
        return TC.Projectiles.viewOf('arrow');
      }
      return legacyArrows;
    }
  });

  // ---- helpers ----

  // Apply DMG_VARIANCE (uniform +/-v) then a crit double-damage roll.
  // Crit chance = CONST.CRIT_CHANCE + resolved player critChance contributions.
  // classMul scales by the resolver's damage-class multiplier (melee/ranged).
  function rollDamage(base, classMul) {
    const v = TC.CONST.DMG_VARIANCE || 0;
    // st.critChance from the resolver ALREADY includes the CONST.CRIT_CHANCE
    // base (stats.js finalize); adding the base again here inflated melee
    // crit odds by another absolute CRIT_CHANCE — only fall back to the bare
    // base when no resolver snapshot is available.
    let critChance = TC.CONST.CRIT_CHANCE || 0;
    let mul = (typeof classMul === 'number') ? classMul : 1;
    if (TC.Stats && typeof TC.Stats.resolve === 'function' && TC.player) {
      try {
        const st = TC.Stats.resolve(TC.player);
        if (st) {
          critChance = st.critChance || 0;
          mul *= 1;
        }
      } catch (e) {}
    }
    let d = base * mul * (1 - v + Math.random() * 2 * v);
    const crit = Math.random() < critChance;
    if (crit) d *= 2;
    return { dmg: Math.max(1, Math.round(d)), crit };
  }

  // Resolved damage-class multiplier for the local player (1 when unknown).
  function classMul(field) {
    if (!TC.Stats || typeof TC.Stats.resolve !== 'function' || !TC.player) return 1;
    try {
      const st = TC.Stats.resolve(TC.player);
      return (st && typeof st[field] === 'number' && st[field] > 0) ? st[field] : 1;
    } catch (e) { return 1; }
  }

  // Normalize an angle into [0, TAU).
  function normTau(a) {
    a %= TAU;
    return a < 0 ? a + TAU : a;
  }

  // Distance from a point to an axis-aligned rect (0 when inside).
  function distToRect(px, py, rx, ry, rw, rh) {
    const nx = Math.max(rx, Math.min(rx + rw, px));
    const ny = Math.max(ry, Math.min(ry + rh, py));
    const dx = px - nx, dy = py - ny;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function sparks(x, y) {
    if (TC.Particles && TC.Particles.burst) {
      TC.Particles.burst(x, y, 6, { colors: ['#ffd76a', '#e8a53a'], speed: 110 });
    }
  }

  // ---- public API ----

  // Hit each enemy whose center lies within r of (cx,cy) and whose angle from
  // the center falls in the sweep [a0..a1] (wraps through PI). An enemy is hit
  // at most once per swingId. Returns the number of enemies hit.
  Combat.meleeStrike = function (cx, cy, r, a0, a1, dmg, kb, swingId) {
    if (!TC.Enemies || !TC.Enemies.list ||
        typeof TC.Enemies.damageEnemy !== 'function') return 0;
    const span = normTau(a1 - a0);
    const fullCircle = span >= TAU - 1e-6;
    let hits = 0;
    const list = TC.Enemies.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.hp <= 0) continue;
      if (swingId != null && e.lastHitSwing === swingId) continue;
      const dx = e.x + e.w / 2 - cx;
      const dy = e.y + e.h / 2 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) continue;
      if (!fullCircle && dist > 0.001) {
        const off = normTau(Math.atan2(dy, dx) - a0);
        if (off > span) continue;
      }
      if (swingId != null) e.lastHitSwing = swingId;
      const roll = rollDamage(dmg, classMul('meleeDamage'));
      TC.Enemies.damageEnemy(e, roll.dmg, dx >= 0 ? 1 : -1, kb, roll.crit);
      hits++;
    }
    if (hits > 0 && TC.Audio) TC.Audio.play('hit');
    return hits;
  };

  Combat.shootArrow = function (x, y, angle, speed, dmg) {
    const eff = Math.round(dmg * classMul('rangedDamage'));
    if (TC.Projectiles && typeof TC.Projectiles.spawn === 'function') {
      TC.Projectiles.spawn('arrow', x, y, angle, { speed: speed, dmg: eff });
    } else {
      legacyArrows.push({
        x: x, y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        age: 0,
        dmg: eff
      });
    }
    if (TC.Audio) TC.Audio.play('swing'); // bow release shares the whoosh recipe
  };

  Combat.update = function (dt) {
    // Unified pool drives all projectiles; this hook keeps main.js unchanged.
    if (TC.Projectiles && typeof TC.Projectiles.update === 'function') {
      TC.Projectiles.update(dt);
      return;
    }
    const arrows = legacyArrows;
    for (let i = arrows.length - 1; i >= 0; i--) {
      const a = arrows[i];
      a.age += dt;
      a.vy += ARROW_GRAVITY * dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;

      const sp = Math.sqrt(a.vx * a.vx + a.vy * a.vy) || 1;
      const ux = a.vx / sp, uy = a.vy / sp;
      const tipX = a.x + ux * ARROW_LEN;
      const tipY = a.y + uy * ARROW_LEN;

      let dead = a.age > ARROW_MAX_AGE;

      if (!dead && TC.world && typeof TC.world.solidAtPixel === 'function' &&
          TC.world.solidAtPixel(tipX, tipY)) {
        sparks(tipX, tipY);
        dead = true;
      }

      if (!dead && TC.Enemies && TC.Enemies.list &&
          typeof TC.Enemies.damageEnemy === 'function') {
        const list = TC.Enemies.list;
        for (let j = 0; j < list.length; j++) {
          const e = list[j];
          if (!e || e.hp <= 0) continue;
          if (distToRect(tipX, tipY, e.x, e.y, e.w, e.h) > ARROW_HIT_RADIUS) continue;
          const roll = rollDamage(a.dmg);
          TC.Enemies.damageEnemy(e, roll.dmg, a.vx >= 0 ? 1 : -1, ARROW_KB, roll.crit);
          if (TC.Audio) TC.Audio.play('hit');
          dead = true;
          break;
        }
      }

      if (dead) arrows.splice(i, 1);
    }
  };

  // World-space. With TC.Projectiles present it renders every projectile
  // (arrows included); otherwise the legacy arrow painter runs.
  Combat.draw = function (ctx, cam) {
    if (TC.Projectiles && typeof TC.Projectiles.draw === 'function') {
      TC.Projectiles.draw(ctx, cam);
      return;
    }
    const arrows = legacyArrows;
    if (!arrows.length) return;
    TC.applyCam(ctx);
    for (let i = 0; i < arrows.length; i++) {
      const a = arrows[i];
      const sp = Math.sqrt(a.vx * a.vx + a.vy * a.vy) || 1;
      const ux = a.vx / sp, uy = a.vy / sp;
      const tipX = a.x + ux * ARROW_LEN, tipY = a.y + uy * ARROW_LEN;
      const px = -uy, py = ux; // perpendicular

      ctx.strokeStyle = '#8a5a32';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();

      ctx.fillStyle = '#c0c0cc';
      ctx.beginPath();
      ctx.moveTo(tipX + ux * 3, tipY + uy * 3);
      ctx.lineTo(tipX + px * 2, tipY + py * 2);
      ctx.lineTo(tipX - px * 2, tipY - py * 2);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = '#d84a4a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x + px * 2.5, a.y + py * 2.5);
      ctx.lineTo(a.x - ux * 3, a.y - uy * 3);
      ctx.lineTo(a.x - px * 2.5, a.y - py * 2.5);
      ctx.stroke();
    }
    TC.clearCam(ctx);
  };

  // Incoming damage on the player: variance only, no crits. Equipment defense
  // applies except for environmental 'fall'/'void' sources. Returns
  // { finalDamage, defenseApplied, crit: false } — the numbers actually passed
  // to Player.damage — or null when no player is present.
  Combat.hurtPlayer = function (dmg, kbx, kby, src) {
    if (!TC.player || typeof TC.player.damage !== 'function') return null;
    const v = TC.CONST.DMG_VARIANCE || 0;
    let final = Math.max(1, Math.round(dmg * (1 - v + Math.random() * 2 * v)));
    let defenseApplied = 0;
    if (src !== 'fall' && src !== 'void') {
      const defense = (typeof TC.player.totalDefense === 'function') ? TC.player.totalDefense() : 0;
      defenseApplied = Math.min(defense, final - 1);   // intake never drops below 1
      final = Math.max(1, final - defense);
    }
    TC.player.damage(final, kbx, kby, src);
    if (src === 'lava' && TC.Buffs && typeof TC.Buffs.apply === 'function') {
      try { TC.Buffs.apply('burning', 4); } catch (e) {}
    }
    if (TC.Audio) TC.Audio.play('hurt');
    return { finalDamage: final, defenseApplied: defenseApplied, crit: false };
  };

  // Radial ground-slam around (x,y): damages the player with linear falloff
  // to half damage at r, kicks them away, and throws a dust ring. Used by the
  // granite golem's slam attack. Returns true when the player was hit.
  Combat.shockwave = function (x, y, r, dmg, kb) {
    if (TC.Particles && TC.Particles.burst) {
      TC.Particles.burst(x, y, 18, {
        colors: ['#9aa8b4', '#6a7884', '#c8d2da'],
        speed: 150, life: 0.5, size: 3, gravity: 500
      });
    }
    const p = TC.player;
    if (!p || p.dead || typeof p.damage !== 'function') return false;
    const pcx = p.x + p.w / 2, pcy = p.y + p.h / 2;
    const dx = pcx - x, dy = pcy - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > r) return false;
    const falloff = 1 - d / r;                       // 1 at center, 0 at rim
    const dir = dx >= 0 ? 1 : -1;
    Combat.hurtPlayer(Math.max(1, Math.round(dmg * (0.5 + 0.5 * falloff))),
                      dir * (kb || 240), -220, 'shockwave');
    return true;
  };

  // Wipe every projectile: the pooled pool first (arrows, bolts, grenades,
  // watchers' targets...), then the legacy fallback array. The old body only
  // zeroed Combat.arrows — which with TC.Projectiles present is a reused
  // viewOf() scratch buffer, so pooled projectiles survived world changes.
  function clearAll() {
    if (TC.Projectiles && typeof TC.Projectiles.clear === 'function') {
      TC.Projectiles.clear();
    }
    legacyArrows.length = 0;
  }
  Combat.clear = clearAll;

  // Reaction: a freshly loaded world never inherits stale projectiles.
  // (main.js also calls Combat.clear() on newGame/continueGame; this is the
  // event-driven backstop, harmless when both run.)
  if (TC.Events && typeof TC.Events.on === 'function' &&
      TC.Events.EVENT && TC.Events.EVENT.WorldLoaded) {
    TC.Events.on(TC.Events.EVENT.WorldLoaded, function () { clearAll(); });
  }

  // Foundation scheduler: expose the tick as a 'combat'-phase system. It
  // drives TC.Projectiles.update internally (see Combat.update), so exactly
  // ONE of { Systems.updateAll, main.js's direct Combat.update call } may be
  // active at a time — running both would double-step every projectile.
  if (TC.Systems && typeof TC.Systems.register === 'function') {
    TC.Systems.register('combat', 'core.combat', {
      update: function (dt) { Combat.update(dt); }
    });
  }
})();
