/* items.js — TC.Inventory (50-slot grid, favorites + sort/quick-move helpers),
   TC.Items drop registry + icon factory, TC.Chests per-position containers. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};
  const CONST = TC.CONST;

  // ---- shared helpers ----
  function def(id) { return TC.ITEM_DEFS ? TC.ITEM_DEFS[id] : null; }
  function maxStack(id) { const d = def(id); return (d && d.maxStack) || 999; }

  // Coerce a serialized entry ([id,count] or {id,count}) into a valid stack.
  function sanitizeStack(e) {
    let id = null, count = 0;
    if (Array.isArray(e)) { id = e[0]; count = e[1]; }
    else if (e && typeof e === 'object') { id = e.id; count = e.count; }
    if (typeof id !== 'string' || !id) return null;
    count = (typeof count === 'number' && isFinite(count)) ? Math.floor(count) : 0;
    if (count <= 0) return null;
    return { id: id, count: Math.min(count, maxStack(id)) };
  }

  // Fire InventoryChanged after a mutation; events.js may be absent early.
  function emitInvChanged(payload) {
    try {
      if (TC.Events && typeof TC.Events.emit === 'function' &&
          TC.Events.EVENT && TC.Events.EVENT.InventoryChanged) {
        TC.Events.emit(TC.Events.EVENT.InventoryChanged, payload);
      }
    } catch (e) { /* listeners must never break inventory flow */ }
  }

  // Merge the stack `st` ({id,count}, mutated in place) into a raw slot array:
  // matching-id stacks first, then the first empty slot. Returns moved count.
  function moveIntoSlots(st, target) {
    if (!st || !st.id || !(st.count > 0) || !Array.isArray(target)) return 0;
    const max = maxStack(st.id);
    let moved = 0;
    for (let i = 0; i < target.length && st.count > 0; i++) {
      const t = target[i];
      if (t && t.id === st.id && t.count < max) {
        const m = Math.min(max - t.count, st.count);
        t.count += m;
        st.count -= m;
        moved += m;
      }
    }
    for (let i = 0; i < target.length && st.count > 0; i++) {
      if (!target[i]) {
        target[i] = { id: st.id, count: st.count };
        moved += st.count;
        st.count = 0;
      }
    }
    return moved;
  }

  // ====================================================================
  // TC.Inventory — SIZE slots; indices 0-9 are the hotbar row.
  // ====================================================================
  class Inventory {
    constructor(size) {
      this.size = ((size | 0) > 0) ? (size | 0) : Inventory.SIZE;
      this.slots = new Array(this.size).fill(null);   // null | {id, count}
      this.favorites = new Set();                     // pinned slot indexes
    }

    // Fill existing same-id stacks first, then empty slots. Returns leftover.
    add(id, count) {
      let n = (typeof count === 'number' && isFinite(count)) ? Math.floor(count) : 0;
      if (!id || n <= 0) return 0;
      const want = n;
      const max = maxStack(id);
      const slots = this.slots;
      for (let i = 0; i < slots.length && n > 0; i++) {
        const s = slots[i];
        if (s && s.id === id && s.count < max) {
          const move = Math.min(max - s.count, n);
          s.count += move;
          n -= move;
        }
      }
      for (let i = 0; i < slots.length && n > 0; i++) {
        if (!slots[i]) {
          const put = Math.min(max, n);
          slots[i] = { id: id, count: put };
          n -= put;
        }
      }
      const placed = want - n;
      if (placed > 0) emitInvChanged({ reason: 'add', id: String(id), count: placed });
      return n;
    }

    count(id) {
      let total = 0;
      const slots = this.slots;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s && s.id === id) total += s.count;
      }
      return total;
    }

    // Id-based removal; mutates only when the full amount is present.
    remove(id, count) {
      let n = (typeof count === 'number' && isFinite(count)) ? Math.floor(count) : 0;
      if (!id || n <= 0) return false;
      if (this.count(id) < n) return false;
      const asked = n;
      const slots = this.slots;
      for (let i = 0; i < slots.length && n > 0; i++) {
        const s = slots[i];
        if (s && s.id === id) {
          const take = Math.min(s.count, n);
          s.count -= take;
          n -= take;
          if (s.count <= 0) slots[i] = null;
        }
      }
      emitInvChanged({ reason: 'remove', id: String(id), count: asked });
      return true;
    }

    get(i) {
      const k = i | 0;
      if (k !== i || k < 0 || k >= this.slots.length) return null;
      return this.slots[k] || null;
    }

    // UI drag logic: place/swap/merge cursor stack at slot i.
    // Returns the resulting cursor stack ({id,count}) or null when emptied.
    swapOrPlace(i, stack) {
      const slots = this.slots;
      const k = i | 0;
      if (k !== i || k < 0 || k >= slots.length) return stack || null;
      const cur = (stack && stack.id && stack.count > 0)
        ? { id: String(stack.id), count: Math.floor(stack.count) } : null;
      const s = slots[k];

      if (!cur) {                       // empty cursor: pick the slot up
        if (!s) return null;
        slots[k] = null;
        emitInvChanged({ reason: 'move', slot: k });
        return { id: s.id, count: s.count };
      }
      if (!s) {                         // empty slot: place what fits
        const put = Math.min(maxStack(cur.id), cur.count);
        slots[k] = { id: cur.id, count: put };
        cur.count -= put;
        emitInvChanged({ reason: 'move', slot: k });
        return cur.count > 0 ? cur : null;
      }
      if (s.id === cur.id) {            // same item: merge into the slot
        const move = Math.min(maxStack(s.id) - s.count, cur.count);
        if (move > 0) {
          s.count += move;
          cur.count -= move;
          emitInvChanged({ reason: 'move', slot: k });
        }
        return cur.count > 0 ? cur : null;
      }
      slots[k] = { id: cur.id, count: cur.count };   // different items: swap
      emitInvChanged({ reason: 'move', slot: k });
      return { id: s.id, count: s.count };
    }

    // Favorite pin (slot-index meta). Survives save/load; depositAll skips
    // favorited slots. Returns the new favorite state.
    toggleFavorite(idx) {
      const k = idx | 0;
      if (k !== idx || k < 0 || k >= this.slots.length) return false;
      const now = !this.favorites.has(k);
      if (now) this.favorites.add(k);
      else this.favorites.delete(k);
      emitInvChanged({ reason: 'favorite', slot: k, favorite: now });
      return now;
    }

    isFavorite(idx) {
      const k = idx | 0;
      return k === idx && this.favorites.has(k);
    }

    // Split half of the stack (or n items when given) out of a slot.
    // Cursor-style return: {id,count} | null; source empties when drained.
    stackSplit(slot, count) {
      const k = slot | 0;
      if (k !== slot || k < 0 || k >= this.slots.length) return null;
      const s = this.slots[k];
      if (!s) return null;
      const take = (typeof count === 'number' && isFinite(count) && count > 0)
        ? Math.min(s.count, Math.floor(count))
        : Math.max(1, Math.floor(s.count / 2));
      const out = { id: s.id, count: take };
      s.count -= take;
      if (s.count <= 0) this.slots[k] = null;
      emitInvChanged({ reason: 'split', slot: k, id: out.id, count: take });
      return out;
    }

    // Move the stack at fromSlot into targetContainerSlots (a raw slot array):
    // matching-id stacks first, then the first empty slot. Clears the source
    // slot when fully moved. Returns the moved count.
    quickMove(fromSlot, targetContainerSlots) {
      const k = fromSlot | 0;
      if (k !== fromSlot || k < 0 || k >= this.slots.length) return 0;
      const s = this.slots[k];
      if (!s || !Array.isArray(targetContainerSlots)) return 0;
      const st = { id: s.id, count: s.count };
      const moved = moveIntoSlots(st, targetContainerSlots);
      if (moved <= 0) return 0;
      if (st.count <= 0) this.slots[k] = null;
      else s.count = st.count;
      emitInvChanged({ reason: 'quickMove', slot: k, id: st.id, count: moved });
      return moved;
    }

    // Quick-stack every non-favorited slot into targetSlots. Returns the
    // total moved count; emits one aggregate InventoryChanged when > 0.
    depositAll(targetSlots) {
      if (!Array.isArray(targetSlots)) return 0;
      let total = 0;
      for (let i = 0; i < this.slots.length; i++) {
        if (this.favorites.has(i)) continue;       // pinned slots stay put
        const s = this.slots[i];
        if (!s) continue;
        const st = { id: s.id, count: s.count };
        const moved = moveIntoSlots(st, targetSlots);
        if (moved > 0) {
          total += moved;
          if (st.count <= 0) this.slots[i] = null;
          else s.count = st.count;
        }
      }
      if (total > 0) emitInvChanged({ reason: 'depositAll', count: total });
      return total;
    }

    // Deterministic tidy: occupied stacks ordered by kind then id (unknown
    // defs last), compacted toward slot 0; empty slots trail. Stable sort,
    // so equal keys keep their relative order and stacks never merge.
    sort() {
      const order = [];
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (s && s.id && s.count > 0) order.push({ id: s.id, count: s.count });
      }
      if (order.length < 2) return order.length;
      const kindOf = (id) => {
        const d = def(id);
        return (d && d.kind) ? String(d.kind) : '\uffff';
      };
      const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      order.sort((a, b) => cmpStr(kindOf(a.id), kindOf(b.id)) || cmpStr(a.id, b.id));
      let oi = 0;
      for (let i = 0; i < this.slots.length; i++) {
        this.slots[i] = (oi < order.length) ? order[oi++] : null;
      }
      emitInvChanged({ reason: 'sort', count: order.length });
      return order.length;
    }

    // Dense array of null | [id, count]. When favorites are pinned the shape
    // becomes { slots, favorites } so the pins ride along in the same blob;
    // classic array saves still load (deserialize tolerates both).
    serialize() {
      const out = new Array(this.slots.length);
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        out[i] = (s && s.id && s.count > 0) ? [s.id, s.count] : null;
      }
      if (!this.favorites.size) return out;
      const favs = [];
      this.favorites.forEach((k) => {
        if (k >= 0 && k < this.slots.length) favs.push(k);
      });
      favs.sort((a, b) => a - b);
      return { slots: out, favorites: favs };
    }

    // Load an array (classic) or a {slots, favorites} envelope; bad entries
    // become empty slots. Returns bool.
    deserialize(data) {
      this.slots.fill(null);
      this.favorites.clear();
      let arr = data, favs = null;
      if (data && typeof data === 'object' && !Array.isArray(data) &&
          Array.isArray(data.slots)) {
        arr = data.slots;
        favs = Array.isArray(data.favorites) ? data.favorites : null;
      }
      if (!Array.isArray(arr)) return false;
      for (let i = 0; i < arr.length && i < this.slots.length; i++) {
        const s = sanitizeStack(arr[i]);
        if (s) this.slots[i] = s;
      }
      if (favs) {
        for (let i = 0; i < favs.length; i++) {
          const k = favs[i] | 0;
          if (k === favs[i] && k >= 0 && k < this.slots.length) this.favorites.add(k);
        }
      }
      return true;
    }

    // Build an Inventory from an array (classic) or a {slots, favorites}
    // envelope; returns null for unusable input.
    static deserialize(data) {
      if (!data || typeof data !== 'object') return null;
      const inv = new Inventory();
      if (!inv.deserialize(data)) return null;
      return inv;
    }
  }
  Inventory.SIZE = 50;

  // ====================================================================
  // TC.Items — world drop registry.
  // ====================================================================
  const DROP_R = 6;              // collision half-size in px
  const DRAW_S = 10;             // drawn icon size (~0.6 * 16)
  const HOME_SPEED_MIN = 130;    // magnet speed at the pull-radius edge
  const HOME_SPEED_MAX = 360;
  const GROUND_FRICTION = 520;   // drop ground friction, px/s^2
  const MERGE_D2 = 14 * 14;      // merge when centers are closer than this
  const BLINK_LAST = 10;         // seconds of expiry blinking

  const drops = [];
  let clock = 0;                 // animation time for bobbing

  function solidPx(x, y) {
    const w = TC.world;
    return !!(w && typeof w.solidAtPixel === 'function' && w.solidAtPixel(x, y));
  }

  function spawnDrop(x, y, id, count, scatter) {
    const d = {
      x: x, y: y,
      vx: (Math.random() - 0.5) * (scatter ? 120 : 36),
      vy: scatter ? -(60 + Math.random() * 80) : -(30 + Math.random() * 40),
      id: String(id),
      count: Math.max(1, Math.floor(count) || 1),
      age: 0,
      phase: Math.random() * Math.PI * 2,
      pickupDelay: scatter ? 0.9 : 0.35,   // grace so thrown drops escape the magnet
      onGround: false
    };
    drops.push(d);
    return d;
  }

  // Point-vs-tile integration: bounce off walls, land on floors.
  function moveDrop(d, dt) {
    const TS = CONST.TS;

    if (d.vx !== 0) {
      const nx = d.x + d.vx * dt;
      const dir = d.vx > 0 ? 1 : -1;
      if (solidPx(nx + dir * DROP_R, d.y)) d.vx = -d.vx * 0.3;
      else d.x = nx;
    }

    const ny = d.y + d.vy * dt;
    if (d.vy > 0) {
      if (solidPx(d.x, ny + DROP_R)) {
        d.y = Math.floor((ny + DROP_R) / TS) * TS - DROP_R - 0.01;
        d.vy = 0;
        d.onGround = true;
      } else { d.y = ny; d.onGround = false; }
    } else if (d.vy < 0) {
      if (solidPx(d.x, ny - DROP_R)) {
        d.y = (Math.floor((ny - DROP_R) / TS) + 1) * TS + DROP_R + 0.01;
        d.vy = 0;
      } else { d.y = ny; d.onGround = false; }
    } else {
      d.onGround = solidPx(d.x, d.y + DROP_R + 1);
    }

    const w = TC.world;               // keep inside the world
    if (w) {
      const hiX = w.width * TS - DROP_R;
      if (d.x < DROP_R) { d.x = DROP_R; d.vx = Math.abs(d.vx) * 0.3; }
      else if (d.x > hiX) { d.x = hiX; d.vx = -Math.abs(d.vx) * 0.3; }
      const hiY = w.height * TS + 60;
      if (d.y > hiY) { d.y = hiY; d.vy = 0; d.onGround = true; }
    }
  }

  // Fold nearby same-id stacks together (respects maxStack).
  function mergeDrops() {
    for (let i = 0; i < drops.length; i++) {
      const a = drops[i];
      for (let j = drops.length - 1; j > i; j--) {
        const b = drops[j];
        if (b.id !== a.id) continue;
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx * dx + dy * dy > MERGE_D2) continue;
        const max = maxStack(a.id);
        if (a.count + b.count > max) continue;
        a.count += b.count;
        a.pickupDelay = Math.min(a.pickupDelay, b.pickupDelay);
        drops.splice(j, 1);
      }
    }
  }

  function update(dt, player) {
    clock += dt;
    mergeDrops();

    const canMagnet = !!(player && !player.dead && player.inventory &&
                         typeof player.inventory.add === 'function');
    const pcx = canMagnet ? player.x + player.w / 2 : 0;
    const pcy = canMagnet ? player.y + player.h / 2 : 0;
    const PULL = CONST.PICKUP_PULL, PULL2 = PULL * PULL;
    const COLLECT = CONST.PICKUP_COLLECT, COLLECT2 = COLLECT * COLLECT;

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.age += dt;
      if (d.age >= CONST.DROP_LIFETIME) { drops.splice(i, 1); continue; }
      if (d.pickupDelay > 0) d.pickupDelay -= dt;

      const dx = pcx - d.x, dy = pcy - d.y;
      const dist2 = dx * dx + dy * dy;
      const homing = canMagnet && d.pickupDelay <= 0 && dist2 < PULL2;

      if (homing) {                    // override gravity, home to the player
        const dist = Math.sqrt(dist2) || 1;
        const sp = Math.min(HOME_SPEED_MAX, HOME_SPEED_MIN + (PULL - dist) * 7);
        d.vx = dx / dist * sp;
        d.vy = dy / dist * sp;
      } else {
        d.vy = Math.min(d.vy + CONST.GRAVITY * dt, CONST.MAX_FALL);
      }

      moveDrop(d, dt);

      if (!homing && d.onGround) {     // settle horizontally on the ground
        const f = GROUND_FRICTION * dt;
        if (Math.abs(d.vx) <= f) d.vx = 0;
        else d.vx -= d.vx > 0 ? f : -f;
      }

      if (canMagnet && d.pickupDelay <= 0 && dist2 < COLLECT2) {
        const left = player.inventory.add(d.id, d.count);
        if (left <= 0) {
          drops.splice(i, 1);
          if (TC.Audio) { try { TC.Audio.play('pickup'); } catch (e) {} }
          if (TC.Particles) {
            try {
              TC.Particles.burst(d.x, d.y, 3,
                { colors: ['#ffffff'], speed: 50, life: 0.3, size: 2 });
            } catch (e) {}
          }
        } else {
          d.count = left;              // inventory full: keep the remainder alive
        }
      }
    }
  }

  // World-space; main.js calls this inside an active camera transform.
  function draw(ctx, cam) {
    if (!drops.length) return;
    let vw = 0, vh = 0;
    if (TC.canvas) {
      const z = cam ? cam.zoom : 1;
      vw = TC.canvas.width / z;
      vh = TC.canvas.height / z;
    }
    const vx0 = (cam ? cam.x : 0) - 24, vy0 = (cam ? cam.y : 0) - 24;
    const vx1 = vx0 + vw + 48, vy1 = vy0 + vh + 48;

    ctx.save();
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      if (vw && (d.x < vx0 || d.x > vx1 || d.y < vy0 || d.y > vy1)) continue;
      const bob = d.onGround ? Math.sin(clock * 2.8 + d.phase) * 1.4 : 0;
      const left = CONST.DROP_LIFETIME - d.age;
      if (left < BLINK_LAST) ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(d.age * 5));
      if (d.onGround) {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath();
        ctx.ellipse(d.x, d.y + DROP_R + 1, 5, 1.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      const ic = iconFor(d.id);
      if (ic) ctx.drawImage(ic, d.x - DRAW_S / 2, d.y - DRAW_S / 2 + bob, DRAW_S, DRAW_S);
      if (d.count > 1) {
        const tx = d.x + DRAW_S / 2 + 1, ty = d.y + DRAW_S / 2 + bob + 1;
        ctx.font = 'bold 7px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillText(String(d.count), tx + 0.5, ty + 0.5);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(d.count), tx, ty);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function clearDrops() {
    drops.length = 0;
  }

  // ====================================================================
  // iconFor — cached 16px canvas per item id.
  // ====================================================================
  const ICON = 16;
  const iconCache = new Map();

  function toRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function shade(hex, t) {   // t > 0 toward white, t < 0 toward black
    const c = toRgb(hex);
    const w = t >= 0 ? 255 : 0;
    const k = Math.min(1, Math.abs(t));
    let out = '#';
    for (let i = 0; i < 3; i++) {
      const v = Math.round(c[i] + (w - c[i]) * k);
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }
  function rgba(hex, a) {
    const c = toRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
  }
  function rect(g, style, x, y, w, h) { g.fillStyle = style; g.fillRect(x, y, w, h); }

  // Tier metal from an id like copper_pickaxe; null when not a metal item.
  function tierMetal(id) {
    const m = /^(copper|iron|gold)(_|$)/.exec(id);
    return (m && CONST.COLORS[m[1]]) || null;
  }

  function paintPickaxe(g, metal, wood) {
    for (let i = 0; i < 8; i++) {           // wooden handle, diagonal
      rect(g, wood, 3 + i, 13 - i, 2, 2);
      rect(g, shade(wood, -0.25), 3 + i, 15 - i, 2, 1);
    }
    g.strokeStyle = metal;                  // curved head across the top
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(2, 9);
    g.quadraticCurveTo(8, 1, 14, 9);
    g.stroke();
    g.strokeStyle = shade(metal, 0.35);     // polished edge
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(3, 7.5);
    g.quadraticCurveTo(8, 2, 13, 7.5);
    g.stroke();
  }

  function paintAxe(g, metal, wood) {
    g.strokeStyle = wood;                   // handle
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(4, 14);
    g.lineTo(11, 5);
    g.stroke();
    g.fillStyle = metal;                    // blade beside the handle top
    g.beginPath();
    g.moveTo(8, 2);
    g.lineTo(14, 4);
    g.lineTo(13, 10);
    g.lineTo(7, 7);
    g.closePath();
    g.fill();
    g.strokeStyle = shade(metal, 0.4);      // cutting-edge highlight
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(8.5, 2.5);
    g.lineTo(13.5, 4.5);
    g.stroke();
    rect(g, shade(wood, -0.3), 8, 6, 2, 2); // binding
  }

  function paintSword(g, blade, guard, grip) {
    g.strokeStyle = blade;                  // diagonal blade
    g.lineWidth = 3;
    g.lineCap = 'butt';
    g.beginPath();
    g.moveTo(5, 11);
    g.lineTo(12, 4);
    g.stroke();
    g.strokeStyle = shade(blade, 0.45);     // bright upper edge
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(4.3, 10.3);
    g.lineTo(11.3, 3.3);
    g.stroke();
    rect(g, blade, 12, 2, 2, 2);            // tip
    g.strokeStyle = guard;                  // crossguard across the base
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(2.5, 9.5);
    g.lineTo(6.5, 13.5);
    g.stroke();
    g.strokeStyle = grip;                   // grip + pommel
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(2, 14);
    g.lineTo(3.5, 12.5);
    g.stroke();
    rect(g, shade(grip, -0.3), 1, 14, 2, 2);
  }

  function paintBow(g, wood) {
    g.strokeStyle = '#e8e2d0';              // string
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(4, 2);
    g.lineTo(4, 14);
    g.stroke();
    g.strokeStyle = wood;                   // limb bulging right
    g.lineWidth = 2;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(4, 2);
    g.quadraticCurveTo(13, 8, 4, 14);
    g.stroke();
    rect(g, shade(wood, -0.35), 7, 7, 3, 2); // grip wrap
  }

  function paintArrow(g) {
    g.strokeStyle = '#8a5a32';              // shaft
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(3, 13);
    g.lineTo(11, 5);
    g.stroke();
    g.fillStyle = '#c0c0cc';                // steel head
    g.beginPath();
    g.moveTo(14, 2);
    g.lineTo(12.2, 6.4);
    g.lineTo(9.6, 3.8);
    g.closePath();
    g.fill();
    g.strokeStyle = '#d84a4a';              // fletching
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(4, 10);
    g.lineTo(2, 12);
    g.moveTo(6, 12);
    g.lineTo(4, 14);
    g.stroke();
  }

  function paintBar(g, metal) {
    const ingot = (x, y, w, h) => {
      g.fillStyle = metal;
      g.beginPath();
      g.moveTo(x, y + h);
      g.lineTo(x + 2, y);
      g.lineTo(x + w - 2, y);
      g.lineTo(x + w, y + h);
      g.closePath();
      g.fill();
      rect(g, shade(metal, 0.35), x + 2.5, y + 0.5, w - 5, 1);   // glint
      rect(g, shade(metal, -0.3), x + 1, y + h - 1.5, w - 2, 1); // base shadow
    };
    ingot(1, 9, 7, 4.5);                    // bottom pair
    ingot(8, 9, 7, 4.5);
    ingot(4, 3.5, 7, 4.5);                  // one stacked on top
  }

  function paintGel(g) {
    const c = '#3ec54a';
    g.fillStyle = rgba(c, 0.78);            // translucent rounded blob
    g.fillRect(3, 5, 10, 8);
    g.fillRect(4, 4, 8, 10);
    g.fillRect(2, 6, 12, 6);
    rect(g, rgba(shade(c, 0.5), 0.8), 4, 5, 2, 2);      // gloss
    rect(g, rgba(shade(c, -0.35), 0.6), 3, 12, 10, 1);  // dense base
  }

  function paintOre(g, metal) {
    const stone = '#7d7d7d';
    g.fillStyle = stone;                    // rocky lump
    g.beginPath();
    g.moveTo(2, 10);
    g.lineTo(4, 4);
    g.lineTo(10, 2);
    g.lineTo(14, 6);
    g.lineTo(13, 12);
    g.lineTo(6, 14);
    g.closePath();
    g.fill();
    rect(g, shade(stone, 0.18), 5, 5, 2, 1);
    rect(g, shade(stone, -0.2), 10, 9, 2, 1);
    rect(g, shade(stone, -0.2), 4, 11, 2, 1);
    const nugget = (x, y) => {              // colored nuggets
      rect(g, metal, x, y, 2, 2);
      rect(g, shade(metal, 0.4), x, y, 1, 1);
      rect(g, shade(metal, -0.3), x + 1, y + 1, 1, 1);
    };
    nugget(5, 7);
    nugget(9, 4);
    nugget(10, 10);
  }

  function paintFallback(g) {
    rect(g, '#8d8676', 3, 3, 10, 10);
    rect(g, '#6d675a', 3, 3, 10, 1);
    rect(g, '#6d675a', 3, 12, 10, 1);
    rect(g, '#6d675a', 3, 3, 1, 10);
    rect(g, '#6d675a', 12, 3, 1, 10);
    rect(g, '#a49c8a', 5, 5, 3, 2);
  }

  function paintArmor(g, id) {
    const metal = tierMetal(id) || '#c0c0cc';
    const dark = shade(metal, -30), lite = shade(metal, 35);
    if (/helmet$/.test(id)) {            // dome cap with visor slit
      rect(g, metal, 4, 4, 8, 5);
      rect(g, lite, 4, 4, 8, 1);
      rect(g, dark, 3, 7, 10, 2);
      rect(g, dark, 4, 9, 2, 3);
      rect(g, dark, 10, 9, 2, 3);
      rect(g, '#20242c', 6, 8, 4, 1);    // visor
    } else if (/mail$/.test(id)) {       // chestplate with shoulders
      rect(g, metal, 5, 4, 6, 8);
      rect(g, lite, 5, 4, 6, 1);
      rect(g, dark, 3, 4, 2, 3);
      rect(g, dark, 11, 4, 2, 3);
      rect(g, dark, 7, 5, 2, 6);         // center ridge
      rect(g, metal, 5, 12, 2, 2);
      rect(g, metal, 9, 12, 2, 2);
    } else {                             // greaves / boots
      rect(g, metal, 4, 3, 3, 7);
      rect(g, metal, 9, 3, 3, 7);
      rect(g, lite, 4, 3, 3, 1);
      rect(g, lite, 9, 3, 3, 1);
      rect(g, dark, 3, 10, 5, 3);
      rect(g, dark, 8, 10, 5, 3);
      rect(g, '#3a3430', 3, 13, 5, 1);
      rect(g, '#3a3430', 8, 13, 5, 1);
    }
  }

  function paintCharm(g) {               // Void Charm: dark orb, gold rim, glint
    rect(g, '#2a1f38', 4, 4, 8, 8);
    rect(g, '#3a2a50', 5, 5, 6, 6);
    rect(g, CONST.COLORS.gold || '#ffd24a', 4, 4, 8, 1);
    rect(g, CONST.COLORS.gold || '#ffd24a', 4, 11, 8, 1);
    rect(g, CONST.COLORS.gold || '#ffd24a', 3, 5, 1, 6);
    rect(g, CONST.COLORS.gold || '#ffd24a', 12, 5, 1, 6);
    rect(g, '#b07ae8', 6, 6, 2, 2);
    rect(g, '#181022', 9, 8, 2, 2);
  }

  // Buckets: riveted metal pail with an arc handle; the fill color names the
  // liquid it carries (empty shows bare interior).
  const BUCKET_FILL = {
    bucket_water: ['#3a6ea8', '#5a8ec8'],
    bucket_lava: ['#e85a1a', '#ffb03a'],
    bucket_honey: ['#d18a1f', '#f0b455'],
  };
  function paintBucket(g, id) {
    g.fillStyle = '#9aa0ad';               // body
    g.beginPath();
    g.moveTo(3.5, 6);
    g.lineTo(12.5, 6);
    g.lineTo(11.2, 14);
    g.lineTo(4.8, 14);
    g.closePath();
    g.fill();
    g.strokeStyle = '#7d828e';             // body shading
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(4, 13); g.lineTo(12, 13); g.stroke();
    g.strokeStyle = '#c6ccd8';             // rim + handle
    g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(3, 6); g.lineTo(13, 6); g.stroke();
    g.beginPath(); g.moveTo(4.5, 6); g.quadraticCurveTo(8, 1.5, 11.5, 6); g.stroke();
    const fill = BUCKET_FILL[id];
    if (fill) {
      g.fillStyle = fill[0];               // liquid surface peeking over the rim
      g.fillRect(4.5, 6.5, 7, 2);
      g.fillStyle = fill[1];
      g.fillRect(5.5, 6.5, 2, 1);
    } else {
      g.fillStyle = '#5d626e';             // empty: dark interior
      g.fillRect(4.5, 6.8, 7, 1.6);
    }
  }

  // Coins (TC.Economy denominations): a stamped metal disc with a mint mark
  // sized by denomination so the three tiers read apart at a glance.
  function paintCoin(g, id) {
    const metal = id === 'coin_gold' ? '#ffd24a'
      : id === 'coin_silver' ? '#c0c0cc'
      : '#c87137';
    g.fillStyle = shade(metal, -40);       // rim shadow
    g.beginPath(); g.arc(8, 8.6, 6.2, 0, Math.PI * 2); g.fill();
    g.fillStyle = metal;                   // face
    g.beginPath(); g.arc(8, 8, 5.6, 0, Math.PI * 2); g.fill();
    g.fillStyle = shade(metal, 45);        // top-left glint band
    g.beginPath();
    g.moveTo(3.6, 6.4);
    g.arc(8, 8, 4.6, Math.PI * 1.05, Math.PI * 1.55);
    g.closePath();
    g.fill();
    g.strokeStyle = shade(metal, -55);     // mint mark: ring / bars / star
    g.lineWidth = 1;
    if (id === 'coin_gold') {
      g.beginPath(); g.arc(8, 8, 2.4, 0, Math.PI * 2); g.stroke();
      rect(g, shade(metal, -55), 7.5, 5, 1, 6);
    } else if (id === 'coin_silver') {
      g.beginPath();
      g.moveTo(5.5, 8); g.lineTo(10.5, 8);
      g.moveTo(8, 5.5); g.lineTo(8, 10.5);
      g.stroke();
    } else {
      g.beginPath();
      g.moveTo(6, 9.5); g.lineTo(8, 5.8); g.lineTo(10, 9.5);
      g.stroke();
    }
  }

  function shade(hex, amt) {             // hex like #rrggbb -> lightened/darkened
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amt));
    const gg = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
    const b = Math.max(0, Math.min(255, (n & 255) + amt));
    return '#' + ((r << 16) | (gg << 8) | b).toString(16).padStart(6, '0');
  }

  function paintIcon(g, id) {
    const d = def(id);
    if (d && d.tile != null && TC.Tiles && typeof TC.Tiles.drawTile === 'function') {
      TC.Tiles.drawTile(g, d.tile, 0, 0, ICON, 0, 0, 15);   // blocks reuse tiles
      return;
    }
    const metal = tierMetal(id);
    const wood = CONST.COLORS.wood || '#8a5a32';
    if (d && d.kind === 'tool') {
      if (d.tool === 'pick') return paintPickaxe(g, metal || '#c0c0cc', wood);
      return paintAxe(g, metal || '#c0c0cc', wood);
    }
    if (d && d.kind === 'weapon') return paintSword(g, metal || wood, '#6a5a2a', wood);
    if (d && d.kind === 'ranged') return paintBow(g, wood);
    if (id === 'arrow') return paintArrow(g);
    if (d && d.kind === 'armor') return paintArmor(g, id);
    if (d && d.kind === 'summon') return paintCharm(g);
    if (d && d.kind === 'bucket') return paintBucket(g, id);
    if (d && d.kind === 'currency') return paintCoin(g, id);
    if (d && d.kind === 'material') {
      if (/_bar$/.test(id) && metal) return paintBar(g, metal);
      if (/_ore$/.test(id) && metal) return paintOre(g, metal);
      if (id === 'gel') return paintGel(g);
    }
    paintFallback(g);
  }

  function iconFor(id) {
    const key = String(id);
    let cv = iconCache.get(key);
    if (cv) return cv;
    const gic = (TC.Gear && TC.Gear.iconFor && TC.Gear.iconFor(key)) ||
                (TC.Loot && TC.Loot.iconFor && TC.Loot.iconFor(key)) ||
                (TC.Wiring && typeof TC.Wiring.iconFor === 'function' && TC.Wiring.iconFor(key)) ||
                (TC.Magic && typeof TC.Magic.iconFor === 'function' && TC.Magic.iconFor(key)) ||
                (TC.Accessories && typeof TC.Accessories.iconFor === 'function' && TC.Accessories.iconFor(key)) ||
                (TC.Fishing && typeof TC.Fishing.iconFor === 'function' && TC.Fishing.iconFor(key));
    if (gic) { iconCache.set(key, gic); return gic; }
    cv = document.createElement('canvas');
    cv.width = ICON;
    cv.height = ICON;
    const g = cv.getContext('2d');
    try { paintIcon(g, key); } catch (e) { paintFallback(g); }
    iconCache.set(key, cv);
    return cv;
  }

  // ====================================================================
  // TC.Chests — containers keyed by 'tx,ty'; each is 20 slots of null|{id,count}.
  // ====================================================================
  const CHEST_SIZE = 20;
  const chests = new Map();

  function chestKey(tx, ty) { return (tx | 0) + ',' + (ty | 0); }

  function chestGet(tx, ty) {
    const k = chestKey(tx, ty);
    let slots = chests.get(k);
    if (!slots) {                       // lazy-create an empty container
      slots = new Array(CHEST_SIZE).fill(null);
      chests.set(k, slots);
    }
    return slots;
  }

  // Scatter every stored item as world drops at the tile center, then forget it.
  function chestSpill(tx, ty) {
    const slots = chests.get(chestKey(tx, ty));
    chests.delete(chestKey(tx, ty));
    if (!slots || !TC.Items || typeof TC.Items.spawnDrop !== 'function') return;
    const cx = ((tx | 0) + 0.5) * CONST.TS;
    const cy = ((ty | 0) + 0.5) * CONST.TS;
    for (let i = 0; i < slots.length; i++) {
      const s = sanitizeStack(slots[i]);
      if (s) TC.Items.spawnDrop(cx, cy, s.id, s.count, true);
    }
  }

  // Plain object { 'tx,ty': [slots...] }; empty containers are omitted.
  function chestSerialize() {
    const out = {};
    chests.forEach((slots, k) => {
      let hasItem = false;
      const arr = new Array(slots.length);
      for (let i = 0; i < slots.length; i++) {
        const s = sanitizeStack(slots[i]);
        arr[i] = s ? { id: s.id, count: s.count } : null;
        if (s) hasItem = true;
      }
      if (hasItem) out[k] = arr;
    });
    return out;
  }

  // Replace map contents; bad keys/entries are ignored.
  function chestLoad(data) {
    chests.clear();
    if (!data || typeof data !== 'object') return;
    Object.keys(data).forEach((k) => {
      const arr = data[k];
      if (!Array.isArray(arr)) return;
      let any = false;
      const slots = new Array(CHEST_SIZE).fill(null);
      for (let i = 0; i < arr.length && i < CHEST_SIZE; i++) {
        const s = sanitizeStack(arr[i]);
        if (s) { slots[i] = s; any = true; }
      }
      if (any) chests.set(String(k), slots);
    });
  }

  // Forget every container (fresh world); no drops are spawned.
  function chestClear() {
    chests.clear();
  }

  // ---- public surface ----
  TC.Inventory = Inventory;
  TC.Items = { drops, spawnDrop, update, draw, clearDrops, iconFor };
  TC.Chests = { get: chestGet, spill: chestSpill, serialize: chestSerialize, load: chestLoad, clear: chestClear };
})();
