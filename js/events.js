/* events.js — global event bus: synchronous emit + deferred queue flushed once per frame.
   Listeners have signature fn(payload, eventName). Payloads should be plain
   serializable objects where possible. Never use Math.random here (nothing random at all). */
'use strict';
(function () {
  const TC = (window.TC = window.TC || {});

  // Canonical event names; emitters use TC.Events.EVENT.X so typos are catchable.
  const EVENT = Object.freeze({
    WorldLoaded: 'WorldLoaded',
    WorldGenerated: 'WorldGenerated',
    TileChanged: 'TileChanged',
    TileBroken: 'TileBroken',
    WallChanged: 'WallChanged',
    LiquidChanged: 'LiquidChanged',
    EntitySpawned: 'EntitySpawned',
    EntityRemoved: 'EntityRemoved',
    EntityDamaged: 'EntityDamaged',
    EntityKilled: 'EntityKilled',
    ProjectileSpawned: 'ProjectileSpawned',
    ItemPickedUp: 'ItemPickedUp',
    InventoryChanged: 'InventoryChanged',
    ItemEquipped: 'ItemEquipped',
    BuffApplied: 'BuffApplied',
    BuffExpired: 'BuffExpired',
    CraftCompleted: 'CraftCompleted',
    BossDefeated: 'BossDefeated',
    WorldProgressChanged: 'WorldProgressChanged',
    NpcMovedIn: 'NpcMovedIn',
    WirePulse: 'WirePulse',
    DayChanged: 'DayChanged'
  });

  // Bucket key -> array of entries in registration order (arrays give deterministic order).
  const listeners = new Map();
  let pending = []; // queued {event, payload}, drained by flush()

  const WILDCARD = '*';

  function arrFor(key) {
    let arr = listeners.get(key);
    if (!arr) { arr = []; listeners.set(key, arr); }
    return arr;
  }

  function removeEntry(entry) {
    entry.dead = true;
    const arr = listeners.get(entry.key);
    if (!arr) return;
    const i = arr.indexOf(entry);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) listeners.delete(entry.key);
  }

  function add(event, fn, once) {
    if (typeof event !== 'string' || !event) {
      console.warn('[TC.Events] on/once: event name must be a non-empty string');
      return function () {};
    }
    if (typeof fn !== 'function') {
      console.warn('[TC.Events] "' + event + '": listener must be a function');
      return function () {};
    }
    const entry = { key: event, fn: fn, once: once, dead: false };
    arrFor(event).push(entry);
    return function () { removeEntry(entry); };
  }

  function on(event, fn) { return add(event, fn, false); }
  function once(event, fn) { return add(event, fn, true); }

  function off(event, fn) {
    const arr = listeners.get(event);
    if (!arr || typeof fn !== 'function') return;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].fn === fn) { arr[i].dead = true; arr.splice(i, 1); }
    }
    if (!arr.length) listeners.delete(event);
  }

  // Run a snapshot of one bucket; skip entries removed mid-dispatch.
  function runList(snapshot, payload, event) {
    for (let i = 0; i < snapshot.length; i++) {
      const e = snapshot[i];
      if (e.dead) continue;
      if (e.once) removeEntry(e); // gone before invoke: re-entrant emit can't double-fire it
      try { e.fn(payload, event); } catch (err) {
        console.warn('[TC.Events] listener for "' + event + '" threw:', err);
      }
    }
  }

  // Named listeners first, then '*' wildcards; each group in registration order.
  function dispatch(event, payload) {
    const named = listeners.get(event);
    const wild = listeners.get(WILDCARD);
    if (named) runList(named.slice(), payload, event);
    if (wild) runList(wild.slice(), payload, event);
  }

  // Immediate synchronous dispatch; completes before returning.
  function emit(event, payload) {
    if (typeof event !== 'string' || !event) {
      console.warn('[TC.Events] emit: event name must be a non-empty string');
      return;
    }
    dispatch(event, payload);
  }

  // Defer to the next flush() (lead calls flush() once at end of frame).
  function queue(event, payload) {
    if (typeof event !== 'string' || !event) {
      console.warn('[TC.Events] queue: event name must be a non-empty string');
      return;
    }
    pending.push({ event: event, payload: payload });
  }

  // Drain everything queued before this call, FIFO. Events queued during
  // flush (by listeners) stay pending until the next frame's flush.
  function flush() {
    const batch = pending;
    pending = [];
    for (let i = 0; i < batch.length; i++) dispatch(batch[i].event, batch[i].payload);
  }

  TC.Events = { EVENT: EVENT, on: on, off: off, once: once, emit: emit, queue: queue, flush: flush };
})();
