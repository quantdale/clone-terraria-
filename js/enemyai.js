/* enemyai.js — TC.EnemyAI: reusable enemy behavior archetypes (W13).
   Extracted from enemies.js's runAI switch so that adding an enemy means
   authoring a def (enemydefs.js), selecting one of these behaviors, and only
   writing bespoke code when a design genuinely needs it. Pure decision code:
   each implementation receives (e, ctx, dt) — the entity, a per-tick context
   {clock} and the step delta — returns false to remove the enemy this frame.

   Ownership boundaries:
     - this module never mutates the enemy list or spawns directly: minions
       go through TC.Enemies.spawnServantOf, hostile shots register through
       TC.Enemies.trackHostileShot (enemies.js owns intake bookkeeping)
     - movement/collision stays in enemies.js (moveAndCollide); flyers list
       lives here (isFlyer) since it is an AI property consumed by physics
     - rendering is NOT here: enemies.js keeps procedural drawing

   Adding an archetype: write ai.<name>(e, ctx, dt) -> bool, then reference
   ai:'<name>' from an ENEMY_DEFS entry. Unknown names fall back to idle. */
'use strict';
(function () {
  window.TC = window.TC || {};
  const TC = window.TC;
  if (TC.EnemyAI) return;

  const ai = {};

  // ---- shared helpers (gameplay randomness rides the seeded GameRng 'ai'
  // stream so authoritative replay stays deterministic; W23) ----
  const util = {
    rand(a, b) { return a + TC.GameRng.stream('ai').float() * (b - a); },
    clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
    approach(v, target, rate, dt) { return v + (target - v) * Math.min(1, rate * dt); },
    hexA(hex, a) {
      const r = parseInt(hex.slice(1, 3), 16),
        g = parseInt(hex.slice(3, 5), 16),
        b = parseInt(hex.slice(5, 7), 16);
      return "rgba(" + r + "," + g + "," + b + "," + a + ")";
    },
    daylight() {
      return TC.Sky && typeof TC.Sky.daylight === "function"
        ? TC.Sky.daylight()
        : 1;
    },
    weightedPick(table) {
      let total = 0;
      for (let i = 0; i < table.length; i++) total += table[i][1];
      let r = TC.GameRng.stream('ai').float() * total;
      for (let i = 0; i < table.length; i++) {
        r -= table[i][1];
        if (r <= 0) return table[i][0];
      }
      return table[table.length - 1][0];
    },
    solidAt(tx, ty) {
      const w = TC.world;
      if (!w || typeof w.isSolid !== "function") return false;
      return !!w.isSolid(tx, ty);
    },
    rectSolid(x, y, w, h) {
      const ts = TC.CONST.TS;
      const x0 = Math.floor(x / ts),
        x1 = Math.floor((x + w - 0.01) / ts);
      const y0 = Math.floor(y / ts),
        y1 = Math.floor((y + h - 0.01) / ts);
      for (let ty = y0; ty <= y1; ty++)
        for (let tx = x0; tx <= x1; tx++)
          if (util.solidAt(tx, ty)) return true;
      return false;
    },
    // flyers ignore gravity and reflect off solids instead of stopping
    isFlyer(airName) {
      return (
        airName === "eye" ||
        airName === "bat" ||
        airName === "eye_boss" ||
        airName === "harpy" ||
        airName === "teleporter" ||
        airName === "storm_jelly" ||
        airName === "skeletron" ||
        airName === "skele_hand" ||
        airName === "hungry" ||
        airName === "wof"
      );
    },
  };

  const rand = util.rand,
    clamp = util.clamp,
    approach = util.approach,
    daylight = util.daylight,
    weightedPick = util.weightedPick,
    rectSolid = util.rectSolid;

  // ---- shared Underworld boundary (W19 truth-sync) ----
  // ONE authoritative query lives on TC.Biomes (pure, headless-safe); the
  // Wall lifecycle derives every depth decision from it so summon
  // validation, encounter confinement and spawn zoning can never disagree.
  function uwTopPx() {
    try {
      if (TC.Biomes && typeof TC.Biomes.underworldTopPx === "function")
        return TC.Biomes.underworldTopPx();
    } catch (err) {}
    return ((TC.CONST.GEN && TC.CONST.GEN.underworld && TC.CONST.GEN.underworld.startY) || 355) * TC.CONST.TS;
  }
  function isPlayerInUnderworld(p) {
    if (!p) return false;
    try {
      if (TC.Biomes && typeof TC.Biomes.isUnderworldAt === "function")
        return !!TC.Biomes.isUnderworldAt(p.x, p.y + p.h / 2);
    } catch (err) {}
    const curBiome = (TC.Biomes && TC.Biomes.current) ? TC.Biomes.current : null;
    const rawBiome = (TC.Biomes && TC.Biomes.raw) ? TC.Biomes.raw : null;
    return curBiome === "underworld" || rawBiome === "underworld" ||
      p.y + p.h / 2 >= uwTopPx() - 2 * TC.CONST.TS;
  }

  // Minion shedding delegates to enemies.js, which owns the list, the
  // servant budget bookkeeping and safe placement.
  function spawnServantOf(boss, type, bx, by) {
    if (!TC.Enemies || typeof TC.Enemies.spawnServantOf !== "function") {
      return null;
    }
    return TC.Enemies.spawnServantOf(boss, type, bx, by);
  }

  // Contact-damage knockback profile shared with enemies.js's touch pass.
  const TOUCH_KB_X = 210,
    TOUCH_KB_Y = -190;

  // ---- attack effect helpers ----

  function puffAt(x, y, colors) {
    if (TC.Particles && typeof TC.Particles.burst === "function") {
      try {
        TC.Particles.burst(x, y, 10, {
          colors: colors,
          speed: 120,
          life: 0.45,
          size: 2.5,
          gravity: 0,
        });
      } catch (err) {}
    }
  }

  // Storm Jelly attack cadence per phase (seconds between attacks).
  function jellyCycle(ph) {
    return ph === 1 ? rand(2.6, 3.6) : ph === 2 ? rand(1.8, 2.6) : rand(1.4, 2.1);
  }

  function dropLightning(e) {
    if (!(TC.Projectiles && typeof TC.Projectiles.spawn === "function")) return;
    const dmg = Math.round(e.def.dmg * 0.85);
    const pr = TC.Projectiles.spawn(
      "falling_star",
      e.x + e.w / 2,
      e.y + e.h,
      Math.PI / 2, // straight down (+y)
      {
        owner: null,
        speed: 470,
        dmg: dmg,
        kb: 3,
        life: 2.2,
        hitRadius: 11,
        color: "#ffe98a",
      },
    );
    if (TC.Enemies && typeof TC.Enemies.trackHostileShot === "function") {
      TC.Enemies.trackHostileShot(pr, e, dmg);
    }
    puffAt(e.x + e.w / 2, e.y + e.h, ["#ffe98a", "#ffffff"]);
  }

  function sporeBreath(e) {
    if (!(TC.Projectiles && typeof TC.Projectiles.spawn === "function")) return;
    const f = e.facing || 1;
    const cx = e.x + e.w / 2 + f * e.w * 0.45,
      cy = e.y + e.h * 0.38;
    let base = f > 0 ? 0 : Math.PI;
    const pl = TC.player;
    if (pl && !pl.dead)
      base = Math.atan2(pl.y + pl.h / 2 - cy, pl.x + pl.w / 2 - cx);
    const n = 5 + Math.floor(TC.GameRng.stream('ai').float() * 3); // arc burst of 5-7 spores
    const dmg = Math.round(e.def.dmg * 0.55);
    for (let k = 0; k < n; k++) {
      const ang = base + (k / (n - 1) - 0.5) * 0.76;
      const pr = TC.Projectiles.spawn("magic_bolt", cx, cy, ang, {
        owner: null,
        speed: 290,
        dmg: dmg,
        kb: 2,
        life: 2.4,
        hitRadius: 9,
        color: "#8adf6a",
      });
      if (TC.Enemies && typeof TC.Enemies.trackHostileShot === "function") {
        TC.Enemies.trackHostileShot(pr, e, dmg);
      }
    }
    puffAt(cx, cy, ["#8adf6a", "#c8f0a8"]);
  }

  function shedSporelings(e, bx, by) {
    const n = 2 + (TC.GameRng.stream('ai').chance(0.5) ? 1 : 0); // 2-3 minions
    for (let k = 0; k < n; k++)
      TC.Enemies.spawnServantOf(e, "sporeling", bx, by);
  }

  // ---- archetype: slime ----
  ai["slime"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      if (e.onGround) {
        e.vx = approach(e.vx, 0, 10, dt);
        e.sitTimer -= dt;
        if (e.sitTimer <= 0 && p && !p.dead) {
          const dir = pcx >= ecx ? 1 : -1;
          e.facing = dir;
          e.vx = dir * rand(60, 120);
          e.vy = -rand(280, 360);
          e.sitTimer = rand(0.9, 1.8);
        }
      }
    return true;
  };

  // ---- archetype: zombie ----
  ai["zombie"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      if (daylight() > 0.5) {
        e.fade -= dt * 0.8; // dissolve in sunlight
        e.vx = approach(e.vx, 0, 10, dt);
        return e.fade > 0;
      }
      e.fade = 1;
      if (p && !p.dead) {
        const dir = pcx >= ecx ? 1 : -1;
        e.facing = dir;
        e.vx = approach(e.vx, dir * 55, 8, dt);
        if (e.onGround && e.hitWall) e.vy = -330; // auto-jump obstacles
      } else {
        e.vx = approach(e.vx, 0, 4, dt);
      }
    return true;
  };

  // ---- archetype: eye ----
  ai["eye"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      e.phase += dt * 3.2;
      if (p && !p.dead) {
        const dx = pcx - ecx,
          dy = pcy - ecy;
        const d = Math.hypot(dx, dy) || 1;
        const ACC = 340;
        e.vx += (dx / d) * ACC * dt;
        e.vy += (dy / d) * ACC * dt;
        // sine wobble: perpendicular acceleration gives weaving flight
        const wob = Math.sin(e.phase) * 240 * dt;
        e.vx += (-dy / d) * wob;
        e.vy += (dx / d) * wob;
        const sp = Math.hypot(e.vx, e.vy);
        if (sp > 170) {
          e.vx *= 170 / sp;
          e.vy *= 170 / sp;
        }
      } else {
        e.vx = approach(e.vx, 0, 1.5, dt);
        e.vy = approach(e.vy, 0, 1.5, dt);
      }
      e.facing = e.vx >= 0 ? 1 : -1;
    return true;
  };

  // ---- archetype: bat ----
  ai["bat"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      e.phase += dt * 5.5;
      e.jitterTimer -= dt;
      if (e.jitterTimer <= 0) {
        // sudden erratic course change
        e.jitterTimer = rand(1, 2);
        const ja = TC.GameRng.stream('ai').float() * Math.PI * 2;
        e.vx += Math.cos(ja) * rand(50, 110);
        e.vy += Math.sin(ja) * rand(50, 110);
      }
      if (p && !p.dead) {
        // chase a point circling the player, sine-weaved on both axes
        const oa = ctx.clock * 1.8 * e.orbitDir + e.phase * 0.3;
        const orbR = 56 + Math.sin(e.phase * 0.9) * 26;
        const gx = pcx + Math.cos(oa) * orbR;
        const gy =
          pcy + Math.sin(oa) * orbR * 0.6 + Math.sin(e.phase * 1.7) * 14;
        const dx = gx - ecx,
          dy = gy - ecy;
        const d = Math.hypot(dx, dy) || 1;
        e.vx += (dx / d) * 320 * dt;
        e.vy += (dy / d) * 320 * dt;
      } else {
        e.vx = approach(e.vx, 0, 1.2, dt);
        e.vy = approach(e.vy, 0, 1.2, dt);
      }
      const bsp = Math.hypot(e.vx, e.vy);
      if (bsp > 140) {
        e.vx *= 140 / bsp;
        e.vy *= 140 / bsp;
      }
      e.facing = e.vx >= 0 ? 1 : -1;
    return true;
  };

  // ---- archetype: walker ----
  ai["walker"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      // daylight-immune ground chaser (skeleton / granite golem / blood
      // crawler / wave 6-7 walkers), tuned by def.speed / def.jumpVel;
      // def.lunge adds a frost-wolf pounce, def.charge a rock-charger rush
      if (p && !p.dead) {
        const dir = pcx >= ecx ? 1 : -1;
        let target = e.def.speed || 55;
        if (e.def.lunge) {
          // frost wolf: bursts of extra vx when the player is close by
          e.atkTimer -= dt;
          if (
            e.atkTimer <= 0 &&
            Math.abs(pcx - ecx) < 9 * TC.CONST.TS &&
            Math.abs(pcy - ecy) < 3 * TC.CONST.TS
          ) {
            e.atkTimer = rand(1.8, 3);
            e.vx = dir * (target + (e.def.lungeBoost || 90));
          }
        }
        if (
          e.def.charge &&
          Math.abs(pcy - ecy) < 2.5 * TC.CONST.TS &&
          Math.abs(pcx - ecx) < 12 * TC.CONST.TS
        ) {
          target = e.def.chargeSpeed || 220; // straight-line rush, capped
        }
        e.facing = dir;
        e.vx = approach(e.vx, dir * target, 8, dt);
        if (e.onGround && e.hitWall) e.vy = -(e.def.jumpVel || 330);
      } else {
        e.vx = approach(e.vx, 0, 4, dt);
      }
      // granite golem: ground-slam shockwave when the player is close
      if (e.def.look === "golem") {
        e.atkTimer -= dt;
        if (
          e.atkTimer <= 0 &&
          p &&
          !p.dead &&
          Math.abs(pcx - ecx) < 3 * TC.CONST.TS &&
          Math.abs(pcy - ecy) < 2.5 * TC.CONST.TS
        ) {
          e.atkTimer = rand(2.5, 4);
          if (TC.Combat && typeof TC.Combat.shockwave === "function") {
            TC.Combat.shockwave(
              ecx,
              e.y + e.h,
              3.2 * TC.CONST.TS,
              e.def.dmg,
              260,
            );
          }
        }
      }
    return true;
  };

  // ---- archetype: harpy ----
  ai["harpy"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      // circles overhead, then telegraphs and dive-bombs through the player
      e.atkTimer -= dt;
      if (e.astate === "dive") {
        e.diveLeft -= dt;
        if (e.diveLeft <= 0) {
          e.astate = "idle";
          e.atkTimer = rand(2.5, 4);
        }
        return true;
      }
      if (e.astate === "telegraph") {
        e.teleTimer -= dt;
        e.vx = approach(e.vx, 0, 10, dt);
        e.vy = approach(e.vy, 0, 10, dt);
        if (e.teleTimer <= 0) {
          const dx = pcx - ecx,
            dy = pcy - ecy;
          const d = Math.hypot(dx, dy) || 1;
          e.vx = (dx / d) * 330;
          e.vy = (dy / d) * 330;
          e.diveLeft = 0.8;
          e.astate = "dive";
        }
        return true;
      }
      e.phase += dt * 4;
      if (p && !p.dead) {
        const oa = ctx.clock * 1.3 * e.orbitDir + e.phase * 0.3;
        const orbR = 90 + Math.sin(e.phase) * 20;
        const gx = pcx + Math.cos(oa) * orbR;
        const gy = pcy - 70 + Math.sin(oa) * orbR * 0.35;
        const dx = gx - ecx,
          dy = gy - ecy;
        const d = Math.hypot(dx, dy) || 1;
        e.vx += (dx / d) * 300 * dt;
        e.vy += (dy / d) * 300 * dt;
      } else {
        e.vx = approach(e.vx, 0, 1.2, dt);
        e.vy = approach(e.vy, 0, 1.2, dt);
      }
      const hsp = Math.hypot(e.vx, e.vy);
      if (hsp > 130) {
        e.vx *= 130 / hsp;
        e.vy *= 130 / hsp;
      }
      e.facing = e.vx >= 0 ? 1 : -1;
      if (e.atkTimer <= 0 && p && !p.dead) {
        e.astate = "telegraph";
        e.teleTimer = 0.45;
      }
    return true;
  };

  // ---- archetype: stationary ----
  ai["stationary"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      // rooted hazard (snapvine): cannot move; bites players in short
      // reach on a cooldown, with a brief telegraphed wind-up
      e.vx = 0;
      e.vy = 0;
      const inReach =
        p &&
        !p.dead &&
        Math.abs(pcx - ecx) < 3.2 * TC.CONST.TS &&
        Math.abs(pcy - ecy) < 2.6 * TC.CONST.TS;
      if (e.astate === "bite") {
        e.teleTimer -= dt;
        if (e.teleTimer <= 0) {
          e.astate = "idle";
          e.atkTimer = rand(1.6, 2.6);
          if (inReach) {
            const dir = pcx >= ecx ? 1 : -1;
            e.facing = dir;
            if (
              TC.Combat &&
              typeof TC.Combat.hurtPlayer === "function"
            ) {
              TC.Combat.hurtPlayer(
                e.def.dmg,
                dir * TOUCH_KB_X,
                TOUCH_KB_Y,
                e.def.name,
              );
            }
            puffAt(ecx + dir * 10, ecy, ["#4a9a3e", "#c8e8a0"]);
            if (TC.Audio) TC.Audio.play("hit");
          }
        }
        return true;
      }
      e.atkTimer -= dt;
      if (inReach && e.atkTimer <= 0) {
        e.astate = "bite";
        e.teleTimer = 0.32;
        e.facing = pcx >= ecx ? 1 : -1;
      }
    return true;
  };

  // ---- archetype: teleporter ----
  ai["teleporter"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      // void wisp: drifts like an eye but periodically blinks a short
      // distance toward the player in a puff of particles
      if (e.blinkTimer == null) e.blinkTimer = rand(2, 3.5);
      e.phase += dt * 3;
      e.blinkTimer -= dt;
      if (p && !p.dead) {
        const dx = pcx - ecx,
          dy = pcy - ecy;
        const d = Math.hypot(dx, dy) || 1;
        const ACC = 300;
        e.vx += (dx / d) * ACC * dt;
        e.vy += (dy / d) * ACC * dt;
        const wob = Math.sin(e.phase) * 200 * dt;
        e.vx += (-dy / d) * wob;
        e.vy += (dx / d) * wob;
        const sp = Math.hypot(e.vx, e.vy);
        if (sp > 150) {
          e.vx *= 150 / sp;
          e.vy *= 150 / sp;
        }
      } else {
        e.vx = approach(e.vx, 0, 1.5, dt);
        e.vy = approach(e.vy, 0, 1.5, dt);
      }
      if (e.blinkTimer <= 0 && p && !p.dead) {
        e.blinkTimer = rand(2.2, 3.6);
        puffAt(ecx, ecy, [e.def.color, "#b89aff"]);
        const dx = pcx - ecx,
          dy = pcy - ecy;
        const d = Math.hypot(dx, dy) || 1;
        const dist = rand(80, 150); // always a substantial short-range blink
        // toward-player full/half hops, then an upward pop for when the
        // wisp is terrain-pinned against the ground beside its target
        const hops = [
          [e.x + (dx / d) * dist, e.y + (dy / d) * dist],
          [e.x + (dx / d) * dist * 0.5, e.y + (dy / d) * dist * 0.5],
          [e.x, e.y - Math.max(56, dist * 0.6)],
        ];
        for (let k = 0; k < hops.length; k++) {
          if (!rectSolid(hops[k][0], hops[k][1], e.w, e.h)) {
            e.x = hops[k][0];
            e.y = hops[k][1];
            break;
          }
        }
        puffAt(e.x + e.w / 2, e.y + e.h / 2, [e.def.color, "#b89aff"]);
        e.vx *= 0.25; // resume the drift gently
        e.vy *= 0.25;
      }
      e.facing = e.vx >= 0 ? 1 : -1;
    return true;
  };

  // ---- archetype: king_slime ----
  ai["king_slime"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      if (!e.phase2 && e.hp <= e.maxHp * 0.5) {
        // rage at half health
        e.phase2 = true;
        if (TC.Particles) {
          TC.Particles.burst(ecx, ecy, 24, {
            colors: [e.def.color, "#ffffff"],
            speed: 160,
            life: 0.7,
            size: 3,
            gravity: 300,
          });
        }
      }
      if (e.onGround) {
        e.vx = approach(e.vx, 0, 6, dt);
        e.sitTimer -= dt;
        if (e.sitTimer <= 0 && p && !p.dead) {
          const dir = pcx >= ecx ? 1 : -1;
          e.facing = dir;
          // hop force scales with distance: far player means a huge leap
          const far = clamp(Math.abs(pcx - ecx) / (14 * TC.CONST.TS), 0, 1);
          e.vx = dir * (110 + 190 * far);
          e.vy = -(300 + 260 * far) * (e.phase2 ? 1.15 : 1);
          e.sitTimer = e.phase2 ? rand(0.5, 0.9) : rand(1.0, 1.6);
        }
      }
      // phase 2: shed servant slimes every ~6 s, max 2 alive
      if (e.phase2 && p && !p.dead) {
        e.summonTimer -= dt;
        if (e.summonTimer <= 0) {
          e.summonTimer = rand(5.5, 6.5);
          if (e.servants < 2) spawnServantOf(e, "blue_slime", ecx, ecy);
        }
      }
    return true;
  };

  // ---- archetype: eye_boss ----
  ai["eye_boss"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      if (!e.phase2 && e.hp <= e.maxHp * 0.5) {
        // rage at half health
        e.phase2 = true;
        e.bstate = "hover";
        e.dashTimer = Math.max(e.dashTimer, 1.2);
        if (TC.Particles) {
          TC.Particles.burst(ecx, ecy, 26, {
            colors: [e.def.color, "#ff3040"],
            speed: 170,
            life: 0.7,
            size: 3,
            gravity: 0,
          });
        }
      }
      const spdMul = e.phase2 ? 1.3 : 1;

      if (e.bstate === "telegraph") {
        // shudder in place, then lock onto where the player stands
        e.teleTimer -= dt;
        e.vx = approach(e.vx, 0, 14, dt);
        e.vy = approach(e.vy, 0, 14, dt);
        if (e.teleTimer <= 0) {
          const dx = pcx - ecx,
            dy = pcy - ecy;
          const d = Math.hypot(dx, dy) || 1;
          e.dashDx = dx / d;
          e.dashDy = dy / d;
          e.dashLeft = 20 * TC.CONST.TS;
          e.bstate = "dash";
        }
        return true;
      }

      if (e.bstate === "dash") {
        // velocity opposed to the locked direction means we just bounced
        if (e.vx * e.dashDx + e.vy * e.dashDy < 0) {
          e.bstate = "hover";
          e.dashTimer = e.phase2 ? rand(1.5, 2.25) : rand(3, 4.5);
        } else {
          e.vx = e.dashDx * 420;
          e.vy = e.dashDy * 420;
          e.dashLeft -= 420 * dt;
          if (e.dashLeft <= 0) {
            e.bstate = "hover";
            e.dashTimer = e.phase2 ? rand(1.5, 2.25) : rand(3, 4.5);
          }
        }
        e.facing = e.vx >= 0 ? 1 : -1;
        return true;
      }

      // hover: drift to a spot roughly overhead, 12-16 tiles up
      e.dashTimer -= dt;
      const hx = pcx + Math.sin(ctx.clock * 0.6 + e.phase) * 30 - e.w / 2;
      const hy =
        pcy -
        (e.hoverH || 14 * TC.CONST.TS) +
        Math.sin(ctx.clock * 1.05 + e.phase) * 12 -
        e.h / 2;
      const dx = hx - e.x,
        dy = hy - e.y;
      const d = Math.hypot(dx, dy) || 1;
      e.vx += (dx / d) * 240 * dt;
      e.vy += (dy / d) * 240 * dt;
      const hsp = Math.hypot(e.vx, e.vy);
      const hmax = 110 * spdMul;
      if (hsp > hmax) {
        e.vx *= hmax / hsp;
        e.vy *= hmax / hsp;
      }
      e.facing = pcx >= ecx ? 1 : -1;

      // phase 2: shed servant eyes every ~5 s, max 3 alive per boss
      if (e.phase2 && p && !p.dead) {
        e.summonTimer -= dt;
        if (e.summonTimer <= 0) {
          e.summonTimer = rand(4.5, 5.5);
          const n = 1 + (TC.GameRng.stream('ai').chance(0.5) ? 1 : 0);
          for (let k = 0; k < n && e.servants < 3; k++)
            spawnServantOf(e, "demon_eye", ecx, ecy);
        }
      }

      if (e.dashTimer <= 0 && p && !p.dead) {
        e.bstate = "telegraph";
        e.teleTimer = 0.5;
      }
    return true;
  };

  // ---- archetype: skeletron ----
  ai["skeletron"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      // track living hands; the skull is heavily armored while any survive
      const parts = e.parts || [];
      let handsAlive = 0;
      for (let k = 0; k < parts.length; k++)
        if (parts[k] && parts[k].hp > 0) handsAlive++;
      e.handsAlive = handsAlive;

      if (!e.phase2 && (e.hp <= e.maxHp * 0.5 || handsAlive === 0)) {
        e.phase2 = true; // enraged once exposed or hurt
        e.bstate = "hover";
        e.dashTimer = Math.max(e.dashTimer, 1.0);
        if (TC.Particles) {
          TC.Particles.burst(ecx, ecy, 26, {
            colors: [e.def.color, "#ffd24a"],
            speed: 170,
            life: 0.7,
            size: 3,
            gravity: 0,
          });
        }
      }
      const spdMul = (e.phase2 ? 1.25 : 1) * (handsAlive === 0 ? 1.15 : 1);

      if (e.bstate === "telegraph") {
        e.teleTimer -= dt;
        e.vx = approach(e.vx, 0, 12, dt);
        e.vy = approach(e.vy, 0, 12, dt);
        if (e.teleTimer <= 0) {
          const dx = pcx - ecx,
            dy = pcy - ecy;
          const d = Math.hypot(dx, dy) || 1;
          e.dashDx = dx / d;
          e.dashDy = dy / d;
          e.dashLeft = 18 * TC.CONST.TS;
          e.spin = true;
          e.bstate = "dash";
        }
        return true;
      }

      if (e.bstate === "dash") {
        const done = e.vx * e.dashDx + e.vy * e.dashDy < 0;
        const DSP = 400 * spdMul;
        if (done || e.dashLeft <= 0) {
          e.bstate = "hover";
          e.spin = false;
          e.dashTimer = e.phase2 ? rand(1.4, 2.1) : rand(2.6, 3.8);
        } else {
          e.vx = e.dashDx * DSP;
          e.vy = e.dashDy * DSP;
          e.dashLeft -= DSP * dt;
        }
        e.facing = e.vx >= 0 ? 1 : -1;
        return true;
      }

      // hover: drift to a spot roughly overhead
      e.dashTimer -= dt;
      const hx = pcx + Math.sin(ctx.clock * 0.7 + e.phase) * 40 - e.w / 2;
      const hy =
        pcy -
        11 * TC.CONST.TS +
        Math.sin(ctx.clock * 1.1 + e.phase) * 10 -
        e.h / 2;
      const dx = hx - e.x,
        dy = hy - e.y;
      const d = Math.hypot(dx, dy) || 1;
      e.vx += (dx / d) * 230 * dt;
      e.vy += (dy / d) * 230 * dt;
      const hsp = Math.hypot(e.vx, e.vy);
      const hmax = 100 * spdMul;
      if (hsp > hmax) {
        e.vx *= hmax / hsp;
        e.vy *= hmax / hsp;
      }
      e.facing = pcx >= ecx ? 1 : -1;
      if (e.dashTimer <= 0 && p && !p.dead) {
        e.bstate = "telegraph";
        e.teleTimer = 0.45;
      }
    return true;
  };

  // ---- archetype: skele_hand ----
  ai["skele_hand"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      // orbits its head on a fixed side, periodically lunging at the player
      const m = e.master;
      if (!m || m.hp <= 0) return true; // removed with the head
      const mcx = m.x + m.w / 2,
        mcy = m.y + m.h / 2;
      e.atkTimer -= dt;
      if (e.astate === "windup") {
        e.teleTimer -= dt;
        e.vx = approach(e.vx, 0, 8, dt);
        e.vy = approach(e.vy, 0, 8, dt);
        if (e.teleTimer <= 0) {
          const dx = pcx - ecx,
            dy = pcy - ecy;
          const d = Math.hypot(dx, dy) || 1;
          e.vx = (dx / d) * 300;
          e.vy = (dy / d) * 300;
          e.lungeLeft = 0.7;
          e.astate = "lunge";
        }
        return true;
      }
      if (e.astate === "lunge") {
        e.lungeLeft -= dt;
        if (e.lungeLeft <= 0) {
          e.astate = "orbit";
          e.atkTimer = rand(2.2, 3.6);
        }
        return true;
      }
      const side = e.side || 1;
      const oa = ctx.clock * 1.6 * side + (side > 0 ? 0 : Math.PI);
      const orbR = 60 + Math.sin(ctx.clock * 2 + e.phase) * 8;
      const gx = mcx + Math.cos(oa) * orbR;
      const gy = mcy + Math.sin(oa) * orbR * 0.8;
      const dx = gx - ecx,
        dy = gy - ecy;
      const d = Math.hypot(dx, dy) || 1;
      e.vx += (dx / d) * 420 * dt;
      e.vy += (dy / d) * 420 * dt;
      const sp = Math.hypot(e.vx, e.vy);
      if (sp > 220) {
        e.vx *= 220 / sp;
        e.vy *= 220 / sp;
      }
      e.facing = e.vx >= 0 ? 1 : -1;
      if (e.atkTimer <= 0 && p && !p.dead) {
        e.astate = "windup";
        e.teleTimer = 0.4;
      }
    return true;
  };

  // ---- archetype: hungry (W17 dedicated servant) ----
  ai["hungry"] = function (e, ctx, dt) {
    const p = TC.player;
    const m = e.master;
    if (!m || m.hp <= 0 || (TC.Enemies && TC.Enemies.list.indexOf(m) < 0)) return false;
    const mcx = m.x + m.w / 2, mcy = m.y + m.h / 2;
    const ecx = e.x + e.w / 2, ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx, pcy = p ? p.y + p.h / 2 : ecy;
    const tether = 132; // max reach from master before pull-back
    const dxM = mcx - ecx, dyM = mcy - ecy;
    const dM = Math.hypot(dxM, dyM) || 1;
    // lunge state: short dart toward player, then re-tether
    if (e.hungryState === 'lunge') {
      e.hungryLungeT -= dt;
      if (e.hungryLungeT <= 0 || dM > tether * 1.25) {
        e.hungryState = 'orbit';
        e.hungryCooldown = rand(1.2, 2.2);
      }
      return true;
    }
    // tether pull-back when too far from wall
    if (dM > tether) {
      e.vx += (dxM / dM) * 520 * dt;
      e.vy += (dyM / dM) * 520 * dt;
      const sp = Math.hypot(e.vx, e.vy);
      if (sp > 210) { e.vx *= 210 / sp; e.vy *= 210 / sp; }
      e.facing = e.vx >= 0 ? 1 : -1;
      return true;
    }
    // orbit around master with gentle wobble
    e.phase += dt * 3.6;
    if (p && !p.dead) {
      e.hungryCooldown = (e.hungryCooldown || rand(1.0, 2.0)) - dt;
      const distToPlayer = Math.hypot(pcx - ecx, pcy - ecy);
      if (e.hungryCooldown <= 0 && distToPlayer < 7 * TC.CONST.TS && dM < tether * 0.85) {
        // telegraph then lunge
        const dx = pcx - ecx, dy = pcy - ecy;
        const d = Math.hypot(dx, dy) || 1;
        e.vx = (dx / d) * 260;
        e.vy = (dy / d) * 260;
        e.hungryState = 'lunge';
        e.hungryLungeT = 0.55;
        e.facing = e.vx >= 0 ? 1 : -1;
        return true;
      }
      // gentle orbit pursuit
      const ang = ctx.clock * 1.4 * (e.orbitDir || 1) + e.phase * 0.4;
      const orbR = 44 + Math.sin(e.phase * 0.9) * 14;
      const gx = mcx + Math.cos(ang) * orbR;
      const gy = mcy + Math.sin(ang) * orbR * 0.7 + Math.sin(e.phase * 1.7) * 10;
      const dx = gx - ecx, dy = gy - ecy;
      const d = Math.hypot(dx, dy) || 1;
      e.vx += (dx / d) * 340 * dt;
      e.vy += (dy / d) * 340 * dt;
      const sp = Math.hypot(e.vx, e.vy);
      if (sp > 165) { e.vx *= 165 / sp; e.vy *= 165 / sp; }
    } else {
      e.vx = approach(e.vx, 0, 1.6, dt);
      e.vy = approach(e.vy, 0, 1.6, dt);
    }
    e.facing = e.vx >= 0 ? 1 : -1;
    return true;
  };

  // ---- WOF projectile helpers (canonical hostile ownership) ----
  function fireWofBolt(e) {
    if (!(TC.Projectiles && typeof TC.Projectiles.spawn === 'function')) return;
    const p = TC.player;
    if (!p || p.dead) return;
    const sx = e.wofDir === 1 ? e.x + e.w - 6 : e.x + 6;
    const sy = e.y + e.h * 0.32;
    const tx = p.x + p.w / 2, ty = p.y + p.h / 2;
    const ang = Math.atan2(ty - sy, tx - sx);
    const dmg = Math.round(e.def.dmg * 0.62);
    const pr = TC.Projectiles.spawn('magic_bolt', sx, sy, ang, { owner: null, speed: 320, dmg: dmg, kb: 3, life: 2.6, hitRadius: 10, color: '#ff6a3a' });
    if (TC.Enemies && typeof TC.Enemies.trackHostileShot === 'function') TC.Enemies.trackHostileShot(pr, e, dmg);
  }
  function fireWofFan(e, n) {
    if (!(TC.Projectiles && typeof TC.Projectiles.spawn === 'function')) return;
    const p = TC.player;
    if (!p || p.dead) return;
    const sx = e.wofDir === 1 ? e.x + e.w - 6 : e.x + 6;
    const sy = e.y + e.h * 0.32;
    const base = Math.atan2(p.y + p.h / 2 - sy, p.x + p.w / 2 - sx);
    const spread = n === 3 ? 0.52 : 0.78; // radians total
    const dmg = Math.round(e.def.dmg * (n === 3 ? 0.55 : 0.48));
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 0 : (k / (n - 1) - 0.5);
      const ang = base + t * spread;
      const pr = TC.Projectiles.spawn('magic_bolt', sx, sy, ang, { owner: null, speed: 300 + TC.GameRng.stream('ai').float() * 22, dmg: dmg, kb: 2.5, life: 2.8, hitRadius: 9, color: '#ff7a3a' });
      if (TC.Enemies && typeof TC.Enemies.trackHostileShot === 'function') TC.Enemies.trackHostileShot(pr, e, dmg);
    }
    puffAt(sx, sy, ['#ff7a3a', '#ffb86a']);
  }

  // ---- archetype: wof (W17 production wall) ----
  ai["wof"] = function (e, ctx, dt) {
    const p = TC.player;
    const w = TC.world;
    const TS = TC.CONST.TS;
    const ecx = e.x + e.w / 2, ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
    // lazy init encounter lifecycle
    if (e.wofState == null) {
      e.wofState = 'enter';
      e.wofEnterTime = 0.9;
      e.wofPhase = 1;
      e.wofTimer = 2.2;
      e.wofTele = 0;
      e.wofAttack = null;
      e.phase2 = false; e.phase3 = false;
      e.wofDir = (typeof e.dir === 'number' && (e.dir === 1 || e.dir === -1)) ? e.dir : 1;
      e.dir = e.wofDir;
      if (!e.wofBand) {
        const UW_START = (TC.CONST.GEN.underworld.startY || 355) * TS;
        const minY = UW_START + TS;
        const maxY = w ? w.height * TS - e.h - 4 * TS : e.y + 100;
        e.wofBand = { minY: minY, maxY: maxY, centerY: e.y };
      }
      e.wofElapsed = 0;
      e.wofPeakServants = 0;
      e.wofPeakProjectiles = 0;
      e.wofTransitions = 0;
      e.wofDespawnReason = null;
      e._wofSummonTimer = rand(5, 7);
      e.facing = e.wofDir;
    }
    e.wofElapsed = (e.wofElapsed || 0) + dt;
    const frac = e.hp / e.maxHp;
    if (e.wofPhase === 1 && frac <= 0.66) {
      e.wofPhase = 2; e.phase2 = true; e.wofTransitions++;
      e.wofTimer = Math.min(e.wofTimer, 1.2);
      puffAt(ecx, ecy, [e.def.color, '#ffffff']);
    }
    if (e.wofPhase === 2 && frac <= 0.33) {
      e.wofPhase = 3; e.phase3 = true; e.wofTransitions++;
      e.wofTimer = Math.min(e.wofTimer, 0.9);
      puffAt(ecx, ecy, [e.def.color, '#ff3040']);
    }
    // ---- explicit despawn / failure handling (documented) ----
    let despawnReason = null;
    if (!w || TC.state !== 'playing') despawnReason = 'world_unload';
    else if (!p || p.dead) despawnReason = 'player_dead';
    else {
      // Underworld membership via the ONE shared authoritative query —
      // identical boundary to summon validation and spawn zoning.
      const inUnderworld = isPlayerInUnderworld(p);
      if (!inUnderworld) {
        const dxTiles = Math.abs(pcx - ecx) / TS;
        if (dxTiles > 85) despawnReason = 'escaped_range';
        else {
          const surfY = w.surfaceY ? w.surfaceY[Math.floor(pcx / TS)] : 110;
          if ((p.y + p.h / 2) / TS < surfY + 30) despawnReason = 'escaped_biome';
          else if ((p.y + p.h / 2) / TS < uwTopPx() / TS - 10) despawnReason = 'escaped_biome';
        }
      } else {
        // in underworld: do not despawn merely for being far ahead; the wall is supposed to close distance
        // only despawn if the wall has clearly passed the player and is now far behind (player escaped ahead by >100 tiles beyond wall's trailing edge)
        const dxTiles = (ecx - pcx) / TS; // positive if wall is to the right of player
        const behind = (e.wofDir === 1 && pcx < ecx - 100 * TS) || (e.wofDir === -1 && pcx > ecx + e.w + 100 * TS);
        if (behind) despawnReason = 'escaped_range';
      }
      if (!despawnReason && w) {
        if (e.wofDir === 1 && e.x + e.w >= w.width * TS - 2) despawnReason = 'world_edge';
        if (e.wofDir === -1 && e.x <= 2) despawnReason = 'world_edge';
      }
    }
    if (despawnReason) {
      e.wofDespawnReason = despawnReason;
      try { if (typeof window !== 'undefined') window.__wofLastDespawn = despawnReason + ' at ' + Math.round(e.x) + ',' + Math.round(e.y) + ' player ' + Math.round(pcx) + ',' + Math.round(pcy) + ' biome ' + (TC.Biomes ? TC.Biomes.current : '?'); } catch (err) {}
      if (TC.Enemies && TC.Enemies.list) {
        for (let k = TC.Enemies.list.length - 1; k >= 0; k--) {
          const s = TC.Enemies.list[k];
          if (s !== e && s.master === e) TC.Enemies.list.splice(k, 1);
        }
      }
      if (TC.Enemies && typeof TC.Enemies.clearHostileShotsOf === 'function') {
        try { TC.Enemies.clearHostileShotsOf(e); } catch (err) {}
      }
      return false;
    }
    // ---- entrance (readable) ----
    if (e.wofState === 'enter') {
      e.wofEnterTime -= dt;
      e.vx = e.wofDir * 68;
      const targetY = e.wofBand.centerY;
      e.vy = approach(e.vy, clamp((targetY - e.y) * 1.4, -55, 55), 4, dt);
      e.facing = e.wofDir;
      if (e.wofEnterTime <= 0) {
        e.wofState = 'combat';
        e.wofTimer = e.wofPhase === 1 ? rand(2.0, 2.8) : e.wofPhase === 2 ? rand(1.6, 2.2) : rand(1.2, 1.8);
      }
      return true;
    }
    // ---- active combat movement (direction-locked, band-constrained) ----
    const speedByPhase = e.wofPhase === 1 ? 72 : e.wofPhase === 2 ? 96 : 124;
    e.vx = e.wofDir * speedByPhase;
    let targetY;
    if (p && !p.dead) {
      const playerCenterY = p.y + p.h / 2 - e.h / 2;
      targetY = clamp(playerCenterY, e.wofBand.minY, e.wofBand.maxY);
      targetY += Math.sin(ctx.clock * 0.7 + e.phase) * 6;
    } else {
      targetY = e.wofBand.centerY;
    }
    targetY = clamp(targetY, e.wofBand.minY, e.wofBand.maxY);
    e.vy = approach(e.vy, clamp((targetY - e.y) * 1.3, -70, 70), 3.5, dt);
    e.facing = e.wofDir;
    // ---- telegraphed attacks ----
    if (e.wofTele > 0) {
      e.wofTele -= dt;
      e.flashTimer = 0.12;
      if (e.wofTele <= 0) {
        const atk = e.wofAttack;
        if (atk) {
          const liveProj = TC.Projectiles ? TC.Projectiles.activeCount() : 0;
          const cap = 12;
          if (liveProj < cap) {
            if (atk === 'bolt') fireWofBolt(e);
            else if (atk === 'fan') fireWofFan(e, 3);
            else if (atk === 'spread') fireWofFan(e, 5);
          }
        }
        e.wofAttack = null;
        const next = e.wofPhase === 1 ? rand(2.8, 3.8) : e.wofPhase === 2 ? rand(1.9, 2.7) : rand(1.3, 2.0);
        e.wofTimer = next;
      }
      return true;
    }
    e.wofTimer -= dt;
    if (e.wofTimer <= 0 && p && !p.dead) {
      let choice;
      if (e.wofPhase === 1) choice = 'bolt';
      else if (e.wofPhase === 2) choice = TC.GameRng.stream('ai').chance(0.55) ? 'fan' : 'bolt';
      else choice = TC.GameRng.stream('ai').chance(0.6) ? 'spread' : 'fan';
      e.wofAttack = choice;
      e.wofTele = e.wofPhase === 1 ? 0.42 : e.wofPhase === 2 ? 0.36 : 0.30;
      puffAt(ecx + e.wofDir * 12, ecy - e.h * 0.22, ['#ff5a48', '#ffe0a0']);
    }
    // ---- servant shedding (bounded) ----
    if (p && !p.dead) {
      if (e._wofSummonTimer == null) e._wofSummonTimer = rand(5, 7);
      e._wofSummonTimer -= dt;
      if (e._wofSummonTimer <= 0) {
        const maxServ = e.wofPhase === 1 ? 4 : e.wofPhase === 2 ? 5 : 6;
        const interval = e.wofPhase === 1 ? rand(5.5, 7.0) : e.wofPhase === 2 ? rand(4.0, 5.5) : rand(3.2, 4.5);
        e._wofSummonTimer = interval;
        if (e.servants < maxServ) {
          const sx = e.wofDir === 1 ? e.x + e.w - 8 : e.x + 8;
          const sy = e.y + e.h * 0.28 + rand(-18, 18);
          spawnServantOf(e, 'hungry', sx, sy);
        }
        if (e.servants > (e.wofPeakServants || 0)) e.wofPeakServants = e.servants;
      }
    }
    if (TC.Projectiles) {
      const cur = TC.Projectiles.activeCount();
      if (cur > (e.wofPeakProjectiles || 0)) e.wofPeakProjectiles = cur;
    }
    return true;
  };

  // ---- archetype: storm_jelly ----
  ai["storm_jelly"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      // Storm Jelly: hovers above the player swaying side to side; cycles
      // telegraphed triple lightning drops with dash sweeps; escalates at
      // 66% (faster, more sweeps) and 33% (sheds up to two tiny jellies)
      if (e.cycleTimer == null) e.cycleTimer = 2.2;
      const frac = e.hp / e.maxHp;
      if (!e.phase2 && frac <= 0.66) {
        e.phase2 = true;
        e.cycleTimer = Math.min(e.cycleTimer, 1.2);
        puffAt(ecx, ecy, [e.def.color, "#ffffff"]);
      }
      if (!e.phase3 && frac <= 0.33) {
        e.phase3 = true;
        puffAt(ecx, ecy, [e.def.color, "#ffe98a"]);
        if (p && !p.dead)
          for (let k = 0; k < 2 && e.servants < 2; k++)
            spawnServantOf(e, "jelly_minion", ecx, ecy + 24);
      }
      const ph = e.phase3 ? 3 : e.phase2 ? 2 : 1;

      if (e.bstate === "dash") {
        // sweep through the player's last position until bounced or spent
        const done = e.vx * e.dashDx + e.vy * e.dashDy < 0;
        const DSP = ph >= 2 ? 470 : 400;
        if (done || e.dashLeft <= 0) {
          e.bstate = "hover";
          e.cycleTimer = jellyCycle(ph);
        } else {
          e.vx = e.dashDx * DSP;
          e.vy = e.dashDy * DSP;
          e.dashLeft -= DSP * dt;
        }
        e.facing = e.vx >= 0 ? 1 : -1;
        return true;
      }

      if (e.bstate === "tele") {
        // one pause of the volley: hang right over the player, flashing,
        // then drop a fast bolt straight down
        const hx = pcx - e.w / 2;
        const hy = pcy - 7 * TC.CONST.TS - e.h / 2 + Math.sin(ctx.clock * 2) * 5;
        const dx = hx - e.x,
          dy = hy - e.y;
        const d = Math.hypot(dx, dy) || 1;
        e.vx += (dx / d) * 520 * dt;
        e.vy += (dy / d) * 520 * dt;
        const tsp = Math.hypot(e.vx, e.vy);
        if (tsp > 250) {
          e.vx *= 250 / tsp;
          e.vy *= 250 / tsp;
        }
        e.teleTimer -= dt;
        if (e.teleTimer <= 0) {
          dropLightning(e);
          e.shotsLeft--;
          if (e.shotsLeft > 0) {
            e.teleTimer = 0.55;
          } else {
            e.bstate = "hover";
            e.cycleTimer = jellyCycle(ph);
          }
        }
        return true;
      }

      // hover: drift overhead, swaying
      e.cycleTimer -= dt;
      const hx = pcx + Math.sin(ctx.clock * 0.7 + e.phase) * 46 - e.w / 2;
      const hy =
        pcy -
        (e.hoverH || 12 * TC.CONST.TS) +
        Math.sin(ctx.clock * 1.15 + e.phase) * 10 -
        e.h / 2;
      const dx = hx - e.x,
        dy = hy - e.y;
      const d = Math.hypot(dx, dy) || 1;
      e.vx += (dx / d) * 260 * dt;
      e.vy += (dy / d) * 260 * dt;
      const hsp = Math.hypot(e.vx, e.vy);
      if (hsp > 120) {
        e.vx *= 120 / hsp;
        e.vy *= 120 / hsp;
      }
      e.facing = pcx >= ecx ? 1 : -1;

      if (e.cycleTimer <= 0 && p && !p.dead) {
        // later phases favor the sweep more often
        const dashW = ph === 1 ? 0.9 : ph === 2 ? 1.7 : 2.2;
        if (weightedPick([["bolt", 1.4], ["dash", dashW]]) === "dash") {
          const ddx = pcx - ecx,
            ddy = pcy - ecy;
          const dd = Math.hypot(ddx, ddy) || 1;
          e.dashDx = ddx / dd;
          e.dashDy = ddy / dd;
          e.dashLeft = 13 * TC.CONST.TS;
          e.bstate = "dash";
        } else {
          e.bstate = "tele";
          e.shotsLeft = 3;
          e.teleTimer = 0.55;
        }
      }
    return true;
  };

  // ---- archetype: moss_mother ----
  ai["moss_mother"] = function (e, ctx, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;
      // Moss Mother: slow relentless grounded walker that leaps obstacles;
      // root slams up close, fanned spore breath at range; sheds 2-3
      // sporelings at 50% and again at 25%; enrages below 25%
      if (e.cycleTimer == null) e.cycleTimer = 2.8;
      const frac = e.hp / e.maxHp;
      if (!e.phase2 && frac <= 0.5) {
        e.phase2 = true;
        shedSporelings(e, ecx, ecy);
        puffAt(ecx, ecy, [e.def.color, "#8adf6a"]);
      }
      if (!e.phase3 && frac <= 0.25) {
        e.phase3 = true;
        shedSporelings(e, ecx, ecy);
        puffAt(ecx, ecy, [e.def.color, "#ff8a6a"]);
      }
      const enraged = !!e.phase3;

      if (e.astate === "slamWind" || e.astate === "breathWind") {
        // wind-up: she plants her roots, then releases
        e.teleTimer -= dt;
        e.vx = approach(e.vx, 0, 10, dt);
        if (e.teleTimer <= 0) {
          const wasSlam = e.astate === "slamWind";
          e.astate = "idle";
          e.cycleTimer = enraged ? rand(1.2, 1.9) : rand(2.2, 3.2);
          if (wasSlam) {
            if (
              TC.Combat &&
              typeof TC.Combat.shockwave === "function"
            ) {
              TC.Combat.shockwave(
                ecx,
                e.y + e.h,
                4.2 * TC.CONST.TS,
                e.def.dmg,
                300,
              );
            }
            puffAt(ecx, e.y + e.h, ["#8a6f4a", "#5a4632"]);
          } else {
            sporeBreath(e);
          }
        }
        return true;
      }

      // movement: slow relentless walk; vaults walls with a leap
      const mul = enraged ? 1.5 : 1;
      if (p && !p.dead) {
        const dir = pcx >= ecx ? 1 : -1;
        e.facing = dir;
        e.vx = approach(e.vx, dir * (e.def.speed || 46) * mul, 4, dt);
      } else {
        e.vx = approach(e.vx, 0, 3, dt);
      }
      if (e.onGround && e.hitWall) {
        e.vy = -430;
        e.vx = (e.facing || 1) * 150;
      }

      // pick an attack when the cycle comes around
      e.cycleTimer -= dt;
      if (e.cycleTimer <= 0 && p && !p.dead && e.onGround) {
        const adx = Math.abs(pcx - ecx);
        const ady = Math.abs(pcy - ecy);
        if (adx < 4.5 * TC.CONST.TS && ady < 4 * TC.CONST.TS) {
          e.astate = "slamWind"; // player close: radial root slam
          e.teleTimer = 0.45;
        } else if (adx < 18 * TC.CONST.TS) {
          e.astate = "breathWind"; // range: arc burst of spores
          e.teleTimer = 0.5;
          e.facing = pcx >= ecx ? 1 : -1;
        } else {
          e.cycleTimer = 0.8; // keep walking until she's in range
        }
      }
    return true;
  };


  // Dispatch: unknown AI names fall back to a harmless idle (true = keep).
  ai.get = function (name) {
    return Object.prototype.hasOwnProperty.call(ai, name) ? ai[name] : null;
  };

  TC.EnemyAI = { util: util, ai: ai, isFlyer: util.isFlyer, get: ai.get };
})();
