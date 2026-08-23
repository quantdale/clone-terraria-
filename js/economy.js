/* economy.js — TC.Economy: canonical currency + transaction helpers (W2).
   Coins are ordinary inventory items with a fixed face VALUE in copper
   cents-of-the-realm; three denominations keep stacks manageable:

     coin_copper = 1   coin_silver = 100   coin_gold = 10000

   Everything downstream (shop prices, sell values, drop tables, UI purse)
   speaks a single integer unit: copper. This module owns the arithmetic:

     total(inv)        -> canonical purse value across all slots
     pay(inv, amount)  -> atomic deduct with exact change reconstruction
     give(inv, amount) -> deposit value using the fewest stacks possible
     dropCoins(x,y,n)  -> scatter value as physical coin drops
     format(n)         -> '1g 23s 45c' display string

   Deterministic: no randomness. Transactionality lives in TC.Commands
   (ShopBuy / ShopSell); this module only provides exact primitives. */
'use strict';
(function () {
  const TC = window.TC = window.TC || {};

  // High->low denomination table (item ids defined in constants.js).
  const DENOMS = [
    { id: 'coin_gold', v: 10000 },
    { id: 'coin_silver', v: 100 },
    { id: 'coin_copper', v: 1 },
  ];

  function iDef(id) { return TC.ITEM_DEFS ? TC.ITEM_DEFS[id] : null; }

  function clampAmt(n) {
    n = (typeof n === 'number' && isFinite(n)) ? Math.floor(n) : 0;
    return n > 0 ? n : 0;
  }

  // Canonical purse value across every inventory slot.
  function total(inv) {
    if (!inv || !Array.isArray(inv.slots)) return 0;
    let sum = 0;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i];
      if (!s) continue;
      for (let d = 0; d < DENOMS.length; d++) {
        if (s.id === DENOMS[d].id) sum += s.count * DENOMS[d].v;
      }
    }
    return sum;
  }

  // Deposit `amount` copper into the inventory, largest denominations first.
  // Inventory.add returns the UNPLACED leftover, so placed = n - leftover.
  // Returns the value actually stored (== amount unless defs are missing).
  function give(inv, amount) {
    amount = clampAmt(amount);
    if (!inv || typeof inv.add !== 'function' || !amount) return 0;
    let left = amount;
    for (let d = 0; d < DENOMS.length && left > 0; d++) {
      const den = DENOMS[d];
      if (!iDef(den.id)) continue;
      const n = Math.floor(left / den.v);
      if (n > 0) {
        const placed = n - inv.add(den.id, n);
        left -= placed * den.v;
      }
    }
    // Remainder below the smallest defined denomination is lost by design
    // (smallest denom is 1, so this only triggers with a broken table).
    return amount - left;
  }

  // Atomic deduct: verifies affordability, drains every coin stack, then
  // refunds the exact change. Mutates nothing when short. Returns bool.
  function pay(inv, amount) {
    amount = clampAmt(amount);
    if (!inv || !Array.isArray(inv.slots) || !amount) return false;
    const purse = total(inv);
    if (purse < amount) return false;

    // Drain all coins (idempotent bookkeeping: remember what we took).
    const taken = {};
    let drained = 0;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i];
      if (!s) continue;
      for (let d = 0; d < DENOMS.length; d++) {
        if (s.id === DENOMS[d].id) {
          taken[s.id] = (taken[s.id] || 0) + s.count;
          drained += s.count * DENOMS[d].v;
          inv.slots[i] = null;
          break;
        }
      }
    }
    const change = drained - amount;
    if (change > 0) give(inv, change);
    if (
      TC.Events && typeof TC.Events.emit === 'function' &&
      TC.Events.EVENT && TC.Events.EVENT.InventoryChanged
    ) {
      try {
        TC.Events.emit(TC.Events.EVENT.InventoryChanged, {
          reason: 'pay', amount: amount, change: change,
        });
      } catch (e) {}
    }
    void taken;
    return true;
  }

  // Scatter `amount` copper as physical coin drops at a world position,
  // largest denominations first (a 250-value kill drops 2s 50c). Values above
  // the per-stack burst cap spill into additional stacks so value is exact.
  function dropCoins(x, y, amount, scatter) {
    amount = clampAmt(amount);
    if (!TC.Items || typeof TC.Items.spawnDrop !== 'function' || !amount) return 0;
    let left = amount;
    for (let d = 0; d < DENOMS.length && left > 0; d++) {
      const den = DENOMS[d];
      if (!iDef(den.id)) continue;
      let n = Math.floor(left / den.v);
      left -= n * den.v;
      while (n > 0) {
        const take = Math.min(n, 25); // stacks per drop burst
        TC.Items.spawnDrop(x, y, den.id, take, scatter !== false);
        n -= take;
      }
    }
    return amount - left;
  }

  // Human-readable purse string: gold/silver/copper with zero trimming.
  function format(n) {
    n = clampAmt(n);
    const g = Math.floor(n / 10000);
    const s = Math.floor((n % 10000) / 100);
    const c = n % 100;
    const parts = [];
    if (g) parts.push(g + 'g');
    if (s) parts.push(s + 's');
    if (c || !parts.length) parts.push(c + 'c');
    return parts.join(' ');
  }

  TC.Economy = { DENOMS, total, pay, give, dropCoins, format };
})();
