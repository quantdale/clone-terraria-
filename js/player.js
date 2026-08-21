/* player.js — TC.Player: physics, mining/building/combat actions, procedural humanoid render. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  const CONST = TC.CONST;
  const TILE = TC.TILE;

  const SW = 20, SH = 42;            // sprite size (slightly larger than the 18x40 hitbox)
  const COL = {
    skin: '#edb98a', hair: '#6b4423', shirt: '#3f6fb5', sleeve: '#33578e',
    pants: '#2e3550', shoe: '#23283b', belt: '#4a3a26', eyeW: '#f4f4f4', pupil: '#26262b'
  };
  const LAND_T = 0.14;               // squash-on-land duration
  const BOW_SPEED = 520;
  const EQUIP_CD = 0.25;             // armor swap cooldown (s)

  // ---- guarded cross-module helpers (sibling modules may be absent) ----
  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') { try { TC.Audio.play(name); } catch (e) {} }
  }
  function pBurst(x, y, n, colors, spd) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try { TC.Particles.burst(x, y, n, { colors: colors, speed: spd }); } catch (e) {}
    }
  }
  function pText(x, y, text, color) {
    if (TC.Particles && typeof TC.Particles.floatText === 'function') {
      try { TC.Particles.floatText(x, y, text, color); } catch (e) {}
    }
  }
  function tDef(id) { return TC.TILE_DEFS ? TC.TILE_DEFS[id] : null; }
  function iDef(id) { return TC.ITEM_DEFS ? TC.ITEM_DEFS[id] : null; }
  function metalColor(id) {          // tier metal from an id prefix; gray fallback
    const m = /^(copper|iron|gold)(_|$)/.exec(String(id || ''));
    return (m && CONST.COLORS && CONST.COLORS[m[1]]) || '#9a9aa2';
  }

  // Remove n of id from a slot; tolerates slot-index or id-based Inventory.remove.
  function consumeFromSlot(inv, slotIdx, id, n) {
    if (!inv || typeof inv.remove !== 'function') return false;
    const read = () => {
      if (typeof inv.get !== 'function') return -1;
      const s = inv.get(slotIdx);
      return (s && s.id === id) ? s.count : 0;
    };
    const before = read();
    if (before <= 0) return false;
    try { inv.remove(slotIdx, n); } catch (e) {}
    if (read() === before) { try { inv.remove(id, n); } catch (e) {} } // id-based fallback
    return read() < before;
  }

  function findSlotWith(inv, id) {
    if (!inv || typeof inv.get !== 'function') return -1;
    const n = (inv.slots && inv.slots.length) ? inv.slots.length : 50;
    for (let i = 0; i < n; i++) {
      const s = inv.get(i);
      if (s && s.id === id && s.count > 0) return i;
    }
    return -1;
  }

  class Player {

    constructor(px, py) {
      this.x = (typeof px === 'number' && isFinite(px)) ? px : 0;
      this.y = (typeof py === 'number' && isFinite(py)) ? py : 0;
      this.w = CONST.PLAYER_W;
      this.h = CONST.PLAYER_H;
      this.vx = 0;
      this.vy = 0;
      this.facing = 1;
      this.onGround = false;
      this.hp = CONST.PLAYER_HP;
      this.maxHp = CONST.PLAYER_HP;
      this.dead = false;
      this.respawnTimer = 0;
      this.iframes = 0;
      this.regenTimer = CONST.REGEN_DELAY;
      this.inWater = false;
      this.fallTiles = 0;
      this.lavaTimer = 0;             // seconds until the next lava burn
      this.breath = 1;                // 0..1 air supply; ui.js reads directly
      this.drownPool = 0;             // fractional drowning damage accumulator
      this.inventory = TC.Inventory ? new TC.Inventory() : null;
      this.equipment = { head: null, body: null, feet: null };   // slot -> armor item id | null
      this.hotbarIndex = 0;
      this.equipCd = 0;               // armor swap cooldown timer
      this.swing = null;              // {item,timer,dur,swung,loop,bow,id}
      this.mineTarget = null;         // {tx,ty,progress}
      this.coyote = 0;
      this.dropT = 0;                 // >0: platform decks stay pass-through (S to drop)
      // internal / cosmetic state
      this.sx = this.x;               // spawn pixel pos, used by respawn()
      this.sy = this.y;
      this.swingSeq = 0;
      this.mining = false;
      this.mineTick = 0;
      this.landT = 0;
      this.walkPhase = 0;
      this.aimAng = 0;
      this.blinkT = 2 + Math.random() * 3;   // visual-only randomness
      this.blinkHold = 0;
    }

    giveStarterKit() {
      const kit = CONST.STARTER_KIT || [];
      if (!this.inventory) return;
      for (let i = 0; i < kit.length; i++) {
        try { this.inventory.add(kit[i][0], kit[i][1]); } catch (e) {}
      }
    }

    // ---- helpers ----

    selectedSlot() {
      if (this.inventory && typeof this.inventory.get === 'function') {
        try { return this.inventory.get(this.hotbarIndex) || null; } catch (e) {}
      }
      return null;
    }

    solidAt(px, py) {
      // px/py are world PIXELS; isSolid expects tile coords, so convert here
      return !!(TC.world && typeof TC.world.solidAtPixel === 'function' && TC.world.solidAtPixel(px, py));
    }

    // Any solid tile overlapping the hitbox if its top-left were at (px, py).
    // fromAbove/prevFeet feed the platform one-way rule (see solidProbe).
    hitsAt(px, py, fromAbove, prevFeet) {
      const e = 0.01, w = this.w, h = this.h, TS = CONST.TS;
      const P = (x, y) => this.solidProbe(x, y, fromAbove, prevFeet);
      if (P(px + e, py + e) || P(px + w - e, py + e) ||
          P(px + e, py + h - e) || P(px + w - e, py + h - e)) return true;
      for (let s = TS; s < h - e; s += TS) {       // mid samples: hitbox taller than a tile
        if (P(px + e, py + s) || P(px + w - e, py + s)) return true;
      }
      for (let s = TS; s < w - e; s += TS) {       // hitbox slightly wider than a tile
        if (P(px + s, py + e) || P(px + s, py + h - e)) return true;
      }
      return false;
    }

    // Shape-aware solidity at a world pixel, built on World.shapeSolidQuery.
    // FULL tiles take the shim's answer verbatim (byte-compatible with the
    // old isSolid path); slopes are refined to the exact local-x surface via
    // TC.Shapes.solidAt because the shim only knows the mid-tile top.
    // PLATFORM decks stop a fall only when approaching from above with the
    // previous-frame feet at/above the deck top, and never while dropT runs.
    solidProbe(px, py, fromAbove, prevFeet) {
      const w = TC.world;
      if (!w || typeof w.isSolid !== 'function') return false;
      const TS = CONST.TS;
      const tx = Math.floor(px / TS), ty = Math.floor(py / TS);
      let q = null;
      if (typeof w.shapeSolidQuery === 'function') {
        try { q = w.shapeSolidQuery(tx, ty, !!fromAbove, py - ty * TS); } catch (e) { q = null; }
      }
      if (!q) return !!w.isSolid(tx, ty);          // pre-shape worlds: legacy answer
      if (q.platform) {
        const top = ty * TS + TS * 5 / 16;         // deck band top (see renderPath)
        if (this.dropT > 0 || !fromAbove) return false;
        if (prevFeet != null && prevFeet > top + 0.5) return false;
        return py >= top;
      }
      if (!q.solid) return false;
      const SHP = TC.Shapes, s = (SHP && typeof w.shapeAt === 'function') ? (w.shapeAt(tx, ty) | 0) : 0;
      if (s >= 3 && s <= 6) {                      // SLOPE_NE..SW: exact local geometry
        const lx = (px - tx * TS) / TS, ly = (py - ty * TS) / TS;
        return !!SHP.solidAt(s, lx, ly);
      }
      return true;                                 // FULL / HALF depth rule stands
    }

    // Ramp step-up target: when moving horizontally into a ground slope
    // column whose walkable top sits within a ~10px step of the feet, return
    // that surface Y (null otherwise).
    slopeStepY(nx) {
      const w = TC.world, SHP = TC.Shapes;
      if (!w || !SHP || typeof w.shapeAt !== 'function') return null;
      const TS = CONST.TS, e = 0.01;
      const leadX = this.vx > 0 ? nx + this.w - e : nx + e;
      const tx = Math.floor(leadX / TS);
      const feet = this.y + this.h - e;
      const ty = Math.floor(feet / TS);
      const s = w.shapeAt(tx, ty) | 0;
      if (s !== SHP.SLOPE_SE && s !== SHP.SLOPE_SW) return null;
      const lx = Math.min(1, Math.max(0, leadX / TS - tx));
      const surf = ty * TS + SHP.topSurfaceY(s, lx) * TS;
      const rise = feet + e - surf;                // how far the surface tops the feet
      if (rise <= 0 || rise > TS * 0.625) return null;
      return surf;
    }

    // Landing snap for a fall that entered row floor((ny+h)/TS). Shaped feet-row
    // cells snap their own surface (ramp top under the sample x, HALF mid,
    // platform deck); FULL-only landings reproduce the legacy tile-top formula.
    landSnapY(ny, feetBefore) {
      const TS = CONST.TS, e = 0.01;
      const legacy = Math.floor((ny + this.h) / TS) * TS - this.h - e;
      const w = TC.world, SHP = TC.Shapes;
      if (!w || !SHP || typeof w.shapeAt !== 'function') return legacy;
      const rowTy = Math.floor((ny + this.h - e) / TS);
      const py = ny + this.h - e;                  // post-move feet depth
      let best = Infinity;
      const xs = [this.x + e, this.x + this.w / 2, this.x + this.w - e];
      for (let k = 0; k < 3; k++) {
        const sx = xs[k], tx = Math.floor(sx / TS);
        const s = w.shapeAt(tx, rowTy) | 0;
        if (!s || s === SHP.FULL) continue;        // FULL keeps the legacy snap
        const lx = Math.min(1, Math.max(0, sx / TS - tx));
        let top = null;
        if (s === SHP.PLATFORM) {
          if (this.dropT > 0) continue;
          top = rowTy * TS + TS * 5 / 16;
          if (py < top) continue;
          if (feetBefore != null && feetBefore > top + 0.5) continue;
        } else if (s === SHP.HALF) {
          top = rowTy * TS + TS / 2;
          if (py < top) continue;
        } else if (s >= SHP.SLOPE_NE && s <= SHP.SLOPE_SW) {
          top = rowTy * TS + SHP.topSurfaceY(s, lx) * TS;
          if (!SHP.solidAt(s, lx, (py - rowTy * TS) / TS)) continue;
        } else continue;
        const cand = top - this.h;
        if (cand < best) best = cand;              // highest surface among blockers wins
      }
      if (best === Infinity) return legacy;
      if (best < this.y) best = this.y;            // never snap upward past the body
      return best;
    }

    // True while any cell just under the feet is platform-shaped (drop-through gate).
    standingOnPlatform() {
      const w = TC.world, SHP = TC.Shapes;
      if (!w || !SHP || typeof w.shapeAt !== 'function') return false;
      const TS = CONST.TS, e = 0.01;
      const ty = Math.floor((this.y + this.h + 2) / TS);
      const xs = [this.x + e, this.x + this.w / 2, this.x + this.w - e];
      for (let k = 0; k < 3; k++) {
        if ((w.shapeAt(Math.floor(xs[k] / TS), ty) | 0) === SHP.PLATFORM) return true;
      }
      return false;
    }

    checkWater() {
      if (!TC.world || typeof TC.world.get !== 'function') return false;
      const TS = CONST.TS, e = 0.01;
      const x0 = Math.floor((this.x + e) / TS), x1 = Math.floor((this.x + this.w - e) / TS);
      const y0 = Math.floor((this.y + e) / TS), y1 = Math.floor((this.y + this.h - e) / TS);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (TC.world.get(tx, ty) === TILE.WATER) return true;
        }
      }
      return false;
    }

    checkLava() {
      if (!TC.world || typeof TC.world.get !== 'function') return false;
      const TS = CONST.TS, e = 0.01;
      const x0 = Math.floor((this.x + e) / TS), x1 = Math.floor((this.x + this.w - e) / TS);
      const y0 = Math.floor((this.y + e) / TS), y1 = Math.floor((this.y + this.h - e) / TS);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (TC.world.get(tx, ty) === TILE.LAVA) return true;
        }
      }
      return false;
    }

    // Head-submersion test for the breath meter: single tile sample.
    checkHeadWater() {
      if (!TC.world || typeof TC.world.get !== 'function') return false;
      const TS = CONST.TS;
      return TC.world.get(Math.floor((this.x + this.w / 2) / TS),
        Math.floor((this.y + 6) / TS)) === TILE.WATER;
    }

    inReach(tx, ty) {
      const TS = CONST.TS;
      const dx = tx * TS + TS / 2 - (this.x + this.w / 2);
      const dy = ty * TS + TS / 2 - (this.y + this.h / 2);
      return dx * dx + dy * dy <= CONST.REACH * CONST.REACH;
    }

    walkFrame() {
      if (!this.onGround) return 1;
      if (Math.abs(this.vx) < 10) return 0;
      return Math.floor(this.walkPhase * 4) % 4;
    }

    // Total defense via the stat resolver (armor + accessories + buffs).
    totalDefense() {
      if (TC.Stats && typeof TC.Stats.resolve === 'function') {
        return TC.Stats.resolve(this).defense;
      }
      const eq = this.equipment;
      if (!eq) return 0;
      const slots = (CONST.EQUIP_SLOTS && CONST.EQUIP_SLOTS.length)
        ? CONST.EQUIP_SLOTS : ['head', 'body', 'feet'];
      let n = 0;
      for (let i = 0; i < slots.length; i++) {
        const d = iDef(eq[slots[i]]);
        if (d && d.kind === 'armor') n += d.defense || 0;
      }
      return n;
    }

    // ---- update ----

    update(dt) {
      if (this.dead) {
        this.respawnTimer -= dt;
        if (this.respawnTimer <= 0) this.respawn();
        return;
      }
      if (this.iframes > 0) this.iframes -= dt;
      if (this.landT > 0) this.landT -= dt;
      if (this.equipCd > 0) this.equipCd -= dt;
      if (this.blinkHold > 0) this.blinkHold -= dt;
      this.blinkT -= dt;
      if (this.blinkT <= 0) { this.blinkT = 2 + Math.random() * 3; this.blinkHold = 0.12; }

      const inp = TC.Input;
      if (inp) this.readHotbar(inp);

      // intent
      let ix = 0, jump = false;
      if (inp && typeof inp.axis === 'function') {
        const a = inp.axis();
        ix = a ? (a.x || 0) : 0;
        jump = !!(a && a.jump);
      }

      this.inWater = this.checkWater();

      // S/Down on a platform deck: suspend platform collision briefly and
      // drop through (HALF blocks and slopes stay solid regardless).
      if (this.dropT > 0) this.dropT -= dt;
      if (inp && typeof inp.down === 'function' && !jump && this.onGround &&
          (inp.down('KeyS') || inp.down('ArrowDown')) && this.standingOnPlatform()) {
        this.dropT = 0.25;
        this.onGround = false;
      }

      // lava burns on a fixed cadence while any hitbox tile is lava
      if (this.checkLava()) {
        this.lavaTimer -= dt;
        if (this.lavaTimer <= 0) {
          this.lavaTimer = CONST.LAVA_TICK;
          const cx = this.x + this.w / 2, cy = this.y + this.h / 2;
          if (TC.Combat && typeof TC.Combat.hurtPlayer === 'function') {
            try { TC.Combat.hurtPlayer(CONST.LAVA_DMG, 0, -120, 'lava'); } catch (e) { this.damage(CONST.LAVA_DMG, 0, -120, 'lava'); }
          } else {
            this.damage(CONST.LAVA_DMG, 0, -120, 'lava');
          }
          pBurst(cx, cy, 6, ['#e85a1a', '#ffb03a'], 90);   // hurt sfx comes from the hurtPlayer path
        }
      } else {
        this.lavaTimer = 0;
      }

      // breath: drain underwater, drown at zero, recover fast in air
      if (this.checkHeadWater()) {
        this.breath -= dt / CONST.BREATH_SECONDS;
        if (this.breath <= 0) {
          this.breath = 0;
          this.drownPool += CONST.DROWN_DMG * dt;
          if (this.drownPool >= 1) {
            const d = Math.floor(this.drownPool);
            this.drownPool -= d;
            if (TC.Combat && typeof TC.Combat.hurtPlayer === 'function') {
              try { TC.Combat.hurtPlayer(d, 0, 0, 'drown'); } catch (e) { this.damage(d, 0, 0, 'drown'); }
            } else {
              this.damage(d, 0, 0, 'drown');
            }
          }
        }
      } else {
        this.breath = Math.min(1, this.breath + dt * 2);
        if (this.breath >= 1) this.drownPool = 0;
      }

      // resolved stats: max health sync, movement, regen (accessories/buffs/armor)
      const st = (TC.Stats && typeof TC.Stats.resolve === 'function') ? TC.Stats.resolve(this) : null;
      if (st && st.maxHealth > 0) {
        const prevMax = this.maxHp;
        this.maxHp = st.maxHealth;
        if (this.maxHp > prevMax) this.hp += this.maxHp - prevMax;
        if (this.hp > this.maxHp) this.hp = this.maxHp;
      }

      // horizontal
      const wm = this.inWater ? CONST.SWIM_MOVE_MULT : 1;
      const spdMul = st ? st.moveSpeed : 1;
      const maxSp = CONST.RUN_MAX * spdMul * wm;
      const accel = CONST.RUN_ACCEL * spdMul * wm;
      if (ix !== 0) {
        this.vx += ix * accel * dt;
        if (this.vx > maxSp) this.vx = maxSp;
        if (this.vx < -maxSp) this.vx = -maxSp;
        this.facing = ix > 0 ? 1 : -1;
      } else {
        const fr = (this.onGround ? CONST.GROUND_FRICTION : CONST.AIR_FRICTION) * wm * dt;
        if (this.vx > fr) this.vx -= fr;
        else if (this.vx < -fr) this.vx += fr;
        else this.vx = 0;
      }

      // jump / swim strokes
      if (jump) {
        if (this.inWater) {
          if (this.vy > CONST.SWIM_STROKE) this.vy = CONST.SWIM_STROKE;
          this.fallTiles = 0;
        } else if (this.onGround || this.coyote > 0) {
          this.vy = -CONST.JUMP_VEL * ((st && st.jumpPower) || 1);
          this.coyote = 0;
          this.onGround = false;
        }
      }

      // gravity + fall tracking
      this.vy += CONST.GRAVITY * (this.inWater ? CONST.SWIM_GRAVITY_MULT : 1) * dt;
      const term = this.inWater ? CONST.SWIM_MAX_FALL : CONST.MAX_FALL;
      if (this.vy > term) this.vy = term;
      if (this.inWater) this.fallTiles = 0;
      else if (this.vy > 0 && !this.onGround) this.fallTiles += (this.vy * dt) / CONST.TS;

      this.moveAndCollide(dt);

      // safety net below the world
      if (TC.world && this.y > TC.world.height * CONST.TS + 120) {
        this.damage(9999, 0, 0, 'void');
      }

      // actions
      this.mining = false;
      let held = false;
      if (inp && inp.mouse && inp.mouse.down && !inp.uiHover && TC.state === 'playing') {
        held = true;
        this.useHeld(dt);
      }
      if (!held) this.mineTarget = null;

      // independent right-click interaction (doors, chests); never swings
      if (inp && inp.mouse && inp.mouse.rightClicked && !inp.uiHover &&
          TC.state === 'playing' && !this.dead) {
        this.interact(inp.mouse);
      }

      this.advanceSwing(dt);

      // natural regen
      const regenRate = st ? st.healthRegen : CONST.REGEN_RATE;
      this.regenTimer -= dt;
      if (this.regenTimer <= 0 && this.hp < this.maxHp) {
        this.hp = Math.min(this.maxHp, this.hp + regenRate * dt);
      }

      this.walkPhase += (Math.abs(this.vx) * dt) / 48;
    }

    readHotbar(inp) {
      if (typeof inp.pressed === 'function') {
        for (let i = 0; i < 10; i++) {
          if (inp.pressed('Digit' + ((i + 1) % 10))) this.hotbarIndex = i;
        }
      }
      if (inp.hotbarScroll) {
        const d = inp.hotbarScroll > 0 ? 1 : -1;
        this.hotbarIndex = (this.hotbarIndex + d + 10) % 10;
        inp.hotbarScroll = 0;
      }
    }

    moveAndCollide(dt) {
      const TS = CONST.TS;
      const wasGround = this.onGround;
      const feetBefore = this.y + this.h;          // previous-frame feet (one-way rule)

      // X
      const nx = this.x + this.vx * dt;
      if (this.vx !== 0 && this.hitsAt(nx, this.y)) {
        const stepTo = wasGround ? this.slopeStepY(nx) : null;
        if (stepTo != null && !this.hitsAt(nx, stepTo - this.h)) {
          this.x = nx;
          this.y = stepTo - this.h;                // smooth ramp climb
        } else if (wasGround && !this.hitsAt(nx, this.y - TS)) {
          this.x = nx;
          this.y -= TS;                            // 1-tile auto step-up
        } else {
          this.x = this.vx > 0
            ? Math.floor((nx + this.w) / TS) * TS - this.w - 0.01
            : (Math.floor(nx / TS) + 1) * TS + 0.01;
          this.vx = 0;
        }
      } else {
        this.x = nx;
      }

      // Y
      const ny = this.y + this.vy * dt;
      if (this.vy > 0 && this.hitsAt(this.x, ny, true, feetBefore)) {
        this.y = this.landSnapY(ny, feetBefore);
        this.vy = 0;
      } else if (this.vy < 0 && this.hitsAt(this.x, ny)) {
        this.y = (Math.floor(ny / TS) + 1) * TS + 0.01;
        this.vy = 0;
      } else {
        this.y = ny;
      }

      this.onGround = this.vy >= 0 &&
        this.hitsAt(this.x, this.y + 0.08, true, this.y + this.h);
      if (this.onGround) this.coyote = CONST.COYOTE;
      else this.coyote -= dt;

      // landing: fall damage + squash
      if (this.onGround && !wasGround) {
        const tiles = this.fallTiles;
        this.fallTiles = 0;
        if (tiles > 2) this.landT = LAND_T;
        if (tiles > CONST.FALL_SAFE_TILES && !this.inWater) {
          const dmg = Math.max(1, Math.round((tiles - CONST.FALL_SAFE_TILES) * CONST.FALL_DMG_PER_TILE));
          if (TC.Combat && typeof TC.Combat.hurtPlayer === 'function') {
            try { TC.Combat.hurtPlayer(dmg, 0, 0, 'fall'); } catch (e) { this.damage(dmg, 0, 0, 'fall'); }
          } else {
            this.damage(dmg, 0, 0, 'fall');
          }
        }
      }
    }

    // ---- item use ----

    useHeld(dt) {
      const inp = TC.Input, m = inp.mouse;
      const sel = this.selectedSlot();
      const def = sel ? iDef(sel.id) : null;
      const cx = this.x + this.w / 2;
      if (isFinite(m.worldX)) this.facing = m.worldX >= cx ? 1 : -1;
      if (!def) { this.mineTarget = null; return; }
      if (TC.Gear && TC.Gear.onUseHeld(this, def, dt)) return;
      if (TC.Loot && TC.Loot.onUseHeld(this, def, dt)) return;
      if (TC.Fishing && typeof TC.Fishing.onUseHeld === 'function' && TC.Fishing.onUseHeld(this, def, dt)) return;
      if (TC.Accessories && typeof TC.Accessories.onUseHeld === 'function' && TC.Accessories.onUseHeld(this, def, dt)) return;
      switch (def.kind) {
        case 'tool': this.doMine(def, m, dt); break;
        case 'block': this.mineTarget = null; this.doPlace(def, sel.id, m); break;
        case 'weapon': this.mineTarget = null; this.doMelee(def); break;
        case 'ranged': this.mineTarget = null; this.doBow(def, m); break;
        case 'armor': this.mineTarget = null; this.doEquip(def, sel.id); break;
        case 'summon': this.mineTarget = null; this.doSummon(def, sel.id); break;
        default: this.mineTarget = null;
      }
    }

    // Right-click: toggle doors open/closed, open chests. Consumes nothing.
    interact(m) {
      const world = TC.world;
      if (!world || typeof world.get !== 'function' || typeof world.set !== 'function') return;
      const TS = CONST.TS;
      const tx = Math.floor(m.worldX / TS), ty = Math.floor(m.worldY / TS);
      if (!this.inReach(tx, ty)) return;
      if (TC.Wiring && typeof TC.Wiring.interact === 'function') {
        try { if (TC.Wiring.interact(this, m)) return; } catch (w) {}
      }
      const id = world.get(tx, ty);
      if (id === TILE.DOOR_CLOSED || id === TILE.DOOR_OPEN) {
        const next = id === TILE.DOOR_CLOSED ? TILE.DOOR_OPEN : TILE.DOOR_CLOSED;
        const nd = tDef(next);
        if (nd && nd.solid) {              // don't shut a door into the player
          const rx = tx * TS, ry = ty * TS;
          if (rx < this.x + this.w && rx + TS > this.x &&
              ry < this.y + this.h && ry + TS > this.y) return;
        }
        let ok = true;
        try { ok = world.set(tx, ty, next) !== false; } catch (e) { return; }
        if (ok) sfx('place');
      } else if (id === TILE.CHEST) {
        if (TC.UI && typeof TC.UI.openChest === 'function') {
          try { TC.UI.openChest(tx, ty); } catch (e) {}
        }
      }
    }

    doMine(def, m, dt) {
      const world = TC.world;
      if (!world || typeof world.get !== 'function' || typeof world.applyMineDamage !== 'function') return;
      const TS = CONST.TS;
      const tx = Math.floor(m.worldX / TS), ty = Math.floor(m.worldY / TS);
      if (!this.inReach(tx, ty)) { this.mineTarget = null; return; }

      // hammers reshape shapeable tiles instead of mining them
      if (def.tool === 'hammer' && typeof world.canShape === 'function' &&
          typeof world.hammer === 'function' && world.canShape(tx, ty)) {
        this.doHammer(def, world, tx, ty, dt);
        return;
      }

      const id = world.get(tx, ty);
      const td = tDef(id);
      if (!td || id === TILE.AIR || !(td.hardness > 0) || td.hardness >= 9999 ||
          (td.minPower || 0) > def.power || (td.tool !== 'any' && td.tool !== def.tool)) {
        this.doMineWall(def, m, dt, tx, ty, id, td);   // nothing minable here: try the wall behind
        return;
      }
      const tcx = tx * TS + TS / 2, tcy = ty * TS + TS / 2;

      // axes fell whole trees instead of chipping trunks tile-by-tile
      if (def.tool === 'axe' && id === TILE.TRUNK) {
        this.mineTarget = null;
        this.startSwing(def, true);
        this.fellTree(tx, ty);
        return;
      }

      if (!this.mineTarget || this.mineTarget.tx !== tx || this.mineTarget.ty !== ty) {
        this.mineTarget = { tx, ty, progress: 0 };
        this.mineTick = 0;
      }
      this.mining = true;
      this.startSwing(def, true);

      const rate = (def.power / 100) * dt / td.hardness;
      this.mineTarget.progress += rate;
      let broken = false;
      try { broken = !!world.applyMineDamage(tx, ty, rate); } catch (e) {}

      this.mineTick -= dt;
      if (this.mineTick <= 0) {
        this.mineTick = 0.2;
        sfx('dig');
        pBurst(tcx, tcy, 3, td.colors, 70);
      }

      if (broken) {
        this.mineTarget = null;
        this.mineTick = 0;
        sfx('break');
        if (id === TILE.CHEST && TC.Chests && typeof TC.Chests.spill === 'function') {
          try { TC.Chests.spill(tx, ty); } catch (e) {}   // scatter stored items first
        }
        // canonical break completion: exactly one tile write + one TileBroken
        try { world.set(tx, ty, TILE.AIR); } catch (e) {}
        if (TC.Events) {
          try { TC.Events.emit(TC.Events.EVENT.TileBroken, { tx: tx, ty: ty, id: id }); } catch (eb) {}
        }
        if (td.drop && TC.Items && typeof TC.Items.spawnDrop === 'function') {
          try { TC.Items.spawnDrop(tcx, tcy, td.drop, 1); } catch (e) {}
        }
        pBurst(tcx, tcy, 10, td.colors, 120);
        try {
          if (world.damage && typeof world.damage.delete === 'function') {
            world.damage.delete(ty * world.width + tx);
          }
        } catch (e) {}
      }
    }

    // Hammer shaping on the normal mining cadence: cycles FULL -> PLATFORM ->
    // HALF -> slopes (platform decks flip deck/full). Never mines.
    doHammer(def, world, tx, ty, dt) {
      const TS = CONST.TS;
      const tcx = tx * TS + TS / 2, tcy = ty * TS + TS / 2;
      this.mineTarget = null;
      this.mining = true;
      this.startSwing(def, true);
      this.mineTick -= dt;
      if (this.mineTick > 0) return;
      this.mineTick = 0.2;
      let changed = false;
      try { changed = !!world.hammer(tx, ty); } catch (e) {}
      sfx('dig');
      pBurst(tcx, tcy, 3, ['#c8c8cf', '#8f8f98'], 70);
      if (changed) pBurst(tcx, tcy, 2, ['#ffffff'], 40);
    }

    // Background-wall mining: picks only, and only where no minable tile sits.
    // Walls drop nothing in v1; progress reuses the mineTarget pattern.
    doMineWall(def, m, dt, tx, ty, id, td) {
      const world = TC.world;
      const wdefs = TC.WALL_DEFS;
      if (def.tool !== 'pick' || !wdefs ||
          typeof world.getWall !== 'function' ||
          typeof world.applyWallDamage !== 'function') {
        this.mineTarget = null;
        return;
      }
      if (!(id === TILE.AIR || (td && td.replaceable))) { this.mineTarget = null; return; }
      const wallId = world.getWall(tx, ty);
      const wd = wdefs[wallId];
      if (!(wallId > 0) || !wd || !(wd.hardness > 0)) { this.mineTarget = null; return; }

      const TS = CONST.TS;
      const tcx = tx * TS + TS / 2, tcy = ty * TS + TS / 2;

      if (!this.mineTarget || this.mineTarget.tx !== tx || this.mineTarget.ty !== ty) {
        this.mineTarget = { tx, ty, progress: 0 };
        this.mineTick = 0;
      }
      this.mining = true;
      this.startSwing(def, true);

      const rate = (def.power / 100) * dt / wd.hardness;
      this.mineTarget.progress += rate;
      let broken = false;
      try { broken = !!world.applyWallDamage(tx, ty, rate); } catch (e) {}

      this.mineTick -= dt;
      if (this.mineTick <= 0) {
        this.mineTick = 0.2;
        sfx('dig');
        pBurst(tcx, tcy, 3, [wd.color], 70);
      }

      if (broken) {
        this.mineTarget = null;
        this.mineTick = 0;
        sfx('break');
        // applyWallDamage may or may not remove the wall itself; make sure it's gone
        try { world.setWall(tx, ty, TC.WALL.NONE); } catch (e) {}
        try { world.clearWallDamage(tx, ty); } catch (e) {}
        pBurst(tcx, tcy, 10, [wd.color], 120);
      }
    }

    // BFS connected trunk, plus leaves adjacent to it; remove via setRaw, drop wood per trunk.
    fellTree(tx, ty) {
      const world = TC.world;
      if (!world || typeof world.setRaw !== 'function' || typeof world.get !== 'function') return;
      if (world.get(tx, ty) !== TILE.TRUNK) return;
      const DIR = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

      const trunks = [];
      const seen = new Set();
      const q = [[tx, ty]];
      seen.add(tx + ',' + ty);
      while (q.length && trunks.length < 400) {
        const cur = q.pop();
        trunks.push(cur);
        for (let i = 0; i < 8; i++) {
          const nx2 = cur[0] + DIR[i][0], ny2 = cur[1] + DIR[i][1];
          const k = nx2 + ',' + ny2;
          if (!seen.has(k) && world.get(nx2, ny2) === TILE.TRUNK) {
            seen.add(k);
            q.push([nx2, ny2]);
          }
        }
      }

      const leaves = [];
      const seenL = new Set();
      for (let i = 0; i < trunks.length; i++) {
        for (let d = 0; d < 8; d++) {
          const lx = trunks[i][0] + DIR[d][0], ly = trunks[i][1] + DIR[d][1];
          const k = lx + ',' + ly;
          if (!seen.has(k) && !seenL.has(k) && world.get(lx, ly) === TILE.LEAVES) {
            seenL.add(k);
            leaves.push([lx, ly]);
          }
        }
      }

      const TS = CONST.TS;
      const remove = (rx, ry) => {
        try { world.setRaw(rx, ry, TILE.AIR); } catch (e) {}
        if (TC.Lighting && typeof TC.Lighting.onTileChanged === 'function') {
          try { TC.Lighting.onTileChanged(rx, ry); } catch (e) {}
        }
      };
      for (let i = 0; i < trunks.length; i++) {
        remove(trunks[i][0], trunks[i][1]);
        if (TC.Items && typeof TC.Items.spawnDrop === 'function') {
          try {
            TC.Items.spawnDrop(trunks[i][0] * TS + TS / 2, trunks[i][1] * TS + TS / 2, 'wood', 1);
          } catch (e) {}
        }
      }
      for (let i = 0; i < leaves.length; i++) remove(leaves[i][0], leaves[i][1]);

      sfx('break');
      pBurst(tx * TS + TS / 2, ty * TS + TS / 2, 12, ['#7a5230', '#6a4628', '#2f8f38'], 130);
    }

    doPlace(def, itemId, m) {
      if (typeof itemId === 'string' && itemId === 'actuator' && TC.Wiring &&
          typeof TC.Wiring.attachActuatorAt === 'function') {
        try { TC.Wiring.attachActuatorAt(this, m); } catch (w) {}
        return;
      }
      if (def.tile == null) return;
      const world = TC.world;
      if (!world || typeof world.get !== 'function' || typeof world.set !== 'function') return;
      const TS = CONST.TS;
      const tx = Math.floor(m.worldX / TS), ty = Math.floor(m.worldY / TS);
      if (!this.inReach(tx, ty)) return;
      const cur = world.get(tx, ty);
      const cd = tDef(cur);
      if (!(cur === TILE.AIR || (cd && cd.replaceable))) return;

      // needs an orthogonal non-air neighbor to attach to
      const around = [
        world.get(tx + 1, ty), world.get(tx - 1, ty),
        world.get(tx, ty + 1), world.get(tx, ty - 1)
      ];
      let anchored = false;
      for (let i = 0; i < 4; i++) {
        if (around[i] != null && around[i] !== TILE.AIR) { anchored = true; break; }
      }
      if (!anchored) return;

      // solid tiles may not be placed inside the player hitbox
      const pd = tDef(def.tile);
      if (pd && pd.solid) {
        const rx = tx * TS, ry = ty * TS;
        if (rx < this.x + this.w && rx + TS > this.x &&
            ry < this.y + this.h && ry + TS > this.y) return;
      }

      let ok = true;
      try { ok = world.set(tx, ty, def.tile) !== false; } catch (e) { return; }
      if (!ok) return;
      consumeFromSlot(this.inventory, this.hotbarIndex, itemId, 1);
      sfx('place');
    }

    doMelee(def) {
      if (this.swing && this.swing.item === def) return;   // mid-swing
      this.swing = {
        item: def, timer: def.useTime || 0.3, dur: def.useTime || 0.3,
        swung: false, loop: false, bow: false, id: ++this.swingSeq
      };
    }

    doBow(def, m) {
      if (this.swing && this.swing.item === def) return;   // waiting on useTime
      const inv = this.inventory;
      const slot = findSlotWith(inv, 'arrow');
      if (slot < 0) return;
      const cx = this.x + this.w / 2, cy = this.y + this.h / 2;
      const ang = Math.atan2(m.worldY - cy, m.worldX - cx);
      if (!consumeFromSlot(inv, slot, 'arrow', 1)) return;
      this.aimAng = ang;
      const ad = iDef('arrow');
      const dmg = (def.damage || 0) + ((ad && ad.damage) || 0);
      if (TC.Combat && typeof TC.Combat.shootArrow === 'function') {
        try { TC.Combat.shootArrow(cx, cy, ang, BOW_SPEED, dmg); } catch (e) {}
      }
      this.swing = {
        item: def, timer: def.useTime || 0.8, dur: def.useTime || 0.8,
        swung: true, loop: false, bow: true, id: ++this.swingSeq
      };
    }

    // Equip armor from the selected slot; the worn piece returns to that slot.
    doEquip(def, itemId) {
      if (this.equipCd > 0) return;
      const slot = def.slot;
      if (slot !== 'head' && slot !== 'body' && slot !== 'feet') return;   // unknown slot
      const inv = this.inventory;
      if (!inv) return;
      const put = this.equipment[slot] ? { id: this.equipment[slot], count: 1 } : null;
      let done = false;
      if (typeof inv.swapOrPlace === 'function') {
        try { inv.swapOrPlace(this.hotbarIndex, put); done = true; } catch (e) {}
      }
      if (!done && inv.slots) {          // fallback: write the slot directly
        try { inv.slots[this.hotbarIndex] = put; done = true; } catch (e) {}
      }
      if (!done) return;
      this.equipment[slot] = itemId;
      this.equipCd = EQUIP_CD;
      sfx('pickup');
    }

    // Summon items (kind 'summon'): wake the boss at night, one charge per use.
    doSummon(def, itemId) {
      if (this.swing && this.swing.item === def) return;   // waiting on useTime
      if (!def.boss) return;
      if (!(TC.Enemies && typeof TC.Enemies.spawnBoss === 'function')) return;
      const cx = this.x + this.w / 2;
      const dl = (TC.Sky && typeof TC.Sky.daylight === 'function') ? TC.Sky.daylight() : 1;
      if (dl >= 0.5) {                   // night only; nothing consumed
        pText(cx, this.y - 6, 'The eye only stirs at night...',
          (CONST.COLORS && CONST.COLORS.crit) || '#ff5a48');
        this.swing = { item: def, timer: 0.6, dur: 0.6, swung: true, loop: false, bow: false, id: ++this.swingSeq };
        return;
      }
      if (!consumeFromSlot(this.inventory, this.hotbarIndex, itemId, 1)) return;
      const TS = CONST.TS;
      let bx2 = cx, by2 = this.y + this.h / 2 - 400;   // boss enters above the player
      if (TC.world) {                    // clamp inside world bounds
        const lo = 8, hiX = Math.max(lo, TC.world.width * TS - 8);
        const hiY = Math.max(lo, TC.world.height * TS - 8);
        bx2 = Math.min(Math.max(bx2, lo), hiX);
        by2 = Math.min(Math.max(by2, lo), hiY);
      }
      try { TC.Enemies.spawnBoss(def.boss, bx2, by2); } catch (e) {}
      if (TC.UI && typeof TC.UI.toast === 'function') {
        try { TC.UI.toast('Eye of the Void has awoken!'); } catch (e) {}
      }
      sfx('die');
      this.swing = {
        item: def, timer: def.useTime || 0.5, dur: def.useTime || 0.5,
        swung: true, loop: false, bow: false, id: ++this.swingSeq
      };
    }

    startSwing(def, loop) {
      if (!this.swing || this.swing.item !== def) {
        this.swing = {
          item: def, timer: def.useTime || 0.3, dur: def.useTime || 0.3,
          swung: true, loop: !!loop, bow: false, id: ++this.swingSeq
        };
      } else {
        this.swing.loop = !!loop;
      }
    }

    advanceSwing(dt) {
      const s = this.swing;
      if (!s) return;
      s.timer -= dt;
      if (!s.bow && !s.swung && s.item && s.item.kind === 'weapon') {
        const p = 1 - s.timer / s.dur;
        if (p >= 0.3) {                      // middle 40% of the arc, once per swing
          s.swung = true;
          this.meleeStrike(s);
        }
      }
      if (s.timer <= 0) {
        if (s.loop && this.mining) s.timer += s.dur;   // tools loop while mining
        else this.swing = null;
      }
    }

    meleeStrike(s) {
      const cx = this.x + this.w / 2, cy = this.y + this.h / 2;
      const base = this.facing === 1 ? 0 : Math.PI;
      const arc = 55 * Math.PI / 180;
      if (TC.Combat && typeof TC.Combat.meleeStrike === 'function') {
        try {
          TC.Combat.meleeStrike(cx, cy, 34, base - arc, base + arc,
            s.item.damage || 1, s.item.knockback || 3, s.id);
        } catch (e) {}
      }
    }

    // ---- health ----

    damage(dmg, kbx, kby, src) {
      if (this.dead || this.iframes > 0) return;
      dmg = Math.max(1, Math.round(dmg));
      dmg -= Math.min(this.totalDefense(), dmg - 1);   // armor softens; at least 1 lands
      this.hp -= dmg;
      this.vx += (kbx || 0) * 24;            // partial knockback
      this.vy += (kby || 0) * 24;
      if (this.vx > 420) this.vx = 420; else if (this.vx < -420) this.vx = -420;
      if (this.vy > CONST.MAX_FALL) this.vy = CONST.MAX_FALL;
      else if (this.vy < -520) this.vy = -520;
      this.iframes = CONST.IFRAMES;
      this.regenTimer = CONST.REGEN_DELAY;
      sfx('hurt');
      pText(this.x + this.w / 2, this.y - 4, '-' + dmg,
        (CONST.COLORS && CONST.COLORS.taken) || '#ff4a4a');
      if (this.hp <= 0) this.die();
    }

    heal(n) {
      if (this.dead || !(n > 0)) return;
      const before = this.hp;
      this.hp = Math.min(this.maxHp, this.hp + n);
      const got = Math.round(this.hp - before);
      if (got > 0) {
        pText(this.x + this.w / 2, this.y - 4, '+' + got,
          (CONST.COLORS && CONST.COLORS.heal) || '#7dff7d');
      }
    }

    die() {
      this.dead = true;
      this.hp = 0;
      this.respawnTimer = CONST.RESPAWN_SECONDS;
      this.swing = null;
      this.mineTarget = null;
      this.vx = 0;
      this.vy = 0;
      sfx('die');
      pBurst(this.x + this.w / 2, this.y + this.h / 2, 14, ['#c93a3a', '#7a2020'], 140);
    }

    respawn() {
      this.x = this.sx;
      this.y = this.sy;
      let tries = 0;                          // nudge up out of blocks placed at spawn
      while (this.hitsAt(this.x, this.y) && tries++ < 40) this.y -= CONST.TS;
      this.vx = 0;
      this.vy = 0;
      this.hp = this.maxHp;
      this.dead = false;
      this.iframes = CONST.IFRAMES;
      this.regenTimer = CONST.REGEN_DELAY;
      this.fallTiles = 0;
      this.breath = 1;
      this.drownPool = 0;
      this.coyote = 0;
      this.onGround = false;
      this.respawnTimer = 0;
      this.swing = null;
      this.mineTarget = null;
      if (TC.Magic && typeof TC.Magic.onRespawn === 'function') TC.Magic.onRespawn(this);
    }

    // ---- persistence ----

    serialize() {
      const d = {
        x: this.x, y: this.y, vx: this.vx, vy: this.vy,
        hp: this.hp, hotbarIndex: this.hotbarIndex,
        sx: this.sx, sy: this.sy,
        inventory: this.inventory ? this.inventory.serialize() : null,
        equipment: {
          head: this.equipment.head || null,
          body: this.equipment.body || null,
          feet: this.equipment.feet || null
        }
      };
      // v1-blob parity for systems that used to ride prototype wraps
      if (TC.Magic && typeof TC.Magic.captureOf === 'function') {
        try { Object.assign(d, TC.Magic.captureOf(this)); } catch (e) {}
      }
      if (TC.Accessories && typeof TC.Accessories.captureOf === 'function') {
        try { d.accessories = TC.Accessories.captureOf(this); } catch (e2) {}
      }
      if (TC.Buffs && typeof TC.Buffs.captureOf === 'function') {
        try { d.buffs = TC.Buffs.captureOf(); } catch (e3) {}
      }
      return d;
    }

    static deserialize(data) {
      if (!data || typeof data !== 'object') return null;
      const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
      const x = num(data.x), y = num(data.y);
      if (x === null || y === null) return null;
      const p = new TC.Player(x, y);
      const vx = num(data.vx), vy = num(data.vy);
      if (vx !== null) p.vx = vx;
      if (vy !== null) p.vy = vy;
      const hp = num(data.hp);
      p.hp = (hp !== null) ? Math.min(Math.max(hp, 1), p.maxHp) : p.maxHp;
      const hb = num(data.hotbarIndex);
      p.hotbarIndex = (hb !== null) ? Math.abs(Math.floor(hb)) % 10 : 0;
      const sx = num(data.sx), sy = num(data.sy);
      if (sx !== null) p.sx = sx;
      if (sy !== null) p.sy = sy;
      if (data.inventory != null) {
        try {
          if (p.inventory && typeof p.inventory.deserialize === 'function') {
            p.inventory.deserialize(data.inventory);
          } else if (TC.Inventory && typeof TC.Inventory.deserialize === 'function') {
            const inv = TC.Inventory.deserialize(data.inventory);
            if (inv) p.inventory = inv;
          }
        } catch (e) {}
      }
      if (data.equipment && typeof data.equipment === 'object') {
        const eq = data.equipment;
        const slots = (CONST.EQUIP_SLOTS && CONST.EQUIP_SLOTS.length)
          ? CONST.EQUIP_SLOTS : ['head', 'body', 'feet'];
        for (let i = 0; i < slots.length; i++) {
          const k = slots[i];
          const d = iDef(eq[k]);
          p.equipment[k] = (d && d.kind === 'armor' && d.slot === k) ? eq[k] : null;
        }
      }
      // restore system state that used to arrive via prototype wraps (v1 blobs)
      if (TC.Magic && typeof TC.Magic.restoreLegacy === 'function') {
        try { TC.Magic.restoreLegacy(data, p); } catch (e) {}
      }
      if (TC.Accessories && typeof TC.Accessories.restoreLegacy === 'function') {
        try { TC.Accessories.restoreLegacy(data); } catch (e2) {}
      }
      if (data.lifeCrystals != null) p.lifeCrystals = data.lifeCrystals;
      return p;
    }

    // ---- draw ----

    draw(ctx, cam) {
      if (!ctx || this.dead) return;
      if (TC.applyCam) TC.applyCam(ctx);      // idempotent; main.js also applies it
      this.drawHammerGhost(ctx);

      const cx = this.x + this.w / 2;
      const footY = this.y + this.h;
      const bx = this.x - 1, by = this.y - 2;   // top-left of the 20x42 sprite

      ctx.save();
      if (this.iframes > 0 && Math.floor(this.iframes * 14) % 2 === 1) ctx.globalAlpha = 0.35;
      if (this.landT > 0) {
        const q = (this.landT / LAND_T) * 0.16;
        ctx.translate(cx, footY);
        ctx.scale(1 + q * 0.7, 1 - q);
        ctx.translate(-cx, -footY);
      }
      ctx.translate(cx, 0);
      ctx.scale(this.facing, 1);
      ctx.translate(-cx, 0);

      const f = this.walkFrame();
      const lf = [0, 3, 0, -3][f], lb = -lf;
      const bob = (f === 1 || f === 3) ? 1 : 0;
      const mailCol = this.equipment.body ? metalColor(this.equipment.body) : null;
      const helmCol = this.equipment.head ? metalColor(this.equipment.head) : null;
      const bootCol = this.equipment.feet ? metalColor(this.equipment.feet) : null;

      // back arm
      ctx.fillStyle = COL.sleeve;
      ctx.fillRect(bx + 4, by + 14 + bob, 3, 8);
      ctx.fillStyle = COL.skin;
      ctx.fillRect(bx + 4, by + 22 + bob, 3, 3);
      // legs + shoes
      ctx.fillStyle = COL.pants;
      ctx.fillRect(bx + 6 + lb, by + 27, 4, 12);
      ctx.fillRect(bx + 11 + lf, by + 27, 4, 12);
      if (bootCol) {                     // greave cuffs above the boots
        ctx.fillStyle = bootCol;
        ctx.fillRect(bx + 6 + lb, by + 36, 4, 3);
        ctx.fillRect(bx + 11 + lf, by + 36, 4, 3);
      }
      ctx.fillStyle = bootCol || COL.shoe;
      ctx.fillRect(bx + 6 + lb, by + 39, 4, 3);
      ctx.fillRect(bx + 11 + lf, by + 39, 4, 3);
      // torso + belt
      ctx.fillStyle = COL.shirt;
      ctx.fillRect(bx + 5, by + 13 + bob, 11, 12);
      if (mailCol) {                     // metal mail over the shirt
        ctx.fillStyle = mailCol;
        ctx.fillRect(bx + 5, by + 13 + bob, 11, 12);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(bx + 5, by + 13 + bob, 11, 2);
      }
      ctx.fillStyle = COL.belt;
      ctx.fillRect(bx + 5, by + 24 + bob, 11, 2);
      // head + hair
      ctx.fillStyle = COL.skin;
      ctx.fillRect(bx + 5, by + 3 + bob, 11, 10);
      ctx.fillStyle = COL.hair;
      ctx.fillRect(bx + 4, by + 1 + bob, 13, 4);
      ctx.fillRect(bx + 4, by + 3 + bob, 3, 8);
      ctx.fillRect(bx + 12, by + 5 + bob, 4, 2);
      if (helmCol) {                     // simple metal cap with side flaps
        ctx.fillStyle = helmCol;
        ctx.fillRect(bx + 4, by + 1 + bob, 13, 4);
        ctx.fillRect(bx + 4, by + 5 + bob, 2, 2);
        ctx.fillRect(bx + 15, by + 5 + bob, 2, 2);
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(bx + 5, by + 1 + bob, 11, 1);
      }
      // eye
      const ey = by + 7 + bob;
      if (this.blinkHold > 0) {
        ctx.fillStyle = COL.skin;
        ctx.fillRect(bx + 12, ey, 3, 3);
        ctx.fillStyle = COL.hair;
        ctx.fillRect(bx + 12, ey, 3, 1);
      } else {
        ctx.fillStyle = COL.eyeW;
        ctx.fillRect(bx + 12, ey, 3, 3);
        ctx.fillStyle = COL.pupil;
        ctx.fillRect(bx + 14, ey, 1, 3);
      }
      // front arm + held item
      this.drawFrontArm(ctx, bx, by, bob);

      ctx.restore();
    }

    // Ghost outline of the hovered tile's hammer shape while a hammer is the
    // held tool (world space; caller applied the camera transform).
    drawHammerGhost(ctx) {
      if (!TC.Tiles || typeof TC.Tiles.drawShapePreview !== 'function') return;
      const inp = TC.Input;
      if (!inp || !inp.mouse || !isFinite(inp.mouse.worldX)) return;
      const sel = this.selectedSlot();
      const def = sel ? iDef(sel.id) : null;
      if (!def || def.tool !== 'hammer') return;
      const world = TC.world;
      if (!world || typeof world.canShape !== 'function' ||
          typeof world.shapeAt !== 'function') return;
      const TS = CONST.TS;
      const tx = Math.floor(inp.mouse.worldX / TS), ty = Math.floor(inp.mouse.worldY / TS);
      if (!this.inReach(tx, ty) || !world.canShape(tx, ty)) return;
      try { TC.Tiles.drawShapePreview(ctx, tx * TS, ty * TS, TS, world.shapeAt(tx, ty)); } catch (e) {}
    }

    drawFrontArm(ctx, bx, by, bob) {
      const shX = bx + 14, shY = by + 15 + bob;
      const s = this.swing;
      const sel = this.selectedSlot();
      const id = sel ? sel.id : null;

      let ang = null;
      if (s && s.bow) {
        ang = (this.facing === 1) ? this.aimAng : Math.PI - this.aimAng;
      } else if (s) {
        const p = 1 - Math.max(0, s.timer) / s.dur;
        ang = -2.3 + 3.2 * Math.min(1, Math.max(0, p));   // swing arc: up-back -> down-forward
      }
      if (ang !== null) {
        this.armAt(ctx, shX, shY, ang, id);
        return;
      }
      const moving = Math.abs(this.vx) > 10 && this.onGround;
      const sway = moving
        ? Math.sin(this.walkPhase * Math.PI * 2) * 0.28
        : Math.sin(performance.now() * 0.002) * 0.04;
      this.armAt(ctx, shX, shY, 1.3 + sway, id);
    }

    armAt(ctx, shX, shY, ang, itemId) {
      ctx.save();
      ctx.translate(shX, shY);
      ctx.rotate(ang);
      ctx.fillStyle = COL.sleeve;
      ctx.fillRect(-2, -2, 7, 4);
      ctx.fillStyle = COL.skin;
      ctx.fillRect(5, -2, 3, 4);
      if (itemId && TC.Items && typeof TC.Items.iconFor === 'function') {
        let ic = null;
        try { ic = TC.Items.iconFor(itemId); } catch (e) {}
        if (ic) {
          const ih = ic.height || 16;
          try { ctx.drawImage(ic, 6, -ih / 2); } catch (e) {}
        }
      }
      ctx.restore();
    }
  }

  TC.Player = Player;
})();
