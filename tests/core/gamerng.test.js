/* tests/core/gamerng.test.js — W23 authoritative gameplay RNG contract:
   seeded named streams, deterministic reset/restore, digest identity,
   WorldLoaded reseed, stream isolation, fallback routing. */

const { test } = require("node:test");
const assert = require("node:assert");
const { loadGame } = require("../helpers/load-game.js");

test("gamerng: same seed reproduces identical per-stream sequences", () => {
  const { TC } = loadGame({ hash: "" });
  function drawAll(seed) {
    TC.GameRng.reset(seed);
    const out = {};
    for (const name of TC.GameRng.STREAMS) {
      const s = TC.GameRng.stream(name);
      out[name] = [s.float(), s.float(), s.range(1, 7), s.int(0, 9), s.pick(["a", "b", "c"])];
    }
    return out;
  }
  const a = drawAll(12345);
  const b = drawAll(12345);
  assert.deepStrictEqual(b, a, "identical seeds give identical draws");

  const c = drawAll(54321);
  assert.notDeepStrictEqual(c, a, "different seeds diverge");
});

test("gamerng: streams are isolated — drawing from one leaves others intact", () => {
  const { TC } = loadGame({ hash: "" });
  TC.GameRng.reset(777);
  const lootBefore = TC.GameRng.stream("loot").state();
  const ai = TC.GameRng.stream("ai");
  for (let i = 0; i < 50; i++) ai.float();
  assert.deepStrictEqual(TC.GameRng.stream("loot").state(), lootBefore,
    "'loot' untouched by 'ai' draws");
});

test("gamerng: state()/restore() resumes exactly; digest is stable", () => {
  const { TC } = loadGame({ hash: "" });
  TC.GameRng.reset(42);
  const ai = TC.GameRng.stream("ai");
  for (let i = 0; i < 17; i++) ai.float();
  const snap = TC.GameRng.state();
  const d1 = TC.GameRng.digest();

  // diverge hard
  for (let i = 0; i < 100; i++) {
    TC.GameRng.stream("combat").float();
    TC.GameRng.stream("ai").float();
  }
  assert.notStrictEqual(TC.GameRng.digest(), d1, "digest tracks consumption");

  TC.GameRng.restore(snap);
  assert.strictEqual(TC.GameRng.digest(), d1, "restore returns the exact state");
  const s1 = [TC.GameRng.stream("ai").float(), TC.GameRng.stream("ai").float(), TC.GameRng.stream("ai").float()];
  TC.GameRng.restore(snap);
  const s2 = [TC.GameRng.stream("ai").float(), TC.GameRng.stream("ai").float(), TC.GameRng.stream("ai").float()];
  assert.deepStrictEqual(s2, s1, "post-restore futures match");
});

test("gamerng: unknown stream routes to 'misc' (fail-closed determinism)", () => {
  const { TC } = loadGame({ hash: "" });
  TC.GameRng.reset(9);
  const m = TC.GameRng.stream("nope");
  assert.strictEqual(m.name, "misc", "unknown names share the misc stream");
});

test("gamerng: WorldLoaded reseeds from TC.worldSeed", () => {
  const { TC } = loadGame({ hash: "" });
  TC.worldSeed = 31415;
  TC.GameRng.reset(1);
  for (let i = 0; i < 10; i++) TC.GameRng.stream("spawn").float();
  const before = TC.GameRng.digest();

  TC.Events.emit(TC.Events.EVENT.WorldLoaded, {});
  assert.strictEqual(TC.GameRng.seedOf(), 31415 >>> 0, "reseeded from worldSeed");
  assert.notStrictEqual(TC.GameRng.digest(), before);

  // fresh realm with the same seed matches the post-load digest
  const { TC: TC2 } = loadGame({ hash: "" });
  TC2.Events.emit(TC2.Events.EVENT.WorldLoaded, {}); // worldSeed undefined -> 0
  TC2.worldSeed = 31415;
  TC2.Events.emit(TC2.Events.EVENT.WorldLoaded, {});
  assert.strictEqual(TC2.GameRng.digest(), TC.GameRng.digest(),
    "two realms loading seed 31415 agree on RNG state");
});
