/* combat.js — CANONICAL combat-hit resolution (W12) + melee arc strikes +
   arrows facade (delegated to TC.Projectiles) + player damage intake.

   One authority for damage math: TC.Combat.resolveHit(spec) computes a hit
   from a declarative spec and mutates nothing. Every damaging pathway
   (melee arcs, pooled projectiles, magic weapons, trap darts, explosions)
   routes through it, and TC.Enemies.damageEnemy applies the FINAL number
   (defense/class/variance/crit/mitigation were already resolved here).

   Spec fields (all optional unless noted):
     base        required number > 0 — unscaled damage
     cls         'generic'|'melee'|'ranged'|'magic'|'summon' (default generic)
     attacker    source entity; player-owned attacks scale through TC.Stats
                 (class multiplier + critChance). Any other source deals its
                 declared base untouched — bosses/traps never inherit the
                 player's gear stats.
     target      victim entity; reads its defense + registered mitigation
     mult        extra multiplier (explosion falloff etc.), default 1
     pen         flat defense penetration
     kb          knockback power carried onto the result
     critBonus   +flat crit chance on top of the attacker snapshot
     critMul     crit damage multiplier (default 2)
     variance    override CONST.DMG_VARIANCE; noVariance disables rolling
     rng         injectable RNG () => [0,1) — deterministic test seam
                 (default Math.random). Used for BOTH variance and crit.
     stats       pre-resolved stat snapshot (skips TC.Stats.resolve)
     defense     explicit target defense override
     environmental true bypasses defense entirely (see ENVIRONMENTAL below)
     statuses    [{id,dur}] the caller intends to apply on a landed hit
     source      string tag echoed onto the result (events/policies)

   Result: { ok, damage, crit, kb, cls, source, defenseApplied, mitigated,
             statuses, rejected } — damage is FINAL (>= 1 minimum).
   rejected is null here; intake-side gates (player i-frames/dead) report
   through hurtPlayer's result instead.

   Mitigation registry: content modules contribute target-side damage
   policies via TC.Combat.registerMitigation(key, fn(target)->mult) keyed by
   ENEMY_DEFS[].ai or type (registered through TC.Systems.boot tasks so load
   order never matters; see enemies.js). This replaces per-pathway special
   cases — Skeletron's hands-alive skull resist lives there, nowhere else.

   Environmental policy: intake sources named in ENVIRONMENTAL bypass
   defense (fall, void — falling/void can't be armored away). Lava/drown/
   shockwave/enemy contact remain ordinary defended intake; lava inflicts
   the status declared by TC.Buffs.statusForSource('lava') (accessories.js
   owns that mapping) rather than combat hardcoding an effect id.

   Events: EntityDamaged/EntityKilled/BossDefeated are emitted exactly once,
   at the single application site (Enemies.damageEnemy / killEnemy) — never
   here. Death occurs exactly once (hp<=0 guard).

   Foundation contracts: Combat.clear() wipes the TC.Projectiles pool (plus
   the legacy fallback), WorldLoaded clears stale projectiles, and the tick
   is registered with TC.Systems phase 'combat' system 'core.combat'. */
'use strict';
(function () {
  const TC = window.TC;

  const TAU = Math.PI * 2;
  const ARROW_GRAVITY = 900;   // px/s^2 (legacy fallback only)
  const ARROW_MAX_AGE = 3;     // s before despawn
  const ARROW_HIT_RADIUS = 12; // px around tip that damages an enemy
  const ARROW_LEN = 13;        // visual px from tail to tip
  const ARROW_KB = 3;          // knockback power dealt by arrows

  // Intake sources that bypass player defense. Everything else (enemy
  // contact, boss shots, lava burns, drowning, shockwaves, trap darts) is
  // reduced by equipment defense like any ordinary hit.
  const ENVIRONMENTAL = { fall: true, void: true };

  // Damage-class registry. statField names the TC.Stats snapshot field that
  // scales the class; summon/future classes plug in by adding a row (and a
  // matching stats.js contributor) — no resolver rewrite.
  const DAMAGE_CLASSES = Object.freeze({
    generic: { id: 'generic', statField: null },
    melee:   { id: 'melee',   statField: 'meleeDamage' },
    ranged:  { id: 'ranged',  statField: 'rangedDamage' },
    magic:   { id: 'magic',   statField: 'magicDamage' },
    summon:  { id: 'summon',  statField: 'summonDamage' },
  });

  const Combat = {};
  TC.Combat = Combat;

  Combat.DAMAGE_CLASSES = DAMAGE_CLASSES;
  Combat.ENVIRONMENTAL_SOURCES = Object.freeze(['fall', 'void']);

  // ---- target-side mitigation registry ----------------------------------

  // key -> fn(target) -> positive multiplier (<1 reduces damage)
  const MITIGATIONS = new Map();

  // Register a target mitigation policy under an ai name or enemy type.
  // Re-registering replaces (idempotent boot tasks are welcome).
  Combat.registerMitigation = function (key, fn) {
    if ((typeof key !== 'string' || !key) || typeof fn !== 'function') return false;
    MITIGATIONS.set(key, fn);
    return true;
  };

  function mitigationFor(target) {
    if (!target) return null;
    const ai = target.def && target.def.ai;
    return (ai && MITIGATIONS.get(ai)) || (target.type && MITIGATIONS.get(target.type)) || null;
  }

  function targetDefenseOf(target) {
    if (!target) return 0;
    if (target.def && typeof target.def.defense === 'number' && target.def.defense > 0) {
      return target.def.defense;
    }
    if (typeof target.totalDefense === 'function') {
      try { const d = target.totalDefense(); return (d > 0) ? d : 0; } catch (e) {}
    }
    return 0;
  }

  function safeStats(attacker) {
    if (!TC.Stats || typeof TC.Stats.resolve !== 'function') return null;
    try { return TC.Stats.resolve(attacker) || null; } catch (e) { return null; }
  }

  // ---- canonical resolution ---------------------------------------------

  // Pure computation: no hp writes, no events, no particles. Deterministic
  // when callers inject spec.rng.
  Combat.resolveHit = function (spec) {
    const o = spec || {};
    const fail = function (reason) {
      return { ok: false, reason: reason, damage: 0, crit: false, kb: 0,
               cls: 'generic', source: o.source || null, defenseApplied: 0,
               mitigated: null, statuses: [], rejected: null };
    };
    const base = Number(o.base);
    if (!isFinite(base) || base <= 0) return fail('invalid-base');

    const rng = (typeof o.rng === 'function') ? o.rng : Math.random;
    const clsId = DAMAGE_CLASSES[o.cls] ? o.cls : 'generic';
    const clsDef = DAMAGE_CLASSES[clsId];
    const attacker = o.attacker || null;
    const target = o.target || null;

    // Class-aware scaling ONLY for attacks owned by the local player.
    const isPlayerAttack = !!(attacker && TC.player && attacker === TC.player);
    let stats = null;
    if (isPlayerAttack) stats = o.stats || safeStats(TC.player);

    let mul = (typeof o.mult === 'number' && o.mult > 0) ? o.mult : 1;
    if (isPlayerAttack && clsDef.statField && stats) {
      const f = stats[clsDef.statField];
      if (typeof f === 'number' && f > 0) mul *= f;
    }

    // Variance: uniform +/-v around the scaled base.
    let v = (TC.CONST && TC.CONST.DMG_VARIANCE) || 0;
    if (o.noVariance) v = 0;
    else if (typeof o.variance === 'number' && o.variance >= 0) v = o.variance;
    let dmg = base * mul * (1 - v + rng() * 2 * v);

    // Crit: attacker snapshot chance (already includes the CONST base) plus
    // any per-hit bonus; non-player attacks never crit.
    let critChance = 0;
    if (isPlayerAttack) {
      critChance = stats ? (stats.critChance ||
        ((TC.CONST && TC.CONST.CRIT_CHANCE) || 0)) : ((TC.CONST && TC.CONST.CRIT_CHANCE) || 0);
    }
    if (typeof o.critBonus === 'number' && o.critBonus > 0) critChance += o.critBonus;
    const critMul = (typeof o.critMul === 'number' && o.critMul > 0) ? o.critMul : 2;
    const crit = critChance > 0 && rng() < Math.min(1, critChance);
    if (crit) dmg *= critMul;

    // Target mitigation policies (content-contributed, e.g. Skeletron's
    // protected skull while a hand lives).
    let mitigated = null;
    if (target) {
      const pol = mitigationFor(target);
      if (pol) {
        let m = 1;
        try { m = pol(target); } catch (e) { m = 1; }
        if (typeof m === 'number' && isFinite(m) && m > 0 && m < 1) {
          dmg *= m;
          mitigated = m;
        }
      }
    }

    // Defense: skipped for environmental sources; pen pierces flat amounts;
    // final damage never drops below 1. The scaled roll is rounded BEFORE
    // defense (legacy rollDamage/damageEnemy granularity), and defense that
    // would be wasted by the 1-damage floor is not counted as applied.
    let defenseApplied = 0;
    if (!o.environmental) {
      dmg = Math.round(dmg);
      const def = (typeof o.defense === 'number' && o.defense > 0)
        ? o.defense : targetDefenseOf(target);
      const pen = (typeof o.pen === 'number' && o.pen > 0) ? o.pen : 0;
      const effective = Math.max(0, def - pen);
      defenseApplied = Math.min(effective, Math.max(0, dmg - 1));
      dmg -= defenseApplied;
    }

    const damage = Math.max(1, Math.round(dmg));
    return {
      ok: true, damage, crit,
      kb: (typeof o.kb === 'number') ? o.kb : 0,
      cls: clsId, source: o.source || null,
      defenseApplied, mitigated,
      statuses: Array.isArray(o.statuses) ? o.statuses.slice() : [],
      rejected: null,
    };
  };

  // Resolve + apply to an enemy in one step. Returns the result, or null
  // when the target/application layer is unavailable. Emits NO events here:
  // Enemies.damageEnemy stays the single event/death authority.
  Combat.hitEnemy = function (target, dir, spec) {
    if (!target || !TC.Enemies || typeof TC.Enemies.damageEnemy !== 'function') return null;
    const o = spec || {};
    const res = Combat.resolveHit(Object.assign({}, o, { target: target }));
    if (!res.ok) return res;
    TC.Enemies.damageEnemy(target, res.damage, dir >= 0 ? 1 : -1,
                           res.kb, res.crit);
    return res;
  };

  // ---- legacy arrow storage ---------------------------------------------
  // With TC.Projectiles present this is unused and Combat.arrows resolves
  // to a live view of pooled arrows instead.
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

  function normTau(a) {
    a %= TAU;
    return a < 0 ? a + TAU : a;
  }

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

  function playerStats() {
    return (TC.player) ? safeStats(TC.player) : null;
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
    const stats = playerStats();
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
      Combat.hitEnemy(e, dx >= 0 ? 1 : -1, {
        base: dmg, cls: 'melee', attacker: TC.player, stats: stats, kb: kb,
      });
      hits++;
    }
    if (hits > 0 && TC.Audio) TC.Audio.play('hit');
    return hits;
  };

  // Class scaling now happens at RESOLUTION time (arrow type carries
  // cls:'ranged'), so the projectile launches with its raw damage.
  Combat.shootArrow = function (x, y, angle, speed, dmg) {
    if (TC.Projectiles && typeof TC.Projectiles.spawn === 'function') {
      TC.Projectiles.spawn('arrow', x, y, angle, { speed: speed, dmg: dmg });
    } else {
      legacyArrows.push({
        x: x, y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        age: 0,
        dmg: dmg
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
    const stats = playerStats();
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
          Combat.hitEnemy(e, a.vx >= 0 ? 1 : -1, {
            base: a.dmg, cls: 'ranged', attacker: TC.player, stats: stats,
            kb: ARROW_KB,
          });
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

  // Incoming damage on the player through the canonical resolver. Returns
  // { finalDamage, defenseApplied, crit, rejected } or null when no player
  // exists. rejected === 'iframes' means the hit landed during invulnerability
  // (or post-death) and the player took nothing — the numbers are informational.
  Combat.hurtPlayer = function (dmg, kbx, kby, src, opts) {
    if (!TC.player || typeof TC.player.damage !== 'function') return null;
    const p = TC.player;
    const o = opts || {};
    const res = Combat.resolveHit({
      base: dmg,
      cls: o.cls || 'generic',
      attacker: o.attacker || null,   // non-player: no stat scaling/crit
      target: p,
      kb: 0,
      source: src || null,
      environmental: !!ENVIRONMENTAL[src],
      noVariance: !!o.noVariance,
      rng: o.rng,
      stats: o.stats || null,
      statuses: o.statuses || null,
    });
    if (!res.ok) {
      return { finalDamage: 0, defenseApplied: 0, crit: false, rejected: res.reason };
    }
    const out = {
      finalDamage: res.damage, defenseApplied: res.defenseApplied,
      crit: res.crit, rejected: null, cls: res.cls, source: res.source,
    };
    if (p.dead || p.iframes > 0) {
      out.rejected = 'iframes';
      return out;
    }
    p.damage(res.damage, kbx, kby, src);
    // Environmental status infliction via the accessories-owned mapping
    // (BUFF_DEFS[].fromSource) — combat never hardcodes effect ids.
    const st = (TC.Buffs && typeof TC.Buffs.statusForSource === 'function')
      ? TC.Buffs.statusForSource(src) : null;
    if (st && Array.isArray(res.statuses) && res.statuses.length === 0) {
      try { TC.Buffs.apply(st.id, st.dur); } catch (e) {}
    }
    for (let i = 0; i < res.statuses.length; i++) {
      const s = res.statuses[i];
      if (s && s.id && TC.Buffs) {
        try { TC.Buffs.apply(s.id, s.dur); } catch (e) {}
      }
    }
    if (TC.Audio) TC.Audio.play('hurt');
    return out;
  };

  // Radial ground-slam around (x,y): damages the player with linear falloff
  // to half damage at r, kicks them away, and throws a dust ring. Used by the
  // granite golem's slam attack and Moss Mother's root slam. Returns true
  // when the player was hit.
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
    const res = Combat.hurtPlayer(Math.max(1, Math.round(dmg * (0.5 + 0.5 * falloff))),
                                  dir * (kb || 240), -220, 'shockwave');
    return !!(res && !res.rejected);
  };

  // Wipe every projectile: the pooled pool first (arrows, bolts, grenades,
  // watchers' targets...), then the legacy fallback array.
  function clearAll() {
    if (TC.Projectiles && typeof TC.Projectiles.clear === 'function') {
      TC.Projectiles.clear();
    }
    legacyArrows.length = 0;
  }
  Combat.clear = clearAll;

  // Reaction: a freshly loaded world never inherits stale projectiles.
  if (TC.Events && typeof TC.Events.on === 'function' &&
      TC.Events.EVENT && TC.Events.EVENT.WorldLoaded) {
    TC.Events.on(TC.Events.EVENT.WorldLoaded, function () { clearAll(); });
  }

  // Foundation scheduler: expose the tick as a 'combat'-phase system. It
  // drives TC.Projectiles.update internally (see Combat.update), so exactly
  // ONE driver may be active — the scheduler is canonical. Gated to live
  // simulation (no projectile stepping on title / while paused).
  if (TC.Systems && typeof TC.Systems.register === 'function') {
    TC.Systems.register('combat', 'core.combat', {
      update: function (dt) { Combat.update(dt); }
    }, {
      when: function () { return TC.state === 'playing' && !(TC.UI && TC.UI.paused); }
    });
  }
})();
