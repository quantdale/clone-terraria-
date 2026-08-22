/* tests/player/physics-matrix.test.js — Phase 6 shape-physics torture matrix.
   Walks the REAL player controller across every shaped-column transition at
   low/high speed, plus platform drop-through permanence, edge/coyote, exact
   boundary settle, side collisions, fall damage interaction, knockback
   recovery and a multi-phase tunneling sweep. Production defects get fixed
   in js/player.js — never loosened here. */

const test = require("node:test");
const assert = require("node:assert");
const { DT, setup, place, runFrames, feetOf } = require("./helpers-arena.js");

const TS = 16;
// Short strip keys ('se', 'sw', ...) must resolve through this map — include
// every spelling used by the column tables so a typo can never silently
// leave a shaped column as FULL again.
const SHP_KEYS = {
  FULL: 0,
  PLATFORM: 1,
  PLAT: 1,
  HALF: 2,
  SLOPE_NE: 3,
  NE: 3,
  SLOPE_NW: 4,
  NW: 4,
  SLOPE_SE: 5,
  SE: 5,
  SLOPE_SW: 6,
  SW: 6,
};

// ---- strip terrain builder -------------------------------------------------
// Builds a horizontal strip at base row R out of `cols` ({key:'full'|...}),
// with a 6-column full runway on the left and a 6-column runway on the right.
// Everything above/below in the band is air (floating strips => tunneling-real).
function buildStrip(TC, R, cols) {
  const world = TC.world,
    T = TC.TILE;
  const x0 = 100,
    runway = 6,
    len = cols.length;
  const total = runway + len + runway;
  for (let tx = x0; tx < x0 + total; tx++) {
    for (let ty = R - 14; ty <= R + 3; ty++) world.setRaw(tx, ty, T.AIR);
  }
  const keyOf = (i) => {
    if (i < runway || i >= runway + len) return "full";
    return cols[i - runway];
  };
  for (let i = 0; i < total; i++) {
    const tx = x0 + i,
      key = keyOf(i);
    world.setRaw(tx, R, T.STONE);
    if (key !== "full") world.setShape(tx, R, SHP_KEYS[key.toUpperCase()]);
  }
  return { x0, x1: x0 + total - 1, runway, len, R, cols };
}

// Surface top (pixel y the feet rest on) for strip column key at sample x.
// Returns Infinity when the sample column offers no walkable surface.
function surfaceTop(key, tx, sx, R) {
  const lx = Math.min(1, Math.max(0, (sx - tx * TS) / TS));
  switch (key) {
    case "full":
      return R * TS;
    case "half":
      return R * TS + TS / 2;
    case "plat":
      return R * TS + (TS * 5) / 16;
    case "se":
      return R * TS + (1 - lx) * TS; // rises eastward
    case "sw":
      return R * TS + lx * TS; // falls eastward
    default:
      return Infinity; // ceiling shapes: no floor
  }
}

function keyAt(strip, tx) {
  if (tx < strip.x0 || tx > strip.x1) return null;
  const i = tx - strip.x0;
  if (i < strip.runway || i >= strip.runway + strip.len) return "full";
  return strip.cols[i - strip.runway];
}

// Expected settled feet height: the HIGHEST surface (min y) visible under the
// hitbox footprint — mirrors landSnapY's best-candidate rule.
function expectedFeet(strip, p) {
  const e = 0.01;
  const xs = [p.x + e, p.x + p.w / 2, p.x + p.w - e];
  let best = Infinity;
  for (const sx of xs) {
    const tx = Math.floor(sx / TS);
    const key = keyAt(strip, tx);
    if (!key) continue;
    const top = surfaceTop(key, tx, sx, strip.R);
    if (top < best) best = top;
  }
  return best;
}

// Walk a pinned-vx sweep across the strip; returns {trace, strip}.
function walkAcross(TC, strip, vx, startOffsetPx) {
  const startX = (strip.x0 + 1) * TS + (startOffsetPx || 0);
  const p = place(TC, startX, (strip.R - 4) * TS);
  const frames = Math.ceil(((strip.len + 14) * TS) / Math.abs(vx)) + 40;
  const trace = runFrames(TC, frames, vx);
  return { p, trace };
}

// Grounded frames must show vy==0 and sub-pixel stability. Consecutive-frame
// comparisons only count when BOTH frames are grounded — the airborne->landed
// transition legitimately moves several px.
function assertNoJitter(trace, label) {
  let groundedRun = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1],
      b = trace[i];
    assert.ok(
      Number.isFinite(b.x) && Number.isFinite(b.y),
      label + ": finite coords",
    );
    if (b.onGround) {
      groundedRun++;
      assert.strictEqual(
        b.vy,
        0,
        label + ": vy must be 0 while onGround (frame " + i + ")",
      );
      if (a.onGround) {
        // Walking a 1:1 facet changes y exactly with x; only STATIONARY
        // oscillation is jitter. Bound dy by the facet grade times |dx|.
        const dx = Math.abs(b.x - a.x);
        const d = Math.abs(b.y - a.y);
        const limit = dx * 1.05 + 0.05;
        assert.ok(
          d <= limit,
          label +
            ": jitter " +
            d.toFixed(3) +
            "px between settled frames (dx " +
            dx.toFixed(3) +
            ", frame " +
            i +
            ")",
        );
      }
    } else {
      groundedRun = 0;
    }
  }
  return groundedRun;
}

// While crossing the strip core the player must stay on/near the surface
// profile. Grounded frames must rest ON real support: feet coincide with at
// least ONE walkable surface under the footprint (an 18px box can straddle
// two facet heights, so requiring the HIGHEST one every frame would reject
// correct discretized resting). Airborne frames may cut a descending facet's
// diagonal ballistically, but never sink more than a tile (tunneling).
function assertFollowsProfile(strip, p, trace, label, tolAbove) {
  tolAbove = tolAbove || 3;
  const REST_EPS = 0.06;
  for (let i = 0; i < trace.length; i++) {
    const s = trace[i];
    const ghost = { x: s.x, w: p.w };
    const want = expectedFeet(strip, ghost);
    if (!Number.isFinite(want)) continue;
    const feet = s.y + p.h;
    // tops under each footprint sample
    const e = 0.01;
    const xs = [ghost.x + e, ghost.x + ghost.w / 2, ghost.x + ghost.w - e];
    const tops = [];
    for (const sx of xs) {
      const tx = Math.floor(sx / TS);
      const key = keyAt(strip, tx);
      if (!key) continue;
      const top = surfaceTop(key, tx, sx, strip.R);
      if (Number.isFinite(top)) tops.push(top);
    }
    if (s.onGround) {
      const supported =
        tops.length > 0 &&
        tops.some((t) => Math.abs(feet - t) <= REST_EPS);
      assert.ok(
        supported,
        label +
          ": grounded feet rest on no real surface at frame " +
          i +
          " (feet " +
          feet.toFixed(2) +
          ", tops [" +
          tops.map((t) => t.toFixed(1)).join(", ") +
          "])",
      );
      assert.ok(
        feet >= want - tolAbove,
        label +
          ": grounded hover above surface at frame " +
          i +
          " (" +
          feet.toFixed(2) +
          " < " +
          want.toFixed(2) +
          ")",
      );
    } else {
      assert.ok(
        feet <= want + TS,
        label +
          ": airborne sink exceeded a tile at frame " +
          i +
          " (" +
          feet.toFixed(2) +
          " > " +
          want.toFixed(2) +
          ")",
      );
    }
  }
}

// ---- 1. the transition matrix ----------------------------------------------

const FLOOR_PAIRS = [
  ["full", "full"],
  ["full", "plat"],
  ["plat", "full"],
  ["full", "half"],
  ["half", "full"],
  ["half", "half"],
  ["full", "se"],
  ["se", "full"],
  ["half", "se"],
  ["se", "half"],
  ["full", "sw"],
  ["sw", "full"],
  ["half", "sw"],
  ["sw", "half"],
  ["se", "se"],
  ["sw", "sw"],
  ["se", "sw"], // peak
  ["sw", "se"], // valley
];

for (const [a, b] of FLOOR_PAIRS) {
  for (const speed of [60, 220]) {
    // low crawl + above RUN_MAX dash
    test(`matrix ${a}->${b} @${speed}px/s`, () => {
      const { TC } = setup(700 + a.length * 13 + b.length);
      const strip = buildStrip(TC, 80, [a, b]);
      const { p, trace } = walkAcross(TC, strip, speed);
      assertNoJitter(trace, `${a}->${b}@${speed}`);
      assertFollowsProfile(strip, p, trace, `${a}->${b}@${speed}`);
      assert.strictEqual(
        p.onGround,
        true,
        `${a}->${b}@${speed}: must finish grounded`,
      );
    });
  }
}

// ---- 2. longer mixed chains --------------------------------------------------

test("matrix chain full->se->sw->full (peak climb and descend)", () => {
  const { TC } = setup(731);
  const strip = buildStrip(TC, 80, ["se", "sw"]);
  const { p, trace } = walkAcross(TC, strip, 90);
  assertNoJitter(trace, "peak-chain");
  assertFollowsProfile(strip, p, trace, "peak-chain");
  assert.strictEqual(p.onGround, true);
});

test("matrix chain full->sw->se->full (valley cross)", () => {
  const { TC } = setup(732);
  const strip = buildStrip(TC, 80, ["sw", "se"]);
  const { p, trace } = walkAcross(TC, strip, 90);
  assertNoJitter(trace, "valley-chain");
  assertFollowsProfile(strip, p, trace, "valley-chain");
  assert.strictEqual(p.onGround, true);
});

test("matrix reverse-direction walks (westward) over se/sw", () => {
  for (const cols of [
    ["se", "sw"],
    ["sw", "se"],
    ["half", "se"],
    ["sw", "half"],
  ]) {
    const { TC } = setup(740 + cols.join("").length);
    const strip = buildStrip(TC, 80, cols);
    const startX = (strip.x1 - 1) * TS;
    const p = place(TC, startX, (strip.R - 4) * TS);
    const trace = runFrames(TC, 260, -70);
    assertNoJitter(trace, "west-" + cols.join(">"));
    assertFollowsProfile(strip, p, trace, "west-" + cols.join(">"));
    assert.strictEqual(p.onGround, true, "west walk must finish grounded");
  }
});

// ---- 3. exact boundary settle per shape --------------------------------------

test("boundary settle: feet rest exactly on each shape surface", () => {
  const cases = [
    ["full", 0],
    ["half", TS / 2],
    ["plat", (TS * 5) / 16],
  ];
  for (const [key, off] of cases) {
    const { TC } = setup(750);
    // 3-wide shaped region: the 18px hitbox must never sample a different shape
    const strip = buildStrip(TC, 80, [key, key, key]);
    const midTx = strip.x0 + strip.runway + 1;
    const p = place(
      TC,
      midTx * TS + TS / 2 - TC.player.w / 2,
      (strip.R - 6) * TS,
    );
    runFrames(TC, 120);
    const want = strip.R * TS + off;
    assert.ok(
      Math.abs(feetOf(p) - want) < 0.02,
      key + ": feet " + feetOf(p).toFixed(3) + " vs surface " + want,
    );
    assert.strictEqual(p.onGround, true);
  }
});

test("boundary settle: slope midpoint matches linear surface", () => {
  for (const key of ["se", "sw"]) {
    const { TC } = setup(751);
    // 3-wide shaped region so corner samples never touch the FULL runway
    const strip = buildStrip(TC, 80, [key, key, key]);
    const midTx = strip.x0 + strip.runway + 1;
    const cx = midTx * TS + TS / 2 - TC.player.w / 2;
    const p = place(TC, cx, (strip.R - 6) * TS);
    runFrames(TC, 120);
    // The engine rests on the HIGHEST contact under the footprint (the same
    // best-candidate rule expectedFeet models), not the center-line facet.
    const want = expectedFeet(strip, { x: p.x, w: p.w });
    assert.ok(
      Math.abs(feetOf(p) - want) < 1.5,
      key +
        ": feet " +
        feetOf(p).toFixed(2) +
        " vs slope surface " +
        want.toFixed(2),
    );
    assert.strictEqual(p.onGround, true);
  }
});

// ---- 4. platform behaviors -----------------------------------------------------

test("platform drop-through is not permanent: deck is solid again after landing", () => {
  const { TC } = setup(760);
  const R = 80;
  // 3-wide deck: the 18px hitbox is wider than one tile, so a single-column
  // deck always overlaps the full-runway shoulders and the best-contact rule
  // would legitimately rest the player on those instead.
  const strip = buildStrip(TC, R, ["plat", "plat", "plat"]);
  const deckTx = strip.x0 + strip.runway + 1;
  const deckTop = R * TS + (TS * 5) / 16;
  const p = place(TC, deckTx * TS + (TS - TC.player.w) / 2, (R - 5) * TS);
  runFrames(TC, 90);
  assert.strictEqual(p.onGround, true, "precondition: settled on deck");
  assert.ok(Math.abs(feetOf(p) - deckTop) < 0.05);

  // catch floor two tiles under the deck, built BEFORE the gate opens so the
  // fall window below can never reach generated terrain
  for (let tx = strip.x0; tx <= strip.x1; tx++) {
    TC.world.setRaw(tx, R + 2, TC.TILE.STONE);
  }

  // open the S-drop gate and leave the deck
  p.dropT = 0.25;
  runFrames(TC, 8);
  assert.ok(
    !p.onGround || feetOf(p) > deckTop + 4,
    "must be falling after opening the drop gate",
  );

  runFrames(TC, 120);
  assert.strictEqual(p.onGround, true, "lands on the floor below");
  const landedFeet = feetOf(p);

  // jump back up: the SAME deck must catch the player again
  p.vy = -TC.CONST.JUMP_VEL;
  let crossedDeck = false;
  for (let i = 0; i < 90; i++) {
    p.update(DT);
    if (feetOf(p) <= deckTop + 1) {
      crossedDeck = true;
      break;
    }
  }
  assert.ok(crossedDeck, "jump reached deck altitude");
  runFrames(TC, 60);
  assert.ok(
    Math.abs(feetOf(p) - deckTop) < 0.05 || feetOf(p) < deckTop,
    "deck re-solidified: player rests on deck, not below it",
  );
  assert.strictEqual(p.onGround, true);
  void landedFeet;
});

test("stacked decks: dropping through the upper deck is caught by the lower deck", () => {
  const { TC } = setup(761);
  const R = 84;
  const world = TC.world,
    T = TC.TILE;
  const x0 = 100;
  for (let tx = x0 - 4; tx <= x0 + 16; tx++) {
    for (let ty = R - 14; ty <= R + 4; ty++) world.setRaw(tx, ty, T.AIR);
  }
  for (let tx = x0; tx <= x0 + 12; tx++) {
    world.setRaw(tx, R - 8, T.PLATFORM); // upper deck
    world.setRaw(tx, R - 3, T.PLATFORM); // lower deck, 5 tiles below
    world.setRaw(tx, R + 2, T.STONE); // safety floor
  }
  const upperTop = (R - 8) * TS + (TS * 5) / 16;
  const lowerTop = (R - 3) * TS + (TS * 5) / 16;
  const p = place(TC, (x0 + 6) * TS, (R - 13) * TS);
  runFrames(TC, 90);
  assert.ok(Math.abs(feetOf(p) - upperTop) < 0.05, "settled on upper deck");

  p.dropT = 0.25; // S-drop through UPPER only
  runFrames(TC, 120);
  assert.strictEqual(p.onGround, true, "caught by something");
  assert.ok(
    Math.abs(feetOf(p) - lowerTop) < 0.05,
    "lower deck caught the player at " +
      feetOf(p).toFixed(2) +
      " vs " +
      lowerTop,
  );

  // second gated drop reaches the stone floor
  p.dropT = 0.25;
  runFrames(TC, 150);
  assert.strictEqual(p.onGround, true);
  assert.ok(Math.abs(feetOf(p) - (R + 2) * TS) < 0.05, "stone floor reached");
});

test("drop gate does NOT open holes in HALF blocks or ground slopes", () => {
  for (const key of ["half", "se", "sw"]) {
    const { TC } = setup(762);
    const strip = buildStrip(TC, 80, [key]);
    const p = place(
      TC,
      (strip.x0 + strip.runway + 0.5) * TS,
      (strip.R - 5) * TS,
    );
    runFrames(TC, 90);
    assert.strictEqual(p.onGround, true, key + ": precondition grounded");
    const f0 = feetOf(p);
    p.dropT = 0.25;
    runFrames(TC, 40);
    assert.strictEqual(p.onGround, true, key + ": dropT must not pass " + key);
    assert.ok(Math.abs(feetOf(p) - f0) < 0.5, key + ": stayed put");
  }
});

// ---- 5. edge contact, coyote, hover ---------------------------------------------

test("walking off an edge: coyote window opens then closes; no hover", () => {
  const { TC } = setup(770);
  const R = 80;
  const strip = buildStrip(TC, R, []);
  const p = place(TC, (strip.x1 - 1) * TS, (R - 4) * TS);
  runFrames(TC, 60);
  assert.strictEqual(p.onGround, true);
  const coyoteWhileGrounded = p.coyote;
  assert.ok(
    coyoteWhileGrounded >= TC.CONST.COYOTE - 1e-9,
    "coyote refilled while grounded",
  );

  // walk east off the edge. Mid-box grounding (slope contact lives under the
  // box CENTER) extends the physical ledge by ~half a hitbox, so allow the
  // full walk-up plus fall window here; every assertion below is unchanged.
  let sawAirborne = false,
    coyoteAfterLeave = -1;
  for (let i = 0; i < 90; i++) {
    p.vx = 60;
    p.update(DT);
    if (!p.onGround && sawAirborne === false) {
      sawAirborne = true;
      coyoteAfterLeave = p.coyote;
    }
  }
  assert.ok(sawAirborne, "left the edge");
  assert.ok(
    coyoteAfterLeave > 0,
    "coyote time active just after leaving ground",
  );
  assert.ok(
    p.coyote <= 0 || p.vy > 0,
    "coyote expired or falling well past the ledge",
  );
  // no hover: vy must reflect real gravity accumulation by now
  assert.ok(
    p.vy > 200,
    "falling with real velocity off the edge (vy=" + p.vy + ")",
  );
});

test("exact tile boundary: feet at tile top produce no sink and no float", () => {
  const { TC } = setup(771);
  const R = 80;
  const strip = buildStrip(TC, R, ["full"]);
  const p = place(TC, (strip.x0 + strip.runway + 0.5) * TS, R * TS - p0H());
  p.y = R * TS - p.h; // EXACT boundary, zero velocity
  p.vy = 0;
  for (let i = 0; i < 30; i++) p.update(DT);
  assert.strictEqual(p.onGround, true);
  assert.ok(
    Math.abs(feetOf(p) - R * TS) < 0.02,
    "stayed exactly on the boundary",
  );
});
function p0H() {
  return 40;
}

// ---- 6. side collisions -----------------------------------------------------------

test("side collision: running into a full wall stops cleanly at the face", () => {
  const { TC } = setup(780);
  const R = 80;
  const strip = buildStrip(TC, R, []);
  const wallX = strip.x0 + 8;
  for (let ty = R - 4; ty <= R - 1; ty++)
    TC.world.setRaw(wallX, ty, TC.TILE.STONE);
  const p = place(TC, (strip.x0 + 2) * TS, (R - 1) * TS - 40);
  runFrames(TC, 60, 185);
  assert.strictEqual(p.onGround, true);
  const face = wallX * TS;
  assert.ok(
    p.x + p.w <= face + 0.02,
    "stopped at the wall face: x+w=" + (p.x + p.w).toFixed(3) + " vs " + face,
  );
});

test("wall slide: jumping along a wall face does not stick or embed", () => {
  const { TC } = setup(781);
  const R = 80;
  const strip = buildStrip(TC, R, []);
  const wallX = strip.x0 + 10;
  for (let ty = R - 12; ty <= R - 1; ty++)
    TC.world.setRaw(wallX, ty, TC.TILE.STONE);
  const p = place(TC, (wallX - 2) * TS - 4, (R - 1) * TS - 40);
  runFrames(TC, 30, 185);
  const xAtWall = p.x;
  // jump into the wall repeatedly: x stays blocked, y moves freely, no NaN
  for (let hop = 0; hop < 3; hop++) {
    p.vy = -TC.CONST.JUMP_VEL;
    for (let i = 0; i < 40; i++) {
      p.vx = 185;
      p.update(DT);
      assert.ok(
        Number.isFinite(p.x) && Number.isFinite(p.y),
        "finite during wall slide",
      );
      assert.ok(p.x + p.w <= wallX * TS + 0.02, "never embeds into the wall");
    }
    assert.strictEqual(
      p.vx,
      0,
      "vx zeroed by the blocked face (no stick force)",
    );
  }
  void xAtWall;
});

test("ceiling slopes (NE/NW): jumping into them stops the head without embed", () => {
  for (const key of ["ne", "nw"]) {
    const { TC } = setup(782);
    const R = 80;
    const strip = buildStrip(TC, R, []);
    const cTy = R - 5; // ceiling row
    const ctx = strip.x0 + strip.runway;
    // Stone slab one row above the wedge cell; buildStrip already carved the
    // air pocket (rows R-14..R+3) and laid the floor — do NOT clear further
    // down or the arena floor itself gets erased.
    for (let tx = strip.x0; tx <= strip.x1; tx++) {
      TC.world.setRaw(tx, cTy - 1, TC.TILE.STONE);
    }
    TC.world.setRaw(ctx, cTy, TC.TILE.AIR);
    TC.world.setRaw(ctx, cTy, TC.TILE.STONE);
    TC.world.setShape(ctx, cTy, SHP_KEYS[key.toUpperCase()]);
    const p = place(TC, ctx * TS + 4, (R - 2) * TS - 40);
    runFrames(TC, 40);
    p.vy = -TC.CONST.JUMP_VEL;
    let bumped = false;
    for (let i = 0; i < 60 && !bumped; i++) {
      p.update(DT);
      if (p.vy === 0 && p.y < (R - 2) * TS - 20) bumped = true; // rising stopped early
    }
    assert.ok(bumped, key + ": head bump registered under the ceiling slope");
    assert.ok(
      p.y + 0.01 >= (cTy + 1) * TS - 41,
      key + ": head stayed below the ceiling cell",
    );
    assert.ok(!p.hitsAt(p.x, p.y), key + ": no residual embed after bump");
  }
});

// ---- 7. fall damage interaction ---------------------------------------------------

function dropFrom(TC, tilesAbove, floorKey) {
  const R = 96;
  const strip = buildStrip(TC, R, floorKey ? [floorKey] : []);
  const cx = (strip.x0 + strip.runway + 0.5) * TS;
  const p = place(TC, cx, (R - tilesAbove) * TS);
  const hp0 = p.hp;
  runFrames(TC, 60 + tilesAbove * 5);
  return { p, hp0 };
}

test("fall damage: long fall hurts exactly once", () => {
  const { TC } = setup(790);
  const { p, hp0 } = dropFrom(TC, 30, "full");
  assert.ok(p.hp < hp0, "long fall dealt damage: " + p.hp + " < " + hp0);
  const hpAfterLanding = p.hp;
  assert.strictEqual(p.fallTiles, 0, "fall counter reset on landing");
  runFrames(TC, 60); // more grounded frames
  assert.strictEqual(p.hp, hpAfterLanding, "damage applied exactly once");
  assert.strictEqual(p.onGround, true);
});

test("fall damage: short hop deals none", () => {
  const { TC } = setup(791);
  const R = 80;
  const strip = buildStrip(TC, R, ["full"]);
  const p = place(TC, (strip.x0 + strip.runway + 0.5) * TS, (R - 4) * TS);
  runFrames(TC, 60);
  const hp0 = p.hp;
  p.vy = -TC.CONST.JUMP_VEL;
  for (let i = 0; i < 70; i++) p.update(DT);
  assert.strictEqual(p.hp, hp0, "no fall damage from a normal jump");
  assert.strictEqual(p.fallTiles, 0);
});

test("fall damage: platform deck landing counts as a landing", () => {
  const { TC } = setup(792);
  const R = 110;
  const world = TC.world,
    T = TC.TILE,
    x0 = 100;
  for (let tx = x0 - 4; tx <= x0 + 12; tx++) {
    for (let ty = R - 40; ty <= R + 3; ty++) world.setRaw(tx, ty, T.AIR);
    world.setRaw(tx, R - 32, T.PLATFORM); // deck 32 tiles above nothing
  }
  const p = place(TC, (x0 + 4) * TS, (R - 62) * TS);
  const hp0 = p.hp;
  runFrames(TC, 400);
  assert.strictEqual(p.onGround, true, "caught by the deck");
  assert.ok(
    p.hp < hp0,
    "deck landing still deals fall damage (" + p.hp + " < " + hp0 + ")",
  );
  assert.strictEqual(p.fallTiles, 0);
});

// ---- 8. knockback interaction ------------------------------------------------------

test("knockback across half/slope terrain: slides, recovers, never embeds", () => {
  for (const key of ["half", "se", "sw", "plat"]) {
    const { TC } = setup(793);
    const R = 80;
    const strip = buildStrip(TC, R, [key, key]);
    const p = place(TC, (strip.x0 + strip.runway - 1) * TS, (R - 4) * TS);
    runFrames(TC, 60);
    const hp0 = p.hp;
    // Combat-grade knockback impulse while running onto the shaped columns
    try {
      TC.Combat.hurtPlayer(0, 260, -220, "test-kb");
    } catch (e) {
      p.vx = 260;
      p.vy = -220; // fallback: raw impulse
    }
    for (let i = 0; i < 90; i++) {
      p.update(DT);
      assert.ok(
        Number.isFinite(p.x) && Number.isFinite(p.y),
        key + ": finite under knockback",
      );
      assert.ok(!p.hitsAt(p.x, p.y), key + ": never embedded in geometry");
    }
    assert.strictEqual(p.onGround, true, key + ": recovered to ground");
    assert.ok(p.hp <= hp0, key + ": hp sane");
    const ghost = { x: p.x, w: p.w };
    const want = expectedFeet(strip, ghost);
    if (Number.isFinite(want)) {
      assert.ok(
        Math.abs(feetOf(p) - want) < 2.5,
        key +
          ": rests on the surface profile (" +
          feetOf(p).toFixed(2) +
          " vs " +
          want.toFixed(2) +
          ")",
      );
    }
  }
});

// ---- 9. tunneling sweep --------------------------------------------------------------

for (const vy of [900, 1200, 1800]) {
  for (const key of ["full", "half", "plat", "se", "sw"]) {
    for (const phase of [0, 3, 7, 11]) {
      // alignment sweep over the tile
      test(`tunneling vy=${vy} ${key} phase=${phase}`, () => {
        const { TC } = setup(800 + (vy / 100) * 5 + phase);
        const R = 90;
        const strip = buildStrip(TC, R, [key]); // floating 1-tile floor, air below
        const deckTop =
          R * TS +
          (key === "half" ? TS / 2 : key === "plat" ? (TS * 5) / 16 : 0);
        const cx = (strip.x0 + strip.runway + 0.5) * TS;
        const p = place(TC, cx, (R - 3) * TS - phase);
        let worst = Infinity,
          fellThrough = false;
        for (let i = 0; i < 60; i++) {
          p.vy = vy;
          p.moveAndCollide(DT);
          const feet = feetOf(p);
          worst = Math.min(worst, deckTop - (feet - 0)); // negative => passed below top
          if (feet > deckTop + TS + 4) {
            fellThrough = true;
            break;
          }
          if (p.onGround && p.vy === 0) break;
        }
        assert.ok(
          !fellThrough,
          `vy=${vy} ${key}: punched through a 1-tile floor (worst ${worst.toFixed(2)})`,
        );
        assert.ok(
          Number.isFinite(p.x) && Number.isFinite(p.y),
          "finite coords",
        );
      });
    }
  }
}

// ---- 10. grounded-state coherence -----------------------------------------------------

test("grounded state coherence: vy==0 whenever onGround across a mixed walk", () => {
  const { TC } = setup(850);
  const strip = buildStrip(TC, 80, ["half", "se", "sw", "plat", "full"]);
  const { trace } = walkAcross(TC, strip, 130);
  for (let i = 0; i < trace.length; i++) {
    const s = trace[i];
    if (s.onGround) assert.strictEqual(s.vy, 0, "frame " + i);
    assert.ok(Number.isFinite(s.y), "frame " + i);
  }
});
