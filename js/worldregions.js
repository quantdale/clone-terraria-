/* worldregions.js — TC.WorldRegions: THE canonical world-region invalidation
   authority (W21 / PERF-004).

   One shared vocabulary of 32x32-tile regions over the live world. Every
   authoritative world mutation seam reports here; independent presentation
   and infrastructure consumers (chunk renderer, RGB lighting, minimap,
   future persistence/networking) observe invalidations through their own
   cursors.

   MULTI-CONSUMER INVARIANT (the reason this module exists):
   Consumers can NEVER steal invalidations from each other. There is no
   shared dirty Set to drain. Each region carries a monotonic revision
   counter; each registered consumer keeps its OWN delivery queue and a
   per-region last-seen revision. A region modified once is queued for
   EVERY consumer and stays queued until THAT consumer observes it:

     mark -> rev[i]++ ; queue push per consumer (deduped by flag)
     observe(i) by one consumer never touches another's queue

   Repeated marks before an observation coalesce into a single delivered
   entry; an entry an observer skips stays queued (its owner re-scans its
   whole queue cheaply and filters by seen[]).

   Change classification: marks carry a reason ('tile'|'wall'|'shape'|
   'paint'|'liquid'|'bulk'|'world'); the pending kind-bitmask per region is
   readable while the region is stale for at least one consumer and clears
   automatically once everyone caught up. Per-reason totals feed stats().

   Cost model: marks are O(consumers); sweeps are O(consumer's own queue);
   queues compact lazily when scanned length dwarfs real backlog. Zero
   Canvas/DOM dependency; headless-safe. Networking readiness (NET-004
   prerequisites, documented not implemented): stable region identity,
   monotonic revisions suitable for ack/replication cursors, deterministic
   reason classification. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  const CHUNK = 32;
  const REASONS = ['tile', 'wall', 'shape', 'paint', 'liquid', 'bulk', 'world'];
  const BIT = { tile: 1, wall: 2, shape: 4, paint: 8, liquid: 16, bulk: 32, world: 64 };

  const R = {
    CHUNK: CHUNK,
    REASONS: REASONS.slice(),
    LIQUID_BIT: BIT.liquid, // consumer-side filtering (e.g. renderer skips liquid-only regions)
    world: null,
    chunksX: 0, chunksY: 0, count: 0,
    rev: null,          // Uint32Array(count) monotonic per-region revision
    kinds: null,        // Uint8Array(count) pending-change kind bitmask
    outstanding: null,  // Uint16Array(count) consumers not yet observing rev
    bumps: 0,           // total mark operations accepted
    sweeps: 0,          // consumer dirty-scans served
    marksByReason: {},  // reason -> lifetime count
    consumers: new Map()// name -> consumer record
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
  function bump(idx, bit) {
    // Consumers whose seen[] equals the PREVIOUS revision were current and
    // become stale now: their pending counter grows by one and the region
    // joins their personal delivery queue (unless already queued there).
    // Already-stale consumers keep their single queued entry (coalescing).
    const old = R.rev[idx];
    R.rev[idx] = old + 1;
    R.bumps++;
    R.outstanding[idx] = R.consumers.size;
    R.kinds[idx] |= bit;
    for (const rec of R.consumers.values()) {
      if (!rec.qFlag[idx]) { rec.qFlag[idx] = 1; rec.queue.push(idx); }
      if (rec.seen[idx] === old) rec.pending++;
      if (rec.kinds) rec.kinds[idx] |= bit; // per-consumer pending-kind view
    }
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
    if (!R.rev || !R.world) return 0;
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
    // Fresh seen[] starts at revision zero: every region whose rev has moved
    // is stale for THIS consumer. Reconcile the shared bookkeeping here so
    // consumers registering after a world build (init's markAll runs with
    // zero consumers) still make their stale regions outstanding and queued
    // in their OWN delivery queue.
    rec.seen = new Uint32Array(R.count);
    rec.pending = 0;
    rec.queue = [];
    rec.qFlag = new Uint8Array(R.count);
    rec._buf = [];
    // Per-consumer pending-kind view: bits accumulated while THIS consumer is
    // stale, cleared on its own observe(). Lets a consumer skip invalidation
    // kinds it does not render (the chunk renderer ignores liquid-only marks;
    // liquid paints through TC.Liquids.draw, never through chunk canvases).
    rec.kinds = new Uint8Array(R.count);
    const rev = R.rev;
    for (let i = 0; i < R.count; i++) {
      if (rec.seen[i] !== rev[i]) {
        rec.pending++;
        R.outstanding[i]++;
        rec.qFlag[i] = 1;
        rec.queue.push(i);
        rec.kinds[i] = R.kinds ? (R.kinds[i] || 1) : 1; // conservative snapshot
      }
    }
    rec._clean = false;
    rec._bumpAtLastSweep = -1;
  }

  // Register a named consumer. Re-registering a name returns the existing
  // handle (idempotent).
  R.consume = function (name) {
    let rec = R.consumers.get(name);
    if (rec) return rec.api;
    rec = { name: name, seen: null, pending: 0 };
    if (R.rev) allocConsumer(rec);
    R.consumers.set(name, rec);
    rec.api = {
      name: name,
      isDirty: function (idx) {
        return !!(rec.seen && R.rev && rec.seen[idx] !== R.rev[idx]);
      },
      pendingCount: function () { return rec.pending; },
      revision: function () { return R.revision; },
      // Indices of stale regions for THIS consumer, ascending, from this
      // consumer's personal queue. The returned array is a reused scratch
      // buffer owned by the handle: valid until the next dirtyRegions()/
      // staleAll() call on it. Entries the consumer does not observe stay
      // queued — nothing is ever lost by under-processing a delivery.
      dirtyRegions: function () {
        if (!R.rev || !rec.seen) return [];
        if (rec._clean && rec._bumpAtLastSweep === R.bumps) return [];
        R.sweeps++;
        const buf = rec._buf || (rec._buf = []);
        buf.length = 0;
        const q = rec.queue, seen = rec.seen, rev = R.rev;
        let live = 0;
        for (let k = 0; k < q.length; k++) {
          const i = q[k];
          if (seen[i] !== rev[i]) { buf.push(i); live++; }
        }
        // Lazy compaction: when fully-observed junk dwarfs real backlog,
        // drop observed entries and release their queue slots so future
        // marks re-register them.
        if (q.length > 64 && live * 2 <= q.length) {
          const kept = [];
          for (let k = 0; k < q.length; k++) {
            const i = q[k];
            if (seen[i] !== rev[i]) kept.push(i);
            else rec.qFlag[i] = 0;
          }
          rec.queue = kept;
        }
        rec._clean = buf.length === 0;
        rec._bumpAtLastSweep = R.bumps;
        return buf;
      },
      // Direct O(regions) scan ignoring the queue — for rare structural
      // paths (light-window moves, world swaps) that must see every stale
      // region regardless of queue history.
      staleAll: function () {
        if (!R.rev || !rec.seen) return [];
        const out = [];
        const seen = rec.seen, rev = R.rev;
        for (let i = 0; i < R.count; i++) {
          if (seen[i] !== rev[i]) out.push(i);
        }
        return out;
      },
      // Observe one region: only THIS consumer's slot bookkeeping moves.
      // The queue entry stays parked (flag stays set) so future marks of
      // the same region coalesce into the existing slot until compaction.
      observe: function (idx) {
        if (!R.rev || !rec.seen) return;
        if (rec.seen[idx] === R.rev[idx]) return;
        rec.seen[idx] = R.rev[idx];
        rec.pending--;
        if (rec.pending < 0) rec.pending = 0;
        if (rec.kinds) rec.kinds[idx] = 0;
        if (R.outstanding[idx] > 0) {
          R.outstanding[idx]--;
          if (R.outstanding[idx] === 0) R.kinds[idx] = 0; // fully observed
        }
      },
      observeAll: function () {
        if (!R.rev || !rec.seen) return;
        const seen = rec.seen, rev = R.rev;
        for (let i = 0; i < R.count; i++) {
          if (seen[i] !== rev[i]) {
            seen[i] = rev[i];
            rec.pending = Math.max(0, rec.pending - 1);
            if (rec.kinds) rec.kinds[i] = 0;
            if (R.outstanding[i] > 0) {
              R.outstanding[i]--;
              if (R.outstanding[i] === 0) R.kinds[i] = 0;
            }
          }
        }
        rec.pending = 0;
        rec._clean = true;
        rec._bumpAtLastSweep = R.bumps;
      },
      // Pending-change kind bitmask for THIS consumer at idx (0 when current).
      // Precise per-consumer view — unlike R.pendingKinds(), which keeps
      // bits while ANY consumer lags.
      pendingKinds: function (idx) {
        return (rec.kinds && rec.seen && R.rev && rec.seen[idx] !== R.rev[idx])
          ? rec.kinds[idx] : 0;
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
    const queues = {};
    for (const [name, rec] of R.consumers) queues[name] = rec.queue.length;
    return {
      regions: R.count,
      chunksX: R.chunksX, chunksY: R.chunksY,
      bumps: R.bumps,
      sweeps: R.sweeps,
      staleRegions: stale,
      consumers: [...R.consumers.keys()],
      queues: queues,
      marksByReason: Object.assign({}, R.marksByReason)
    };
  };

  TC.WorldRegions = R;
})();
