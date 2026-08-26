/* liquids.js — THE authoritative liquid simulation (GAMEPLAY campaign W1).
   Liquid lives in two typed arrays (type + amount 0..255 per cell) layered
   over the tile grid. Provides a budgeted volume-based settle sim (fall /
   spread / equalize / evaporate, water+lava -> stone contact), immersion
   queries for breath/buoyancy consumers, wave rendering, sparse SaveCore
   persistence, bucket collect/place interactions, and a CONSUMING bridge
   import from WATER/LAVA tiles.
   Authority model (single authority, one-way migration):
     - Every runtime world enters mode 'layer' at build time: main.buildWorld
       calls importFromWorld() which CLAIMS all WATER/LAVA tiles out of the
       grid (tiles -> AIR) into this layer. The legacy tile ids survive only
       as worldgen output format and legacy-save diff payloads; they never
       simulate anything (the old World.stepWater mover was removed).
     - Legacy liquid tiles are treated as SOLID by this sim so flow can never
       re-enter them, and claim-on-set clears them when the layer writes a
       cell they occupy.
   Invariant: no cell ever holds BOTH a legacy liquid tile AND layer liquid.
   Enforced by claim-on-set, consuming import, restore filtering, and the
   settle sim refusing to enter legacy-liquid cells. */

(() => {
  const TC = window.TC;
  const TS = (TC.CONST && TC.CONST.TS) || 16;

  // ---- tuning (TC.CONST.LIQUIDS overrides when present) ----
  const LC = (TC.CONST && TC.CONST.LIQUIDS) || {};
  const TICK = LC.tick || 0.05; // seconds between settle steps
  const BUDGET = LC.budget || 400; // active cells processed per step
  const MAX_ACTIVE = LC.maxActive || 4000;
  const MIN_VOLUME = LC.minVolume || 8; // settled cells below this evaporate
  const EVENT_CAP = 32; // LiquidChanged entries queued per frame

  const TYPE = { NONE: 0, WATER: 1, LAVA: 2, HONEY: 3 };
  const FULL = 255; // one completely full cell
  const VISC = [1, 1, 1, 4]; // transfer divisor per type (honey crawls)

  const COLORS = { 1: "#3a6ea8", 2: "#e85a1a", 3: "#d18a1f" };
  const ALPHA = { 1: 0.72, 2: 0.96, 3: 0.85 };

  // ---- state (module-level: only one World lives at a time) ----
  let worldRef = null;
  let liquidType = null; // Uint8Array width*height, TYPE.*
  let liquidAmount = null; // Uint8Array width*height, 0..255
  let ready = false;
  let acc = 0; // settle-step accumulator (seconds)
  let mode = "tiles"; // 'tiles' | 'layer' (authority, see header)
  const active = new Set(); // cell indices due for a settle visit
  let frameChanges = []; // [[x,y,type,amount]] recorded this frame
  let frameContacts = []; // [[x,y]] water+lava -> stone this frame

  function clampType(t) {
    t = t | 0;
    return t >= TYPE.WATER && t <= TYPE.HONEY ? t : 0;
  }
  function clampAmt(a) {
    a = a | 0;
    return a < 0 ? 0 : a > FULL ? FULL : a;
  }

  // Legacy liquid tiles are impassable terrain for THIS layer's sim so flow
  // can never violate the dual-authority invariant from the layer side.
  function solidAt(w, x, y) {
    const id = w.tiles[y * w.width + x];
    if (id === TC.TILE.WATER || id === TC.TILE.LAVA) return true;
    if (typeof w.isSolid === "function") return w.isSolid(x, y);
    return !!TC.TILE_DEFS[id].solid;
  }

  // ---- active set ----
  function wakeIdx(i) {
    if (active.has(i)) return;
    if (active.size >= MAX_ACTIVE) {
      // Evict the oldest entries (Sets iterate in insertion order).
      let excess = active.size - MAX_ACTIVE + 1;
      for (const k of active) {
        active.delete(k);
        if (--excess <= 0) break;
      }
    }
    active.add(i);
  }

  function wakeAroundIdx(i) {
    const w = worldRef;
    if (!w) return;
    const width = w.width,
      x = i % width,
      y = (i / width) | 0;
    if (x > 0) wakeIdx(i - 1);
    if (x < width - 1) wakeIdx(i + 1);
    if (y > 0) wakeIdx(i - width);
    if (y < w.height - 1) wakeIdx(i + width);
  }

  // Public: wake a cell plus its 4-neighbours (after edits, placements...).
  function wake(x, y) {
    const w = worldRef;
    if (!ready || !w || !w.inB(x, y)) return;
    wakeIdx(y * w.width + x);
    wakeAroundIdx(y * w.width + x);
  }

  function noteChange(i) {
    const w = worldRef;
    if (frameChanges.length < 128) { // hard cap; payload trims to 32
      frameChanges.push([
        i % w.width,
        (i / w.width) | 0,
        liquidType[i],
        liquidAmount[i],
      ]);
    }
    // W21: liquid motion invalidates its region in the shared authority so
    // the minimap (and any other presentation consumer) repaints exactly
    // the affected area.
    if (TC.WorldRegions && typeof TC.WorldRegions.markCell === "function") {
      TC.WorldRegions.markCell(i % w.width, (i / w.width) | 0, "liquid");
    }
  }

  // ---- settle sim ----
  // Volume actually handed over per visit: viscosity stretches honey out.
  function pour(type, want) {
    return Math.ceil(want / VISC[type]);
  }

  // Push volume from cell i into side cell s. Returns units moved.
  function spreadInto(i, s, t) {
    const w = worldRef;
    if (liquidType[i] !== t) return 0; // spent by the first spread
    if (solidAt(w, s % w.width, (s / w.width) | 0)) return 0;
    const st = liquidType[s];
    const a = liquidAmount[i];
    if (st === t) {
      // equalize toward the lower side
      const d = a - liquidAmount[s];
      if (d < 2) return 0;
      const m = Math.min(a, pour(t, d >> 1));
      liquidAmount[s] += m;
      liquidAmount[i] = a - m;
      noteChange(s);
      noteChange(i);
      return m;
    }
    if (st !== TYPE.NONE) return 0; // immiscible; contact is vertical-only
    const m = Math.min(a, pour(t, a >> 1)); // spill: split roughly half
    // Viability guard: never spill when either side would land below the
    // evaporation floor — unguarded halving thins pools away to nothing.
    if (m < MIN_VOLUME || a - m < MIN_VOLUME) return 0;
    liquidType[s] = t;
    liquidAmount[s] = m;
    liquidAmount[i] = a - m;
    if (liquidAmount[i] === 0) liquidType[i] = TYPE.NONE;
    noteChange(s);
    noteChange(i);
    wakeIdx(s);
    wakeAroundIdx(s);
    return m;
  }

  // Water + lava contact: both liquids are consumed and a stone block forms
  // at the receiving cell (basic obsidian stand-in). setRaw is guarded so
  // headless/test worlds without the full edit path just consume the liquids.
  function reactContact(src, dst, dx, dy) {
    liquidType[src] = TYPE.NONE;
    liquidAmount[src] = 0;
    liquidType[dst] = TYPE.NONE;
    liquidAmount[dst] = 0;
    noteChange(src);
    noteChange(dst);
    if (frameContacts.length < EVENT_CAP) frameContacts.push([dx, dy]);
    const w = worldRef;
    if (w && typeof w.setRaw === "function") {
      try {
        w.setRaw(dx, dy, TC.TILE.STONE);
      } catch (e) {
        /* headless worlds */
      }
    }
    wakeAroundIdx(src);
    wakeAroundIdx(dst);
  }

  // One cell's rules: fall/pour down, else spread sideways splitting volume,
  // else settle (tiny volumes evaporate). Returns true when the cell should
  // stay active for another visit.
  function settleCell(i) {
    const w = worldRef;
    const width = w.width,
      height = w.height;
    const x = i % width,
      y = (i / width) | 0;
    const t = liquidType[i];
    let a = liquidAmount[i];
    if (t === TYPE.NONE || a === 0) return false; // stale entry

    // 1) gravity: free-fall into an empty cell below, pour into a partial
    //    one, react when the liquid below is a different type
    const below = y + 1 < height ? i + width : -1;
    if (below >= 0 && !solidAt(w, x, y + 1)) {
      const bt = liquidType[below];
      if (bt === TYPE.NONE) {
        liquidType[below] = t;
        liquidAmount[below] = a;
        liquidType[i] = TYPE.NONE;
        liquidAmount[i] = 0;
        noteChange(below);
        noteChange(i);
        wakeIdx(below);
        wakeAroundIdx(below);
        wakeAroundIdx(i); // the column above follows
        return false; // source is spent
      }
      if (bt === t && liquidAmount[below] < FULL) {
        const want = Math.min(a, FULL - liquidAmount[below]);
        const m = Math.min(a, pour(t, want));
        liquidAmount[below] += m;
        a -= m;
        noteChange(below);
        if (a === 0) {
          liquidType[i] = TYPE.NONE;
          liquidAmount[i] = 0;
          noteChange(i);
          return false;
        }
        liquidAmount[i] = a;
        noteChange(i);
        return true;
      }
      if (bt !== t) {
        reactContact(i, below, x, y + 1);
        return false;
      }
    }

    // 2) sideways: spill into empty cells and equalize with lower same-type
    //    neighbours; the preferred side alternates by parity (anti-jitter)
    const l = x > 0 ? i - 1 : -1;
    const r = x < width - 1 ? i + 1 : -1;
    const first = (i & 1) === 0 ? r : l;
    const second = first === l ? r : l;
    let moved = 0;
    if (first >= 0) moved += spreadInto(i, first, t);
    if (second >= 0) moved += spreadInto(i, second, t);

    // 3) settled: tiny volumes evaporate instead of lingering as thin films
    if (moved === 0) {
      a = liquidAmount[i];
      if (a < MIN_VOLUME) {
        liquidType[i] = TYPE.NONE;
        liquidAmount[i] = 0;
        noteChange(i);
      }
      return false;
    }
    return true; // more to give next visit
  }

  // Batched LiquidChanged emission: one queued event per settling frame, at
  // most EVENT_CAP change entries (overflow reported via payload.more).
  function flushEvents() {
    if (!frameChanges.length && !frameContacts.length) return;
    if (
      TC.Events &&
      typeof TC.Events.queue === "function" &&
      TC.Events.EVENT &&
      TC.Events.EVENT.LiquidChanged
    ) {
      TC.Events.queue(TC.Events.EVENT.LiquidChanged, {
        changes: frameChanges.slice(0, EVENT_CAP),
        more: Math.max(0, frameChanges.length - EVENT_CAP),
        contacts: frameContacts.slice(0, EVENT_CAP),
      });
    }
    frameChanges.length = 0;
    frameContacts.length = 0;
  }

  // ---- lifecycle ----
  // Lazy allocation for the live world; keeps existing arrays when reused.
  function init(w) {
    if (!w) return false;
    if (
      ready &&
      worldRef === w &&
      liquidType &&
      liquidType.length === w.width * w.height
    )
      return true;
    return reset(w);
  }

  // Hard clear + (re)allocation for a new/loaded world. A fresh world starts
  // in 'tiles' mode: worldgen liquid arrives as WATER/LAVA tile ids owned by
  // the legacy sim until an explicit import claims it into the layer.
  function reset(w) {
    worldRef = w || null;
    ready = false;
    mode = "tiles";
    active.clear();
    acc = 0;
    frameChanges = [];
    frameContacts = [];
    if (!w) return false;
    liquidType = new Uint8Array(w.width * w.height);
    liquidAmount = new Uint8Array(w.width * w.height);
    ready = true;
    return true;
  }

  // Budgeted settle pass, at most every TICK (mirrors world.stepWater).
  // PERF + DETERMINISM: the active set is snapshotted into a reusable buffer
  // and processed in ascending index order each step. Cells woken mid-step
  // join the NEXT step — identical inputs now produce identical evolution
  // regardless of how the set was built (save/load rebuilds it), so saved
  // worlds replay their remaining settle deterministically.
  let orderBuf = new Uint32Array(0);
  function update(dt) {
    if (!ready) return;
    frameChanges.length = 0;
    frameContacts.length = 0;
    acc += dt;
    if (acc < TICK) return;
    acc %= TICK;
    if (!active.size) return;
    if (orderBuf.length < active.size) {
      orderBuf = new Uint32Array(Math.max(64, active.size * 2));
    }
    const list = orderBuf;
    {
      let k = 0;
      for (const i of active) list[k++] = i;
    }
    const n = active.size;
    // Numeric, in-place sort of exactly the occupied range.
    orderBuf.subarray(0, n).sort();
    let budget = BUDGET;
    for (let k = 0; k < n; k++) {
      if (budget-- <= 0) break;
      if (!settleCell(list[k])) active.delete(list[k]);
    }
    flushEvents();
  }

  // ---- queries ----
  // Immersion sample for breath/buoyancy consumers. px/py in world pixels.
  function sampleAt(px, py) {
    const w = worldRef;
    if (!ready || !w || !isFinite(px) || !isFinite(py)) {
      return { type: TYPE.NONE, amount: 0, percent: 0 };
    }
    const tx = Math.floor(px / TS),
      ty = Math.floor(py / TS);
    if (!w.inB(tx, ty)) return { type: TYPE.NONE, amount: 0, percent: 0 };
    const i = ty * w.width + tx;
    const a = liquidAmount[i];
    return { type: liquidType[i], amount: a, percent: a / FULL };
  }

  // Tile-coord query for consumers (fishing zones, minimap, rendering):
  // { type, amount } at a cell, zeros when out of bounds / not ready.
  function queryAt(tx, ty) {
    const w = worldRef;
    if (!ready || !w || !w.inB(tx, ty)) {
      return { type: TYPE.NONE, amount: 0 };
    }
    const i = ty * w.width + tx;
    return { type: liquidType[i], amount: liquidAmount[i] };
  }

  // Displace the liquid under a newly placed tile: the volume is destroyed
  // (not pushed — deterministic and simple), neighbours wake so pools close
  // the gap. Called from World.set when a solid/opaque tile covers a cell.
  function displace(x, y) {
    const w = worldRef;
    if (!ready || !w || !w.inB(x, y)) return false;
    const i = ty_idx(w, x, y);
    if (liquidType[i] === TYPE.NONE && liquidAmount[i] === 0) return false;
    liquidType[i] = TYPE.NONE;
    liquidAmount[i] = 0;
    noteChange(i);
    wakeAroundIdx(i);
    return true;
  }

  function ty_idx(w, x, y) {
    return y * w.width + x;
  }

  // ---- buckets -------------------------------------------------------
  // Canonical liquid containers: an empty bucket scoops a settled cell
  // (needs BUCKET_MIN volume), a filled bucket pours a FULL cell into an
  // empty, non-solid one. Either way the held item converts in place.
  const COLLECT_MIN = 96; // ~38% of a cell: puddle films can't be scooped
  const BUCKET_CD = 0.3; // seconds between uses (player._bucketCd)
  const BUCKET_ITEM = { 1: "bucket_water", 2: "bucket_lava", 3: "bucket_honey" };

  // Scoop the whole cell at (tx,ty). Returns the collected TYPE or 0 when
  // too shallow / dry / blocked.
  function collectAt(tx, ty) {
    const w = worldRef;
    if (!ready || !w || !w.inB(tx, ty)) return 0;
    const i = ty_idx(w, tx, ty);
    if (liquidAmount[i] < COLLECT_MIN) return 0;
    const t = liquidType[i];
    if (!t) return 0;
    liquidType[i] = TYPE.NONE;
    liquidAmount[i] = 0;
    noteChange(i);
    wakeAroundIdx(i);
    return t;
  }

  // Pour a FULL cell of `type` at (tx,ty). Fails on solids, other liquids,
  // legacy liquid tiles and cells that already hold liquid. Wakes the cell.
  function placeAt(tx, ty, type) {
    const w = worldRef;
    type = clampType(type);
    if (!type || !ready || !w || !w.inB(tx, ty)) return false;
    const id = w.tiles[ty_idx(w, tx, ty)];
    if (id === TC.TILE.WATER || id === TC.TILE.LAVA) return false;
    if (typeof w.isSolid === "function" ? w.isSolid(tx, ty) : !!TC.TILE_DEFS[id].solid)
      return false;
    const i = ty_idx(w, tx, ty);
    if (liquidType[i] !== TYPE.NONE) return false;
    liquidType[i] = type;
    liquidAmount[i] = FULL;
    noteChange(i);
    wakeIdx(i);
    wakeAroundIdx(i);
    return true;
  }

  // Lead-facing use hook (kind 'bucket' items). True = the vanilla switch
  // must not run. Click-paced via player._bucketCd; dt only ticks it down.
  function onUseHeld(player, def, dt) {
    if (!player || !def || def.kind !== "bucket") return false;
    if ((player._bucketCd || 0) > 0) {
      player._bucketCd -= dt || 0; // click-paced: swallow the hold while hot
      return true;
    }
    const inp = TC.Input;
    const m = inp && inp.mouse;
    if (!m || !isFinite(m.worldX) || !isFinite(m.worldY)) return true;
    const tx = Math.floor(m.worldX / TS),
      ty = Math.floor(m.worldY / TS);
    const sel =
      typeof player.selectedSlot === "function" ? player.selectedSlot() : null;
    const inv = player.inventory;
    if (!sel || !inv || typeof inv.add !== "function") return true;

    let used = false;
    if (def.bucketEmpty) {
      const got = collectAt(tx, ty);
      if (got && BUCKET_ITEM[got] && TC.ITEM_DEFS[BUCKET_ITEM[got]]) {
        used = swapHeld(inv, sel.id, BUCKET_ITEM[got]);
        if (used) splashFx(tx, ty, got);
      } else {
        floatTxt(
          m.worldX,
          m.worldY,
          "no liquid",
          "#9ecbff",
        );
      }
    } else if (def.bucketType) {
      if (placeAt(tx, ty, def.bucketType)) {
        used = swapHeld(inv, sel.id, "bucket");
        if (used) splashFx(tx, ty, clampType(def.bucketType));
      }
    }
    if (used) {
      player._bucketCd = BUCKET_CD;
      sfx("splash");
    }
    return true;
  }

  // Consume one of itemId from the slot that holds it and add `giveId`.
  // Prefers the selected slot; falls back to any stack of the same id.
  function swapHeld(inv, itemId, giveId) {
    const slots = Array.isArray(inv.slots) ? inv.slots : null;
    if (!slots) return false;
    let idx = -1;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] && slots[i].id === itemId) {
        idx = i;
        break;
      }
    }
    if (idx < 0 || !TC.ITEM_DEFS[giveId]) return false;
    slots[idx].count--;
    if (slots[idx].count <= 0) slots[idx] = null;
    inv.add(giveId, 1);
    if (
      TC.Events &&
      typeof TC.Events.emit === "function" &&
      TC.Events.EVENT &&
      TC.Events.EVENT.InventoryChanged
    ) {
      try {
        TC.Events.emit(TC.Events.EVENT.InventoryChanged, {
          reason: "bucket",
          from: String(itemId),
          to: String(giveId),
        });
      } catch (e) {}
    }
    return true;
  }

  function splashFx(tx, ty, t) {
    const c = COLORS[t] || COLORS[1];
    if (TC.Particles && typeof TC.Particles.burst === "function") {
      try {
        TC.Particles.burst((tx + 0.5) * TS, (ty + 0.5) * TS, 8, {
          colors: [c],
          speed: 70,
          life: 0.4,
          size: 2,
        });
      } catch (e) {}
    }
  }

  function sfx(name) {
    if (TC.Audio && typeof TC.Audio.play === "function") {
      try {
        TC.Audio.play(name);
      } catch (e) {}
    }
  }

  function floatTxt(x, y, str, color) {
    if (TC.Particles && typeof TC.Particles.floatText === "function") {
      try {
        TC.Particles.floatText(x, y, str, color);
      } catch (e) {}
    }
  }

  // Topmost liquid row in a tile column, -1 when the column is dry.
  function columnSurface(tx) {
    const w = worldRef;
    if (!ready || !w || tx < 0 || tx >= w.width) return -1;
    for (let ty = 0; ty < w.height; ty++) {
      const i = ty * w.width + tx;
      if (liquidType[i] !== TYPE.NONE && liquidAmount[i] > 0) return ty;
    }
    return -1;
  }

  // Mean surface row across [tx0..tx1] (dry columns ignored), -1 if all dry.
  function averageColumnSurface(tx0, tx1) {
    const w = worldRef;
    if (!ready || !w) return -1;
    const a = Math.max(0, tx0 | 0),
      b = Math.min(w.width - 1, tx1 | 0);
    let sum = 0,
      n = 0;
    for (let tx = a; tx <= b; tx++) {
      const s = columnSurface(tx);
      if (s >= 0) {
        sum += s;
        n++;
      }
    }
    return n ? sum / n : -1;
  }

  // Direct layer write for future spigots/migration tooling. Wakes the cell.
  // CLAIMS the cell first: writing liquid over a legacy WATER/LAVA tile clears
  // that tile (setRaw keeps chunk rebuild + TileChanged correct) so the two
  // representations can never hold the same conceptual liquid.
  function set(tx, ty, type, amount) {
    const w = worldRef;
    if (!ready || !w || !w.inB(tx, ty)) return false;
    const i = ty * w.width + tx;
    const t = clampType(type),
      a = clampAmt(amount);
    if (t && a) {
      const id = w.tiles[i];
      if (id === TC.TILE.WATER || id === TC.TILE.LAVA) {
        try {
          w.setRaw(tx, ty, TC.TILE.AIR);
        } catch (e) {
          /* headless worlds */
        }
      }
    }
    liquidType[i] = t && a ? t : TYPE.NONE;
    liquidAmount[i] = t && a ? a : 0;
    // W24 defect fix: the direct-write authority seam MUST report to the
    // shared invalidation authority like every other mutation path (buckets
    // and settling already do). Without this, pump/spigot writes were
    // invisible to region consumers — including multiplayer replication.
    noteChange(i);
    wake(tx, ty);
    return true;
  }

  // W24 read-only region snapshot seam for replication: copies authoritative
  // type+amount layers for a CHUNK×CHUNK tile area into fresh (or provided)
  // buffers. Never exposes the live arrays. Out-of-bounds cells read as empty.
  function snapshotRegion(baseX, baseY, size, outType, outAmt) {
    const w = worldRef;
    const t = outType || new Uint8Array(size * size);
    const a = outAmt || new Uint8Array(size * size);
    if (!ready || !w || !liquidType) return { type: t, amount: a };
    for (let y = 0; y < size; y++) {
      const wy = baseY + y;
      if (wy >= w.height) break;
      for (let x = 0; x < size; x++) {
        const wx = baseX + x;
        if (wx >= w.width) break;
        const o = y * size + x;
        const i = wy * w.width + wx;
        t[o] = liquidType[i];
        a[o] = liquidAmount[i];
      }
    }
    return { type: t, amount: a };
  }

  // W24 presentation-only mirror writer for JOINED CLIENTS: writes replicated
  // truth straight into the local layer without waking the settle sim,
  // queueing LiquidChanged events, or touching gameplay state elsewhere.
  // Marks WorldRegions ('liquid') so local renderer/minimap/lighting repaint.
  // The HOST must never call this; it is not an authority mutation path.
  function applyMirrorRegion(baseX, baseY, size, srcType, srcAmt) {
    const w = worldRef;
    if (!ready || !w || !liquidType) return false;
    if (!srcType || !srcAmt || srcType.length < size * size || srcAmt.length < size * size) {
      return false;
    }
    let changed = -1;
    for (let y = 0; y < size && changed < 0; y++) {
      const wy = baseY + y;
      if (wy >= w.height) break;
      for (let x = 0; x < size; x++) {
        const wx = baseX + x;
        if (wx >= w.width) break;
        const o = y * size + x;
        const i = wy * w.width + wx;
        if (liquidType[i] !== srcType[o]) { changed = i; break; }
        if (liquidAmount[i] !== srcAmt[o]) { changed = i; break; }
      }
    }
    if (changed < 0) return true; // idempotent re-apply, nothing to paint
    for (let y = 0; y < size; y++) {
      const wy = baseY + y;
      if (wy >= w.height) break;
      for (let x = 0; x < size; x++) {
        const wx = baseX + x;
        if (wx >= w.width) break;
        const o = y * size + x;
        const i = wy * w.width + wx;
        const nt = clampType(srcType[o]);
        const na = nt ? clampAmt(srcAmt[o]) : 0;
        if (liquidType[i] === nt && liquidAmount[i] === na) continue;
        liquidType[i] = nt;
        liquidAmount[i] = na;
        if (TC.WorldRegions && typeof TC.WorldRegions.markCell === "function") {
          TC.WorldRegions.markCell(wx, wy, "liquid");
        }
      }
    }
    return true;
  }

  // Deterministic FNV-1a over the full authoritative liquid layers. Used by
  // replay/convergence tests to prove identical type+amount state.
  function digest() {
    if (!ready || !liquidType) return 0;
    let h = 0x811c9dc5;
    const mix = (v) => {
      h ^= v & 0xff; h = (h * 0x01000193) >>> 0;
    };
    for (let i = 0; i < liquidType.length; i++) {
      mix(liquidType[i]);
      mix(liquidAmount[i]);
    }
    return h >>> 0;
  }

  // Debug snapshot: nonzero cell count + active-set size (O(n) scan).
  function stats() {
    if (!ready || !liquidType) return { cells: 0, active: 0 };
    let cells = 0;
    for (let i = 0; i < liquidType.length; i++) {
      if (liquidType[i] !== TYPE.NONE && liquidAmount[i] > 0) cells++;
    }
    return { cells: cells, active: active.size };
  }

  // ---- bridge: CONSUMING tile -> layer conversion (the migration act) ----
  // Deterministic row-major scan; every WATER/LAVA tile becomes a FULL layer
  // cell and its tile is claimed to AIR via setRaw (chunk rebuild + TileChanged
  // stay correct). This is the one-way boundary: afterwards the layer is the
  // sole liquid authority (mode 'layer') and world.stepWater() freezes.
  // Surface cells are woken so pools resettle.
  function importFromWorld(w) {
    if (!w) return 0;
    // Reset only when switching worlds or resizing; a repeat import on the
    // SAME world must be a non-destructive no-op (it finds no liquid tiles
    // left to claim), never a wipe of already-imported layer data.
    const sized = worldRef === w && liquidType && liquidType.length === w.width * w.height;
    if (!sized && !reset(w)) return 0;
    const T = TC.TILE,
      n = w.width * w.height;
    let count = 0;
    const claimed = [];
    for (let i = 0; i < n; i++) {
      const id = w.tiles[i];
      if (id === T.WATER) {
        liquidType[i] = TYPE.WATER;
        liquidAmount[i] = FULL;
        count++;
        claimed.push(i);
      } else if (id === T.LAVA) {
        liquidType[i] = TYPE.LAVA;
        liquidAmount[i] = FULL;
        count++;
        claimed.push(i);
      }
    }
    // Claim AFTER the scan so seedWater()'s neighbour wakeups see final state.
    for (let k = 0; k < claimed.length; k++) {
      const i = claimed[k];
      try {
        w.setRaw(i % w.width, (i / w.width) | 0, T.AIR);
      } catch (e) {
        /* headless worlds */
      }
    }
    for (let i = 0; i < n; i++) {
      const t = liquidType[i];
      if (!t) continue;
      const above = i >= w.width ? i - w.width : -1;
      if (above < 0 || liquidType[above] !== t) wakeIdx(i);
    }
    mode = "layer";
    return count;
  }

  // ---- rendering ----
  // World-space; the lead calls this with the camera transform already
  // applied (right after wall/tile draw). Liquid fills its cell by amount;
  // surface cells (no same-type liquid above) get a sine wave on the top
  // edge. Alpha scales with volume so shallow liquid reads as shallow.
  function draw(ctx, cam, w) {
    if (!ready || !liquidType || !cam || !cam.zoom || !ctx.canvas) return;
    const wr = w && w.width * w.height === liquidType.length ? w : worldRef;
    if (!wr) return;
    const width = wr.width;
    const viewW = ctx.canvas.width / cam.zoom;
    const viewH = ctx.canvas.height / cam.zoom;
    const tx0 = Math.max(0, Math.floor(cam.x / TS) - 1);
    const ty0 = Math.max(0, Math.floor(cam.y / TS) - 1);
    const tx1 = Math.min(width - 1, Math.ceil((cam.x + viewW) / TS));
    const ty1 = Math.min(wr.height - 1, Math.ceil((cam.y + viewH) / TS));
    const now = Date.now() * 0.001;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const i = ty * width + tx;
        const t = liquidType[i],
          a = liquidAmount[i];
        if (t === TYPE.NONE || a === 0) continue;
        const pct = a / FULL;
        const above = ty > 0 ? i - width : -1;
        const surf = above < 0 || liquidType[above] !== t;
        const h = TS * (surf ? 0.25 + 0.75 * pct : 1);
        let yOff = TS - h;
        if (surf) yOff += Math.sin(now * 2.2 + tx * 0.7) * 1.5;
        ctx.globalAlpha = ALPHA[t] * (0.35 + 0.65 * pct);
        ctx.fillStyle = COLORS[t];
        ctx.fillRect(tx * TS, ty * TS + yOff, TS, h);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---- persistence ----
  // Sparse [[idx,type,amount]] entries, ascending idx; runs of consecutive
  // equal cells collapse to [idx,type,amount,runLen] (RLE-ish). Only nonzero
  // cells are stored. Deserialize restores into the ctx world and wakes
  // surface cells (no same-type liquid above) so saved pools resettle;
  // buried cells stay dormant until an edit wakes them.
  function registerSaveProvider() {
    if (!TC.SaveCore || typeof TC.SaveCore.register !== "function") return;
    try {
      TC.SaveCore.register("world.core.liquids", {
        version: 2,
        serialize: (ctx) => {
          const w = (ctx && ctx.world) || worldRef;
          if (
            !ready ||
            !w ||
            !liquidType ||
            liquidType.length !== w.width * w.height
          )
            return null;
          const n = liquidType.length;
          const out = [];
          let prev = -2,
            pt = 0,
            pa = 0;
          for (let i = 0; i < n; i++) {
            const t = liquidType[i],
              a = liquidAmount[i];
            if (t === TYPE.NONE || a === 0) continue;
            if (i === prev + 1 && t === pt && a === pa) {
              const e = out[out.length - 1];
              if (e.length === 3) e.push(2);
              else e[3]++;
            } else {
              out.push([i, t, a]);
            }
            prev = i;
            pt = t;
            pa = a;
          }
          // v2: persist the active set so a reload CONTINUES the settle
          // deterministically instead of re-deriving it from a surface-wake
          // heuristic (which changes visit order and can resolve pending
          // water×lava contacts differently than the live session would).
          const act = [];
          if (active.size) {
            const idxs = Array.from(active);
            idxs.sort((x, y) => x - y);
            let s = -2, run = 0;
            for (const i of idxs) {
              if (i === s + run) { run++; continue; }
              if (run) pushRun(act, s, run);
              s = i; run = 1;
            }
            if (run) pushRun(act, s, run);
          }
          return out.length ? { cells: out, active: act } : null;
        },
        deserialize: (data, ctx) => {
          const w = (ctx && ctx.world) || TC.world || null;
          if (!w) return;
          reset(w);
          // v1 legacy payload: bare RLE array of cells.
          const cells = Array.isArray(data) ? data
            : (data && Array.isArray(data.cells)) ? data.cells : null;
          if (!cells) return;
          mode = "layer"; // restored data is layer-owned liquid
          const n = w.width * w.height;
          const legacyWake = Array.isArray(data); // v1: heuristic wakes; v2: exact set below
          for (let k = 0; k < cells.length; k++) {
            applyCellEntry(cells[k], legacyWake);
          }
          // v2: exact active-set restore. Legacy payloads fall back to the
          // surface-wake heuristic above.
          if (!Array.isArray(data) && data && Array.isArray(data.active)) {
            for (let k = 0; k < data.active.length; k++) {
              const e = data.active[k];
              if (!Array.isArray(e) || e.length < 2) continue;
              const start = e[0] | 0;
              const len = Math.max(1, e[1] | 0);
              for (let j = 0; j < len; j++) wakeIdx(start + j);
            }
          }
        },
      });
    } catch (e) {
      console.warn(
        "[TC.Liquids] SaveCore provider registration skipped:",
        e && e.message,
      );
    }
  }

  function pushRun(arr, start, len) { arr.push([start, len]); }

  // One RLE cell entry [start,type,amount(,runLen)] into the live layers,
  // honouring the dual-authority invariant (never over a legacy liquid tile).
  // When `heuristicWake` is set, surface cells also wake (v1 payloads and
  // callers without an explicit active set); v2 restores pass false so the
  // persisted active set is the sole source of wake state.
  function applyCellEntry(e, heuristicWake) {
    if (!Array.isArray(e) || e.length < 3) return;
    const w = worldRef;
    if (!w) return;
    const n = w.width * w.height;
    const start = e[0] | 0;
    const t = clampType(e[1]);
    const a = clampAmt(e[2]);
    if (!t || !a || start < 0 || start >= n) return;
    const len = e.length > 3 ? Math.max(1, e[3] | 0) : 1;
    for (let j = 0; j < len && start + j < n; j++) {
      const i = start + j;
      const id = w.tiles[i];
      if (id === TC.TILE.WATER || id === TC.TILE.LAVA) continue;
      liquidType[i] = t;
      liquidAmount[i] = a;
      if (heuristicWake) {
        const above = i >= w.width ? i - w.width : -1;
        if (above < 0 || liquidType[above] !== t) wakeIdx(i);
      }
    }
  }

  registerSaveProvider();

  TC.Liquids = {
    TYPE: TYPE,
    FULL: FULL,
    init: init,
    reset: reset,
    update: update,
    draw: draw,
    wake: wake,
    set: set,
    sampleAt: sampleAt,
    queryAt: queryAt,
    displace: displace,
    collectAt: collectAt,
    placeAt: placeAt,
    onUseHeld: onUseHeld,
    columnSurface: columnSurface,
    averageColumnSurface: averageColumnSurface,
    importFromWorld: importFromWorld,
    stats: stats,

    // W24 replication seams: read-only region snapshot (host side),
    // presentation mirror application (joined-client side), state digest.
    snapshotRegion: snapshotRegion,
    applyMirrorRegion: applyMirrorRegion,
    digest: digest,

    // Authority mode of the current world's liquid. Runtime worlds are
    // imported into the layer at build time, so this reads 'layer' during
    // normal play; headless tests may still see 'tiles' before importing.
    mode: () => mode,

    // True when (tx,ty) holds layer liquid of any type with volume > 0.
    isLiquid: (tx, ty) => {
      const q = queryAt(tx, ty);
      return q.type !== TYPE.NONE && q.amount > 0;
    },
  };
})();
