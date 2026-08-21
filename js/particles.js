/* particles.js — pooled world-space particles + floating combat text. */
'use strict';
window.TC = window.TC || {};
(function () {
  const TC = window.TC;

  const MAX_PARTICLES = 600; // hard cap; oldest dropped when full
  const MAX_TEXTS = 64;

  const live = [];  // active particles, oldest first
  const texts = []; // floating text, oldest first
  const free = [];  // recycled particle objects

  function acquire() {
    return free.length ? free.pop() : {};
  }

  // remove live[i], recycle it, swap last into the gap
  function release(i) {
    free.push(live[i]);
    live[i] = live[live.length - 1];
    live.pop();
  }

  // FIFO eviction for the cap; shift() keeps age order (swap-pop would not)
  function dropOldest() {
    if (live.length) free.push(live.shift());
  }

  const P = {
    // opts: {x, y, vx, vy, life, size, color, gravity, fade}
    spawn(opts) {
      if (!opts) return null;
      if (live.length >= MAX_PARTICLES) dropOldest();
      const p = acquire();
      p.x = opts.x || 0;
      p.y = opts.y || 0;
      p.vx = opts.vx || 0;
      p.vy = opts.vy || 0;
      p.life = p.maxLife = (opts.life != null) ? opts.life : 0.6;
      p.size = (opts.size != null) ? opts.size : 3;
      p.color = opts.color || '#ffffff';
      p.gravity = (opts.gravity != null) ? opts.gravity : 0;
      p.fade = opts.fade !== false;
      live.push(p);
      return p;
    },

    // radial puff of chips/debris; o: {colors[], speed, life, size, gravity}
    burst(x, y, n, o) {
      o = o || {};
      const colors = o.colors || ['#cccccc'];
      const speed = (o.speed != null) ? o.speed : 90;
      const life = (o.life != null) ? o.life : 0.5;
      const size = (o.size != null) ? o.size : 2.5;
      const gravity = (o.gravity != null) ? o.gravity : 700;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = speed * (0.35 + Math.random() * 0.65);
        P.spawn({
          x: x, y: y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s - s * 0.25, // slight upward bias
          life: life * (0.6 + Math.random() * 0.7),
          size: size * (0.7 + Math.random() * 0.6),
          color: colors[(Math.random() * colors.length) | 0],
          gravity: gravity
        });
      }
    },

    // rising fading label (damage numbers); drawn bold monospace w/ outline
    floatText(x, y, str, color, sizePx) {
      if (texts.length >= MAX_TEXTS) texts.shift();
      texts.push({
        x: x, y: y, str: String(str),
        color: color || '#ffffff',
        size: sizePx || 14,
        life: 1.1, maxLife: 1.1,
        vy: -36
      });
    },

    update(dt) {
      for (let i = live.length - 1; i >= 0; i--) {
        const p = live[i];
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= dt;
        if (p.life <= 0) release(i);
      }
      for (let i = texts.length - 1; i >= 0; i--) {
        const t = texts[i];
        t.y += t.vy * dt;
        t.vy *= Math.max(0, 1 - 1.6 * dt); // ease the rise
        t.life -= dt;
        if (t.life <= 0) texts.splice(i, 1);
      }
    },

    // world-space; caller has already drawn world/entities under the same camera
    draw(ctx, cam) {
      if (!ctx) return;
      ctx.save();
      if (typeof TC.applyCam === 'function') TC.applyCam(ctx);
      else if (cam) ctx.setTransform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom);

      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        if (p.fade) ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
        ctx.fillStyle = p.color;
        const h = p.size / 2;
        ctx.fillRect(p.x - h, p.y - h, p.size, p.size);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 3;
      for (let i = 0; i < texts.length; i++) {
        const t = texts[i];
        ctx.globalAlpha = Math.max(0, Math.min(1, t.life / t.maxLife));
        ctx.font = 'bold ' + t.size + 'px monospace';
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeText(t.str, t.x, t.y);
        ctx.fillStyle = t.color;
        ctx.fillText(t.str, t.x, t.y);
      }

      ctx.restore(); // resets alpha/font/align and the camera transform
    },

    clear() {
      for (let i = 0; i < live.length; i++) free.push(live[i]);
      live.length = 0;
      texts.length = 0;
    }
  };

  TC.Particles = P;
})();
