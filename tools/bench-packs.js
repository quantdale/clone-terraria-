/* tools/bench-packs.js — W25 WS12 pack-overhead evidence (headless).
   Measures: base vs fixture-pack boot, activation cost, registry lookup
   with/without packs, save envelope size delta + build time, classify cost,
   and the v4 handshake encode overhead. Deterministic (no wall-clock in
   outputs beyond the measured ms). */
'use strict';
const path = require('path');
const { loadGame } = require(path.join(__dirname, '..', 'tests', 'helpers', 'load-game.js'));

function now() { return process.hrtime.bigint() / 1000n; } // µs
function ms(us) { return Number(us) / 1000; }

function median(arr) {
  return arr.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[(arr.length / 2) | 0];
}

console.log('== W25 pack overhead benchmarks ==');

// ---- boot cost -----------------------------------------------------------
function bootTime(withPacks) {
  const t = [];
  for (let i = 0; i < 7; i++) {
    const a = now();
    const g = loadGame({ frames: 0 });
    if (withPacks) {
      g.TC.Packs.setActive(['testpack'], { persist: false });
    }
    t.push(now() - a);
    g.ctx = null; // hint GC in long runs
  }
  return median(t);
}
const bootBase = bootTime(false);
const bootPack = bootTime(true);
console.log('boot (scripts+registry sync), median of 7:');
console.log('  zero packs      :', ms(bootBase).toFixed(1), 'ms');
console.log('  fixture active  :', ms(bootPack).toFixed(1), 'ms  (+' +
  ms(bootPack - bootBase).toFixed(2), 'ms)');

// ---- activation transaction ----------------------------------------------
{
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  // first activation commits; measure on a fresh realm each round for honesty
  const t = [];
  for (let i = 0; i < 9; i++) {
    const gg = loadGame({ frames: 0 });
    const a = now();
    gg.TC.Packs.setActive(['testpack'], { persist: false });
    t.push(now() - a);
  }
  console.log('full activation (validate+stage+commit fixture):',
    ms(median(t)).toFixed(3), 'ms median of 9');

  // idempotent re-request (the hot path when boot re-runs)
  TC.Packs.setActive(['testpack'], { persist: false });
  const a2 = now();
  TC.Packs.setActive(['testpack'], { persist: false });
  console.log('idempotent re-setActive:', ms(now() - a2).toFixed(4), 'ms');
}

// ---- registry lookup ------------------------------------------------------
{
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  const N = 200000;
  let a = now();
  for (let i = 0; i < N; i++) TC.Registry.legacyToStable('item', 'iron_bar');
  const base = now() - a;
  TC.Packs.setActive(['testpack'], { persist: false });
  a = now();
  for (let i = 0; i < N; i++) TC.Registry.legacyToStable('item', 'iron_bar');
  const withP = now() - a;
  a = now();
  for (let i = 0; i < N; i++) TC.Registry.legacyToStable('item', 'tempest_shard');
  const packRef = now() - a;
  console.log('Registry.legacyToStable per 200k lookups:');
  console.log('  built-in ref, zero packs :', ms(base).toFixed(1), 'ms');
  console.log('  built-in ref, pack loaded:', ms(withP).toFixed(1), 'ms');
  console.log('  pack ref                 :', ms(packRef).toFixed(1), 'ms');
}

// ---- save envelope --------------------------------------------------------
{
  const storageRuns = (withPacks) => {
    const g = loadGame({ frames: 0 });
    const TC = g.TC;
    if (withPacks) TC.Packs.setActive(['testpack'], { persist: false });
    TC.Runtime.createWorld(9090);
    TC.Runtime.advanceTicks(60);
    const a = now();
    const okSave = TC.Save.save();
    const dtSave = now() - a;
    const bytes = TC.Save.exportSave().length;
    const b = now();
    TC.Runtime.reset();
    TC.Runtime.createWorld(9090);
    if (TC.Packs.active().length) { /* same session semantics */ }
    TC.continueGame();
    const dtLoad = now() - b;
    return { okSave, bytes, dtSave, dtLoad };
  };
  const baseS = storageRuns(false);
  const packS = storageRuns(true);
  console.log('save envelope bytes: base=' + baseS.bytes + '  with-pack=' +
    packS.bytes + '  (delta +' + (packS.bytes - baseS.bytes) + ')');
  console.log('saveNow ms   : base=' + ms(baseS.dtSave).toFixed(2) +
    '  pack=' + ms(packS.dtSave).toFixed(2));
  console.log('continue ms  : base=' + ms(baseS.dtLoad).toFixed(2) +
    '  pack=' + ms(packS.dtLoad).toFixed(2));
}

// ---- classification + handshake meta --------------------------------------
{
  const g = loadGame({ frames: 0 });
  const TC = g.TC;
  TC.Packs.setActive(['testpack'], { persist: false });
  const meta = TC.Packs.saveMetadata();
  const N = 50000;
  let a = now();
  for (let i = 0; i < N; i++) TC.Packs.classifySave(meta);
  console.log('classifySave per 50k:', ms(now() - a).toFixed(1), 'ms');

  const msg = TC.NetProto.encode({
    v: TC.NetProto.VERSION, t: 'hello', sid: null, pid: null,
    cseq: 1, sseq: 0, tick: 0,
    p: { name: 'Bench', packs: { fp: TC.Packs.digest(), list: ['testpack@1.0.0'] } },
  });
  console.log('v4 hello encoded bytes (pack identity incl.):', msg.length);
  a = now();
  for (let i = 0; i < N; i++) TC.NetProto.decode(msg);
  console.log('decode hello per 50k:', ms(now() - a).toFixed(1), 'ms');
}

console.log('done.');
