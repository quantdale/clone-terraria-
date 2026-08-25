/* targeting.js — TC.Targets: THE deterministic multi-player target-selection
   policy for authoritative gameplay (W23 / WS2).

   WHY: enemy AI, boss anchors and spawn placement read the legacy
   `TC.player` singleton, so every hostile decision centered the primary
   pawn even when other eligible players were closer/better targets.

   POLICY (single authority consumed by enemyai/enemies/enemyspawn):
     - eligible = registered player that is alive with finite position;
     - nearest by squared distance to the consumer's anchor point;
     - deterministic tie-breaking by stable player id (string compare);
     - stickiness/hysteresis per consuming entity: an existing target is
       kept until it becomes ineligible or another candidate is meaningfully
       closer (STICKY_RATIO), so enemies do not thrash between equidistant
       players every tick;
     - graceful no-target: returns null when no player is eligible;
     - single-player equivalence: with one eligible player this IS the old
       primary path (the registry fallback preserves legacy embeds).

   Deliberately NOT routed through here (classified primary/local):
   camera follow, local input sampling, HUD/UI ownership, client mirror
   self-identification — see ARCHITECTURE.md §27.

   Headless-safe: zero DOM/Canvas dependency. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  const STICKY_RATIO = 0.8;   // challenger must be ≥20% closer to steal

  function eligible() {
    const out = [];
    if (TC.Players && typeof TC.Players.entries === 'function' &&
        TC.Players.count() > 0) {
      for (const rec of TC.Players.entries()) {
        const p = rec.player;
        if (!p || p.dead) continue;
        if (!isFinite(p.x) || !isFinite(p.y)) continue;
        out.push({ id: rec.id, player: p });
      }
      return out;
    }
    // Legacy singleton fallback: no session registry populated (ordinary
    // single-player) — preserve the pre-W22 semantics exactly.
    if (TC.player && !TC.player.dead && isFinite(TC.player.x) && isFinite(TC.player.y)) {
      out.push({ id: 'p1', player: TC.player });
    }
    return out;
  }

  // Nearest eligible player to a world-space point. Deterministic.
  function nearest(x, y) {
    let best = null, bestD = Infinity, bestId = null;
    for (const e of eligible()) {
      const p = e.player;
      const dx = p.x + (p.w || 0) / 2 - x;
      const dy = p.y + (p.h || 0) / 2 - y;
      const d = dx * dx + dy * dy;
      if (d < bestD || (d === bestD && e.id < bestId)) {
        best = p; bestD = d; bestId = e.id;
      }
    }
    return best;
  }

  // Sticky per-entity selection. e may be any object to hang state on
  // (enemy entities). opts.anchor overrides the measured point (defaults
  // to the entity center). opts.stickyRatio scales the hysteresis.
  function of(e, opts) {
    const o = opts || {};
    const list = eligible();
    if (!list.length) {
      if (e) e._targetId = null;
      return null;
    }
    const ax = (o.anchor && isFinite(o.anchor.x)) ? o.anchor.x
      : (e ? e.x + (e.w || 0) / 2 : 0);
    const ay = (o.anchor && isFinite(o.anchor.y)) ? o.anchor.y
      : (e ? e.y + (e.h || 0) / 2 : 0);

    let best = null, bestD = Infinity, bestId = null;
    for (const t of list) {
      const p = t.player;
      const dx = p.x + (p.w || 0) / 2 - ax;
      const dy = p.y + (p.h || 0) / 2 - ay;
      const d = dx * dx + dy * dy;
      if (d < bestD || (d === bestD && t.id < bestId)) {
        best = p; bestD = d; bestId = t.id;
      }
    }
    if (!e) return best;

    // Hysteresis: keep the incumbent while still eligible unless beaten.
    const curId = e._targetId || null;
    if (curId && curId !== bestId) {
      let cur = null;
      for (const t of list) if (t.id === curId) { cur = t; break; }
      if (cur) {
        const cp = cur.player;
        const dx = cp.x + (cp.w || 0) / 2 - ax;
        const dy = cp.y + (cp.h || 0) / 2 - ay;
        const cd = dx * dx + dy * dy;
        const ratio = o.stickyRatio || STICKY_RATIO;
        if (bestD > cd * ratio * ratio) {
          return cp;                    // incumbent keeps the aggro
        }
      }
    }
    e._targetId = bestId;
    return best;
  }

  // Default spawn/summon anchor: the primary pawn while eligible, else any
  // eligible player (nearest to world spawn as final fallback).
  function anchor() {
    const list = eligible();
    if (!list.length) return null;
    if (TC.Players && typeof TC.Players.primary === 'function') {
      const pr = TC.Players.primary();
      if (pr && !pr.dead && isFinite(pr.x)) return pr;
    }
    return list[0].player;
  }

  function all() {
    return eligible().map(function (t) { return t.player; });
  }

  function count() { return eligible().length; }

  TC.Targets = {
    of: of,
    nearest: nearest,
    all: all,
    count: count,
    anchor: anchor,
    STICKY_RATIO: STICKY_RATIO
  };
})();
