/* liquids.js — independent liquid layer foundation (ARCHITECTURE campaign).
   Liquid lives in two typed arrays (type + amount 0..255 per cell) layered
   over the tile grid. Provides a budgeted volume-based settle sim (fall /
   spread / equalize / evaporate, water+lava -> stone contact), immersion
   queries for breath/buoyancy consumers, wave rendering, sparse SaveCore
   persistence, and a CONSUMING bridge import from WATER/LAVA tiles.
   Authority model (one-directional compatibility boundary):
     - mode 'tiles' (default): legacy WATER/LAVA tile ids own all liquid;
       world.stepWater() simulates them and this layer stays empty unless a
       caller explicitly writes it.
     - mode 'layer': entered by importFromWorld() or provider restore. All
       imported liquid was CLAIMED out of the tile grid (tiles -> AIR),
       world.stepWater() is frozen, and this layer is the single authority.
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
    if (frameChanges.length >= 128) return; // hard cap; payload trims to 32
    const w = worldRef;
    frameChanges.push([
      i % w.width,
      (i / w.width) | 0,
      liquidType[i],
      liquidAmount[i],
    ]);
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
  function update(dt) {
    if (!ready) return;
    frameChanges.length = 0;
    frameContacts.length = 0;
    acc += dt;
    if (acc < TICK) return;
    acc %= TICK;
    if (!active.size) return;
    let budget = BUDGET;
    for (const i of active) {
      if (budget-- <= 0) break;
      if (!settleCell(i)) active.delete(i);
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
    wake(tx, ty);
    return true;
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
        version: 1,
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
          return out.length ? out : null;
        },
        deserialize: (data, ctx) => {
          const w = (ctx && ctx.world) || TC.world || null;
          if (!w) return;
          reset(w);
          if (!Array.isArray(data)) return;
          mode = "layer"; // restored data is layer-owned liquid
          const n = w.width * w.height;
          for (let k = 0; k < data.length; k++) {
            const e = data[k];
            if (!Array.isArray(e) || e.length < 3) continue;
            const start = e[0] | 0;
            const t = clampType(e[1]);
            const a = clampAmt(e[2]);
            if (!t || !a || start < 0 || start >= n) continue;
            const len = e.length > 3 ? Math.max(1, e[3] | 0) : 1;
            for (let j = 0; j < len && start + j < n; j++) {
              const i = start + j;
              // Invariant guard: never restore layer liquid into a cell that
              // still holds a legacy liquid tile.
              const id = w.tiles[i];
              if (id === TC.TILE.WATER || id === TC.TILE.LAVA) continue;
              liquidType[i] = t;
              liquidAmount[i] = a;
              const above = i >= w.width ? i - w.width : -1;
              if (above < 0 || liquidType[above] !== t) wakeIdx(i);
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
    columnSurface: columnSurface,
    averageColumnSurface: averageColumnSurface,
    importFromWorld: importFromWorld,
    stats: stats,

    // Authority mode of the current world's liquid: 'tiles' until an explicit
    // import/restore claims the liquid into this layer, then 'layer'. Read by
    // world.stepWater() to freeze the legacy sim once the layer owns liquid.
    mode: () => mode,
  };
})();
