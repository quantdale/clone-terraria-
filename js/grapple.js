/* grapple.js — TC.Grapple: canonical grappling-hook traversal (W3).
   A real traversal system built as a small state machine over ONE active
   hook (multi-hook accessories can later extend HOOKS_MAX):

     flying   hook flies toward the aim point until it hits valid terrain,
              exceeds the item's range, or times out -> retract
     latched  anchor fixed to terrain; pulls the player along the rope and
              acts as a pendulum constraint so momentum swings are possible;
              jump or re-use releases with momentum kept
     retract  hook returns to the owner; system idles once home

   Design rules honored here:
     - no teleporting: the player is only ever accelerated or position-
       corrected by the rope constraint; all movement still resolves
       through the normal tile collision in player.moveAndCollide
     - hooks only latch SOLID tiles (never AIR, platforms-as-deck, ghosts)
     - speed caps everywhere; no unbounded velocity
     - anchor validity is re-checked every frame (mined anchor releases)
     - state machine is data-driven from the held item's def
       { grapple: { range, pull, speed } } so new hooks are table rows

   Integration (lead-owned call sites):
     - player.useHeld dispatches kind 'grapple' here first (onUseHeld)
     - main.step calls preUpdate(dt) before player.update (pull thrust)
       and postUpdate(dt) after it (rope constraint + hook flight)
     - main.draw calls drawWorld(ctx, cam) inside the camera transform */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  const TAU = Math.PI * 2;

  // ---- tuning fallbacks (per-item defs override) ----
  const DEF_SPEED = 780;    // hook flight px/s
  const DEF_PULL = 560;     // pull accel px/s^2 along the rope
  const DEF_RANGE = 280;    // max rope length px
  const FLY_TIME = 1.1;     // s before an unanswered hook retracts
  const RETRACT_SPEED = 1400;
  const LATCH_SLACK = 2;    // px of positional slop before correction
  const MAX_PLAYER_SPEED = 900; // absolute cap while influenced
  const ARRIVE_DIST = 14;   // px: "reached the anchor", fling and release
  const COOLDOWN = 0.22;

  // ---- state (one live hook) ----
  let st = null; // null | {phase,x,y,vx,vy,ax,ay,len,maxLen,timer,item}
  let owner = null;

  function iDef(id) { return TC.ITEM_DEFS ? TC.ITEM_DEFS[id] : null; }

  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === 'function') {
      try { TC.Audio.play(name); } catch (e) {}
    }
  }
  function pBurst(x, y, n, colors, spd) {
    if (TC.Particles && typeof TC.Particles.burst === 'function') {
      try {
        TC.Particles.burst(x, y, n, { colors: colors, speed: spd || 90 });
      } catch (e) {}
    }
  }

  // May this cell host an anchor? Solid full blocks only; wiring ghosts,
  // platforms (deck shapes) and liquids are rejected.
  function anchorable(tx, ty) {
    const w = TC.world;
    if (!w || !TC.TILE_DEFS || typeof w.get !== 'function') return false;
    if (!w.inB(tx, ty)) return false;
    const id = w.get(tx, ty);
    const def = TC.TILE_DEFS[id];
    if (!def || !def.solid) return false;
    if (id === TC.TILE.WATER || id === TC.TILE.LAVA) return false;
    if (TC.Wiring && typeof TC.Wiring.isGhost === 'function' &&
        TC.Wiring.isGhost(tx, ty)) return false;
    // platform decks read as solid:false in TILE_DEFS today, so the def
    // check above already excludes them; half/sloped solids are fair game.
    return true;
  }

  function resetForNewWorld() {
    st = null;
    owner = null;
  }

  function active() { return !!(st && owner); }

  // Fire (or cancel). Returns true when the click was consumed.
  function onUseHeld(player, def, dt) {
    if (!player || !def || def.kind !== 'grapple') return false;
    void dt;
    if ((player._grappleCd || 0) > 0) return true;
    player._grappleCd = COOLDOWN;

    // A second use while the hook is out releases it (cancellation path).
    if (active()) { release(true); return true; }

    const inp = TC.Input;
    const m = inp && inp.mouse;
    if (!m || !isFinite(m.worldX) || !isFinite(m.worldY)) return true;

    const g = def.grapple || {};
    const cx = player.x + player.w / 2;
    const cy = player.y + player.h / 2;
    const dx = m.worldX - cx, dy = m.worldY - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 4) return true; // aim is on top of us: nothing to hook
    const speed = g.speed || DEF_SPEED;

    st = {
      phase: 'flying',
      x: cx, y: cy,
      vx: (dx / d) * speed, vy: (dy / d) * speed,
      ax: 0, ay: 0,
      len: 0,
      // The rope budget is the ITEM'S range stat, not the cursor distance:
      // the hook travels through the aim point until terrain or this cap.
      maxLen: g.range || DEF_RANGE,
      timer: FLY_TIME,
      item: def
    };
    owner = player;
    sfx('throw');
    return true;
  }

  // Detach. `keepMomentum` preserves current player velocity (jump-cancel),
  // otherwise a light damp avoids launching off huge pull speeds.
  function release(keepMomentum) {
    if (st && st.phase === 'latched') {
      pBurst(st.ax, st.ay, 4, ['#c8ccd8', '#8a5a32'], 70);
    }
    if (!keepMomentum && owner) {
      owner.vx *= 0.85;
      owner.vy *= 0.85;
    }
    st = null;
  }

  function beginRetract() {
    if (!st) return;
    st.phase = 'retract';
    st.timer = 1.0;
  }

  // ---- per-frame phases ------------------------------------------------

  function flyStep(dt) {
    const w = TC.world;
    st.x += st.vx * dt;
    st.y += st.vy * dt;
    st.timer -= dt;
    const ox = owner.x + owner.w / 2, oy = owner.y + owner.h / 2;
    const travelled = Math.sqrt((st.x - ox) * (st.x - ox) + (st.y - oy) * (st.y - oy));
    if (travelled > st.maxLen || st.timer <= 0 ||
        st.x < 0 || st.y < 0 || !w ||
        st.x > w.width * TC.CONST.TS || st.y > w.height * TC.CONST.TS) {
      beginRetract();
      return;
    }
    // tile hit test at the tip
    const tx = Math.floor(st.x / TC.CONST.TS), ty = Math.floor(st.y / TC.CONST.TS);
    if (anchorable(tx, ty)) {
      st.phase = 'latched';
      st.ax = tx * TC.CONST.TS + TC.CONST.TS / 2;
      st.ay = ty * TC.CONST.TS + TC.CONST.TS / 2;
      st.len = Math.max(8, dist(ownerCenter(), { x: st.ax, y: st.ay }));
      st.timer = 30; // safety lifetime while latched
      pBurst(st.ax, st.ay, 5, ['#d8dce8', '#a97d4b'], 60);
      sfx('dig');
    }
  }

  function retractStep(dt) {
    const c = ownerCenter();
    const dx = c.x - st.x, dy = c.y - st.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const step = RETRACT_SPEED * dt;
    if (d <= step || !isFinite(d)) { st = null; return; }
    st.x += (dx / d) * step;
    st.y += (dy / d) * step;
  }

  function dist(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function ownerCenter() {
    return {
      x: owner.x + owner.w / 2,
      y: owner.y + owner.h / 2
    };
  }

  // ---- lead call sites --------------------------------------------------

  // Before player.update: while latched, thrust the player along the rope
  // toward the anchor (pull) — movement itself stays in player physics.
  function preUpdate(dt) {
    if (!active()) return;
    if (owner.dead) { release(false); return; }
    if ((owner._grappleCd || 0) > 0) owner._grappleCd -= dt;
    if (st.phase !== 'latched') return;

    // anchor destroyed while we hung on it?
    const atx = Math.floor(st.ax / TC.CONST.TS), aty = Math.floor(st.ay / TC.CONST.TS);
    if (!anchorable(atx, aty)) { release(false); return; }

    const c = ownerCenter();
    const dx = st.ax - c.x, dy = st.ay - c.y;
    const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const pull = (st.item && st.item.grapple && st.item.grapple.pull) || DEF_PULL;
    owner.vx += (dx / d) * pull * dt;
    owner.vy += (dy / d) * pull * dt;

    // arrival: fling upward-ish and release for a satisfying pop over ledges
    if (d < ARRIVE_DIST) {
      owner.vx += (dx / d) * 120;
      owner.vy -= 160;
      release(true);
    }

    capVelocity();
  }

  // After player.update: enforce the rope constraint (pendulum swing),
  // tick hook flight/retraction, and honor jump-release.
  function postUpdate(dt) {
    if (!active()) return;

    if (st.phase === 'latched') {
      // jump input cancels with momentum (wall-leap feel)
      const inp = TC.Input;
      if (inp && typeof inp.axis === 'function') {
        const a = inp.axis();
        if (a && a.jump) { release(true); return; }
      }

      const c = ownerCenter();
      let dx = c.x - st.ax, dy = c.y - st.ay;
      const d = Math.max(0.001, Math.sqrt(dx * dx + dy * dy));
      if (d > st.len + LATCH_SLACK) {
        // positional correction: clamp back onto the rope circle
        const nx = dx / d, ny = dy / d;
        const excess = d - st.len;
        owner.x -= nx * excess;
        owner.y -= ny * excess;
        // kill outward radial velocity -> tangential swing remains
        const radial = owner.vx * nx + owner.vy * ny;
        if (radial > 0) {
          owner.vx -= nx * radial;
          owner.vy -= ny * radial;
        }
      }
      st.timer -= dt;
      if (st.timer <= 0) beginRetract();
    } else if (st.phase === 'flying') {
      flyStep(dt);
    } else if (st.phase === 'retract') {
      retractStep(dt);
    }
    capVelocity();
  }

  function capVelocity() {
    if (!owner) return;
    const sp = owner.vx * owner.vx + owner.vy * owner.vy;
    if (sp > MAX_PLAYER_SPEED * MAX_PLAYER_SPEED) {
      const k = MAX_PLAYER_SPEED / Math.sqrt(sp);
      owner.vx *= k;
      owner.vy *= k;
    }
  }

  // ---- rendering ---------------------------------------------------------

  // World-space (camera transform applied). Rope from the player's shoulder
  // to the hook head; a small three-pronged hook drawn at the far end.
  function drawWorld(ctx, cam) {
    if (!st || !owner) return;
    void cam;
    const sx = owner.x + owner.w / 2, sy = owner.y + 10;
    ctx.save();
    ctx.strokeStyle = '#7a5230';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(st.x, st.y);
    ctx.stroke();

    ctx.translate(st.x, st.y);
    if (st.phase === 'latched') {
      const ang = Math.atan2(sy - st.ay, sx - st.ax);
      ctx.rotate(ang);
    } else {
      ctx.rotate(Math.atan2(st.vy, st.vx));
    }
    ctx.fillStyle = '#c0c0cc';
    ctx.fillRect(-3, -2, 6, 4);            // head block
    ctx.strokeStyle = '#9aa0ad';
    ctx.lineWidth = 1.4;
    ctx.beginPath();                        // prongs
    ctx.moveTo(2, 0); ctx.lineTo(7, -4);
    ctx.moveTo(2, 0); ctx.lineTo(7, 4);
    ctx.moveTo(-2, -1.5); ctx.lineTo(-6, -4);
    ctx.moveTo(-2, 1.5); ctx.lineTo(-6, 4);
    ctx.stroke();
    ctx.restore();
  }

  TC.Grapple = {
    onUseHeld, preUpdate, postUpdate, drawWorld, release, active, resetForNewWorld,

    // 'flying' | 'latched' | 'retract' | null — debug/UI/test readback.
    phase: () => (st ? st.phase : null),

    // Anchor position while latched, else null (rope renderers, tests).
    anchor: () => (st && st.phase === "latched" ? { x: st.ax, y: st.ay } : null),
  };
})();
