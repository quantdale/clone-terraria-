/* enemies.js — enemy ENTITY lifecycle: factory, physics, AI dispatch,
   contact damage, final-damage application + death events, boss summoning,
   hostile-shot intake tracking and all procedural rendering (W13 shape).

   Decomposition ownership:
     enemydefs.js   content tables (ENEMY_DEFS/ITEM_DEFS/RECIPES additions)
     enemyai.js     behavior archetypes dispatched by runAI (TC.EnemyAI)
     enemyspawn.js  spawn director, zone tables, Blood Moon (TC.EnemySpawn)
     lootables.js   canonical loot evaluation (TC.LootTables)
     this file      entities: makeEnemy/update/moveAndCollide/damage/death,
                    servants, spawnBoss, hostile-shot tracking, drawing

   Boss shots ride TC.Projectiles with owner:null for motion/tiles/light;
   player contact for those shots is tracked here because the pool
   deliberately damages enemies only (same split wiring.js uses for trap
   darts). EntityDamaged/EntityKilled/BossDefeated fire exactly once, here. */

(() => {
  window.TC = window.TC || {};
  const TC = window.TC;

  const FLASH_TIME = 0.15;
  const TOUCH_KB_X = 210,
    TOUCH_KB_Y = -190;

  // W12 target-side mitigation policy: Skeletron's skull takes 65% less
  // damage while either hand is still alive (kill the hands to expose it).
  // Registered through a boot task so load order never matters — combat.js
  // owns the registry, this module owns the boss behavior.
  if (TC.Systems && typeof TC.Systems.boot === "function") {
    TC.Systems.boot("core.enemy-mitigations", {
      init: function () {
        if (TC.Combat && typeof TC.Combat.registerMitigation === "function") {
          TC.Combat.registerMitigation("skeletron", function (target) {
            return target && target.handsAlive > 0 ? 0.35 : 1;
          });
        }
      },
    });
  }

  // ---- small local helpers (gameplay randomness rides the seeded GameRng
  // 'ai'/'loot' streams for deterministic authoritative replay; W23) ----
  // approach/daylight/weightedPick moved to enemyai.js with the behaviors
  // that used them; physics/rendering keep rand/clamp/hexA here.
  function rand(a, b) {
    return a + TC.GameRng.stream('ai').float() * (b - a);
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function hexA(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16),
      g = parseInt(hex.slice(3, 5), 16),
      b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  // ---- world queries ----
  function solidAt(tx, ty) {
    const w = TC.world;
    if (!w || typeof w.isSolid !== "function") return false;
    return !!w.isSolid(tx, ty);
  }
  function rectSolid(x, y, w, h) {
    const ts = TC.CONST.TS;
    const x0 = Math.floor(x / ts),
      x1 = Math.floor((x + w - 0.01) / ts);
    const y0 = Math.floor(y / ts),
      y1 = Math.floor((y + h - 0.01) / ts);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) if (solidAt(tx, ty)) return true;
    return false;
  }

  // ---- state ----
  const list = [];
  let clock = 0; // animation time (visual only; read by AI via aiCtx)
  let eidSeq = 0; // W22: stable per-session entity id for network replication

  // ---- factory ----
  function makeEnemy(type, def, x, y) {
    return {
      eid: ++eidSeq,
      type,
      def,
      x,
      y,
      w: def.w,
      h: def.h,
      vx: 0,
      vy: 0,
      hp: def.hp,
      maxHp: def.hp,
      facing: 1,
      onGround: false,
      flashTimer: 0,
      touchTimer: 0,
      sitTimer: rand(0.4, 1.2), // slime: pause between hops
      phase: rand(0, Math.PI * 2), // wobble / walk-cycle offset
      jitterTimer: rand(1, 2), // bat: erratic course-change countdown
      orbitDir: TC.GameRng.stream('ai').sign(), // bat: which way it circles
      bstate: "hover", // eye_boss: hover | telegraph | dash
      dashTimer: rand(3, 4.5), // eye_boss: seconds until next dash
      servants: 0, // eye_boss: live demon_eye minions
      hitWall: false, // set by collision, read by zombie auto-jump
      fade: 1, // zombies dissolve in daylight
      lastHitSwing: 0,
      atkTimer: rand(2.5, 4.5), // harpy dive / hand lunge / wof spawn countdown
      astate: "idle", // generic attack sub-state (harpy/hand/wof)
      dir: 1, // wof travel direction (+1 = right)
      // WOF encounter state (lazy-init in AI, but defaults here for shape)
      wofState: null,
      wofDir: 1,
      wofBand: null,
      wofPhase: 1,
      wofTimer: 0,
      wofTele: 0,
      wofAttack: null,
      wofElapsed: 0,
      wofEnterTime: 0.9,
      wofPeakServants: 0,
      wofPeakProjectiles: 0,
      wofTransitions: 0,
      wofDespawnReason: null,
    };
  }

  // ---- physics: integrate with tile collision (flyers reflect instead of stopping) ----
  function moveAndCollide(e, dt) {
    // WOF is a noclip sweeping wall: ignore tile solidity and just clamp to world bounds.
    // Its vertical band is pre-validated as free at spawn; horizontal sweep must not be deflected by terrain.
    if (e.def.ai === 'wof') {
      e.hitWall = false;
      const w = TC.world;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      if (w) {
        const maxX = w.width * TC.CONST.TS - e.w;
        const maxY = w.height * TC.CONST.TS - e.h;
        e.x = clamp(e.x, 0, Math.max(0, maxX));
        e.y = clamp(e.y, 0, Math.max(0, maxY));
      }
      e.onGround = false;
      return;
    }
    e.hitWall = false;
    const w = TC.world;
    if (!w || typeof w.isSolid !== "function") {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      return;
    }
    const ts = TC.CONST.TS;
    const flyer = isFlyer(e.def.ai);
    const bounce = flyer
      ? e.def.ai === "bat"
        ? 0.6
        : e.def.ai === "eye_boss"
          ? 0.4
          : 0.5
      : 0;

    // horizontal
    let nx = e.x + e.vx * dt;
    if (rectSolid(nx, e.y, e.w, e.h)) {
      if (e.vx > 0) nx = Math.floor((nx + e.w) / ts) * ts - e.w - 0.01;
      else nx = (Math.floor(nx / ts) + 1) * ts + 0.01;
      if (rectSolid(nx, e.y, e.w, e.h)) nx = e.x;
      if (flyer) e.vx = -e.vx * bounce;
      else {
        e.hitWall = true;
        e.vx = 0;
      }
    }
    e.x = nx;

    // vertical
    let ny = e.y + e.vy * dt;
    e.onGround = false;
    if (rectSolid(e.x, ny, e.w, e.h)) {
      if (e.vy > 0) {
        ny = Math.floor((ny + e.h) / ts) * ts - e.h - 0.01;
        e.onGround = true;
      } else {
        ny = (Math.floor(ny / ts) + 1) * ts + 0.01;
      }
      if (rectSolid(e.x, ny, e.w, e.h)) ny = e.y;
      if (flyer) e.vy = -e.vy * bounce;
      else e.vy = 0;
    }
    e.y = ny;

    // keep inside the world
    const maxX = w.width * ts - e.w,
      maxY = w.height * ts - e.h;
    e.x = clamp(e.x, 0, Math.max(0, maxX));
    e.y = clamp(e.y, 0, Math.max(0, maxY));
  }

  // ---- AI delegation (W13) ----
  // Behavior archetypes live in enemyai.js; this module owns entities,
  // physics and rendering. ctx carries the animation clock the AI reads.
  function runAI(e, dt) {
    const impl =
      TC.EnemyAI && typeof TC.EnemyAI.get === "function"
        ? TC.EnemyAI.get(e.def.ai)
        : null;
    if (!impl) return true; // unknown/absent archetype: idle, never crash
    return impl(e, aiCtx, dt) !== false;
  }
  const aiCtx = {
    get clock() {
      return clock;
    },
  };

  // Flyer classification for physics: single authority in enemyai.js; a
  // missing module degrades flyers to ground physics rather than crashing.
  function isFlyer(aiName) {
    return TC.EnemyAI && typeof TC.EnemyAI.isFlyer === "function"
      ? TC.EnemyAI.isFlyer(aiName)
      : false;
  }

  // ---- loot ----
  // Roll a dead enemy's loot table and scatter the results at (cx,cy).
  // Evaluation is delegated to the canonical TC.LootTables (W13): chance /
  // min-max / coins semantics and validation live there; ENEMY_DEFS[].drops
  // + .coins stay the single content source. Returns nothing.
  function rollDrops(e, cx, cy) {
    if (TC.LootTables && typeof TC.LootTables.rollEntity === "function") {
      TC.LootTables.rollEntity(e.def, cx, cy);
      return;
    }
    // Fallback while lootables.js is absent (partial-script loads only).
    const drops = e.def.drops || [];
    for (let k = 0; k < drops.length; k++) {
      const d = drops[k];
      if (!TC.GameRng.stream('loot').chance(d.chance == null ? 1 : d.chance)) continue;
      const n = d.min + Math.floor(TC.GameRng.stream('loot').float() * (d.max - d.min + 1));
      if (n > 0 && TC.Items && typeof TC.Items.spawnDrop === "function") {
        TC.Items.spawnDrop(cx, cy, d.id, n, true);
      }
    }
    const coins = e.def.coins;
    if (Array.isArray(coins) && coins.length >= 2) {
      const amount =
        coins[0] + Math.floor(TC.GameRng.stream('loot').float() * (coins[1] - coins[0] + 1));
      if (
        amount > 0 &&
        TC.Economy &&
        typeof TC.Economy.dropCoins === "function"
      ) {
        TC.Economy.dropCoins(cx, cy, amount);
      }
    }
  }

  // ---- damage / death ----
  // Apply FINAL damage to an enemy (W12): defense, class scaling, variance,
  // crit and target mitigation were already resolved by TC.Combat.resolveHit
  // — this is the single application site, and the single place where
  // EntityDamaged / EntityKilled / BossDefeated fire. dmg is rounded/floored
  // at 1 here as a last-line invariant. Returns the applied amount.
  function damageEnemy(e, dmg, dir, power, crit) {
    if (!e || e.hp <= 0) return 0;
    const final = Math.max(1, Math.round(dmg));
    e.hp -= final;
    if (TC.Events) {
      try {
        TC.Events.emit(TC.Events.EVENT.EntityDamaged, {
          type: e.type,
          dmg: final,
          crit: !!crit,
          hp: e.hp,
        });
      } catch (err) {}
    }
    e.flashTimer = FLASH_TIME;
    const resist = 1 - (e.def.kbResist || 0);
    if (resist > 0) {
      e.vx += dir * power * 30 * resist;
      e.vy =
        e.def.ai === "eye"
          ? e.vy - power * 8 * resist
          : Math.min(e.vy, -power * 12 * resist);
    }
    const cx = e.x + e.w / 2;
    if (TC.Particles) {
      TC.Particles.floatText(
        cx,
        e.y - 6,
        final,
        crit ? TC.CONST.COLORS.crit : TC.CONST.COLORS.dealt,
        crit ? 18 : 13,
      );
    }
    if (TC.Audio) TC.Audio.play("hit");
    if (e.hp <= 0) killEnemy(e);
    return final;
  }

  function killEnemy(e) {
    const i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1);
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2;
    if (TC.Events) {
      try {
        TC.Events.emit(TC.Events.EVENT.EntityKilled, {
          type: e.type,
          x: cx,
          y: cy,
          boss: !!e.def.boss,
        });
      } catch (err) {}
      if (e.def.boss) {
        try {
          TC.Events.emit(TC.Events.EVENT.BossDefeated, { type: e.type });
        } catch (err2) {}
      }
    }
    if (TC.Particles) {
      if (e.def.boss) {
        TC.Particles.burst(cx, cy, 60, {
          colors: [e.def.color, "#ffffff", "#ff3040"],
          speed: 260,
          life: 1.1,
          size: 4,
          gravity: 220,
        });
      } else {
        TC.Particles.burst(cx, cy, 14, {
          colors: [e.def.color, "#ffffff"],
          speed: 110,
          life: 0.55,
          size: 3,
          gravity: 650,
        });
      }
    }
    if (e.master && e.master.servants > 0) e.master.servants--;
    // a fallen boss takes its servants with it
    if (e.def.boss) {
      for (let k = TC.Enemies.list.length - 1; k >= 0; k--) {
        const s = TC.Enemies.list[k];
        if (s !== e && s.master === e) {
          if (TC.Particles && typeof TC.Particles.burst === "function") {
            try {
              TC.Particles.burst(s.x + s.w / 2, s.y + s.h / 2, 8, {
                colors: [s.def.color, "#ffffff"],
                speed: 90,
                life: 0.4,
                size: 2.5,
                gravity: 500,
              });
            } catch (err) {}
          }
          TC.Enemies.list.splice(k, 1);
        }
      }
    }
    rollDrops(e, cx, cy);
    // blood moon bounty: non-boss kills shed extra blood shards
    if (
      (!TC.EnemySpawn || TC.EnemySpawn.isBloodMoon()) &&
      !e.def.boss &&
      !e.def.part &&
      TC.GameRng.stream('loot').chance(e.def.bloodShard == null ? 0.4 : e.def.bloodShard) &&
      TC.Items &&
      typeof TC.Items.spawnDrop === "function"
    ) {
      TC.Items.spawnDrop(
        cx,
        cy,
        "blood_shard",
        1 + (TC.GameRng.stream('loot').chance(0.4) ? 1 : 0),
        true,
      );
    }
    if (e.def.boss && TC.UI && typeof TC.UI.toast === "function") {
      TC.UI.toast(TC.Localization
        ? TC.Localization.t("progress.boss_defeated", { boss: TC.Localization.contentName("enemy", e.type) })
        : e.def.name + " has been defeated!");
    }
  }

  // ---- hostile boss projectiles ----
  // TC.Projectiles deliberately damages enemies only (see projectiles.js),
  // so boss shots ride the pool for motion/tiles/light with owner:null and
  // player contact is tracked here each frame (the same split wiring.js uses
  // for trap darts). The shooter is pre-seeded into every shot's hit list so
  // homing/bite-back can never target the boss herself.
  const hostileShots = [];

  function trackHostileShot(pr, shooter, dmg) {
    if (!pr) return;
    if (Array.isArray(pr.hits)) pr.hits.push(shooter);
    // remember the type: pooled slots recycle, so the tracker must confirm
    // the slot still holds this kind of shot before reading it as hostile
    hostileShots.push({ p: pr, type: pr.type, dmg: dmg, src: shooter.def.name });
  }

  function clearHostileShotsOf(boss) {
    for (let i = hostileShots.length - 1; i >= 0; i--) {
      const h = hostileShots[i];
      if (h.src === (boss.def && boss.def.name) || h.p === boss || (h.src && boss.def && h.src === boss.def.name)) {
        // also match by shooter reference if available via closure
        hostileShots.splice(i, 1);
        if (h.p && h.p.active) h.p.age = (h.p.maxAge || 1) + 1;
      } else if (h.p && !h.p.active) {
        hostileShots.splice(i, 1);
      }
    }
    // fallback: any shot whose shooter was the boss and now orphaned
    for (let i = hostileShots.length - 1; i >= 0; i--) {
      const h = hostileShots[i];
      if (h.p && h.p.active && h.p.owner == null && boss && boss.def) {
        // wof shots are owner:null; we cannot reliably filter, but if boss is despawning we clear all wof-typed shots
        // This is safe because wof is the only wall boss using magic_bolt with owner null in underworld
        if (h.type === 'magic_bolt' && h.src === boss.def.name) {
          hostileShots.splice(i, 1);
          h.p.age = (h.p.maxAge || 1) + 1;
        }
      }
    }
  }

  function updateHostileShots() {
    for (let i = hostileShots.length - 1; i >= 0; i--) {
      const h = hostileShots[i];
      if (
        !h.p ||
        !h.p.active ||
        h.p.type !== h.type ||
        h.p.owner != null
      ) {
        hostileShots.splice(i, 1);
        continue;
      }
      const p0 = TC.player;
      if (!p0 || p0.dead) continue;
      const r = h.p.hitRadius || 8;
      // W22: hostile shots threaten EVERY authoritative player, not just the
      // primary singleton (first hit wins; the shot then expires).
      const victims = (TC.Players && TC.Players.all) ? TC.Players.all() : [p0];
      for (let vi = 0; vi < victims.length; vi++) {
        const p = victims[vi];
        if (!p || p.dead) continue;
        if (
          h.p.x + r > p.x &&
          h.p.x - r < p.x + p.w &&
          h.p.y + r > p.y &&
          h.p.y - r < p.y + p.h &&
          TC.Combat &&
          typeof TC.Combat.hurtPlayer === "function"
        ) {
          try {
            TC.Combat.hurtPlayer(
              h.dmg,
              (h.p.vx >= 0 ? 1 : -1) * 170,
              -150,
              h.src,
              { target: p },
            );
          } catch (err) {}
          h.p.age = (h.p.maxAge || 1) + 1; // expire on the pool's next tick
          hostileShots.splice(i, 1);
          break;
        }
      }
    }
  }

  // Attack-effect helpers (puffAt, jellyCycle, dropLightning, sporeBreath,
  // shedSporelings) live in enemyai.js alongside the archetypes that use
  // them; hostile shots they fire register through Enemies.trackHostileShot.

  // ---- boss summoning ----
  // Shed a servant of `type` beside the boss in free space. Links it to the
  // boss (dies with the boss, tracked via boss.servants). Returns the enemy.
  function spawnServantOf(boss, type, bx, by) {
    const def = TC.ENEMY_DEFS && TC.ENEMY_DEFS[type];
    if (!def) return null;
    // W17: wof hungry cap is 6; enforce at the factory so direct test calls cannot overflow
    if (boss && boss.def && boss.def.ai === 'wof' && type === 'hungry' && boss.servants >= 6) return null;
    for (let t = 0; t < 6; t++) {
      const x = bx + rand(-56, 24),
        y = by + rand(-56, 24);
      if (rectSolid(x, y, def.w, def.h)) continue;
      const s = makeEnemy(type, def, x, y);
      s.master = boss;
      boss.servants++;
      list.push(s);
      if (TC.Particles) {
        TC.Particles.burst(x + def.w / 2, y + def.h / 2, 8, {
          colors: [def.color, "#ffffff"],
          speed: 90,
          life: 0.4,
          size: 2,
          gravity: 0,
        });
      }
      return s;
    }
    return null;
  }

  // Summon boss `type` at (x,y) at full hp. Returns the enemy, or null when
  // MAX_BOSSES bosses already live (or the type is not a boss).
  // Special case: type '__blood_moon__' (blood_sigil item) starts the Blood
  // Moon event instead of spawning anything. `opts` carries optional
  // encounter profile (e.g. wof dir/band) from Player.doSummon.
  function spawnBoss(type, x, y, opts) {
    if (type === "__blood_moon__") {
      if (TC.EnemySpawn && typeof TC.EnemySpawn.setBloodMoon === "function") {
        TC.EnemySpawn.setBloodMoon(true);
      }
      return null;
    }
    const def = TC.ENEMY_DEFS ? TC.ENEMY_DEFS[type] : null;
    if (!def || !def.boss) return null;
    let bosses = 0;
    for (let i = 0; i < list.length; i++)
      if (list[i].def && list[i].def.boss) bosses++;
    if (bosses >= (TC.CONST.MAX_BOSSES || 1)) return null;
    // W23: default anchor is the targeting policy's anchor (primary while
    // eligible, else any eligible player) — not blindly the singleton.
    const p = TC.Targets ? TC.Targets.anchor() : TC.player;
    if (typeof x !== "number" || !isFinite(x))
      x = p ? p.x + p.w / 2 - def.w / 2 : 0;
    if (typeof y !== "number" || !isFinite(y))
      y = p ? p.y - def.h - 14 * TC.CONST.TS : 0;
    const e = makeEnemy(type, def, x, y);
    e.hoverH = rand(12, 16) * TC.CONST.TS; // preferred altitude above the player
    e.summonTimer = 5;

    if (type === "king_slime") {
      e.sitTimer = 1; // brief pause before the first hop
      e.summonTimer = 6;
    } else if (type === "skeletron") {
      // attach a hand to each side; parts persist but never count as bosses
      e.parts = [];
      e.dashTimer = 2.5;
      e.summonTimer = 4;
      for (let s = -1; s <= 1; s += 2) {
        const hdef = TC.ENEMY_DEFS.skele_hand;
        const h = makeEnemy(
          "skele_hand",
          hdef,
          x + s * (def.w / 2 + hdef.w),
          y + 10,
        );
        h.master = e;
        h.side = s;
        e.parts.push(h);
        list.push(h);
      }
    } else if (type === "wof") {
      // W17 direction-locked wall: honour the summon placement profile when present,
      // otherwise fall back to the legacy side heuristic (preserves old saves/tests).
      if (opts && typeof opts.dir === 'number' && (opts.dir === 1 || opts.dir === -1)) {
        e.dir = opts.dir;
        e.wofDir = opts.dir;
      } else {
        e.dir = p && p.x + p.w / 2 >= x + def.w / 2 ? 1 : -1;
        e.wofDir = e.dir;
      }
      if (opts && opts.band && typeof opts.band.minY === 'number') {
        e.wofBand = { minY: opts.band.minY, maxY: opts.band.maxY, centerY: opts.band.centerY || y + def.h / 2 };
      } else {
        // Shared authoritative boundary (TC.Biomes.underworldTopPx) with a
        // guarded legacy fallback so embeds without biomes.js still band.
        let UW_START;
        try {
          UW_START = (TC.Biomes && typeof TC.Biomes.underworldTopPx === 'function')
            ? TC.Biomes.underworldTopPx()
            : ((TC.CONST.GEN.underworld && TC.CONST.GEN.underworld.startY) || 355) * TC.CONST.TS;
        } catch (err) {
          UW_START = y;
        }
        const minY = UW_START + TC.CONST.TS;
        const maxY = (TC.world ? TC.world.height * TC.CONST.TS - e.h - 4 * TC.CONST.TS : y + 100);
        e.wofBand = { minY: minY, maxY: maxY, centerY: y };
      }
      e.wofState = 'enter';
      e.wofPhase = 1;
      e.wofElapsed = 0;
      e.wofEnterTime = 0.9;
      e.wofPeakServants = 0;
      e.wofPeakProjectiles = 0;
      e.wofTransitions = 0;
      e.wofDespawnReason = null;
      e.summonTimer = 7;
    } else if (type === "storm_jelly") {
      e.cycleTimer = 2.2; // first attack after a short settle
      e.shotsLeft = 0;
    } else if (type === "moss_mother") {
      e.cycleTimer = 2.8;
    }

    list.push(e);
    if (TC.Particles) {
      TC.Particles.burst(x + def.w / 2, y + def.h / 2, 30, {
        colors: [def.color, "#ffffff"],
        speed: 200,
        life: 0.8,
        size: 3,
        gravity: 0,
      });
    }
    if (TC.UI && typeof TC.UI.toast === "function") {
      TC.UI.toast(TC.Localization
        ? TC.Localization.t("progress.boss_awakened", { boss: TC.Localization.contentName("enemy", type) })
        : def.name + " has awoken!");
    }
    return e;
  }

  // ---- per-frame update ----
  function update(dt) {
    clock += dt;
    // W23: despawn/contact evaluate the full eligible roster, not just the
    // primary pawn (Targets.all falls back to the singleton when absent).
    const players = (TC.Targets && TC.Targets.all) ? TC.Targets.all()
      : (TC.player ? [TC.player] : []);

    // Blood Moon dusk/dawn lifecycle lives in TC.EnemySpawn (W13 split).
    if (TC.EnemySpawn && typeof TC.EnemySpawn.tickEvent === "function") {
      TC.EnemySpawn.tickEvent(dt);
    }

    // boss-shot player contact (pool damages enemies only; see above)
    updateHostileShots();

    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];

      // despawn only when far from EVERY eligible player (bosses and boss
      // parts persist). With no players alive nothing distance-despawns.
      if (!e.def.boss && !e.def.part && players.length > 0) {
        const max = TC.CONST.ENEMY_DESPAWN_DIST;
        let nearAny = false;
        for (let pi = 0; pi < players.length; pi++) {
          const p = players[pi];
          const dx = (e.x + e.w / 2 - (p.x + p.w / 2)) / TC.CONST.TS;
          const dy = (e.y + e.h / 2 - (p.y + p.h / 2)) / TC.CONST.TS;
          if (dx * dx + dy * dy <= max * max) { nearAny = true; break; }
        }
        if (!nearAny) {
          if (e.master && e.master.servants > 0) e.master.servants--;
          list.splice(i, 1);
          continue;
        }
      }

      e.flashTimer = Math.max(0, e.flashTimer - dt);
      e.touchTimer = Math.max(0, e.touchTimer - dt);

      if (runAI(e, dt) === false) {
        list.splice(i, 1);
        continue;
      }

      if (!isFlyer(e.def.ai)) {
        e.vy = Math.min(e.vy + TC.CONST.GRAVITY * dt, TC.CONST.MAX_FALL);
      }
      moveAndCollide(e, dt);

      // contact damage — W22: every authoritative player can be touched,
      // not only the primary singleton
      if (TC.Players && TC.Players.all) {
        const players = TC.Players.all();
        for (let pi = 0; pi < players.length; pi++) {
          touchContact(e, players[pi]);
        }
      } else {
        touchContact(e, players[0] || null);
      }
    }
  }

  // One enemy-vs-one-player contact check (extracted verbatim from the old
  // single-player branch so behavior is unchanged when only one exists).
  function touchContact(e, p) {
    if (
      p &&
      !p.dead &&
      e.fade >= 1 &&
      e.touchTimer <= 0 &&
      e.x < p.x + p.w &&
      e.x + e.w > p.x &&
      e.y < p.y + p.h &&
      e.y + e.h > p.y &&
      TC.Combat &&
      typeof TC.Combat.hurtPlayer === "function"
    ) {
      const dir = p.x + p.w / 2 >= e.x + e.w / 2 ? 1 : -1;
      TC.Combat.hurtPlayer(
        e.def.dmg,
        dir * TOUCH_KB_X,
        TOUCH_KB_Y,
        e.def.name,
        { target: p },
      );
      e.touchTimer = TC.CONST.ENEMY_TOUCH_COOLDOWN;
    }
  }

  // ---- drawing (world-space) ----
  function drawSlime(c, e) {
    const w = e.w,
      h = e.h;
    // squish factor from vertical speed; idle breathing when settled
    const k = e.onGround
      ? Math.sin(clock * 2.2 + e.phase) * 0.05
      : clamp(Math.abs(e.vy) / 1400, 0, 0.28);
    const f = e.facing || 1;
    c.save();
    c.translate(e.x + w / 2, e.y + h);
    c.scale(1 - k * 0.7, 1 + k);

    // translucent rounded blob with a flat bottom
    const hw = w / 2;
    c.fillStyle = hexA(e.def.color, 0.78);
    c.beginPath();
    c.moveTo(-hw, 0);
    c.lineTo(hw, 0);
    c.quadraticCurveTo(hw + 1, -h * 0.55, hw * 0.55, -h * 0.85);
    c.quadraticCurveTo(0, -h * 1.08, -hw * 0.55, -h * 0.85);
    c.quadraticCurveTo(-hw - 1, -h * 0.55, -hw, 0);
    c.closePath();
    c.fill();

    // glossy highlight
    c.fillStyle = "rgba(255,255,255,0.28)";
    c.beginPath();
    c.ellipse(-hw * 0.35, -h * 0.68, hw * 0.28, h * 0.16, -0.5, 0, Math.PI * 2);
    c.fill();

    // eyes, shifted toward facing
    c.fillStyle = "rgba(8,28,12,0.9)";
    c.fillRect(f * 2 - w * 0.17, -h * 0.52, 3, 4);
    c.fillRect(f * 2 + w * 0.07, -h * 0.52, 3, 4);
    c.restore();
  }

  function drawZombie(c, e) {
    const w = e.w,
      h = e.h,
      x = e.x,
      y = e.y;
    const f = e.facing || 1;
    const skin = e.def.color;
    const walking = Math.abs(e.vx) > 8 && e.onGround;
    const step = walking ? Math.sin(clock * 9 + e.phase) : 0;

    // legs
    c.fillStyle = "#37432c";
    c.fillRect(x + w * 0.12 + step * 3, y + h * 0.62, w * 0.28, h * 0.38);
    c.fillRect(x + w * 0.56 - step * 3, y + h * 0.62, w * 0.28, h * 0.38);

    // torso
    c.fillStyle = "#4d6238";
    c.fillRect(x + w * 0.1, y + h * 0.3, w * 0.8, h * 0.36);
    c.fillStyle = "#2f3d24"; // rot patches
    c.fillRect(x + w * 0.52, y + h * 0.4, w * 0.22, h * 0.1);
    c.fillRect(x + w * 0.16, y + h * 0.54, w * 0.16, h * 0.09);

    // arms reaching forward
    c.fillStyle = skin;
    c.fillRect(
      f === 1 ? x + w * 0.42 : x - w * 0.85 + w * 0.43,
      y + h * 0.33,
      w * 0.85,
      h * 0.12,
    );

    // head
    c.fillRect(x + w * 0.15, y, w * 0.7, h * 0.26);
    c.fillStyle = "#2f3d24";
    c.fillRect(x + w * 0.15, y, w * 0.7, h * 0.06); // matted hair
    c.fillStyle = "#c03030";
    c.fillRect(x + (f === 1 ? w * 0.58 : w * 0.24), y + h * 0.11, 3, 3);
  }

  function drawEye(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      r = e.w / 2;
    const flap = Math.sin(clock * 18 + e.phase);

    // flapping triangle wings
    c.fillStyle = "#7a2323";
    c.beginPath();
    c.moveTo(cx - r * 0.5, cy - r * 0.15);
    c.lineTo(cx - r * 1.65, cy - r * (0.9 + flap * 0.55));
    c.lineTo(cx - r * 0.55, cy + r * 0.35);
    c.moveTo(cx + r * 0.5, cy - r * 0.15);
    c.lineTo(cx + r * 1.65, cy - r * (0.9 + flap * 0.55));
    c.lineTo(cx + r * 0.55, cy + r * 0.35);
    c.closePath();
    c.fill();

    // sclera
    c.fillStyle = "#e8ddce";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.35)";
    c.lineWidth = 1.5;
    c.stroke();

    // iris + pupil track the player
    let tx = e.facing || 1,
      ty = 0;
    const p = TC.Targets.of(e);
    if (p) {
      const dx = p.x + p.w / 2 - cx,
        dy = p.y + p.h / 2 - cy;
      const d = Math.hypot(dx, dy) || 1;
      tx = dx / d;
      ty = dy / d;
    }
    const ir = r * 0.55;
    const icx = cx + tx * r * 0.34,
      icy = cy + ty * r * 0.34;
    c.fillStyle = e.def.color;
    c.beginPath();
    c.arc(icx, icy, ir, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#200a0a";
    c.beginPath();
    c.arc(icx + tx * ir * 0.25, icy + ty * ir * 0.25, ir * 0.5, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.7)";
    c.fillRect(icx - ir * 0.5, icy - ir * 0.55, 2, 2);
  }

  function drawBat(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2;
    const bw = e.w / 2,
      bh = e.h / 2;
    const f = e.facing || 1;
    const flap = Math.sin(clock * 15 + e.phase);

    // scalloped membrane wings
    c.fillStyle = "#4e4236";
    for (let s = -1; s <= 1; s += 2) {
      const tipX = cx + s * bw * (1.5 + flap * 0.15);
      const tipY = cy - bh * (0.2 + flap * 0.7);
      c.beginPath();
      c.moveTo(cx + s * bw * 0.25, cy - bh * 0.15);
      c.quadraticCurveTo(
        cx + s * bw * 0.9,
        cy - bh * (0.55 + flap * 0.4),
        tipX,
        tipY,
      );
      c.quadraticCurveTo(
        cx + s * bw * 1.05,
        cy + bh * (0.1 - flap * 0.25),
        cx + s * bw * 0.68,
        cy + bh * (0.02 - flap * 0.3),
      );
      c.quadraticCurveTo(
        cx + s * bw * 0.46,
        cy + bh * (0.5 - flap * 0.15),
        cx + s * bw * 0.18,
        cy + bh * 0.3,
      );
      c.closePath();
      c.fill();
    }

    // furry body with a pale chest patch
    c.fillStyle = e.def.color;
    c.beginPath();
    c.ellipse(cx, cy, bw * 0.55, bh * 0.85, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(215,195,170,0.3)";
    c.beginPath();
    c.ellipse(cx, cy + bh * 0.28, bw * 0.3, bh * 0.4, 0, 0, Math.PI * 2);
    c.fill();

    // tiny ears
    c.fillStyle = e.def.color;
    c.beginPath();
    c.moveTo(cx - bw * 0.38, cy - bh * 0.5);
    c.lineTo(cx - bw * 0.26, cy - bh * 1.35);
    c.lineTo(cx - bw * 0.08, cy - bh * 0.62);
    c.moveTo(cx + bw * 0.08, cy - bh * 0.62);
    c.lineTo(cx + bw * 0.26, cy - bh * 1.35);
    c.lineTo(cx + bw * 0.38, cy - bh * 0.5);
    c.closePath();
    c.fill();

    // beady eyes, shifted toward travel direction
    c.fillStyle = "#1a1114";
    c.fillRect(cx + f * 1.5 - 3, cy - 2, 2, 2);
    c.fillRect(cx + f * 1.5 + 1, cy - 2, 2, 2);
  }

  function drawEyeBoss(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      r = e.w / 2;
    const p2 = !!e.phase2;

    c.save();
    if (e.bstate === "telegraph") {
      // pre-dash shudder
      c.translate(Math.sin(clock * 62) * 2.6, Math.cos(clock * 47) * 2.2);
    }

    // torn-back membrane tendrils trailing behind the motion
    const sp = Math.hypot(e.vx, e.vy);
    const bx = sp > 20 ? -e.vx / sp : 0,
      by = sp > 20 ? -e.vy / sp : -1;
    c.strokeStyle = hexA("#3d1558", 0.9);
    c.lineWidth = 4;
    c.lineCap = "round";
    for (let i = 0; i < 5; i++) {
      const a = (i - 2) * 0.55;
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const dx = bx * ca - by * sa,
        dy = bx * sa + by * ca; // fanned back dir
      const len = r * (0.5 + 0.16 * ((i * 2.3) % 1));
      const sw = Math.sin(clock * 2.6 + i * 1.9) * r * 0.3;
      c.beginPath();
      c.moveTo(cx + dx * r * 0.88, cy + dy * r * 0.88);
      c.quadraticCurveTo(
        cx + dx * (r * 0.88 + len * 0.5) - dy * sw * 0.5,
        cy + dy * (r * 0.88 + len * 0.5) + dx * sw * 0.5,
        cx + dx * (r * 0.88 + len) - dy * sw,
        cy + dy * (r * 0.88 + len) + dx * sw,
      );
      c.stroke();
    }

    // sclera
    c.fillStyle = "#ddd2c2";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.35)";
    c.lineWidth = 2;
    c.stroke();

    // veins creeping inward from the rim
    c.strokeStyle = p2 ? "rgba(205,40,50,0.65)" : "rgba(170,50,60,0.45)";
    c.lineWidth = 1.6;
    for (let i = 0; i < 7; i++) {
      const wig = Math.sin(clock * 1.4 + i * 2.1) * 0.08;
      let rr = r * 0.97,
        aa = (i / 7) * Math.PI * 2 + e.phase * 0.13;
      c.beginPath();
      c.moveTo(cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr);
      for (let k = 0; k < 3; k++) {
        rr -= r * 0.17;
        aa += wig + (k % 2 ? -0.09 : 0.09);
        c.lineTo(cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr);
      }
      c.stroke();
    }

    // iris + pupil track the player
    let tx = e.facing || 1,
      ty = 0;
    const p = TC.Targets.of(e);
    if (p) {
      const dx = p.x + p.w / 2 - cx,
        dy = p.y + p.h / 2 - cy;
      const d = Math.hypot(dx, dy) || 1;
      tx = dx / d;
      ty = dy / d;
    }
    const ir = r * 0.52;
    const icx = cx + tx * r * 0.3,
      icy = cy + ty * r * 0.3;
    if (p2) {
      // phase 2: pulsing red glow behind the iris
      c.fillStyle = hexA("#ff2038", 0.3 + Math.sin(clock * 6) * 0.1);
      c.beginPath();
      c.arc(icx, icy, ir * 1.45, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = p2 ? "#ad2f52" : e.def.color;
    c.beginPath();
    c.arc(icx, icy, ir, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#1c060c";
    c.beginPath();
    c.arc(
      icx + tx * ir * 0.28,
      icy + ty * ir * 0.28,
      ir * 0.48,
      0,
      Math.PI * 2,
    );
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.75)";
    c.fillRect(icx - ir * 0.5, icy - ir * 0.55, 3, 3);

    if (p2) {
      // faint enraged wash over the whole eye
      c.fillStyle = "rgba(255,40,40,0.1)";
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  function drawKingSlime(c, e) {
    drawSlime(c, e);
    // golden crown perched on top, bobbing with the idle breath
    const cx = e.x + e.w / 2;
    const cy = e.y + 3 + Math.sin(clock * 2.2 + e.phase) * 1.2;
    c.fillStyle = "#ffd24a";
    c.beginPath();
    c.moveTo(cx - 9, cy + 6);
    c.lineTo(cx - 9, cy - 4);
    c.lineTo(cx - 4.5, cy);
    c.lineTo(cx, cy - 6);
    c.lineTo(cx + 4.5, cy);
    c.lineTo(cx + 9, cy - 4);
    c.lineTo(cx + 9, cy + 6);
    c.closePath();
    c.fill();
    c.fillStyle = "#c87137"; // jewel
    c.fillRect(cx - 1.5, cy + 1, 3, 3);
  }

  function drawWalker(c, e) {
    const w = e.w,
      h = e.h,
      x = e.x,
      y = e.y;
    const f = e.facing || 1;
    const walking = Math.abs(e.vx) > 8 && e.onGround;
    const step = walking ? Math.sin(clock * 9 + e.phase) : 0;
    const look = e.def.look;

    if (look === "skeleton") {
      // bones: pale ribcage, spine, dangling arm, skull
      c.strokeStyle = "#d8d2c0";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x + w * 0.35, y + h * 0.55);
      c.lineTo(x + w * 0.3 + step * 3, y + h);
      c.moveTo(x + w * 0.65, y + h * 0.55);
      c.lineTo(x + w * 0.7 - step * 3, y + h);
      c.moveTo(x + w * 0.5, y + h * 0.22);
      c.lineTo(x + w * 0.5, y + h * 0.58);
      c.moveTo(x + w * 0.5, y + h * 0.3);
      c.lineTo(x + w * (f === 1 ? 0.95 : 0.05), y + h * 0.42 + step * 2);
      for (let i = 0; i < 3; i++) {
        const ry = y + h * (0.3 + i * 0.09);
        c.moveTo(x + w * 0.28, ry);
        c.lineTo(x + w * 0.72, ry);
      }
      c.stroke();
      c.fillStyle = "#e4ddca";
      c.fillRect(x + w * 0.22, y, w * 0.56, h * 0.24);
      c.fillStyle = "#1a1a1a";
      c.fillRect(x + (f === 1 ? w * 0.52 : w * 0.26), y + h * 0.09, 3, 3);
      c.fillRect(x + (f === 1 ? w * 0.66 : w * 0.4), y + h * 0.09, 3, 3);
      c.fillStyle = "#b8b2a0";
      c.fillRect(x + w * 0.34, y + h * 0.17, w * 0.32, 2);
    } else if (look === "golem") {
      // bulky stone body with a pulsing energy core
      c.fillStyle = "#5a6874";
      c.fillRect(x + w * 0.1, y + h * 0.25, w * 0.8, h * 0.45);
      c.fillRect(x + w * 0.06 + step * 2, y + h * 0.3, w * 0.2, h * 0.34);
      c.fillRect(x + w * 0.74 - step * 2, y + h * 0.3, w * 0.2, h * 0.34);
      c.fillStyle = "#7a8a96";
      c.fillRect(x + w * 0.16, y + h * 0.62, w * 0.26, h * 0.38);
      c.fillRect(x + w * 0.58, y + h * 0.62, w * 0.26, h * 0.38);
      c.fillRect(x + w * 0.18, y, w * 0.64, h * 0.26);
      c.strokeStyle = "rgba(40,50,60,0.7)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x + w * 0.3, y + h * 0.32);
      c.lineTo(x + w * 0.45, y + h * 0.5);
      c.lineTo(x + w * 0.38, y + h * 0.62);
      c.stroke();
      c.fillStyle = hexA(
        "#8adfff",
        0.55 + Math.sin(clock * 4 + e.phase) * 0.25,
      );
      c.fillRect(x + w * 0.42, y + h * 0.38, w * 0.16, h * 0.14);
      c.fillStyle = "#3a4a56";
      c.fillRect(x + (f === 1 ? w * 0.58 : w * 0.26), y + h * 0.09, 4, 3);
    } else if (look === "charger") {
      // boulder brute: craggy round body, heavy arms; the ember core flares
      // brighter the faster it charges
      c.fillStyle = "#6a6054";
      c.fillRect(x + w * 0.18, y + h * 0.66, w * 0.24, h * 0.34);
      c.fillRect(x + w * 0.58, y + h * 0.66, w * 0.24, h * 0.34);
      c.fillStyle = e.def.color;
      c.beginPath();
      c.arc(x + w * 0.5, y + h * 0.44, w * 0.46, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = "rgba(50,44,38,0.7)";
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(x + w * 0.2, y + h * 0.36);
      c.lineTo(x + w * 0.42, y + h * 0.5);
      c.moveTo(x + w * 0.66, y + h * 0.26);
      c.lineTo(x + w * 0.58, y + h * 0.48);
      c.moveTo(x + w * 0.4, y + h * 0.68);
      c.lineTo(x + w * 0.6, y + h * 0.6);
      c.stroke();
      const glow = clamp(Math.abs(e.vx) / 200, 0, 1);
      c.fillStyle = hexA("#ff8a3a", 0.35 + glow * 0.55);
      c.beginPath();
      c.arc(x + w * 0.5, y + h * 0.46, w * 0.14, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#2c2620";
      c.fillRect(x + (f === 1 ? w * 0.6 : w * 0.26), y + h * 0.28, 4, 4);
      c.fillRect(x + (f === 1 ? w * 0.74 : w * 0.4), y + h * 0.3, 4, 4);
    } else if (look === "wolf") {
      // lean arctic wolf: galloping legs, bushy tail, pointed ears
      c.strokeStyle = "#7e9cb8";
      c.lineWidth = 3;
      c.lineCap = "round";
      c.beginPath();
      for (let i = 0; i < 2; i++) {
        const lx = x + w * (0.3 + i * 0.4);
        const o = (i === 0 ? 1 : -1) * step * 4;
        c.moveTo(lx + o, y + h * 0.6);
        c.lineTo(lx + o * 1.6, y + h);
        c.moveTo(lx + 5 - o, y + h * 0.6);
        c.lineTo(lx + 5 - o * 1.6, y + h);
      }
      c.stroke();
      c.fillStyle = e.def.color;
      c.beginPath();
      c.ellipse(
        x + w * 0.48,
        y + h * 0.46,
        w * 0.36,
        h * 0.3,
        0,
        0,
        Math.PI * 2,
      );
      c.fill();
      // tail streaming behind
      const rx = x + w * (f === 1 ? 0.16 : 0.84);
      c.strokeStyle = e.def.color;
      c.lineWidth = 5;
      c.beginPath();
      c.moveTo(rx, y + h * 0.42);
      c.quadraticCurveTo(
        rx - f * w * 0.16,
        y + h * 0.22,
        rx - f * w * 0.3,
        y + h * 0.34,
      );
      c.stroke();
      // head with muzzle and ears
      const hd = x + w * (f === 1 ? 0.76 : 0.24);
      c.fillStyle = e.def.color;
      c.beginPath();
      c.arc(hd, y + h * 0.34, h * 0.26, 0, Math.PI * 2);
      c.fill();
      c.beginPath(); // ears sweep back
      c.moveTo(hd - f * 3, y + h * 0.14);
      c.lineTo(hd - f * 8, y - h * 0.04);
      c.lineTo(hd - f * 12, y + h * 0.18);
      c.closePath();
      c.fill();
      c.beginPath(); // muzzle
      c.moveTo(hd + f * h * 0.16, y + h * 0.28);
      c.lineTo(hd + f * h * 0.44, y + h * 0.38);
      c.lineTo(hd + f * h * 0.16, y + h * 0.46);
      c.closePath();
      c.fill();
      c.fillStyle = "#eef6fc"; // chest ruff
      c.beginPath();
      c.ellipse(
        hd - f * w * 0.08,
        y + h * 0.52,
        h * 0.16,
        h * 0.12,
        0,
        0,
        Math.PI * 2,
      );
      c.fill();
      c.fillStyle = "#16222e";
      c.fillRect(hd + f * 2 - 1.5, y + h * 0.26, 3, 3); // eye
      c.fillRect(hd + f * h * 0.4, y + h * 0.35, 2.5, 2.5); // nose
    } else if (look === "stalker") {
      // low sand lizard: scuttling legs, long tail, wedge head
      c.strokeStyle = "#a8894e";
      c.lineWidth = 2.5;
      c.lineCap = "round";
      c.beginPath();
      for (let i = 0; i < 2; i++) {
        const lx = x + w * (0.32 + i * 0.36);
        c.moveTo(lx, y + h * 0.62);
        c.lineTo(lx - 3 + step * 3, y + h);
        c.moveTo(lx + 4, y + h * 0.62);
        c.lineTo(lx + 7 - step * 3, y + h);
      }
      c.stroke();
      c.fillStyle = e.def.color;
      c.beginPath();
      c.ellipse(
        x + w * 0.5,
        y + h * 0.5,
        w * 0.4,
        h * 0.26,
        0,
        0,
        Math.PI * 2,
      );
      c.fill();
      // tail curls away from travel
      const rx = x + w * (f === 1 ? 0.14 : 0.86);
      c.strokeStyle = e.def.color;
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(rx, y + h * 0.46);
      c.quadraticCurveTo(
        rx - f * w * 0.14,
        y + h * 0.36,
        rx - f * w * 0.24,
        y + h * 0.56,
      );
      c.stroke();
      c.fillStyle = "#8a6f3c"; // back stripe
      c.fillRect(x + w * 0.24, y + h * 0.32, w * 0.5, 3);
      const hd = x + w * (f === 1 ? 0.78 : 0.22);
      c.fillStyle = e.def.color;
      c.beginPath();
      c.moveTo(hd, y + h * 0.36);
      c.lineTo(hd + f * w * 0.24, y + h * 0.5);
      c.lineTo(hd, y + h * 0.64);
      c.closePath();
      c.fill();
      c.fillStyle = "#1c1408";
      c.fillRect(hd + f * w * 0.06 - 1.5, y + h * 0.42, 3, 3);
    } else if (look === "sporeling") {
      // mushroom imp: domed cap over a pale stem body
      c.fillStyle = "#d8cfa8";
      c.fillRect(x + w * 0.2 + step * 2, y + h * 0.78, w * 0.22, h * 0.22);
      c.fillRect(x + w * 0.58 - step * 2, y + h * 0.78, w * 0.22, h * 0.22);
      c.beginPath();
      c.ellipse(
        x + w * 0.5,
        y + h * 0.58,
        w * 0.3,
        h * 0.28,
        0,
        0,
        Math.PI * 2,
      );
      c.fill();
      c.fillStyle = e.def.color;
      c.beginPath();
      c.moveTo(x - w * 0.08, y + h * 0.44);
      c.quadraticCurveTo(
        x + w * 0.5,
        y - h * 0.14,
        x + w * 1.08,
        y + h * 0.44,
      );
      c.closePath();
      c.fill();
      c.fillStyle = "#c8e8a8";
      c.fillRect(x + w * 0.3, y + h * 0.16, 3, 3);
      c.fillRect(x + w * 0.62, y + h * 0.22, 3, 3);
      c.fillStyle = "#2a2018";
      c.fillRect(x + (f === 1 ? w * 0.54 : w * 0.32), y + h * 0.54, 2.5, 4);
      c.fillRect(x + (f === 1 ? w * 0.68 : w * 0.46), y + h * 0.54, 2.5, 4);
    } else {
      // crawler: low, wide blood spider
      c.strokeStyle = "#701a1a";
      c.lineWidth = 2;
      c.beginPath();
      for (let i = 0; i < 3; i++) {
        const lx = x + w * (0.2 + i * 0.3);
        c.moveTo(lx, y + h * 0.55);
        c.lineTo(lx - 5 + step * 2, y + h);
        c.moveTo(lx + 4, y + h * 0.55);
        c.lineTo(lx + 9 - step * 2, y + h);
      }
      c.stroke();
      c.fillStyle = e.def.color;
      c.beginPath();
      c.ellipse(x + w / 2, y + h * 0.42, w * 0.42, h * 0.42, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#ffd24a";
      c.fillRect(x + w * (f === 1 ? 0.62 : 0.26), y + h * 0.3, 3, 3);
      c.fillRect(x + w * (f === 1 ? 0.72 : 0.16), y + h * 0.42, 3, 3);
    }
  }

  function drawHarpy(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2;
    const bw = e.w / 2,
      bh = e.h / 2;
    const f = e.facing || 1;
    const flap = Math.sin(clock * 10 + e.phase);
    const diving = e.astate === "dive";

    // broad feathered wings
    c.fillStyle = "#8a744a";
    for (let s = -1; s <= 1; s += 2) {
      const tipX = cx + s * bw * (1.7 + flap * 0.2);
      const tipY = cy - bh * (0.4 + flap * 0.9);
      c.beginPath();
      c.moveTo(cx + s * bw * 0.2, cy - bh * 0.2);
      c.quadraticCurveTo(
        cx + s * bw * 1.1,
        cy - bh * (0.7 + flap * 0.5),
        tipX,
        tipY,
      );
      c.quadraticCurveTo(
        cx + s * bw * 1.0,
        cy + bh * (0.2 - flap * 0.3),
        cx + s * bw * 0.5,
        cy + bh * 0.15,
      );
      c.closePath();
      c.fill();
    }

    // tail feathers trail behind travel
    c.fillStyle = "#7a643c";
    c.beginPath();
    c.moveTo(cx - f * bw * 0.4, cy);
    c.lineTo(cx - f * bw * 1.3, cy - bh * 0.3);
    c.lineTo(cx - f * bw * 1.25, cy + bh * 0.35);
    c.closePath();
    c.fill();

    // body tilts forward during a dive
    c.fillStyle = e.def.color;
    c.beginPath();
    c.ellipse(
      cx,
      cy,
      bw * 0.55,
      bh * 0.75,
      diving ? f * 0.5 : 0,
      0,
      Math.PI * 2,
    );
    c.fill();

    // pale head + beak
    c.fillStyle = "#e8d8b8";
    c.beginPath();
    c.arc(cx + f * bw * 0.42, cy - bh * 0.5, bh * 0.34, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#e8a53a";
    c.beginPath();
    c.moveTo(cx + f * bw * 0.62, cy - bh * 0.55);
    c.lineTo(cx + f * bw * 1.0, cy - bh * 0.45);
    c.lineTo(cx + f * bw * 0.62, cy - bh * 0.35);
    c.closePath();
    c.fill();
    c.fillStyle = "#2a1a10";
    c.fillRect(cx + f * bw * 0.48, cy - bh * 0.62, 2, 2);
  }

  function drawSkeletron(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      r = e.w / 2;
    const p2 = !!e.phase2;

    c.save();
    if (e.bstate === "telegraph") {
      // pre-dash shudder
      c.translate(Math.sin(clock * 62) * 2.6, Math.cos(clock * 47) * 2.2);
    }
    if (e.spin) {
      // spin-dash streaks
      c.strokeStyle = "rgba(220,215,195,0.4)";
      c.lineWidth = 3;
      for (let i = 0; i < 4; i++) {
        const a = clock * 18 + (i * Math.PI) / 2;
        c.beginPath();
        c.arc(cx, cy, r * (1.15 + i * 0.08), a, a + 1.1);
        c.stroke();
      }
    }

    // skull dome with squared jaw
    c.fillStyle = p2 ? "#efe8d2" : "#ddd6c2";
    c.beginPath();
    c.arc(cx, cy - r * 0.12, r * 0.82, Math.PI, 0);
    c.quadraticCurveTo(
      cx + r * 0.82,
      cy + r * 0.42,
      cx + r * 0.55,
      cy + r * 0.52,
    );
    c.lineTo(cx - r * 0.55, cy + r * 0.52);
    c.quadraticCurveTo(
      cx - r * 0.82,
      cy + r * 0.42,
      cx - r * 0.82,
      cy - r * 0.12,
    );
    c.closePath();
    c.fill();

    // eye sockets glow red once enraged
    c.fillStyle = p2
      ? hexA("#ff2038", 0.75 + Math.sin(clock * 6) * 0.2)
      : "#1c1814";
    c.beginPath();
    c.ellipse(
      cx - r * 0.36,
      cy - r * 0.16,
      r * 0.22,
      r * 0.27,
      0,
      0,
      Math.PI * 2,
    );
    c.ellipse(
      cx + r * 0.36,
      cy - r * 0.16,
      r * 0.22,
      r * 0.27,
      0,
      0,
      Math.PI * 2,
    );
    c.fill();

    // nose gap
    c.fillStyle = "#1c1814";
    c.beginPath();
    c.moveTo(cx, cy + r * 0.12);
    c.lineTo(cx - r * 0.1, cy + r * 0.3);
    c.lineTo(cx + r * 0.1, cy + r * 0.3);
    c.closePath();
    c.fill();

    // teeth row
    c.fillStyle = "#cfc8b0";
    c.fillRect(cx - r * 0.5, cy + r * 0.52, r, r * 0.22);
    c.strokeStyle = "#8a8474";
    c.lineWidth = 1.5;
    c.beginPath();
    for (let i = 0; i <= 5; i++) {
      const tx = cx - r * 0.5 + (r / 5) * i;
      c.moveTo(tx, cy + r * 0.52);
      c.lineTo(tx, cy + r * 0.74);
    }
    c.stroke();
    c.restore();
  }

  function drawSkeleHand(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2;
    const sp = Math.hypot(e.vx, e.vy);
    // fingers point along motion while flying fast, upright when slow
    const ang = sp > 60 ? Math.atan2(e.vy, e.vx) + Math.PI / 2 : 0;
    c.save();
    c.translate(cx, cy);
    c.rotate(ang);
    c.fillStyle = "#cfc8b8";
    c.fillRect(-4, e.h * 0.1, 8, e.h * 0.45); // forearm
    c.fillRect(-9, -e.h * 0.18, 18, e.h * 0.32); // palm
    c.fillStyle = "#e0dac8";
    for (let i = -2; i <= 2; i++) {
      // fingers
      c.save();
      c.translate(i * 4.5, -e.h * 0.18);
      c.rotate(i * 0.16);
      c.fillRect(-2, -e.h * 0.34, 4, e.h * 0.34);
      c.restore();
    }
    c.restore();
  }

  function drawWof(c, e) {
    const x = e.x,
      y = e.y,
      w = e.w,
      h = e.h;
    const rage = 1 - e.hp / e.maxHp;
    // W17 telegraph overlay: flash the wall pale when about to fire
    if (e.wofTele && e.wofTele > 0) {
      const k = e.wofTele / 0.45; // 1..0
      c.fillStyle = 'rgba(255,233,138,' + (0.18 + (1 - k) * 0.22).toFixed(2) + ')';
      c.fillRect(x - 4, y - 4, w + 8, h + 8);
    }

    // fleshy slab with deterministic mottling
    c.fillStyle = "#a83232";
    c.fillRect(x, y, w, h);
    c.fillStyle = "rgba(90,20,20,0.55)";
    for (let i = 0; i < 6; i++) {
      const my = y + ((i * 37 + 13) % Math.max(1, h - 10));
      c.fillRect(x + (i % 2) * w * 0.4, my, w * 0.35, 8);
    }

    // pulsing veins brighten with damage
    c.strokeStyle = "rgba(255,120,120," + (0.3 + rage * 0.3).toFixed(2) + ")";
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i < 4; i++) {
      const vy = y + h * (0.15 + i * 0.22);
      c.moveTo(x + 4, vy);
      c.quadraticCurveTo(
        x + w * 0.5,
        vy + Math.sin(clock * 3 + i) * 6,
        x + w - 4,
        vy + 4,
      );
    }
    c.stroke();

    // central eye tracks the player
    const ecx = x + w / 2,
      ecy = y + h * 0.32,
      er = w * 0.3;
    let tx = e.dir || 1,
      ty = 0;
    const p = TC.Targets.of(e);
    if (p) {
      const dx = p.x + p.w / 2 - ecx,
        dy = p.y + p.h / 2 - ecy;
      const d = Math.hypot(dx, dy) || 1;
      tx = dx / d;
      ty = dy / d;
    }
    c.fillStyle = "#e8ddce";
    c.beginPath();
    c.arc(ecx, ecy, er, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = rage > 0.5 ? "#d42040" : "#8a2020";
    c.beginPath();
    c.arc(
      ecx + tx * er * 0.34,
      ecy + ty * er * 0.34,
      er * 0.52,
      0,
      Math.PI * 2,
    );
    c.fill();
    c.fillStyle = "#200a0a";
    c.beginPath();
    c.arc(
      ecx + tx * er * 0.48,
      ecy + ty * er * 0.48,
      er * 0.24,
      0,
      Math.PI * 2,
    );
    c.fill();

    // toothy maw
    const my = y + h * 0.58,
      mw = w * 0.7,
      mh = h * 0.16;
    c.fillStyle = "#4a0f0f";
    c.fillRect(x + w * 0.15, my, mw, mh);
    c.fillStyle = "#e8ddce";
    for (let i = 0; i < 5; i++) {
      const tw = mw / 5,
        mx = x + w * 0.15 + i * tw;
      c.beginPath(); // top teeth
      c.moveTo(mx, my);
      c.lineTo(mx + tw / 2, my + 7);
      c.lineTo(mx + tw, my);
      c.closePath();
      c.fill();
      c.beginPath(); // bottom teeth
      c.moveTo(mx, my + mh);
      c.lineTo(mx + tw / 2, my + mh - 7);
      c.lineTo(mx + tw, my + mh);
      c.closePath();
      c.fill();
    }
  }

  function drawHungry(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      r = e.w / 2;
    const bite = Math.abs(Math.sin(clock * 8 + e.phase)) * r * 0.4;
    c.fillStyle = "#8a2020";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#4a0f0f";
    c.beginPath();
    c.ellipse(cx, cy, r * 0.72, bite + 2, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#e8ddce";
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + e.phase * 0.2;
      c.fillRect(
        cx + Math.cos(a) * r * 0.62 - 1.5,
        cy + Math.sin(a) * r * 0.62 - 1.5,
        3,
        3,
      );
    }
  }

  function drawSnapvine(c, e) {
    const x = e.x,
      y = e.y,
      w = e.w,
      h = e.h;
    const f = e.facing || 1;
    const biting = e.astate === "bite";
    // jaw openness: idle breathing, wide through the wind-up, snap at release
    const g = biting
      ? Math.max(0.1, Math.sin((1 - e.teleTimer / 0.32) * Math.PI) * 0.95)
      : 0.14 + Math.sin(clock * 2 + e.phase) * 0.06;

    // root pod anchoring the stalk
    c.fillStyle = "#6a4a2c";
    c.beginPath();
    c.ellipse(x + w / 2, y + h * 0.88, w * 0.52, h * 0.16, 0, 0, Math.PI * 2);
    c.fill();

    // curling stalk leaning toward its facing
    c.strokeStyle = "#3a6a2c";
    c.lineWidth = 4;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(x + w / 2, y + h * 0.86);
    c.quadraticCurveTo(
      x + w / 2 - f * w * 0.22,
      y + h * 0.58,
      x + w / 2 + f * w * 0.08,
      y + h * 0.42,
    );
    c.stroke();

    // head bulb with a wedge maw aimed at the player
    const hx = x + w / 2 + f * w * 0.08,
      hy = y + h * 0.34,
      hr = w * 0.46;
    c.save();
    c.translate(hx, hy);
    c.rotate(f * 0.14);
    c.fillStyle = e.def.color;
    c.beginPath();
    c.arc(0, 0, hr, 0, Math.PI * 2);
    c.fill();
    const ma = 0.18 + g * 0.7; // half-angle of the open mouth
    const a0 = f > 0 ? -ma : Math.PI - ma;
    c.fillStyle = "#2a1414";
    c.beginPath();
    c.moveTo(0, 0);
    c.arc(0, 0, hr * 1.02, a0, a0 + ma * 2);
    c.closePath();
    c.fill();
    // teeth flanking the maw
    const bx = f > 0 ? 1 : -1;
    c.fillStyle = "#e8e4c8";
    c.fillRect(bx * hr * 0.62 - 1.5, -hr * 0.3, 3, 5);
    c.fillRect(bx * hr * 0.62 - 1.5, hr * 0.18, 3, 5);
    // crest leaf
    c.strokeStyle = "#79b04a";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-bx * hr * 0.2, -hr * 0.9);
    c.quadraticCurveTo(-bx * hr * 0.9, -hr * 1.5, -bx * hr * 1.3, -hr * 0.8);
    c.stroke();
    c.restore();
  }

  function drawVoidWisp(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      r = e.w / 2;
    const sp = Math.hypot(e.vx, e.vy);
    const bx = sp > 10 ? -e.vx / sp : 0,
      by = sp > 10 ? -e.vy / sp : -0.4;

    // trailing tendrils stream behind the motion
    c.strokeStyle = hexA("#7a5af5", 0.5);
    c.lineWidth = 2;
    c.lineCap = "round";
    for (let i = -1; i <= 1; i++) {
      const wob = Math.sin(clock * 4 + i * 2.1 + e.phase) * r * 0.5;
      c.beginPath();
      c.moveTo(cx, cy);
      c.quadraticCurveTo(
        cx + bx * r * 1.4 - by * wob,
        cy + by * r * 1.4 + bx * wob,
        cx + bx * r * (2.2 + i * 0.35),
        cy + by * r * (2.2 + i * 0.35),
      );
      c.stroke();
    }

    // layered glow body around a dark core
    const flick = 0.85 + Math.sin(clock * 7 + e.phase) * 0.15;
    c.fillStyle = hexA("#8f7ff0", 0.22 * flick);
    c.beginPath();
    c.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = hexA(e.def.color, 0.8 * flick);
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#241238";
    c.beginPath();
    c.arc(cx, cy, r * 0.6, 0, Math.PI * 2);
    c.fill();

    // single pale eye tracks the player
    let tx = e.facing || 1,
      ty = 0;
    const p = TC.Targets.of(e);
    if (p) {
      const dx = p.x + p.w / 2 - cx,
        dy = p.y + p.h / 2 - cy;
      const d = Math.hypot(dx, dy) || 1;
      tx = dx / d;
      ty = dy / d;
    }
    c.fillStyle = "#bfe8ff";
    c.beginPath();
    c.arc(cx + tx * r * 0.22, cy + ty * r * 0.22, r * 0.2, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.8)";
    c.fillRect(cx + tx * r * 0.22 - 1, cy + ty * r * 0.22 - 2, 2, 2);
  }

  function drawStormJelly(c, e) {
    const x = e.x,
      y = e.y,
      w = e.w,
      h = e.h;
    const cx = x + w / 2;
    const tele = e.bstate === "tele";
    const ph3 = !!e.phase3;
    const domeH = h * 0.55;
    const pulse = 0.5 + Math.sin(clock * (tele ? 22 : 3)) * 0.5;
    const tint = ph3 ? "#c09aff" : "#8f7ff0";

    const bellPath = () => {
      c.beginPath();
      c.moveTo(x, y + domeH);
      c.quadraticCurveTo(x - w * 0.02, y - h * 0.08, cx, y - h * 0.08);
      c.quadraticCurveTo(x + w * 1.02, y - h * 0.08, x + w, y + domeH);
      c.quadraticCurveTo(x + w * 0.5, y + domeH + 6, x, y + domeH);
      c.closePath();
    };

    c.save();
    if (tele) c.translate(Math.sin(clock * 55) * 1.6, 0); // charge shudder

    // trailing tentacles sway beneath the bell
    c.strokeStyle = hexA(tint, 0.65);
    c.lineWidth = 3;
    c.lineCap = "round";
    for (let i = 0; i < 5; i++) {
      const tx = x + w * (0.16 + i * 0.17);
      const sw = Math.sin(clock * 2.4 + i * 1.7 + e.phase) * 7;
      c.beginPath();
      c.moveTo(tx, y + domeH * 0.8);
      c.quadraticCurveTo(
        tx + sw * 0.6,
        y + domeH + (h - domeH) * 0.4,
        tx + sw,
        y + h * (0.92 + ((i * 7) % 3) * 0.03),
      );
      c.stroke();
    }

    // translucent violet-blue bell with a bright rim
    c.fillStyle = hexA(tint, 0.42);
    bellPath();
    c.fill();
    c.strokeStyle = hexA("#bdafff", 0.75);
    c.lineWidth = 2;
    bellPath();
    c.stroke();

    // inner glow + rim frill
    c.fillStyle = hexA("#cdbfff", 0.3 + pulse * 0.15);
    c.beginPath();
    c.ellipse(cx, y + domeH * 0.6, w * 0.28, domeH * 0.32, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = hexA("#6a5ad0", 0.5);
    c.fillRect(x + 2, y + domeH - 3, w - 4, 4);

    // eyes
    c.fillStyle = "#241a4a";
    c.fillRect(cx - 10, y + domeH * 0.38, 4, 6);
    c.fillRect(cx + 6, y + domeH * 0.38, 4, 6);

    // lightning telegraph washes the whole bell in warning yellow
    if (tele) {
      c.fillStyle = "rgba(255,233,138," + (0.2 + pulse * 0.35).toFixed(2) + ")";
      bellPath();
      c.fill();
    }

    // dash streaks trail opposite the motion
    if (e.bstate === "dash") {
      c.strokeStyle = "rgba(190,175,255,0.5)";
      c.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        c.beginPath();
        c.moveTo(cx - e.vx * 0.05, y + domeH * (0.3 + i * 0.25));
        c.lineTo(cx - e.vx * 0.12, y + domeH * (0.3 + i * 0.25));
        c.stroke();
      }
    }
    c.restore();
  }

  function drawMossMother(c, e) {
    const x = e.x,
      y = e.y,
      w = e.w,
      h = e.h;
    const f = e.facing || 1;
    const walking = Math.abs(e.vx) > 6 && e.onGround;
    const step = walking ? Math.sin(clock * 6 + e.phase) : 0;
    const enr = !!e.phase3;
    const winding = e.astate === "slamWind" || e.astate === "breathWind";

    c.save();
    if (e.astate === "slamWind") c.translate(Math.sin(clock * 40) * 1.5, 0);

    // root legs
    c.strokeStyle = "#4a3826";
    c.lineWidth = 6;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(x + w * 0.28, y + h * 0.72);
    c.lineTo(x + w * 0.24 + step * 4, y + h);
    c.moveTo(x + w * 0.68, y + h * 0.72);
    c.lineTo(x + w * 0.72 - step * 4, y + h);
    c.stroke();

    // bark body mound
    c.fillStyle = "#5a4632";
    c.beginPath();
    c.moveTo(x, y + h * 0.78);
    c.quadraticCurveTo(x - w * 0.02, y + h * 0.2, x + w * 0.3, y + h * 0.12);
    c.lineTo(x + w * 0.7, y + h * 0.12);
    c.quadraticCurveTo(x + w * 1.02, y + h * 0.2, x + w, y + h * 0.78);
    c.closePath();
    c.fill();

    // mossy cap with lighter clumps
    c.fillStyle = e.def.color;
    c.beginPath();
    c.moveTo(x - w * 0.02, y + h * 0.34);
    c.quadraticCurveTo(x + w * 0.2, y - h * 0.08, x + w * 0.5, y - h * 0.02);
    c.quadraticCurveTo(x + w * 0.8, y - h * 0.06, x + w * 1.02, y + h * 0.34);
    c.quadraticCurveTo(x + w * 0.5, y + h * 0.18, x - w * 0.02, y + h * 0.34);
    c.closePath();
    c.fill();
    c.fillStyle = enr ? "#9ac86a" : "#79b04a";
    for (let i = 0; i < 4; i++) {
      c.beginPath();
      c.ellipse(
        x + w * (0.18 + i * 0.2),
        y + h * (0.1 + ((i * 13) % 3) * 0.04),
        w * 0.09,
        h * 0.07,
        0,
        0,
        Math.PI * 2,
      );
      c.fill();
    }

    // face: amber eyes flare red once enraged
    const ey = y + h * 0.48;
    c.fillStyle = enr ? "#ff5a48" : "#ffb03a";
    c.fillRect(x + w * (f === 1 ? 0.56 : 0.32), ey, w * 0.07, h * 0.07);
    c.fillRect(x + w * (f === 1 ? 0.72 : 0.16), ey, w * 0.07, h * 0.07);
    c.fillStyle = "#2a2018";
    c.fillRect(x + w * 0.38, y + h * 0.64, w * 0.24, 3);

    // claw arm raises while she winds up an attack
    c.strokeStyle = "#4a3826";
    c.lineWidth = 5;
    const raise = winding ? -h * 0.18 : 0;
    c.beginPath();
    c.moveTo(x + w * (f === 1 ? 0.84 : 0.16), y + h * 0.5);
    c.lineTo(x + w * (f === 1 ? 0.98 : 0.02), y + h * 0.66 + raise);
    c.stroke();

    // spore glow gathers while she charges a breath
    if (e.astate === "breathWind") {
      c.fillStyle =
        "rgba(138,223,106," +
        (0.25 + Math.sin(clock * 18) * 0.15).toFixed(2) +
        ")";
      c.beginPath();
      c.arc(
        x + w * (f === 1 ? 0.96 : 0.04),
        y + h * 0.52,
        w * 0.09,
        0,
        Math.PI * 2,
      );
      c.fill();
    }
    c.restore();
  }

  function drawFlash(c, e) {
    c.globalAlpha = Math.min(1, e.flashTimer / FLASH_TIME) * 0.8;
    c.fillStyle = "#ffffff";
    c.beginPath();
    c.ellipse(
      e.x + e.w / 2,
      e.y + e.h / 2,
      e.w / 2,
      e.h / 2,
      0,
      0,
      Math.PI * 2,
    );
    c.fill();
    c.globalAlpha = e.fade < 1 ? Math.max(0, e.fade) : 1;
  }

  function draw(ctx, cam) {
    if (!list.length) return;
    ctx.save();
    if (typeof TC.applyCam === "function") TC.applyCam(ctx);
    else if (cam)
      ctx.setTransform(
        cam.zoom,
        0,
        0,
        cam.zoom,
        -cam.x * cam.zoom,
        -cam.y * cam.zoom,
      );

    // cheap view culling
    let vw = 0,
      vh = 0;
    if (TC.canvas) {
      const z = cam ? cam.zoom : 1;
      vw = TC.canvas.width / z;
      vh = TC.canvas.height / z;
    }
    const vx0 = (cam ? cam.x : 0) - 64,
      vy0 = (cam ? cam.y : 0) - 64;
    const vx1 = vx0 + vw + 128,
      vy1 = vy0 + vh + 128;

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (vw && (e.x + e.w < vx0 || e.x > vx1 || e.y + e.h < vy0 || e.y > vy1))
        continue;
      ctx.save();
      if (e.fade < 1) ctx.globalAlpha = Math.max(0, e.fade);
      const ai = e.def.ai;
      if (ai === "slime") drawSlime(ctx, e);
      else if (ai === "king_slime") drawKingSlime(ctx, e);
      else if (ai === "zombie") drawZombie(ctx, e);
      else if (ai === "walker") drawWalker(ctx, e);
      else if (ai === "bat")
        drawBat(ctx, e); // vulture reuses this too
      else if (ai === "harpy") drawHarpy(ctx, e);
      else if (ai === "eye_boss") drawEyeBoss(ctx, e);
      else if (ai === "skeletron") drawSkeletron(ctx, e);
      else if (ai === "skele_hand") drawSkeleHand(ctx, e);
      else if (ai === "wof") drawWof(ctx, e);
      else if (ai === "hungry") drawHungry(ctx, e);
      else if (ai === "stationary") drawSnapvine(ctx, e);
      else if (ai === "teleporter") drawVoidWisp(ctx, e);
      else if (ai === "storm_jelly") drawStormJelly(ctx, e);
      else if (ai === "moss_mother") drawMossMother(ctx, e);
      else drawEye(ctx, e); // demon eye / eater of souls
      if (e.flashTimer > 0) drawFlash(ctx, e);
      ctx.restore();
    }
    ctx.restore();
  }

  // Generic deterministic spawner for regular enemy types (debug/test hooks
  // and future scripted events). Bosses keep going through spawnBoss so
  // MAX_BOSSES stays authoritative.
  function spawnEnemy(type, x, y) {
    const def = TC.ENEMY_DEFS ? TC.ENEMY_DEFS[type] : null;
    if (!def || def.boss) return null;
    const p = TC.Targets ? TC.Targets.anchor() : TC.player;
    if (typeof x !== "number" || !isFinite(x))
      x = p ? p.x + p.w / 2 - def.w / 2 : 0;
    if (typeof y !== "number" || !isFinite(y))
      y = p ? p.y - 3 * TC.CONST.TS : 0;
    const e = makeEnemy(type, def, x, y);
    list.push(e);
    return e;
  }

  function clear() {
    list.length = 0;
    if (TC.EnemySpawn && typeof TC.EnemySpawn.reset === "function") {
      TC.EnemySpawn.reset();
    }
  }

  // ---- WOF encounter observability (W17) ----
  function getWofEncounter() {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.def && e.def.ai === 'wof') {
        return {
          state: e.wofState || 'unknown',
          phase: e.wofPhase || 1,
          elapsed: e.wofElapsed || 0,
          hpFrac: e.maxHp ? e.hp / e.maxHp : 0,
          servants: e.servants || 0,
          peakServants: e.wofPeakServants || 0,
          peakProjectiles: e.wofPeakProjectiles || 0,
          transitions: e.wofTransitions || 0,
          despawnReason: e.wofDespawnReason || null,
          dir: e.wofDir || e.dir || 1,
          hostile: hostileShots.length,
        };
      }
    }
    return null;
  }
  function clearEncounter() {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.def && e.def.ai === 'wof') {
        for (let k = list.length - 1; k >= 0; k--) {
          const s = list[k];
          if (s !== e && s.master === e) list.splice(k, 1);
        }
        clearHostileShotsOf(e);
        list.splice(i, 1);
      }
    }
  }
  TC.Enemies = {
    list,
    update,
    draw,
    // Director facade: main.js keeps calling this entry point; the rules
    // live in enemyspawn.js.
    spawnDirector(dt) {
      if (TC.EnemySpawn && typeof TC.EnemySpawn.spawnDirector === "function") {
        TC.EnemySpawn.spawnDirector(dt);
      }
    },
    clear,
    damageEnemy,
    spawnBoss,
    spawnEnemy,
    isBloodMoon: () =>
      !!(TC.EnemySpawn && TC.EnemySpawn.isBloodMoon &&
         TC.EnemySpawn.isBloodMoon()),
    setBloodMoon(v) {
      if (TC.EnemySpawn && typeof TC.EnemySpawn.setBloodMoon === "function") {
        TC.EnemySpawn.setBloodMoon(v);
      }
    },
    // Additive seams consumed by enemyai.js / enemyspawn.js (W13 contracts):
    makeEnemy,           // entity factory for the director
    trackHostileShot,    // boss shots register player-contact tracking
    spawnServantOf,      // minion spawning linked to a boss's servant budget
    clearHostileShotsOf,
    getWofEncounter,
    clearEncounter,
  };
  // ---- WOF lifecycle hooks (world unload / quitToTitle) ----
  if (TC.Systems && typeof TC.Systems.boot === 'function') {
    TC.Systems.boot('core.wof-cleanup', {
      init: function() {
        const origQuit = TC.quitToTitle;
        if (typeof origQuit === 'function' && !origQuit._wofWrapped) {
          TC.quitToTitle = function() {
            try { clearEncounter(); } catch (err) {}
            return origQuit.apply(this, arguments);
          };
          TC.quitToTitle._wofWrapped = true;
        }
        if (TC.Events && typeof TC.Events.on === 'function' && TC.Events.EVENT && TC.Events.EVENT.WorldLoaded) {
          TC.Events.on(TC.Events.EVENT.WorldLoaded, function() {
            // transient encounter state never survives a world load
            try {
              for (let i = list.length - 1; i >= 0; i--) {
                const e = list[i];
                if (e.def && e.def.ai === 'wof' && e.wofState === 'enter') {
                  // keep entering wall? No, fresh world starts clean via TC.Enemies.clear()
                }
              }
            } catch (err) {}
          });
        }
      }
    });
  }
})();
