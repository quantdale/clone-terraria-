/* tests/world/worldgen-determinism.test.js — Phase 9 seed corpus.
   Fixed seed matrix chosen to exercise every structure/biome pass (ocean,
   desert+pyramid, evil strip, surface dungeon, hell temples, snow, jungle).
   For each seed: repeated in-process generation must be byte-identical,
   recorded FNV-1a checksums must stay stable, structural features must be
   present, and the spawn point must stand on walkable ground.

   Regenerating the reference table: run
     node -e "const {loadGame}=require('./tests/helpers/load-game.js');
       const g=loadGame(); function f(a){let h=0x811c9dc5;
       for(let i=0;i<a.length;i++){h^=a[i]&255;h=Math.imul(h,16777619);}
       return h>>>0;}
       for(const s of [1,7,...]) { const w=g.TC.WorldGen.generate(s);
         console.log(s,f(w.tiles),f(w.walls),f(w.surfaceY)); }"
   Any change means generation output changed — bump GENERATION_VERSION or
   fix the drift deliberately. */

const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("child_process");
const path = require("path");
const { loadGame } = require("../helpers/load-game.js");

// seed -> [tilesFNV, wallsFNV, surfaceY-FNV]
const CORPUS = {
  1: [2538759686, 1255116183, 2829768341],
  7: [1003567923, 1519507840, 549136040],
  13: [937311125, 2777605827, 3972995700],
  29: [908054374, 2382601387, 1041091505],
  41: [4184507965, 3323436263, 3770651900],
  47: [2172474784, 3425488439, 2843995629],
  987654321: [3544040153, 125538718, 4007195733],
  2147483646: [1023206567, 680799694, 1146218019],
};

function fnv(arr) {
  let h = 0x811c9dc5;
  for (let i = 0; i < arr.length; i++) {
    h ^= arr[i] & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function byteEqual(a, b) {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const bb = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  return Buffer.compare(ba, bb) === 0;
}

// One shared boot; WorldGen is stateless across generate() calls.
const G = loadGame();
const TC = G.TC;

test("worldgen corpus: repeated generation is byte-identical and checksums hold", () => {
  for (const [seedStr, want] of Object.entries(CORPUS)) {
    const seed = Number(seedStr);
    const a = TC.WorldGen.generate(seed);
    const b = TC.WorldGen.generate(seed);
    assert.ok(
      byteEqual(a.tiles, b.tiles),
      `seed ${seed}: tiles differ between runs`,
    );
    assert.ok(
      byteEqual(a.walls, b.walls),
      `seed ${seed}: walls differ between runs`,
    );
    assert.deepStrictEqual(
      Array.from(a.surfaceY),
      Array.from(b.surfaceY),
      `seed ${seed}: surfaceY differs between runs`,
    );
    assert.strictEqual(
      fnv(a.tiles),
      want[0],
      `seed ${seed}: tiles checksum drifted from frozen reference (generation output changed)`,
    );
    assert.strictEqual(
      fnv(a.walls),
      want[1],
      `seed ${seed}: walls checksum drifted`,
    );
    assert.strictEqual(
      fnv(a.surfaceY),
      want[2],
      `seed ${seed}: surfaceY checksum drifted`,
    );
  }
});

test("worldgen corpus: every seed exercises ocean/desert/pyramid/evil/dungeon/hell/snow/jungle", () => {
  const T = TC.TILE;
  for (const seedStr of Object.keys(CORPUS)) {
    const seed = Number(seedStr);
    const gen = TC.WorldGen.generate(seed);
    const t = gen.tiles,
      W = gen.width,
      H = gen.height;
    let evil = 0,
      dungeon = 0,
      hell = 0,
      pyramidBrick = 0,
      cactus = 0;
    let snow = 0,
      jungleGrass = 0,
      lava = 0,
      edgeWater = 0;
    for (let i = 0; i < t.length; i++) {
      const id = t[i];
      if (id === T.EBONSTONE || id === T.EBONGRASS || id === T.CRIMSTONE)
        evil++;
      else if (id === T.DUNGEON_BRICK) dungeon++;
      else if (id === T.HELL_BRICK) hell++;
      else if (id === T.SANDSTONE_BRICK) pyramidBrick++;
      else if (id === T.CACTUS) cactus++;
      else if (id === T.SNOW) snow++;
      else if (id === T.JGRASS) jungleGrass++;
      else if (id === T.LAVA) lava++;
    }
    for (let x = 0; x < 40; x++) {
      for (let y = 100; y < 200; y++) {
        if (t[y * W + x] === T.WATER) edgeWater++;
      }
    }
    for (let x = W - 40; x < W; x++) {
      for (let y = 100; y < 200; y++) {
        if (t[y * W + x] === T.WATER) edgeWater++;
      }
    }
    const label = (what) => `seed ${seed}: missing ${what}`;
    assert.ok(evil > 5000, label(`evil biome blocks (${evil})`));
    assert.ok(dungeon > 100, label(`dungeon brick (${dungeon})`));
    assert.ok(hell > 0, label(`hell brick (${hell})`));
    assert.ok(
      pyramidBrick > 0,
      label(`pyramid sandstone brick (${pyramidBrick})`),
    );
    assert.ok(cactus > 0, label(`cactus (${cactus})`));
    assert.ok(snow > 0, label(`snow band (${snow})`));
    assert.ok(jungleGrass > 0, label(`jungle band (${jungleGrass})`));
    assert.ok(edgeWater > 0, label(`ocean water volume (${edgeWater})`));
    assert.ok(lava > 0, label(`underworld lava (${lava})`));
    void H; // width/height used via W/H locals
  }
});

test("worldgen corpus: spawn point is inside bounds on air-over-solid ground", () => {
  for (const seedStr of Object.keys(CORPUS)) {
    const seed = Number(seedStr);
    const gen = TC.WorldGen.generate(seed);
    const { spawnX: sx, spawnY: sy, width: W, height: H } = gen;
    assert.ok(
      sx >= 8 && sx <= W - 9,
      `seed ${seed}: spawnX ${sx} out of safe bounds`,
    );
    assert.ok(
      sy >= 1 && sy < H - 1,
      `seed ${seed}: spawnY ${sy} out of bounds`,
    );
    const groundId = gen.tiles[sy * W + sx];
    const headId = gen.tiles[(sy - 1) * W + sx];
    assert.strictEqual(
      !!TC.TILE_DEFS[groundId].solid,
      true,
      `seed ${seed}: spawn has no solid ground beneath (${TC.TILE_DEFS[groundId].name})`,
    );
    assert.strictEqual(
      !!TC.TILE_DEFS[headId].solid,
      false,
      `seed ${seed}: spawn head space blocked by ${TC.TILE_DEFS[headId].name}`,
    );
  }
});

test("worldgen corpus: interleaved generation keeps per-pass RNG streams independent", () => {
  // Distinct pair from worldgen.test.js's (777,888) case; both are corpus seeds.
  const a1 = TC.WorldGen.generate(1);
  const b = TC.WorldGen.generate(987654321);
  const a2 = TC.WorldGen.generate(1);
  assert.strictEqual(
    fnv(a1.tiles),
    fnv(a2.tiles),
    "gen(1) drifted after interleaved gen",
  );
  assert.strictEqual(fnv(a1.walls), fnv(a2.walls));
  assert.notStrictEqual(
    fnv(a1.tiles),
    fnv(b.tiles),
    "distinct seeds produced identical worlds (sanity)",
  );
});

test("worldgen corpus: structurally-heavy seed matches in a fresh process", () => {
  const local = fnv(TC.WorldGen.generate(2147483646).tiles);
  const script =
    "const {loadGame}=require(" +
    JSON.stringify(path.join(process.cwd(), "tests/helpers/load-game.js")) +
    ");" +
    "function f(a){let h=0x811c9dc5;for(let i=0;i<a.length;i++){h^=a[i]&255;h=Math.imul(h,16777619);}return h>>>0;}" +
    "console.log(f(loadGame().TC.WorldGen.generate(2147483646).tiles));";
  const out = execFileSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.strictEqual(
    out.trim(),
    String(local),
    "fresh process generated a different world for seed 2147483646",
  );
});

test("worldgen CONFIG: flags default off; toggling is deterministic (currently inert)", () => {
  assert.deepStrictEqual(
    { ...TC.WorldGen.CONFIG },
    { deepCaves: false, microBiomes: false, richOres: false },
  );
  const baseline = TC.WorldGen.generate(41);
  try {
    for (const flag of ["deepCaves", "microBiomes", "richOres"]) {
      TC.WorldGen.CONFIG[flag] = true;
      const on1 = TC.WorldGen.generate(41);
      const on2 = TC.WorldGen.generate(41);
      assert.ok(
        byteEqual(on1.tiles, on2.tiles),
        `CONFIG.${flag}=true made generation nondeterministic`,
      );
      // CURRENT BEHAVIOR: no generation pass reads these flags yet, so output
      // equals flag-off output. If someone implements a flag, this assertion
      // fails and must be updated to assert deterministic-DIFFERENT output.
      assert.strictEqual(
        fnv(on1.tiles),
        fnv(baseline.tiles),
        `CONFIG.${flag} changed generation — update this contract to assert ` +
          `the flag now meaningfully alters output (still deterministically)`,
      );
    }
  } finally {
    TC.WorldGen.CONFIG.deepCaves = false;
    TC.WorldGen.CONFIG.microBiomes = false;
    TC.WorldGen.CONFIG.richOres = false;
  }
});
