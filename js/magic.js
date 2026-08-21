/* magic.js — TC.Magic: player mana pool + regen stars, potion sickness,
   magic weapons (kind 'magic') fired onto the shared TC.Projectiles pool,
   mana potions / mana crystals, and the HUD mana-star bar.

   Foundation-contract edition: NO monkey patching. Every former runtime wrap
   is now a plain exported function or a contract registration:

     was Combat.update wrap   -> TC.Magic.update(dt)          (lead: main step)
     was Combat.draw wrap     -> TC.Magic.drawWorld(ctx,cam)  (lead: main draw)
     was Combat.clear wrap    -> WorldLoaded subscription + manual clear()
     was Player.serialize wrap   -> captureOf + SaveCore provider below
     was Player.deserialize wrap -> attachToPlayer / restoreLegacy
     was Player.respawn wrap  -> TC.Magic.onRespawn(player)
     was UI.draw wrap         -> TC.Magic.drawHud(ctx,w,h)    (lead: ui draw)
     was Items.iconFor wrap   -> TC.Magic.iconFor(id)         (lead: items chain)

   INTEGRATION (one line each, lead-owned files):
     main.js step(), directly after `if (TC.Combat) TC.Combat.update(dt);`:
       if (TC.Magic) TC.Magic.update(dt);
     main.js draw(), directly after `if (TC.Combat) TC.Combat.draw(ctx, cam);`:
       if (TC.Magic) TC.Magic.drawWorld(ctx, cam);
     player.js respawn(), on its last line:
       if (TC.Magic) TC.Magic.onRespawn(this);
     player.js serialize(), before `return {`:
       (optional legacy-v1 parity) Object.assign(d, TC.Magic.captureOf(this));
     player.js static deserialize(), before `return p;`:
       if (TC.Magic) TC.Magic.restoreLegacy(data, p);
     ui.js UI.draw, last statement:
       if (TC.Magic) TC.Magic.drawHud(ctx, w, h);
     items.js iconFor(), extend the existing gic chain:
       || (TC.Magic && TC.Magic.iconFor && TC.Magic.iconFor(key))

   Persistence: SaveCore provider 'character.core.magic' mirrors the live
   player fields (mana/maxMana/potionSickness stay ON the player instance).
   restoreLegacy applies the same fields from an old v1 player blob.

   Bolts: fire() delegates to TC.Projectiles.spawn('magic_bolt', ...) with
   each weapon def mapped onto the pool's opt names (speed/dmg/kb/pierce/
   bounce/gravity/crit/accel/maxSpeed/life/hitRadius/colors). The shared
   magic_bolt type is aligned once at load with classic staff ballistics
   (see TYPES ALIGNMENT below) — flagged for the lead to bake into
   projectiles.js. Per-spawn visual styles (spark streak / scythe crescent /
   orb) are NOT pooled yet (documented projectiles.js limitation): pooled
   bolts render with the standard tinted bolt painter + glow; weapon identity
   survives through color and icons. A death watcher restores impact bursts.
   If TC.Projectiles is absent, a local bolts[] fallback reproduces the old
   private simulation (ticked by update, drawn by drawWorld).

   Regen stars stay module-local: the pool's 'falling_star' is a damaging
   ballistic projectile, nothing like these homing mana pickups.

   Damage: castWeapon passes flat def.damage (today's formula). Stats-based
   scaling (Math.round(def.damage * st.magicDamage)) is available via
   TC.Stats but intentionally NOT applied — it would change current numbers.

   Tuning constants that would ideally live in constants.js (kept here since
   constants.js is lead-owned): MANA_BASE 20, MANA_CAP 200, CRYSTAL_GAIN 20,
   REGEN_DELAY 1.0s, STAR_PAYLOAD 10, POTION_SICKNESS 60s.

   Randomness: Math.random is used only for combat rolls / visual effects,
   matching combat.js precedent — never for seed-reproducible world state. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  if (TC.Magic) return;                       // idempotent: never double-install

  const CONST = TC.CONST || {};
  const TAU = Math.PI * 2;

  // ---- tuning ----
  const MANA_BASE = 20;          // starting max mana (one star)
  const MANA_CAP = 200;          // hard cap from mana crystals
  const CRYSTAL_GAIN = 20;       // max mana per mana crystal
  const STAR_PAYLOAD = 10;       // mana carried by one regen star
  const REGEN_DELAY = 1.0;       // s after spending before regen resumes
  const POTION_SICKNESS = 60;    // s between mana potion drinks
  const WATCH_CAP = 32;          // pooled bolts tracked for impact bursts

  // ---- guarded cross-module helpers ----
  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') { try { TC.Audio.play(name); } catch (e) {} }
  }
  function pBurst(x, y, n, colors, spd, grav) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try { TC.Particles.burst(x, y, n, { colors: colors, speed: spd, gravity: grav }); } catch (e) {}
    }
  }
  function pText(x, y, text, color) {
    if (TC.Particles && typeof TC.Particles.floatText === 'function') {
      try { TC.Particles.floatText(x, y, text, color); } catch (e) {}
    }
  }
  function pSpawn(opts) {
    if (TC.Particles && typeof TC.Particles.spawn === 'function') {
      try { return TC.Particles.spawn(opts); } catch (e) { return null; }
    }
    return null;
  }
  function solidPx(x, y) {
    return !!(TC.world && typeof TC.world.solidAtPixel === 'function' &&
              TC.world.solidAtPixel(x, y));
  }
  function distToRect(px, py, rx, ry, rw, rh) {
    const nx = Math.max(rx, Math.min(rx + rw, px));
    const ny = Math.max(ry, Math.min(ry + rh, py));
    const dx = px - nx, dy = py - ny;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // Same roll shape as combat.js melee/arrows: +/-DMG_VARIANCE then a crit
  // chance of CRIT_CHANCE plus any per-weapon bonus; crits deal double.
  // (Fallback path only — pooled bolts roll inside TC.Projectiles.)
  function rollDamage(base, critBonus) {
    const v = CONST.DMG_VARIANCE || 0;
    let d = base * (1 - v + Math.random() * 2 * v);
    const crit = Math.random() < ((CONST.CRIT_CHANCE || 0) + (critBonus || 0));
    if (crit) d *= 2;
    return { dmg: Math.max(1, Math.round(d)), crit };
  }

  // Remove one of an id from the inventory (Inventory.remove is id-based).
  function consumeOne(inv, id) {
    if (!inv || typeof inv.remove !== 'function') return false;
    try { return !!inv.remove(id, 1); } catch (e) { return false; }
  }

  // ====================================================================
  // Mana core — fields live on the player instance (lazy-initialized so
  // existing saves and parallel-spawned players keep working).
  // ====================================================================
  function ensureMana(p) {
    if (!p || typeof p !== 'object') return;
    if (!(typeof p.maxMana === 'number' && isFinite(p.maxMana) && p.maxMana > 0)) p.maxMana = MANA_BASE;
    if (!(typeof p.mana === 'number' && isFinite(p.mana))) p.mana = p.maxMana;
    if (!(typeof p.manaRegenDelay === 'number')) p.manaRegenDelay = 0;
    if (!(typeof p.manaRegenT === 'number')) p.manaRegenT = 0;
    if (!(typeof p.manaAccum === 'number')) p.manaAccum = 0;
    if (!(typeof p.magicCd === 'number')) p.magicCd = 0;
    if (!(typeof p.potionSickness === 'number')) p.potionSickness = 0;
    p.mana = clamp(p.mana, 0, p.maxMana);
  }

  function spendMana(p, n) {
    ensureMana(p);
    n = n || 0;
    if (p.mana < n) return false;
    p.mana -= n;
    return true;
  }

  function restoreMana(p, n) {
    ensureMana(p);
    if (!(n > 0) || p.dead) return;
    const before = p.mana;
    p.mana = Math.min(p.maxMana, p.mana + n);
    return Math.round(p.mana - before);
  }

  // Mana/s once regen is fully ramped; scales mildly with max mana.
  function regenRate(maxMana) { return 3 + maxMana * 0.05; }

  // ====================================================================
  // Persistence — plain data in/out around the live player fields (was
  // Player.serialize/deserialize wraps). Numbers match the old wraps
  // exactly: rounded mana/sickness out, clamped values back in.
  // ====================================================================
  function captureOf(p) {
    if (!p || typeof p !== 'object') {
      return { mana: MANA_BASE, maxMana: MANA_BASE, potionSickness: 0 };
    }
    ensureMana(p);
    return {
      mana: Math.round(p.mana),
      maxMana: p.maxMana | 0,
      potionSickness: Math.round(p.potionSickness || 0)
    };
  }

  function attachToPlayer(p, data) {
    if (!p || typeof p !== 'object') return p;
    ensureMana(p);
    const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
    const mm = num(data && data.maxMana);
    if (mm !== null) p.maxMana = clamp(Math.round(mm), MANA_BASE, MANA_CAP);
    const mn = num(data && data.mana);
    p.mana = clamp(mn !== null ? mn : p.maxMana, 0, p.maxMana);
    const ps = num(data && data.potionSickness);
    p.potionSickness = ps !== null ? clamp(ps, 0, POTION_SICKNESS) : 0;
    return p;
  }

  // Legacy v1 player blobs carried mana/maxMana/potionSickness inline (the
  // old serialize wrap). Lead calls this after building the player.
  function restoreLegacy(data, player) {
    return attachToPlayer(player || TC.player, data);
  }

  // Death refill (was the Player.respawn wrap body).
  function onRespawn(p) {
    if (!p || typeof p !== 'object') return;
    ensureMana(p);
    p.mana = p.maxMana;        // death refills the pool
    p.potionSickness = 0;
    p.manaRegenDelay = 0;
  }

  if (TC.SaveCore && typeof TC.SaveCore.register === 'function') {
    try {
      TC.SaveCore.register('character.core.magic', {
        version: 1,
        serialize(ctx) { return captureOf(ctx ? ctx.player : null); },
        deserialize(data, ctx) { attachToPlayer(ctx ? ctx.player : null, data); }
      });
    } catch (e) {
      console.warn('[TC.Magic] SaveCore provider refused:', e && e.message);
    }
  }

  // ====================================================================
  // Weapon projectiles — delegated to the shared TC.Projectiles pool.
  // ====================================================================

  // TYPES ALIGNMENT: the shared magic_bolt def ships homing 5.5 / bounce 1 /
  // restitution 0.85; classic staffs fired straight, non-bouncing bolts that
  // shattered on walls (restitution 0.95), and per-spawn opts cannot express
  // "none" (bounce <= 0 falls back to the type default; homing and
  // restitution have no per-spawn override). Water Bolt keeps its 4 bounces
  // via per-spawn opts. Flagged for the lead to bake into projectiles.js.
  if (TC.Projectiles && TC.Projectiles.TYPES && TC.Projectiles.TYPES.magic_bolt) {
    const mb = TC.Projectiles.TYPES.magic_bolt;
    mb.homing = 0;
    mb.bounce = 0;
    mb.restitution = 0.95;
  }

  // Impact-burst watchers: pooled slots are recycled, so each fired bolt's
  // last live position is mirrored here and the burst fires when it dies
  // (wall shatter, final pierce hit, or expiry — indistinguishable, so the
  // mid-strength 0.8 burst stands in for the old per-cause sizes).
  const watched = [];
  function watchBolt(p, colors) {
    if (watched.length >= WATCH_CAP) return;
    watched.push({ p: p, lx: p.x, ly: p.y, colors: colors || ['#ffffff'] });
  }
  function sweepWatched() {
    for (let i = watched.length - 1; i >= 0; i--) {
      const w = watched[i];
      if (w.p.active) { w.lx = w.p.x; w.ly = w.p.y; continue; }
      watched.splice(i, 1);
      impactFxAt(w.lx, w.ly, w.colors, 0.8);
    }
  }

  function impactFxAt(x, y, colors, k) {
    pBurst(x, y, Math.max(2, Math.round(5 * k)), colors, 90 * k + 40, 260);
  }

  // Fire one weapon projectile. Returns the pooled projectile (or a local
  // fallback bolt when TC.Projectiles is absent), or null.
  // Base damage scales by the resolver's magicDamage multiplier (melee/ranged
  // scale at their strike sites; magic scales here at fire time).
  function fire(def, x, y, ang) {
    let mul = 1;
    if (TC.Stats && typeof TC.Stats.resolve === 'function' && TC.player) {
      try {
        const st = TC.Stats.resolve(TC.player);
        if (st && typeof st.magicDamage === 'number' && st.magicDamage > 0) mul = st.magicDamage;
      } catch (e) {}
    }
    if (TC.Projectiles && typeof TC.Projectiles.spawn === 'function') {
      const colors = def.colors || ['#ffffff'];
      const p = TC.Projectiles.spawn('magic_bolt', x, y, ang, {
        speed: def.speed || 400,
        dmg: Math.round((def.damage || 5) * mul),
        kb: def.knockback != null ? def.knockback : 3,
        pierce: def.pierce || 0,          // extra enemies after the first hit
        bounce: def.bounce || 0,          // wall bounces before shattering
        gravity: def.gravity || 0,
        crit: def.crit || 0,
        accel: def.accel || 0,
        maxSpeed: def.maxSpeed || 0,
        life: def.life || 1.2,
        hitRadius: (def.size || 4) + 3,   // old circle-vs-rect test radius
        colors: colors
      });
      if (p) watchBolt(p, colors);
      return p;
    }
    return fireFallbackBolt(def, x, y, ang);
  }

  // ---- fallback local sim (ONLY while TC.Projectiles is absent) ----
  const bolts = [];             // legacy fallback projectiles

  function fireFallbackBolt(def, x, y, ang) {
    bolts.push({
      x: x, y: y,
      vx: Math.cos(ang) * (def.speed || 400),
      vy: Math.sin(ang) * (def.speed || 400),
      age: 0, life: def.life || 1.2,
      dmg: def.damage || 5, kb: def.knockback != null ? def.knockback : 3,
      crit: def.crit || 0,
      pierce: def.pierce || 0,          // extra enemies after the first hit
      bounces: def.bounce || 0,         // wall bounces before shattering
      gravity: def.gravity || 0,
      accel: def.accel || 0, maxSpeed: def.maxSpeed || 0,
      spin: 0, spinV: def.type === 'scythe' ? 11 : 0,
      size: def.size || 4,
      colors: def.colors || ['#ffffff'],
      type: def.type || 'bolt',
      trailT: 0,
      hits: new Set()                   // enemies already struck (pierce bookkeeping)
    });
    return bolts[bolts.length - 1];
  }

  function trailParticle(b) {
    pSpawn({
      x: b.x + (Math.random() - 0.5) * b.size,
      y: b.y + (Math.random() - 0.5) * b.size,
      vx: -b.vx * 0.06, vy: -b.vy * 0.06,
      life: 0.22 + Math.random() * 0.12,
      size: Math.max(1.6, b.size * 0.7),
      color: b.colors[(Math.random() * b.colors.length) | 0],
      gravity: 0
    });
  }

  function updateLocalBolts(dt) {
    if (!bolts.length) return;
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.age += dt;
      if (b.age > b.life) { impactFxAt(b.x, b.y, b.colors, 0.4); bolts.splice(i, 1); continue; }

      // scythe-style acceleration along the current heading
      if (b.accel) {
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
        const ns = Math.min(b.maxSpeed || sp, sp + b.accel * dt);
        b.vx = b.vx / sp * ns;
        b.vy = b.vy / sp * ns;
      }
      if (b.gravity) b.vy += b.gravity * dt;
      if (b.spinV) b.spin += b.spinV * dt;

      b.trailT -= dt;
      if (b.trailT <= 0) { b.trailT = 0.035; trailParticle(b); }

      // axis-separated integration vs solid tiles; bouncers reflect, rest shatter
      let dead = false;
      const nx = b.x + b.vx * dt;
      if (b.vx !== 0 && solidPx(nx, b.y)) {
        if (b.bounces > 0) { b.bounces--; b.vx = -b.vx * 0.95; b.x += Math.sign(b.vx) * 1; impactFxAt(b.x, b.y, b.colors, 0.5); }
        else { impactFxAt(b.x, b.y, b.colors, 1); dead = true; }
      } else b.x = nx;
      if (!dead) {
        const ny = b.y + b.vy * dt;
        if (b.vy !== 0 && solidPx(b.x, ny)) {
          if (b.bounces > 0) { b.bounces--; b.vy = -b.vy * 0.95; b.y += Math.sign(b.vy) * 1; impactFxAt(b.x, b.y, b.colors, 0.5); }
          else { impactFxAt(b.x, b.y, b.colors, 1); dead = true; }
        } else b.y = ny;
      }

      // enemy hits: circle-vs-rect like combat.js arrows, pierce-aware
      if (!dead && TC.Enemies && Array.isArray(TC.Enemies.list) &&
          typeof TC.Enemies.damageEnemy === 'function') {
        const list = TC.Enemies.list;
        for (let j = 0; j < list.length; j++) {
          const e = list[j];
          if (!e || e.hp <= 0 || b.hits.has(e)) continue;
          if (distToRect(b.x, b.y, e.x, e.y, e.w, e.h) > b.size + 3) continue;
          b.hits.add(e);
          const roll = rollDamage(b.dmg, b.crit);
          try { TC.Enemies.damageEnemy(e, roll.dmg, b.vx >= 0 ? 1 : -1, b.kb, roll.crit); } catch (e2) {}
          impactFxAt(b.x, b.y, b.colors, 0.8);
          if (b.pierce > 0) b.pierce--;
          else { dead = true; break; }
        }
      }

      if (dead) bolts.splice(i, 1);
    }
  }

  // ====================================================================
  // Mana regen stars — regen accrues into payloads that fly home as small
  // blue stars (Terraria-style); mana lands when the star does. These are
  // pickups, not weapons: the pool's 'falling_star' type (damaging
  // ballistic) does not cover them, so they stay module-local.
  // ====================================================================
  const stars = [];             // mana regen stars homing to the player
  let noManaMsgT = 0;           // throttle for "not enough mana" style texts

  function spawnRegenStar(p, payload) {
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const a = Math.random() * TAU;                 // visual-only randomness
    const rad = 44 + Math.random() * 44;
    stars.push({
      x: cx + Math.cos(a) * rad,
      y: cy - 16 + Math.sin(a) * rad * 0.7,
      vx: 0, vy: 0, t: 0, payload: payload
    });
  }

  function updateStars(dt) {
    const p = TC.player;
    for (let i = stars.length - 1; i >= 0; i--) {
      const s = stars[i];
      s.t += dt;
      if (p) {
        const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
        const dx = cx - s.x, dy = cy - s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const want = 240 + s.t * 420;              // accelerate as it homes
        const k = Math.min(1, dt * 8);
        s.vx += (dx / d * want - s.vx) * k;
        s.vy += (dy / d * want - s.vy) * k;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (d < 14 || s.t > 2.5) {                 // arrived (or timed out)
          restoreMana(p, s.payload);
          pBurst(s.x, s.y, 3, ['#7dc4ff', '#bfe4ff'], 60, 0);
          sfx('pickup');
          stars.splice(i, 1);
        }
      } else {
        stars.splice(i, 1);                        // world gone: drop pending mana
      }
    }
  }

  function updateRegen(dt, p) {
    if (p.manaRegenDelay > 0) { p.manaRegenDelay -= dt; p.manaRegenT = 0; return; }
    if (p.mana >= p.maxMana) { p.manaAccum = 0; p.manaRegenT = 0; return; }
    p.manaRegenT += dt;
    const ramp = Math.min(1, 0.3 + p.manaRegenT * 0.5);   // ramps up over ~1.4s
    p.manaAccum += regenRate(p.maxMana) * ramp * dt;
    if (p.manaAccum >= STAR_PAYLOAD) {
      p.manaAccum -= STAR_PAYLOAD;
      spawnRegenStar(p, STAR_PAYLOAD);
    }
  }

  // ====================================================================
  // Item use — kind 'magic' fires while LMB is held; potions and mana
  // crystals trigger on the click edge. player.js's useHeld() ignores
  // unknown kinds, so these never double-fire. Base damage scales by
  // TC.Stats magicDamage at fire() time (see header).
  // ====================================================================
  function handleUse(dt, p) {
    const inp = TC.Input;
    if (!inp || !inp.mouse || inp.uiHover) return;
    const m = inp.mouse;
    const sel = (p && typeof p.selectedSlot === 'function') ? p.selectedSlot() : null;
    const def = (sel && TC.ITEM_DEFS) ? TC.ITEM_DEFS[sel.id] : null;
    if (!def) return;
    if (def.kind === 'magic') castWeapon(p, def, m);
    else if (def.kind === 'potion' && m.clicked) drinkPotion(p, sel, def);
    else if (def.kind === 'mana_crystal' && m.clicked) useCrystal(p, sel);
  }

  function castWeapon(p, def, m) {
    if (p.magicCd > 0) return;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    if (!isFinite(m.worldX) || !isFinite(m.worldY)) return;
    const ang = Math.atan2(m.worldY - cy, m.worldX - cx);
    if (!spendMana(p, def.mana || 0)) {
      if (noManaMsgT <= 0) {
        pText(cx, p.y - 6, 'Not enough mana!', '#6ab0ff');
        noManaMsgT = 0.9;
      }
      return;
    }
    p.magicCd = def.useTime || 0.3;
    p.manaRegenDelay = REGEN_DELAY;
    fire(def, cx + Math.cos(ang) * 10, cy + Math.sin(ang) * 10, ang);
    pBurst(cx + Math.cos(ang) * 12, cy + Math.sin(ang) * 12, 3, def.colors || ['#ffffff'], 70, 0);
    p.aimAng = ang;
    p.swingSeq = (p.swingSeq || 0) + 1;
    p.swing = {                        // bow-style pose: arm aims at the cursor
      item: def, timer: p.magicCd, dur: p.magicCd,
      swung: true, loop: false, bow: true, id: p.swingSeq
    };
    sfx('swing');
  }

  function drinkPotion(p, sel, def) {
    if (p.potionSickness > 0) {
      if (noManaMsgT <= 0) {
        pText(p.x + p.w / 2, p.y - 6, 'Potion sickness!', '#b07ae8');
        noManaMsgT = 0.9;
      }
      return;
    }
    const got = restoreMana(p, def.manaRestore || 100);
    if (!(got > 0)) return;            // already full: nothing consumed
    consumeOne(p.inventory, sel.id);
    p.potionSickness = POTION_SICKNESS;
    pText(p.x + p.w / 2, p.y - 6, '+' + got + ' mana', '#6ab0ff');
    pBurst(p.x + p.w / 2, p.y + p.h / 2, 6, ['#3a78e0', '#6aa8ff'], 80, 120);
    sfx('pickup');
  }

  function useCrystal(p, sel) {
    if (p.maxMana >= MANA_CAP) {
      if (noManaMsgT <= 0) {
        pText(p.x + p.w / 2, p.y - 6, 'Mana is at its limit', '#7dc4ff');
        noManaMsgT = 0.9;
      }
      return;
    }
    if (!consumeOne(p.inventory, sel.id)) return;
    p.maxMana = Math.min(MANA_CAP, p.maxMana + CRYSTAL_GAIN);
    p.mana = Math.min(p.maxMana, p.mana + CRYSTAL_GAIN);
    pText(p.x + p.w / 2, p.y - 6, '+' + CRYSTAL_GAIN + ' max mana', '#7dc4ff');
    pBurst(p.x + p.w / 2, p.y + p.h / 2, 8, ['#e87af0', '#b05ae8', '#ffffff'], 90, 150);
    sfx('pickup');
  }

  // ====================================================================
  // Per-frame tick (was the Combat.update wrap; lead calls it directly
  // after TC.Combat.update). Also ticks the fallback bolts and stars.
  // ====================================================================
  function update(dt) {
    const p = TC.player;
    if (!p) return;
    ensureMana(p);
    if (noManaMsgT > 0) noManaMsgT -= dt;
    if (p.potionSickness > 0) p.potionSickness = Math.max(0, p.potionSickness - dt);
    if (p.magicCd > 0) p.magicCd -= dt;
    if (TC.state !== 'playing' || p.dead) {
      sweepWatched(); updateLocalBolts(dt); updateStars(dt);
      return;
    }
    handleUse(dt, p);
    updateRegen(dt, p);
    sweepWatched(); updateLocalBolts(dt); updateStars(dt);
  }

  // Wipe transient state (world transitions). Called automatically on
  // WorldLoaded below; also safe to call manually anytime.
  function clear() {
    bolts.length = 0;
    stars.length = 0;
    watched.length = 0;
    noManaMsgT = 0;
  }

  // ====================================================================
  // World-space rendering (was the Combat.draw wrap; lead calls it
  // directly after TC.Combat.draw). Pooled bolts paint themselves inside
  // TC.Projectiles.draw; this pass covers the fallback bolts and the
  // regen stars.
  // ====================================================================
  function drawWorld(ctx, cam) {
    if (!ctx || (!bolts.length && !stars.length)) return;
    ctx.save();
    if (typeof TC.applyCam === 'function') TC.applyCam(ctx);
    else if (cam) ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);

    for (let i = 0; i < bolts.length; i++) {
      const b = bolts[i];
      const c0 = b.colors[0], c1 = b.colors[1] || b.colors[0];
      if (b.type === 'spark') {                    // short bright streak
        ctx.strokeStyle = c1;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(b.x - b.vx * 0.018, b.y - b.vy * 0.018);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.fillStyle = '#fff8dc';
        ctx.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);
      } else if (b.type === 'scythe') {            // spinning crescent
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.spin);
        ctx.strokeStyle = c0;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, b.size, 0.35, Math.PI - 0.35);
        ctx.stroke();
        ctx.strokeStyle = c1;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, b.size * 0.55, 0.6, Math.PI - 0.6);
        ctx.stroke();
        ctx.restore();
      } else {                                     // bolt/orb: glow disc + core
        ctx.globalAlpha = 0.32;
        ctx.fillStyle = c0;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.size * 1.9, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = c1;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.size, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.size * 0.38, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      starPath(ctx, s.x, s.y, 4.5);
      ctx.fillStyle = '#7dc4ff';
      ctx.fill();
      starPath(ctx, s.x, s.y, 2);
      ctx.fillStyle = '#eaf6ff';
      ctx.fill();
    }

    ctx.restore();
  }

  // Four-point twinkle star path centered at (cx,cy).
  function starPath(ctx, cx, cy, r) {
    const k = r * 0.22;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.quadraticCurveTo(cx + k, cy - k, cx + r, cy);
    ctx.quadraticCurveTo(cx + k, cy + k, cx, cy + r);
    ctx.quadraticCurveTo(cx - k, cy + k, cx - r, cy);
    ctx.quadraticCurveTo(cx - k, cy - k, cx, cy - r);
    ctx.closePath();
  }

  // Screen-space HUD (was the UI.draw wrap; lead calls it from UI.draw):
  // column of mana stars under the hearts/breath row, plus the
  // potion-sickness countdown while it lasts.
  function drawHud(ctx, w) {
    if (TC.state !== 'playing') return;
    const p = TC.player;
    if (!p) return;
    ensureMana(p);

    const starN = Math.ceil(p.maxMana / 20);
    const r = 7, step = r * 2 + 3;
    let x = w - 16 - r, y = 58 + r;
    for (let i = 0; i < starN; i++) {
      const frac = clamp((p.mana - i * 20) / 20, 0, 1);
      starPath(ctx, x, y, r);                          // empty socket
      ctx.fillStyle = 'rgba(26,42,66,0.72)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(120,170,220,0.45)';
      ctx.stroke();
      if (frac > 0) {                                  // bottom-up partial fill
        ctx.save();
        ctx.beginPath();
        ctx.rect(x - r - 1, y - r + (1 - frac) * r * 2, r * 2 + 2, r * 2 * frac + 1);
        ctx.clip();
        starPath(ctx, x, y, r);
        ctx.fillStyle = '#4a9fe8';
        ctx.fill();
        starPath(ctx, x, y, r * 0.45);
        ctx.fillStyle = '#bfe4ff';
        ctx.fill();
        ctx.restore();
      }
      y += step;
    }

    const sick = p.potionSickness || 0;
    if (sick > 0) {                                    // tiny flask + seconds left
      const ly = y + 2;
      ctx.fillStyle = '#b07ae8';
      ctx.fillRect(x - 3, ly, 6, 8);
      ctx.fillStyle = '#e8d8ff';
      ctx.fillRect(x - 2, ly + 4, 4, 3);
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillText(Math.ceil(sick) + 's', x - 7, ly + 5);
      ctx.fillStyle = '#c9a0f0';
      ctx.fillText(Math.ceil(sick) + 's', x - 8, ly + 4);
    }
  }

  // ====================================================================
  // Item + recipe registration (extends the lead-owned tables at runtime;
  // entries are skipped if an id ever lands in constants.js first).
  // ====================================================================
  function M(name, o) {              // magic weapon def builder
    return Object.assign({ name, kind: 'magic', maxStack: 1 }, o);
  }

  const MAGIC_ITEMS = {
    wand_sparking:  M('Wand of Sparking', { damage: 6,  mana: 3,  useTime: 0.28, speed: 430, knockback: 2,
                     type: 'spark', size: 3, life: 0.9, colors: ['#ffd76a', '#ffb03a'] }),
    amethyst_staff: M('Amethyst Staff',   { damage: 12, mana: 6,  useTime: 0.30, speed: 480, knockback: 2.5,
                     type: 'bolt', size: 4, life: 1.2, colors: ['#a25ad8', '#c88af0'] }),
    topaz_staff:    M('Topaz Staff',      { damage: 15, mana: 7,  useTime: 0.28, speed: 500, knockback: 2.5,
                     type: 'bolt', size: 4, life: 1.2, colors: ['#e8c84a', '#f8e08a'] }),
    emerald_staff:  M('Emerald Staff',    { damage: 18, mana: 8,  useTime: 0.26, speed: 520, knockback: 3,
                     type: 'bolt', size: 4, pierce: 1, life: 1.3, colors: ['#3fc86a', '#7ae8a0'] }),
    sapphire_staff: M('Sapphire Staff',   { damage: 21, mana: 9,  useTime: 0.24, speed: 540, knockback: 3,
                     type: 'bolt', size: 4, pierce: 1, life: 1.3, colors: ['#3a78e0', '#6aa8ff'] }),
    ruby_staff:     M('Ruby Staff',       { damage: 26, mana: 11, useTime: 0.22, speed: 560, knockback: 3.5,
                     type: 'bolt', size: 5, pierce: 2, crit: 0.02, life: 1.4, colors: ['#e03a5a', '#ff7a92'] }),
    diamond_staff:  M('Diamond Staff',    { damage: 31, mana: 13, useTime: 0.20, speed: 600, knockback: 4,
                     type: 'bolt', size: 5, pierce: 2, crit: 0.04, life: 1.4, colors: ['#bfe8ff', '#ffffff'] }),
    water_bolt:     M('Water Bolt',       { damage: 23, mana: 12, useTime: 0.32, speed: 380, knockback: 3,
                     type: 'orb', size: 6, pierce: 2, bounce: 4, gravity: 140, life: 6,
                     colors: ['#3a6ea8', '#5a8ec8'] }),
    flower_of_fire: M('Flower of Fire',   { damage: 27, mana: 15, useTime: 0.30, speed: 430, knockback: 6,
                     type: 'orb', size: 6, gravity: 260, life: 2.2, colors: ['#e85a1a', '#ffb03a'] }),
    demon_scythe:   M('Demon Scythe',     { damage: 36, mana: 18, useTime: 0.42, speed: 110, knockback: 5,
                     type: 'scythe', size: 9, pierce: 4, accel: 900, maxSpeed: 720, life: 2.6,
                     colors: ['#8a3ac9', '#c86af0'] }),
    mana_potion:   { name: 'Mana Potion', kind: 'potion', manaRestore: 100, maxStack: 30 },
    mana_crystal:  { name: 'Mana Crystal', kind: 'mana_crystal', maxStack: 99 }
  };

  const MAGIC_RECIPES = [
    { out: 'wand_sparking',  n: 1, station: 'workbench', cost: { wood: 10 } },
    { out: 'amethyst_staff', n: 1, station: 'workbench', cost: { copper_bar: 8, wood: 4 } },
    { out: 'topaz_staff',    n: 1, station: 'anvil',     cost: { iron_bar: 8, wood: 4 } },
    { out: 'emerald_staff',  n: 1, station: 'anvil',     cost: { iron_bar: 10, gold_bar: 2 } },
    { out: 'sapphire_staff', n: 1, station: 'anvil',     cost: { gold_bar: 8 } },
    { out: 'ruby_staff',     n: 1, station: 'anvil',     cost: { gold_bar: 10, gel: 10 } },
    { out: 'diamond_staff',  n: 1, station: 'anvil',     cost: { gold_bar: 12, mana_crystal: 1 } },
    { out: 'water_bolt',     n: 1, station: 'anvil',     cost: { glass: 15, gold_bar: 6, mana_crystal: 1 } },
    { out: 'flower_of_fire', n: 1, station: 'anvil',     cost: { gel: 25, torch: 5, gold_bar: 4 } },
    { out: 'demon_scythe',   n: 1, station: 'anvil',     cost: { gel: 40, gold_bar: 8 } },
    { out: 'mana_crystal',   n: 1, station: 'furnace',   cost: { glass: 6, copper_bar: 3 } },
    { out: 'mana_potion',    n: 1, station: 'workbench', cost: { glass: 2, gel: 4 } }
  ];

  function registerData() {
    if (TC.ITEM_DEFS) {
      for (const id in MAGIC_ITEMS) {
        if (!TC.ITEM_DEFS[id]) TC.ITEM_DEFS[id] = MAGIC_ITEMS[id];
      }
    }
    if (Array.isArray(TC.RECIPES)) {
      for (let i = 0; i < MAGIC_RECIPES.length; i++) {
        const r = MAGIC_RECIPES[i];
        const dup = TC.RECIPES.some(function (x) { return x && x.out === r.out; });
        if (!dup) TC.RECIPES.push(r);
      }
    }
    // Stable content ids under this module's own namespace (the shared-table
    // auto-mirror separately records them as core:* — both may coexist).
    if (TC.Registry && typeof TC.Registry.define === 'function') {
      for (const id in MAGIC_ITEMS) {
        try { TC.Registry.define('item', 'magic:' + id, MAGIC_ITEMS[id]); }
        catch (e) { /* duplicate or rejected: content still ships via tables */ }
      }
    }
  }

  // ====================================================================
  // Icons — hand-painted 16px canvases for our ids only, exposed for the
  // lead's items.js iconFor chain (was an Items.iconFor wrap).
  // ====================================================================
  const GEMS = {
    amethyst_staff: '#a25ad8', topaz_staff: '#e8c84a', emerald_staff: '#3fc86a',
    sapphire_staff: '#3a78e0', ruby_staff: '#e03a5a', diamond_staff: '#bfe8ff'
  };

  function paintStaff(g, gem) {
    g.strokeStyle = '#8a5a32';               // wooden shaft
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(4, 14);
    g.lineTo(10, 8);
    g.stroke();
    g.strokeStyle = '#6a4628';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(4, 15);
    g.lineTo(10, 9);
    g.stroke();
    g.fillStyle = gem;                       // faceted gem head
    g.beginPath();
    g.moveTo(12, 1);
    g.lineTo(15, 4);
    g.lineTo(12, 7);
    g.lineTo(9, 4);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.65)';
    g.fillRect(11, 2, 1, 1);
    g.fillStyle = '#4a3a26';                 // binding
    g.fillRect(9, 7, 3, 2);
  }

  function paintWand(g) {
    g.strokeStyle = '#8a5a32';
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(5, 14);
    g.lineTo(10, 9);
    g.stroke();
    g.fillStyle = '#ffd76a';                 // sparking tip cross
    g.fillRect(10, 4, 4, 1.6);
    g.fillRect(11.2, 3, 1.6, 4);
    g.fillStyle = '#fff8dc';
    g.fillRect(11.7, 4.5, 1, 1);
  }

  function fillCircle(g, x, y, r) {
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  function paintWaterBolt(g) {
    g.fillStyle = 'rgba(58,110,168,0.9)';
    fillCircle(g, 8, 8, 5.5);
    g.fillStyle = 'rgba(90,142,200,0.95)';
    fillCircle(g, 8, 8, 3.4);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(8, 8, 2.2, Math.PI * 0.2, Math.PI * 1.3);
    g.stroke();
    g.fillStyle = '#ffffff';
    g.fillRect(6, 5, 1, 1);
  }

  function paintFlowerOfFire(g) {
    g.fillStyle = '#e85a1a';                 // petals
    g.fillRect(7, 2, 2, 3);
    g.fillRect(7, 11, 2, 3);
    g.fillRect(2, 7, 3, 2);
    g.fillRect(11, 7, 3, 2);
    g.fillStyle = '#ffb03a';                 // blazing core
    fillCircle(g, 8, 8, 3);
    g.fillStyle = '#fff3c0';
    fillCircle(g, 8, 8, 1.3);
  }

  function paintDemonScythe(g) {
    g.fillStyle = '#8a3ac9';
    fillCircle(g, 8, 8, 6);
    g.globalCompositeOperation = 'destination-out';   // punch out the crescent
    fillCircle(g, 10.5, 5.5, 5);
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = '#c86af0';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(8, 8, 5.2, Math.PI * 0.5, Math.PI * 1.2);
    g.stroke();
  }

  function paintPotion(g) {
    g.fillStyle = '#8a5a32';                 // cork
    g.fillRect(6, 1, 4, 2);
    g.fillStyle = 'rgba(200,220,235,0.5)';   // neck
    g.fillRect(6, 3, 4, 2);
    g.fillStyle = 'rgba(190,215,235,0.45)';  // bottle body
    g.fillRect(5, 5, 6, 1);
    g.fillRect(4, 6, 8, 8);
    g.fillRect(5, 14, 6, 1);
    g.fillStyle = '#3a78e0';                 // mana liquid
    g.fillRect(5, 9, 6, 5);
    g.fillStyle = '#6aa8ff';
    g.fillRect(5, 9, 6, 1);
    g.fillStyle = 'rgba(255,255,255,0.7)';   // glint
    g.fillRect(5, 6, 1, 3);
  }

  function shard(g, x, y, h, color) {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(x, y - h);
    g.lineTo(x + h * 0.6, y);
    g.lineTo(x, y + h * 0.5);
    g.lineTo(x - h * 0.6, y);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillRect(x - 1, y - h + 1, 1, 1);
  }

  function paintCrystal(g) {
    g.fillStyle = '#6d675a';                 // rocky base
    g.fillRect(4, 12, 8, 2);
    shard(g, 5, 10, 4, '#b05ae8');
    shard(g, 10, 9, 6, '#e87af0');
    shard(g, 13, 11, 3, '#d88af0');
  }

  function paintMagicIcon(g, id) {
    if (GEMS[id]) return paintStaff(g, GEMS[id]);
    switch (id) {
      case 'wand_sparking': return paintWand(g);
      case 'water_bolt': return paintWaterBolt(g);
      case 'flower_of_fire': return paintFlowerOfFire(g);
      case 'demon_scythe': return paintDemonScythe(g);
      case 'mana_potion': return paintPotion(g);
      case 'mana_crystal': return paintCrystal(g);
      default: break;
    }
    g.fillStyle = '#8d8676';                 // unknown: plain chip
    g.fillRect(3, 3, 10, 10);
  }

  const iconCache = new Map();

  // Canvas for a magic item id, or null when the id is not ours.
  function iconFor(id) {
    const key = String(id);
    if (!Object.prototype.hasOwnProperty.call(MAGIC_ITEMS, key)) return null;
    let cv = iconCache.get(key);
    if (cv) return cv;
    cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 16;
    const g = cv.getContext('2d');
    try { paintMagicIcon(g, key); } catch (e) { /* leave blank rather than crash */ }
    iconCache.set(key, cv);
    return cv;
  }

  // ====================================================================
  // Event wiring — reactions only, installed once at load (guarded).
  // ====================================================================
  if (TC.Events && TC.Events.EVENT && typeof TC.Events.on === 'function') {
    // Fresh world: no stray bolts/stars/watchers (clear() stays public).
    TC.Events.on(TC.Events.EVENT.WorldLoaded, function () { clear(); });
  }

  // ---- load-time installation ----
  registerData();

  // ---- public API ----
  TC.Magic = {
    bolts: bolts,                  // fallback sim only (empty while TC.Projectiles exists)
    stars: stars,
    MANA_BASE: MANA_BASE,
    MANA_CAP: MANA_CAP,
    POTION_SICKNESS: POTION_SICKNESS,
    ensureMana: ensureMana,
    spendMana: spendMana,
    restoreMana: restoreMana,
    fire: fire,
    clear: clear,
    update: update,
    drawWorld: drawWorld,
    drawHud: drawHud,
    captureOf: captureOf,
    attachToPlayer: attachToPlayer,
    restoreLegacy: restoreLegacy,
    onRespawn: onRespawn,
    iconFor: iconFor
  };
})();
