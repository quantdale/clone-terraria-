/* worldregions.js — TC.WorldRegions: THE canonical world-region invalidation
   authority (W21 / PERF-004).

   One shared vocabulary of 32x32-tile regions over the live world. Every
   authoritative world mutation seam reports here; independent presentation
   and infrastructure consumers (chunk renderer, RGB lighting, minimap,
   future persistence/networking) observe invalidations through their own
   cursors.

   MULTI-CONSUMER INVARIANT (the reason this module exists):
   Consumers can NEVER steal invalidations from each other. There is no
   shared dirty Set to drain. Instead every region carries a monotonic
   revision counter; each registered consumer remembers the revision it last
   observed PER REGION. A region modified once stays observably dirty to
   every consumer until THAT consumer accounts for it:

     rev[i]++ on mark            (coalescing: repeated marks before an
                                  observation collapse into one bump)
     consumer.seen[i] == rev[i]  -> consumer is current for region i
     consumer.observe(i)         -> seen[i] = rev[i]  (only this consumer)

   Change classification: marks carry a reason ('tile'|'wall'|'shape'|
   'paint'|'liquid'|'bulk'|'world'); the pending kind-bitmask per region is
   readable while the region is stale for at least one consumer and clears
   automatically once everyone caught up. Per-reason totals feed stats().

   Networking readiness (NET-004 prerequisites, documented not implemented):
   stable region identity (cx,cy,index geometry), monotonic per-region
   revisions suitable for ack/replication cursors, deterministic reason
   classification, zero Canvas/DOM dependency, headless-safe.

   Border fan-out: markTile reproduces the legacy renderer rule — a cell on
   a region border also invalidates the neighbouring region because tile
   edge framing reads across the boundary. markCell marks strictly one
   region (liquids/minimap-style consumers use this through their own
   halos). */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  const CHUNK = 32;
  const REASONS = ['tile', 'wall', 'shape', 'paint', 'liquid', 'bulk', 'world'];
  const BIT = { tile: 1, wall: 2, shape: 4, paint: 8, liquid: 16, bulk: 32, world: 64 };

  const R = {
    CHUNK: CHUNK,
    REASONS: REASONS.slice(),
    world: null,
    chunksX: 0, chunksY: 0, count: 0,
    rev: null,          // Uint32Array(count) monotonic per-region revision
    kinds: null,        // Uint8Array(count) pending-change kind bitmask
    outstanding: null,  // Uint16Array(count) consumers not yet observing rev
    bumps: 0,           // total mark operations accepted
    sweeps: 0,          // consumer dirty-scans served
    marksByReason: {},  // reason -> lifetime count
    consumers: new Map(),// name -> consumer record
    touched: [],        // unique region indices bumped since last compaction
    _touchedFlag: null  // Uint8Array(count) membership dedupe for touched[]
  };
  for (const k of REASONS) R.marksByReason[k] = 0;

  function reasonBit(reason) {
    return (reason && BIT[reason]) ? BIT[reason] : BIT.tile;
  }

  // ---- lifecycle ----
  // Bind to a (new) world. Allocates fresh state and marks every region
  // dirty ('world') so late-registered consumers and existing ones all see
  // the new generation. Never carries revisions across worlds.
  R.init = function (world) {
    R.world = world || null;
    if (!world || !world.width) {
      R.reset();
      return false;
    }
    R.chunksX = Math.ceil(world.width / CHUNK);
    R.chunksY = Math.ceil(world.height / CHUNK);
    R.count = R.chunksX * R.chunksY;
    R.rev = new Uint32Array(R.count);
    R.kinds = new Uint8Array(R.count);
    R.outstanding = new Uint16Array(R.count);
    R._touchedFlag = new Uint8Array(R.count);
    R.touched.length = 0;
    for (const rec of R.consumers.values()) allocConsumer(rec);
    R.markAll('world');
    return true;
  };

  // Tear down (world unload). Regions become unaddressable; marks are
  // rejected until the next init.
  R.reset = function () {
    R.world = null;
    R.chunksX = 0; R.chunksY = 0; R.count = 0;
    R.rev = null; R.kinds = null; R.outstanding = null;
    R.touched.length = 0; R._touchedFlag = null;
  };

  // ---- mapping ----
  R.chunkOf = function (tx, ty) {
    if (!R.world || tx < 0 || ty < 0 ||
        tx >= R.world.width || ty >= R.world.height) return -1;
    return ((ty / CHUNK) | 0) * R.chunksX + ((tx / CHUNK) | 0);
  };
  R.chunkCoords = function (idx) {
    return { cx: idx % R.chunksX, cy: (idx / R.chunksX) | 0 };
  };
  R.inBounds = function (tx, ty) {
    return !!R.world && tx >= 0 && ty >= 0 &&
      tx < R.world.width && ty < R.world.height;
  };

  // ---- marking ----
  function pushTouched(idx) {
    if (R._touchedFlag[idx]) return;
    R._touchedFlag[idx] = 1;
    R.touched.push(idx);
  }
  // Rebuild touched[] from still-outstanding regions (those at least one
  // consumer has not observed yet). Everything else drops out and its flag
  // clears so a future mark re-registers it. Consumer cursors reset to 0:
  // kept entries may be redelivered, and the per-consumer seen[] filter
  // makes redelivery harmless.
  function compactTouched() {
    R.touched.length = 0;
    R._touchedFlag.fill(0);
    let n = 0;
    for (let i = 0; i < R.count; i++) {
      if (R.outstanding[i] > 0) { R._touchedFlag[i] = 1; R.touched.push(i); n++; }
    }
    for (const rec of R.consumers.values()) rec._cursor = 0;
    return n;
  }
  function bump(idx, bit) {
    R.rev[idx]++;
    R.bumps++;
    R.outstanding[idx] = R.consumers.size;
    R.kinds[idx] |= bit;
    if (R._touchedFlag) pushTouched(idx);
  }
  function markIdx(idx, reason) {
    if (idx < 0 || !R.rev) return;
    const r = (reason && BIT[reason]) ? reason : 'tile';
    bump(idx, BIT[r]);
    R.marksByReason[r]++;
  }

  // Strictly the region containing the cell.
  R.markCell = function (tx, ty, reason) {
    if (!R.rev) return;
    const idx = R.chunkOf(tx, ty);
    if (idx < 0) return;
    markIdx(idx, reason);
  };

  // Cell region PLUS border fan-out (legacy World.markDirtyAt parity):
  // framing/mask reads reach one tile across region edges.
  R.markTile = function (tx, ty, reason) {
    if (!R.rev) return;
    const cx = (tx / CHUNK) | 0, cy = (ty / CHUNK) | 0;
    if (!R.inBounds(tx, ty)) return;
    markIdx(cy * R.chunksX + cx, reason);
    const lx = tx - cx * CHUNK, ly = ty - cy * CHUNK;
    if (lx === 0 && cx > 0) markIdx(cy * R.chunksX + cx - 1, reason);
    if (lx === CHUNK - 1 && cx < R.chunksX - 1) markIdx(cy * R.chunksX + cx + 1, reason);
    if (ly === 0 && cy > 0) markIdx((cy - 1) * R.chunksX + cx, reason);
    if (ly === CHUNK - 1 && cy < R.chunksY - 1) markIdx((cy + 1) * R.chunksX + cx, reason);
  };

  // Inclusive tile rectangle, clamped to the world.
  R.markRect = function (x0, y0, x1, y1, reason) {
    if (!R.rev) return 0;
    if (!R.world) return 0;
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    x1 = Math.min(R.world.width - 1, x1 | 0);
    y1 = Math.min(R.world.height - 1, y1 | 0);
    if (x1 < x0 || y1 < y0) return 0;
    const cx0 = (x0 / CHUNK) | 0, cy0 = (y0 / CHUNK) | 0;
    const cx1 = (x1 / CHUNK) | 0, cy1 = (y1 / CHUNK) | 0;
    let n = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        markIdx(cy * R.chunksX + cx, reason);
        n++;
      }
    }
    return n;
  };

  R.markChunk = function (cx, cy, reason) {
    if (!R.rev || cx < 0 || cy < 0 || cx >= R.chunksX || cy >= R.chunksY) return;
    markIdx(cy * R.chunksX + cx, reason);
  };

  R.markAll = function (reason) {
    if (!R.rev) return 0;
    const n = R.count;
    for (let i = 0; i < n; i++) bump(i, reasonBit(reason));
    return n;
  };

  // ---- inspection ----
  R.revision = function (idx) { return R.rev ? R.rev[idx] : 0; };
  R.pendingKinds = function (idx) {
    return (R.rev && R.outstanding && R.outstanding[idx] > 0) ? R.kinds[idx] : 0;
  };
  R.consumerCount = function () { return R.consumers.size; };

  // ---- consumers ----
  function allocConsumer(rec) {
    rec.seen = new Uint32Array(R.count); // rev[] starts at 0; init() markAll bumps to 1
    rec.pending = R.count;               // everything stale right after (re)bind
    rec._bumpAtLastSweep = -1;
    rec._clean = false;
    rec._fullScan = true;                // first sweep reads every region
    rec._cursor = 0;                     // incremental position in touched[]
  }

  // Register a named consumer. Re-registering a name returns the existing
  // handle (idempotent). Handles are plain objects exposing the observation
  // API; they hold no reference that leaks world data beyond the cursor.
  R.consume = function (name) {
    let rec = R.consumers.get(name);
    if (rec) return rec.api;
    rec = { name: name, seen: null, pending: 0, lastSweepBumps: -1 };
    if (R.rev) allocConsumer(rec);
    R.consumers.set(name, rec);
    rec.api = {
      name: name,
      isDirty: function (idx) {
        return !!(R.rev && R.outstanding && R.outstanding[idx] > 0 &&
                  rec.seen && rec.seen[idx] !== R.rev[idx]);
      },
      pendingCount: function () { return rec.pending; },
      revision: function () { return R.revision; },
      // Indices of stale regions for THIS consumer, ascending.
      //
      // Incremental delivery: each consumer keeps a cursor into the shared
      // touched[] list, so a sweep costs O(newly-touched regions), not
      // O(all regions). Entries delivered but deliberately not observed
      // (lighting regions outside its window) are handled by the rare
      // staleAll() full rescan on window moves — they are never lost.
      // Fast path: nothing marked since this consumer's last clean sweep
      // costs constant time.
      dirtyRegions: function () {
        if (!R.rev || !rec.seen) return [];
        if (rec._clean && rec._bumpAtLastSweep === R.bumps) return [];
        R.sweeps++;
        const out = [];
        const seen = rec.seen, rev = R.rev;
        if (rec._fullScan || R.touched.length >= R.count) {
          for (let i = 0; i < R.count; i++) {
            if (seen[i] !== rev[i]) out.push(i);
          }
          rec._fullScan = false;
          rec._cursor = R.touched.length;
          if (R.touched.length >= R.count) compactTouched();
        } else {
          const t = R.touched;
          let k = rec._cursor;
          if (k > t.length) k = t.length;
          for (; k < t.length; k++) {
            const i = t[k];
            if (seen[i] !== rev[i]) out.push(i);
          }
          rec._cursor = t.length;
        }
        rec._clean = out.length === 0;
        rec._bumpAtLastSweep = R.bumps;
        return out;
      },
      // Direct O(regions) scan ignoring the cursor — for rare structural
      // paths (light-window moves, world swaps) that must see every stale
      // region regardless of delivery history. Does not advance anything.
      staleAll: function () {
        if (!R.rev || !rec.seen) return [];
        const out = [];
        const seen = rec.seen, rev = R.rev;
        for (let i = 0; i < R.count; i++) {
          if (seen[i] !== rev[i]) out.push(i);
        }
        return out;
      },
      // Observe one region: only THIS consumer's cursor moves.
      observe: function (idx) {
        if (!R.rev || !rec.seen) return;
        if (rec.seen[idx] === R.rev[idx]) return;
        rec.seen[idx] = R.rev[idx];
        rec.pending--;
        if (rec.pending < 0) rec.pending = 0;
        if (R.outstanding[idx] > 0) {
          R.outstanding[idx]--;
          if (R.outstanding[idx] === 0) R.kinds[idx] = 0; // fully observed
        }
      },
      observeAll: function () {
        if (!R.rev || !rec.seen) return;
        for (let i = 0; i < R.count; i++) rec.seen[i] = R.rev[i];
        for (let i = 0; i < R.count; i++) {
          if (R.outstanding[i] > 0) {
            R.outstanding[i]--;
            if (R.outstanding[i] === 0) R.kinds[i] = 0;
          }
        }
        rec.pending = 0;
      }
    };
    return rec.api;
  };

  R.forget = function (name) { R.consumers.delete(name); };

  R.stats = function () {
    let stale = 0;
    if (R.outstanding) {
      for (let i = 0; i < R.count; i++) if (R.outstanding[i] > 0) stale++;
    }
    return {
      regions: R.count,
      chunksX: R.chunksX, chunksY: R.chunksY,
      bumps: R.bumps,
      sweeps: R.sweeps,
      staleRegions: stale,
      consumers: [...R.consumers.keys()],
      marksByReason: Object.assign({}, R.marksByReason)
    };
  };

  TC.WorldRegions = R;
})();
