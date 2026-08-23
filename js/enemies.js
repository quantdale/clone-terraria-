/* enemies.js — enemy spawning, AI, physics, damage, procedural rendering.
   Also owns this module's content additions: extra ENEMY_DEFS, summon-item
   ITEM_DEFS + RECIPES entries, and the Blood Moon event. constants.js /
   index.html are lead-owned, so new definitions are merged in here at load
   time instead (script order guarantees constants.js has run first). */

(() => {
  window.TC = window.TC || {};
  const TC = window.TC;

  // ======================================================================
  // Content extensions (would live in lead-owned constants.js / index.html;
  // documented here because those files are read-only for this module).
  // ======================================================================

  // -- enemy definitions added on top of TC.ENEMY_DEFS --
  // New shared AI 'walker': daylight-immune ground chaser tuned by def.speed /
  // def.jumpVel. Boss AIs: 'king_slime', 'skeletron' (+ 'skele_hand' parts),
  // 'wof'. def.part marks boss *parts* (Skeletron hands): they persist like
  // bosses but do not count toward MAX_BOSSES and never take the UI boss bar.
  if (TC.ENEMY_DEFS) {
    Object.assign(TC.ENEMY_DEFS, {
      // ---- regular enemies ----
      harpy: {
        name: "Harpy",
        hp: 60,
        dmg: 16,
        kbResist: 0.4,
        ai: "harpy",
        w: 30,
        h: 24,
        color: "#b8a06a",
        drops: [{ id: "feather", min: 1, max: 2, chance: 0.9 }],
      },
      vulture: {
        name: "Vulture",
        hp: 40,
        dmg: 13,
        kbResist: 0.3,
        ai: "bat",
        w: 24,
        h: 18,
        color: "#9a7a52",
        drops: [{ id: "feather", min: 1, max: 1, chance: 0.6 }],
      },
      eater_of_souls: {
        name: "Eater of Souls",
        hp: 70,
        dmg: 20,
        kbResist: 0.45,
        ai: "eye",
        w: 30,
        h: 26,
        color: "#7a4a9a",
        drops: [{ id: "shadow_shard", min: 1, max: 1, chance: 0.5 }],
      },
      ice_slime: {
        name: "Ice Slime",
        hp: 30,
        dmg: 14,
        kbResist: 0.3,
        ai: "slime",
        w: 32,
        h: 20,
        color: "#9adcf0",
        drops: [{ id: "gel", min: 1, max: 2, chance: 1 }],
      },
      sand_slime: {
        name: "Sand Slime",
        hp: 42,
        dmg: 15,
        kbResist: 0.3,
        ai: "slime",
        w: 34,
        h: 22,
        color: "#d8c86e",
        drops: [{ id: "gel", min: 1, max: 3, chance: 1 }],
      },
      jungle_bat: {
        name: "Jungle Bat",
        hp: 26,
        dmg: 14,
        kbResist: 0.2,
        ai: "bat",
        w: 20,
        h: 16,
        color: "#4a8a3a",
        drops: [],
      },
      skeleton: {
        name: "Skeleton",
        hp: 60,
        dmg: 18,
        kbResist: 0.55,
        ai: "walker",
        w: 20,
        h: 40,
        color: "#cfc8b8",
        speed: 55,
        jumpVel: 330,
        look: "skeleton",
        drops: [{ id: "bone", min: 1, max: 2, chance: 1 }],
      },
      granite_golem: {
        name: "Granite Golem",
        hp: 120,
        dmg: 26,
        kbResist: 0.85,
        ai: "walker",
        w: 28,
        h: 38,
        color: "#7a8a96",
        speed: 34,
        jumpVel: 300,
        look: "golem",
        defense: 4,
        drops: [{ id: "granite_shard", min: 1, max: 2, chance: 0.8 }],
      },
      blood_crawler: {
        name: "Blood Crawler",
        hp: 50,
        dmg: 20,
        kbResist: 0.4,
        ai: "walker",
        w: 28,
        h: 18,
        color: "#a02a2a",
        speed: 95,
        jumpVel: 380,
        look: "crawler",
        bloodMoonOnly: true,
        drops: [{ id: "blood_shard", min: 1, max: 2, chance: 0.7 }],
      },
      crimson_slime: {
        name: "Crimson Slime",
        hp: 58,
        dmg: 19,
        kbResist: 0.4,
        ai: "slime",
        w: 36,
        h: 24,
        color: "#c42a3a",
        bloodMoonOnly: true,
        drops: [
          { id: "gel", min: 2, max: 4, chance: 1 },
          { id: "blood_shard", min: 1, max: 1, chance: 0.5 },
        ],
      },
      hungry: {
        name: "Hungry",
        hp: 36,
        dmg: 22,
        kbResist: 0.2,
        ai: "eye",
        w: 22,
        h: 22,
        color: "#b04a4a",
        drops: [],
      }, // Wall of Flesh servant

      // ---- bosses (all kbResist 1; respect MAX_BOSSES via spawnBoss) ----
      king_slime: {
        name: "King Slime",
        hp: 900,
        dmg: 26,
        kbResist: 1,
        ai: "king_slime",
        w: 80,
        h: 56,
        color: "#4a6fd6",
        boss: true,
        defense: 6,
        drops: [
          { id: "gel", min: 30, max: 50, chance: 1 },
          { id: "gold_bar", min: 4, max: 7, chance: 1 },
          { id: "slime_crown", min: 1, max: 1, chance: 0.5 },
        ],
      },
      skeletron: {
        name: "Skeletron",
        hp: 1600,
        dmg: 30,
        kbResist: 1,
        ai: "skeletron",
        w: 64,
        h: 64,
        color: "#ddd6c2",
        boss: true,
        defense: 10,
        drops: [
          { id: "bone", min: 20, max: 35, chance: 1 },
          { id: "gold_bar", min: 6, max: 10, chance: 1 },
        ],
      },
      skele_hand: {
        name: "Skeletron Hand",
        hp: 280,
        dmg: 24,
        kbResist: 1,
        ai: "skele_hand",
        w: 26,
        h: 38,
        color: "#cfc8b8",
        part: true,
        drops: [{ id: "bone", min: 3, max: 6, chance: 1 }],
      },
      wof: {
        name: "Wall of Flesh",
        hp: 2400,
        dmg: 34,
        kbResist: 1,
        ai: "wof",
        w: 46,
        h: 170,
        color: "#c43a3a",
        boss: true,
        defense: 12,
        drops: [
          { id: "blood_shard", min: 15, max: 25, chance: 1 },
          { id: "gold_bar", min: 8, max: 12, chance: 1 },
        ],
      },
    });
  }

  // -- item definitions added on top of TC.ITEM_DEFS (materials + summons) --
  if (TC.ITEM_DEFS) {
    Object.assign(TC.ITEM_DEFS, {
      bone: I_MAT("Bone", {}),
      feather: I_MAT("Feather", {}),
      blood_shard: I_MAT("Blood Shard", {}),
      shadow_shard: I_MAT("Shadow Shard", {}),
      granite_shard: I_MAT("Granite Shard", {}),
      slime_crown: {
        name: "Slime Crown",
        kind: "summon",
        maxStack: 20,
        boss: "king_slime",
      },
      skull_sigil: {
        name: "Skull Sigil",
        kind: "summon",
        maxStack: 20,
        boss: "skeletron",
      },
      flesh_sigil: {
        name: "Flesh Sigil",
        kind: "summon",
        maxStack: 20,
        boss: "wof",
      },
      blood_sigil: {
        name: "Blood Sigil",
        kind: "summon",
        maxStack: 20,
        boss: "__blood_moon__",
      },
    });
  }

  function I_MAT(name, o) {
    return Object.assign({ name, kind: "material", maxStack: 999 }, o);
  }

  // -- crafting recipes for the summon items (appended to lead-owned table) --
  if (TC.RECIPES && typeof TC.RECIPES.push === "function") {
    TC.RECIPES.push(
      {
        out: "slime_crown",
        n: 1,
        station: "anvil",
        cost: { gel: 20, gold_bar: 3 },
      },
      {
        out: "skull_sigil",
        n: 1,
        station: "anvil",
        cost: { bone: 15, gold_bar: 3 },
      },
      {
        out: "flesh_sigil",
        n: 1,
        station: "anvil",
        cost: { blood_shard: 12, shadow_shard: 6, iron_bar: 5 },
      },
      {
        out: "blood_sigil",
        n: 1,
        station: "workbench",
        cost: { blood_shard: 5 },
      },
    );
  }

  const FLASH_TIME = 0.15;
  const TOUCH_KB_X = 210,
    TOUCH_KB_Y = -190;

  // ---- small local helpers (runtime gameplay randomness; Math.random is fine here) ----
  function rand(a, b) {
    return a + Math.random() * (b - a);
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function approach(v, target, rate, dt) {
    return v + (target - v) * Math.min(1, rate * dt);
  }
  function hexA(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16),
      g = parseInt(hex.slice(3, 5), 16),
      b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  function daylight() {
    return TC.Sky && typeof TC.Sky.daylight === "function"
      ? TC.Sky.daylight()
      : 1;
  }
  function weightedPick(table) {
    let total = 0;
    for (let i = 0; i < table.length; i++) total += table[i][1];
    let r = Math.random() * total;
    for (let i = 0; i < table.length; i++) {
      r -= table[i][1];
      if (r <= 0) return table[i][0];
    }
    return table[table.length - 1][0];
  }

  // ---- world queries ----
  function solidAt(tx, ty) {
    const w = TC.world;
    if (!w || typeof w.isSolid !== "function") return false;
    return !!w.isSolid(tx, ty);
  }
  function rectSolid(x, y, w, h) {
    const ts = TC.CONST.TS;
    const x0 = Math.floor(x / ts),
      x1 = Math.floor((x + w - 0.01) / ts);
    const y0 = Math.floor(y / ts),
      y1 = Math.floor((y + h - 0.01) / ts);
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) if (solidAt(tx, ty)) return true;
    return false;
  }

  // ---- state ----
  const list = [];
  let spawnTimer = 2; // grace period before the director starts rolling
  let clock = 0; // animation time (visual only)

  // ---- blood moon event ----
  // Active only at night. While up: night spawn attempts are 3x faster and the
  // night table is replaced with blood-moon-only enemies; kills drop extra
  // blood shards. Starts either by using a blood_sigil (intercepted in
  // spawnBoss) or by a random roll at dusk (~1 in 8 nights); ends at dawn,
  // recording 'event.blood_moon.completed' via TC.Progression.
  let bloodMoon = false;
  let prevDaylight = 1; // for dusk/dawn edge detection
  let bmRolledTonight = false;
  function setBloodMoon(v) {
    if (!!v === bloodMoon) return;
    bloodMoon = !!v;
    if (bloodMoon) {
      if (TC.UI && typeof TC.UI.toast === "function")
        TC.UI.toast("The Blood Moon is rising...");
    } else {
      // the event ended (dawn or manual cancel): record it as completed
      if (TC.Progression && typeof TC.Progression.set === "function") {
        try {
          TC.Progression.set("event.blood_moon.completed");
        } catch (err) {}
      }
      if (
        TC.Sky &&
        typeof TC.Sky.daylight === "function" &&
        TC.Sky.daylight() >= 0.5
      ) {
        if (TC.UI && typeof TC.UI.toast === "function")
          TC.UI.toast("The Blood Moon has set.");
      }
    }
  }

  // ---- spawn tables (extensions merged over lead-owned TC.CONST.SPAWN) ----
  // Biome extras are appended to the base zone table when the surface tile
  // under the player matches; blood-moon entries replace the night table.
  const EXTRA_SPAWN = {
    day: [
      ["harpy", 0.7],
      ["vulture", 0.6],
      ["ice_slime", 1.2],
      ["sand_slime", 1.0],
    ],
    night: [["eater_of_souls", 0.8]],
    cave: [
      ["skeleton", 1.4],
      ["granite_golem", 0.7],
      ["jungle_bat", 0.8],
    ],
  };
  const BLOOD_MOON_TABLE = [
    ["zombie", 3],
    ["demon_eye", 2],
    ["blood_crawler", 2.5],
    ["crimson_slime", 2],
    ["eater_of_souls", 1],
  ];
  function surfaceBiome(pcol) {
    const w = TC.world;
    if (!w || !w.surfaceY || typeof w.get !== "function") return "";
    const id = w.get(pcol, w.surfaceY[pcol]);
    if (id === TC.TILE.SNOW) return "snow";
    if (id === TC.TILE.JGRASS) return "jungle";
    if (id === TC.TILE.SAND) return "desert";
    return "";
  }
  function zoneTable(zone, pcol) {
    const C = TC.CONST;
    const bio =
      TC.Biomes && typeof TC.Biomes.getSpawnOverride === "function"
        ? TC.Biomes.getSpawnOverride()
        : null;
    const base =
      bio && zone !== "cave" ? bio : (C.SPAWN && C.SPAWN[zone]) || [];
    if (zone === "night" && bloodMoon) return BLOOD_MOON_TABLE;
    const extra = (EXTRA_SPAWN[zone] || []).filter((entry) => {
      const def = TC.ENEMY_DEFS[entry[0]];
      if (def && def.bloodMoonOnly && !bloodMoon) return false;
      const b = surfaceBiome(pcol);
      if (entry[0] === "ice_slime") return b === "snow";
      if (entry[0] === "sand_slime") return b === "desert";
      if (entry[0] === "vulture") return b === "desert";
      if (entry[0] === "jungle_bat") return true; // cave-adjacent jungle bat
      return true;
    });
    return base.concat(extra);
  }

  // ---- factory ----
  function makeEnemy(type, def, x, y) {
    return {
      type,
      def,
      x,
      y,
      w: def.w,
      h: def.h,
      vx: 0,
      vy: 0,
      hp: def.hp,
      maxHp: def.hp,
      facing: 1,
      onGround: false,
      flashTimer: 0,
      touchTimer: 0,
      sitTimer: rand(0.4, 1.2), // slime: pause between hops
      phase: rand(0, Math.PI * 2), // wobble / walk-cycle offset
      jitterTimer: rand(1, 2), // bat: erratic course-change countdown
      orbitDir: Math.random() < 0.5 ? -1 : 1, // bat: which way it circles
      bstate: "hover", // eye_boss: hover | telegraph | dash
      dashTimer: rand(3, 4.5), // eye_boss: seconds until next dash
      servants: 0, // eye_boss: live demon_eye minions
      hitWall: false, // set by collision, read by zombie auto-jump
      fade: 1, // zombies dissolve in daylight
      lastHitSwing: 0,
      atkTimer: rand(2.5, 4.5), // harpy dive / hand lunge / wof spawn countdown
      astate: "idle", // generic attack sub-state (harpy/hand/wof)
      dir: 1, // wof travel direction (+1 = right)
    };
  }

  // flyers ignore gravity and reflect off solids instead of stopping
  function isFlyer(ai) {
    return (
      ai === "eye" ||
      ai === "bat" ||
      ai === "eye_boss" ||
      ai === "harpy" ||
      ai === "skeletron" ||
      ai === "skele_hand" ||
      ai === "hungry" ||
      ai === "wof"
    );
  }

  // ---- physics: integrate with tile collision (flyers reflect instead of stopping) ----
  function moveAndCollide(e, dt) {
    e.hitWall = false;
    const w = TC.world;
    if (!w || typeof w.isSolid !== "function") {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      return;
    }
    const ts = TC.CONST.TS;
    const flyer = isFlyer(e.def.ai);
    const bounce = flyer
      ? e.def.ai === "bat"
        ? 0.6
        : e.def.ai === "eye_boss"
          ? 0.4
          : 0.5
      : 0;

    // horizontal
    let nx = e.x + e.vx * dt;
    if (rectSolid(nx, e.y, e.w, e.h)) {
      if (e.vx > 0) nx = Math.floor((nx + e.w) / ts) * ts - e.w - 0.01;
      else nx = (Math.floor(nx / ts) + 1) * ts + 0.01;
      if (rectSolid(nx, e.y, e.w, e.h)) nx = e.x;
      if (flyer) e.vx = -e.vx * bounce;
      else {
        e.hitWall = true;
        e.vx = 0;
      }
    }
    e.x = nx;

    // vertical
    let ny = e.y + e.vy * dt;
    e.onGround = false;
    if (rectSolid(e.x, ny, e.w, e.h)) {
      if (e.vy > 0) {
        ny = Math.floor((ny + e.h) / ts) * ts - e.h - 0.01;
        e.onGround = true;
      } else {
        ny = (Math.floor(ny / ts) + 1) * ts + 0.01;
      }
      if (rectSolid(e.x, ny, e.w, e.h)) ny = e.y;
      if (flyer) e.vy = -e.vy * bounce;
      else e.vy = 0;
    }
    e.y = ny;

    // keep inside the world
    const maxX = w.width * ts - e.w,
      maxY = w.height * ts - e.h;
    e.x = clamp(e.x, 0, Math.max(0, maxX));
    e.y = clamp(e.y, 0, Math.max(0, maxY));
  }

  // ---- AI; returns false when the enemy should be removed this frame ----
  function runAI(e, dt) {
    const p = TC.player;
    const ecx = e.x + e.w / 2,
      ecy = e.y + e.h / 2;
    const pcx = p ? p.x + p.w / 2 : ecx;
    const pcy = p ? p.y + p.h / 2 : ecy;

    switch (e.def.ai) {
      case "slime": {
        if (e.onGround) {
          e.vx = approach(e.vx, 0, 10, dt);
          e.sitTimer -= dt;
          if (e.sitTimer <= 0 && p && !p.dead) {
            const dir = pcx >= ecx ? 1 : -1;
            e.facing = dir;
            e.vx = dir * rand(60, 120);
            e.vy = -rand(280, 360);
            e.sitTimer = rand(0.9, 1.8);
          }
        }
        return true;
      }

      case "zombie": {
        if (daylight() > 0.5) {
          e.fade -= dt * 0.8; // dissolve in sunlight
          e.vx = approach(e.vx, 0, 10, dt);
          return e.fade > 0;
        }
        e.fade = 1;
        if (p && !p.dead) {
          const dir = pcx >= ecx ? 1 : -1;
          e.facing = dir;
          e.vx = approach(e.vx, dir * 55, 8, dt);
          if (e.onGround && e.hitWall) e.vy = -330; // auto-jump obstacles
        } else {
          e.vx = approach(e.vx, 0, 4, dt);
        }
        return true;
      }

      case "eye": {
        e.phase += dt * 3.2;
        if (p && !p.dead) {
          const dx = pcx - ecx,
            dy = pcy - ecy;
          const d = Math.hypot(dx, dy) || 1;
          const ACC = 340;
          e.vx += (dx / d) * ACC * dt;
          e.vy += (dy / d) * ACC * dt;
          // sine wobble: perpendicular acceleration gives weaving flight
          const wob = Math.sin(e.phase) * 240 * dt;
          e.vx += (-dy / d) * wob;
          e.vy += (dx / d) * wob;
          const sp = Math.hypot(e.vx, e.vy);
          if (sp > 170) {
            e.vx *= 170 / sp;
            e.vy *= 170 / sp;
          }
        } else {
          e.vx = approach(e.vx, 0, 1.5, dt);
          e.vy = approach(e.vy, 0, 1.5, dt);
        }
        e.facing = e.vx >= 0 ? 1 : -1;
        return true;
      }

      case "bat": {
        e.phase += dt * 5.5;
        e.jitterTimer -= dt;
        if (e.jitterTimer <= 0) {
          // sudden erratic course change
          e.jitterTimer = rand(1, 2);
          const ja = Math.random() * Math.PI * 2;
          e.vx += Math.cos(ja) * rand(50, 110);
          e.vy += Math.sin(ja) * rand(50, 110);
        }
        if (p && !p.dead) {
          // chase a point circling the player, sine-weaved on both axes
          const oa = clock * 1.8 * e.orbitDir + e.phase * 0.3;
          const orbR = 56 + Math.sin(e.phase * 0.9) * 26;
          const gx = pcx + Math.cos(oa) * orbR;
          const gy =
            pcy + Math.sin(oa) * orbR * 0.6 + Math.sin(e.phase * 1.7) * 14;
          const dx = gx - ecx,
            dy = gy - ecy;
          const d = Math.hypot(dx, dy) || 1;
          e.vx += (dx / d) * 320 * dt;
          e.vy += (dy / d) * 320 * dt;
        } else {
          e.vx = approach(e.vx, 0, 1.2, dt);
          e.vy = approach(e.vy, 0, 1.2, dt);
        }
        const bsp = Math.hypot(e.vx, e.vy);
        if (bsp > 140) {
          e.vx *= 140 / bsp;
          e.vy *= 140 / bsp;
        }
        e.facing = e.vx >= 0 ? 1 : -1;
        return true;
      }

      case "eye_boss": {
        if (!e.phase2 && e.hp <= e.maxHp * 0.5) {
          // rage at half health
          e.phase2 = true;
          e.bstate = "hover";
          e.dashTimer = Math.max(e.dashTimer, 1.2);
          if (TC.Particles) {
            TC.Particles.burst(ecx, ecy, 26, {
              colors: [e.def.color, "#ff3040"],
              speed: 170,
              life: 0.7,
              size: 3,
              gravity: 0,
            });
          }
        }
        const spdMul = e.phase2 ? 1.3 : 1;

        if (e.bstate === "telegraph") {
          // shudder in place, then lock onto where the player stands
          e.teleTimer -= dt;
          e.vx = approach(e.vx, 0, 14, dt);
          e.vy = approach(e.vy, 0, 14, dt);
          if (e.teleTimer <= 0) {
            const dx = pcx - ecx,
              dy = pcy - ecy;
            const d = Math.hypot(dx, dy) || 1;
            e.dashDx = dx / d;
            e.dashDy = dy / d;
            e.dashLeft = 20 * TC.CONST.TS;
            e.bstate = "dash";
          }
          return true;
        }

        if (e.bstate === "dash") {
          // velocity opposed to the locked direction means we just bounced
          if (e.vx * e.dashDx + e.vy * e.dashDy < 0) {
            e.bstate = "hover";
            e.dashTimer = e.phase2 ? rand(1.5, 2.25) : rand(3, 4.5);
          } else {
            e.vx = e.dashDx * 420;
            e.vy = e.dashDy * 420;
            e.dashLeft -= 420 * dt;
            if (e.dashLeft <= 0) {
              e.bstate = "hover";
              e.dashTimer = e.phase2 ? rand(1.5, 2.25) : rand(3, 4.5);
            }
          }
          e.facing = e.vx >= 0 ? 1 : -1;
          return true;
        }

        // hover: drift to a spot roughly overhead, 12-16 tiles up
        e.dashTimer -= dt;
        const hx = pcx + Math.sin(clock * 0.6 + e.phase) * 30 - e.w / 2;
        const hy =
          pcy -
          (e.hoverH || 14 * TC.CONST.TS) +
          Math.sin(clock * 1.05 + e.phase) * 12 -
          e.h / 2;
        const dx = hx - e.x,
          dy = hy - e.y;
        const d = Math.hypot(dx, dy) || 1;
        e.vx += (dx / d) * 240 * dt;
        e.vy += (dy / d) * 240 * dt;
        const hsp = Math.hypot(e.vx, e.vy);
        const hmax = 110 * spdMul;
        if (hsp > hmax) {
          e.vx *= hmax / hsp;
          e.vy *= hmax / hsp;
        }
        e.facing = pcx >= ecx ? 1 : -1;

        // phase 2: shed servant eyes every ~5 s, max 3 alive per boss
        if (e.phase2 && p && !p.dead) {
          e.summonTimer -= dt;
          if (e.summonTimer <= 0) {
            e.summonTimer = rand(4.5, 5.5);
            const n = 1 + (Math.random() < 0.5 ? 1 : 0);
            for (let k = 0; k < n && e.servants < 3; k++)
              spawnServantOf(e, "demon_eye", ecx, ecy);
          }
        }

        if (e.dashTimer <= 0 && p && !p.dead) {
          e.bstate = "telegraph";
          e.teleTimer = 0.5;
        }
        return true;
      }

      case "walker": {
        // daylight-immune ground chaser (skeleton / granite golem / blood
        // crawler), tuned by def.speed / def.jumpVel
        if (p && !p.dead) {
          const dir = pcx >= ecx ? 1 : -1;
          e.facing = dir;
          e.vx = approach(e.vx, dir * (e.def.speed || 55), 8, dt);
          if (e.onGround && e.hitWall) e.vy = -(e.def.jumpVel || 330);
        } else {
          e.vx = approach(e.vx, 0, 4, dt);
        }
        // granite golem: ground-slam shockwave when the player is close
        if (e.def.look === "golem") {
          e.atkTimer -= dt;
          if (
            e.atkTimer <= 0 &&
            p &&
            !p.dead &&
            Math.abs(pcx - ecx) < 3 * TC.CONST.TS &&
            Math.abs(pcy - ecy) < 2.5 * TC.CONST.TS
          ) {
            e.atkTimer = rand(2.5, 4);
            if (TC.Combat && typeof TC.Combat.shockwave === "function") {
              TC.Combat.shockwave(
                ecx,
                e.y + e.h,
                3.2 * TC.CONST.TS,
                e.def.dmg,
                260,
              );
            }
          }
        }
        return true;
      }

      case "harpy": {
        // circles overhead, then telegraphs and dive-bombs through the player
        e.atkTimer -= dt;
        if (e.astate === "dive") {
          e.diveLeft -= dt;
          if (e.diveLeft <= 0) {
            e.astate = "idle";
            e.atkTimer = rand(2.5, 4);
          }
          return true;
        }
        if (e.astate === "telegraph") {
          e.teleTimer -= dt;
          e.vx = approach(e.vx, 0, 10, dt);
          e.vy = approach(e.vy, 0, 10, dt);
          if (e.teleTimer <= 0) {
            const dx = pcx - ecx,
              dy = pcy - ecy;
            const d = Math.hypot(dx, dy) || 1;
            e.vx = (dx / d) * 330;
            e.vy = (dy / d) * 330;
            e.diveLeft = 0.8;
            e.astate = "dive";
          }
          return true;
        }
        e.phase += dt * 4;
        if (p && !p.dead) {
          const oa = clock * 1.3 * e.orbitDir + e.phase * 0.3;
          const orbR = 90 + Math.sin(e.phase) * 20;
          const gx = pcx + Math.cos(oa) * orbR;
          const gy = pcy - 70 + Math.sin(oa) * orbR * 0.35;
          const dx = gx - ecx,
            dy = gy - ecy;
          const d = Math.hypot(dx, dy) || 1;
          e.vx += (dx / d) * 300 * dt;
          e.vy += (dy / d) * 300 * dt;
        } else {
          e.vx = approach(e.vx, 0, 1.2, dt);
          e.vy = approach(e.vy, 0, 1.2, dt);
        }
        const hsp = Math.hypot(e.vx, e.vy);
        if (hsp > 130) {
          e.vx *= 130 / hsp;
          e.vy *= 130 / hsp;
        }
        e.facing = e.vx >= 0 ? 1 : -1;
        if (e.atkTimer <= 0 && p && !p.dead) {
          e.astate = "telegraph";
          e.teleTimer = 0.45;
        }
        return true;
      }

      case "king_slime": {
        if (!e.phase2 && e.hp <= e.maxHp * 0.5) {
          // rage at half health
          e.phase2 = true;
          if (TC.Particles) {
            TC.Particles.burst(ecx, ecy, 24, {
              colors: [e.def.color, "#ffffff"],
              speed: 160,
              life: 0.7,
              size: 3,
              gravity: 300,
            });
          }
        }
        if (e.onGround) {
          e.vx = approach(e.vx, 0, 6, dt);
          e.sitTimer -= dt;
          if (e.sitTimer <= 0 && p && !p.dead) {
            const dir = pcx >= ecx ? 1 : -1;
            e.facing = dir;
            // hop force scales with distance: far player means a huge leap
            const far = clamp(Math.abs(pcx - ecx) / (14 * TC.CONST.TS), 0, 1);
            e.vx = dir * (110 + 190 * far);
            e.vy = -(300 + 260 * far) * (e.phase2 ? 1.15 : 1);
            e.sitTimer = e.phase2 ? rand(0.5, 0.9) : rand(1.0, 1.6);
          }
        }
        // phase 2: shed servant slimes every ~6 s, max 2 alive
        if (e.phase2 && p && !p.dead) {
          e.summonTimer -= dt;
          if (e.summonTimer <= 0) {
            e.summonTimer = rand(5.5, 6.5);
            if (e.servants < 2) spawnServantOf(e, "blue_slime", ecx, ecy);
          }
        }
        return true;
      }

      case "skeletron": {
        // track living hands; the skull is heavily armored while any survive
        const parts = e.parts || [];
        let handsAlive = 0;
        for (let k = 0; k < parts.length; k++)
          if (parts[k] && parts[k].hp > 0) handsAlive++;
        e.handsAlive = handsAlive;

        if (!e.phase2 && (e.hp <= e.maxHp * 0.5 || handsAlive === 0)) {
          e.phase2 = true; // enraged once exposed or hurt
          e.bstate = "hover";
          e.dashTimer = Math.max(e.dashTimer, 1.0);
          if (TC.Particles) {
            TC.Particles.burst(ecx, ecy, 26, {
              colors: [e.def.color, "#ffd24a"],
              speed: 170,
              life: 0.7,
              size: 3,
              gravity: 0,
            });
          }
        }
        const spdMul = (e.phase2 ? 1.25 : 1) * (handsAlive === 0 ? 1.15 : 1);

        if (e.bstate === "telegraph") {
          e.teleTimer -= dt;
          e.vx = approach(e.vx, 0, 12, dt);
          e.vy = approach(e.vy, 0, 12, dt);
          if (e.teleTimer <= 0) {
            const dx = pcx - ecx,
              dy = pcy - ecy;
            const d = Math.hypot(dx, dy) || 1;
            e.dashDx = dx / d;
            e.dashDy = dy / d;
            e.dashLeft = 18 * TC.CONST.TS;
            e.spin = true;
            e.bstate = "dash";
          }
          return true;
        }

        if (e.bstate === "dash") {
          const done = e.vx * e.dashDx + e.vy * e.dashDy < 0;
          const DSP = 400 * spdMul;
          if (done || e.dashLeft <= 0) {
            e.bstate = "hover";
            e.spin = false;
            e.dashTimer = e.phase2 ? rand(1.4, 2.1) : rand(2.6, 3.8);
          } else {
            e.vx = e.dashDx * DSP;
            e.vy = e.dashDy * DSP;
            e.dashLeft -= DSP * dt;
          }
          e.facing = e.vx >= 0 ? 1 : -1;
          return true;
        }

        // hover: drift to a spot roughly overhead
        e.dashTimer -= dt;
        const hx = pcx + Math.sin(clock * 0.7 + e.phase) * 40 - e.w / 2;
        const hy =
          pcy -
          11 * TC.CONST.TS +
          Math.sin(clock * 1.1 + e.phase) * 10 -
          e.h / 2;
        const dx = hx - e.x,
          dy = hy - e.y;
        const d = Math.hypot(dx, dy) || 1;
        e.vx += (dx / d) * 230 * dt;
        e.vy += (dy / d) * 230 * dt;
        const hsp = Math.hypot(e.vx, e.vy);
        const hmax = 100 * spdMul;
        if (hsp > hmax) {
          e.vx *= hmax / hsp;
          e.vy *= hmax / hsp;
        }
        e.facing = pcx >= ecx ? 1 : -1;
        if (e.dashTimer <= 0 && p && !p.dead) {
          e.bstate = "telegraph";
          e.teleTimer = 0.45;
        }
        return true;
      }

      case "skele_hand": {
        // orbits its head on a fixed side, periodically lunging at the player
        const m = e.master;
        if (!m || m.hp <= 0) return true; // removed with the head
        const mcx = m.x + m.w / 2,
          mcy = m.y + m.h / 2;
        e.atkTimer -= dt;
        if (e.astate === "windup") {
          e.teleTimer -= dt;
          e.vx = approach(e.vx, 0, 8, dt);
          e.vy = approach(e.vy, 0, 8, dt);
          if (e.teleTimer <= 0) {
            const dx = pcx - ecx,
              dy = pcy - ecy;
            const d = Math.hypot(dx, dy) || 1;
            e.vx = (dx / d) * 300;
            e.vy = (dy / d) * 300;
            e.lungeLeft = 0.7;
            e.astate = "lunge";
          }
          return true;
        }
        if (e.astate === "lunge") {
          e.lungeLeft -= dt;
          if (e.lungeLeft <= 0) {
            e.astate = "orbit";
            e.atkTimer = rand(2.2, 3.6);
          }
          return true;
        }
        const side = e.side || 1;
        const oa = clock * 1.6 * side + (side > 0 ? 0 : Math.PI);
        const orbR = 60 + Math.sin(clock * 2 + e.phase) * 8;
        const gx = mcx + Math.cos(oa) * orbR;
        const gy = mcy + Math.sin(oa) * orbR * 0.8;
        const dx = gx - ecx,
          dy = gy - ecy;
        const d = Math.hypot(dx, dy) || 1;
        e.vx += (dx / d) * 420 * dt;
        e.vy += (dy / d) * 420 * dt;
        const sp = Math.hypot(e.vx, e.vy);
        if (sp > 220) {
          e.vx *= 220 / sp;
          e.vy *= 220 / sp;
        }
        e.facing = e.vx >= 0 ? 1 : -1;
        if (e.atkTimer <= 0 && p && !p.dead) {
          e.astate = "windup";
          e.teleTimer = 0.4;
        }
        return true;
      }

      case "wof": {
        // stub: a relentless wall that slides toward the player, speeding up
        // as it takes damage; sheds hungry servants; bounces off world edges
        if (!e.phase2 && e.hp <= e.maxHp * 0.5) e.phase2 = true;
        const rage = 1 - e.hp / e.maxHp; // 0..1
        e.vx = e.dir * (55 + 95 * rage);
        if (p && !p.dead) {
          // trail the player's height band
          const targetY = p.y + p.h / 2 - e.h / 2;
          e.vy = approach(e.vy, clamp((targetY - e.y) * 1.2, -60, 60), 3, dt);
        }
        const w = TC.world;
        if (w) {
          if (e.x <= 2) e.dir = 1;
          if (e.x + e.w >= w.width * TC.CONST.TS - 2) e.dir = -1;
        }
        e.facing = e.dir;
        if (p && !p.dead) {
          // shed hungries, max 3 alive
          e.summonTimer -= dt;
          if (e.summonTimer <= 0) {
            e.summonTimer = rand(6, 8);
            if (e.servants < 3)
              spawnServantOf(
                e,
                "hungry",
                ecx + rand(-20, 20),
                ecy + rand(-40, 40),
              );
          }
        }
        return true;
      }

      default:
        return true;
    }
  }

  // ---- damage / death ----
  // Roll a dead enemy's loot table and scatter the results at (cx,cy).
  // def.drops is the single loot source: entries {id,min,max,chance} with
  // chance defaulting to 1; contents and probabilities live in ENEMY_DEFS.
  // def.coins [minCopper,maxCopper] (W2 economy) scatters canonical currency
  // through TC.Economy.dropCoins.
  function rollDrops(e, cx, cy) {
    const drops = e.def.drops || [];
    for (let k = 0; k < drops.length; k++) {
      const d = drops[k];
      if (Math.random() >= (d.chance == null ? 1 : d.chance)) continue;
      const n = d.min + Math.floor(Math.random() * (d.max - d.min + 1));
      if (n > 0 && TC.Items && typeof TC.Items.spawnDrop === "function") {
        TC.Items.spawnDrop(cx, cy, d.id, n, true);
      }
    }
    const coins = e.def.coins;
    if (Array.isArray(coins) && coins.length >= 2) {
      const amount =
        coins[0] + Math.floor(Math.random() * (coins[1] - coins[0] + 1));
      if (
        amount > 0 &&
        TC.Economy &&
        typeof TC.Economy.dropCoins === "function"
      ) {
        TC.Economy.dropCoins(cx, cy, amount);
      }
    }
  }

  function damageEnemy(e, dmg, dir, power, crit) {
    if (!e || e.hp <= 0) return;
    // def.defense absorbs flat damage; Skeletron's skull takes 65% less while
    // either hand is still alive (kill the hands to expose it)
    let final = dmg;
    if (e.def.ai === "skeletron" && e.handsAlive > 0) final *= 0.35;
    final = Math.max(1, Math.round(final - (e.def.defense || 0)));
    e.hp -= final;
    if (TC.Events) {
      try {
        TC.Events.emit(TC.Events.EVENT.EntityDamaged, {
          type: e.type,
          dmg: final,
          crit: !!crit,
          hp: e.hp,
        });
      } catch (err) {}
    }
    e.flashTimer = FLASH_TIME;
    const resist = 1 - (e.def.kbResist || 0);
    if (resist > 0) {
      e.vx += dir * power * 30 * resist;
      e.vy =
        e.def.ai === "eye"
          ? e.vy - power * 8 * resist
          : Math.min(e.vy, -power * 12 * resist);
    }
    const cx = e.x + e.w / 2;
    if (TC.Particles) {
      TC.Particles.floatText(
        cx,
        e.y - 6,
        final,
        crit ? TC.CONST.COLORS.crit : TC.CONST.COLORS.dealt,
        crit ? 18 : 13,
      );
    }
    if (TC.Audio) TC.Audio.play("hit");
    if (e.hp <= 0) killEnemy(e);
  }

  function killEnemy(e) {
    const i = list.indexOf(e);
    if (i >= 0) list.splice(i, 1);
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2;
    if (TC.Events) {
      try {
        TC.Events.emit(TC.Events.EVENT.EntityKilled, {
          type: e.type,
          x: cx,
          y: cy,
          boss: !!e.def.boss,
        });
      } catch (err) {}
      if (e.def.boss) {
        try {
          TC.Events.emit(TC.Events.EVENT.BossDefeated, { type: e.type });
        } catch (err2) {}
      }
    }
    if (TC.Particles) {
      if (e.def.boss) {
        TC.Particles.burst(cx, cy, 60, {
          colors: [e.def.color, "#ffffff", "#ff3040"],
          speed: 260,
          life: 1.1,
          size: 4,
          gravity: 220,
        });
      } else {
        TC.Particles.burst(cx, cy, 14, {
          colors: [e.def.color, "#ffffff"],
          speed: 110,
          life: 0.55,
          size: 3,
          gravity: 650,
        });
      }
    }
    if (e.master && e.master.servants > 0) e.master.servants--;
    // a fallen boss takes its servants with it
    if (e.def.boss) {
      for (let k = TC.Enemies.list.length - 1; k >= 0; k--) {
        const s = TC.Enemies.list[k];
        if (s !== e && s.master === e) {
          if (TC.Particles && typeof TC.Particles.burst === "function") {
            try {
              TC.Particles.burst(s.x + s.w / 2, s.y + s.h / 2, 8, {
                colors: [s.def.color, "#ffffff"],
                speed: 90,
                life: 0.4,
                size: 2.5,
                gravity: 500,
              });
            } catch (err) {}
          }
          TC.Enemies.list.splice(k, 1);
        }
      }
    }
    rollDrops(e, cx, cy);
    // blood moon bounty: non-boss kills shed extra blood shards
    if (
      bloodMoon &&
      !e.def.boss &&
      !e.def.part &&
      Math.random() < (e.def.bloodShard == null ? 0.4 : e.def.bloodShard) &&
      TC.Items &&
      typeof TC.Items.spawnDrop === "function"
    ) {
      TC.Items.spawnDrop(
        cx,
        cy,
        "blood_shard",
        1 + (Math.random() < 0.4 ? 1 : 0),
        true,
      );
    }
    if (e.def.boss && TC.UI && typeof TC.UI.toast === "function") {
      TC.UI.toast(e.def.name + " has been defeated!");
    }
  }

  // ---- spawning ----
  // Find a placement (world px) near tile (tx,ty). Ground walkers scan down from
  // min(surfaceY, ty) up to 12 tiles for `need` free tiles above solid ground;
  // flyers just need an open-air box.
  function findSpot(def, tx, ty, surf) {
    const w = TC.world;
    const ts = TC.CONST.TS;
    const need = Math.ceil(def.h / ts);

    if (isFlyer(def.ai)) {
      for (let ky = 0; ky < need; ky++)
        for (let kx = 0; kx < need; kx++)
          if (solidAt(tx + kx, ty + ky)) return null;
      return { x: tx * ts + (ts - def.w) / 2, y: ty * ts };
    }

    const x = tx * ts + (ts - def.w) / 2;
    const start = Math.min(surf, ty);
    for (let i = 0; i < 12; i++) {
      const gy = start + i + need; // row that must be solid ground
      if (gy >= w.height) break;
      const y = gy * ts - def.h;
      if (rectSolid(x, y, def.w, def.h)) continue;
      // ground must support the middle of the body
      if (!solidAt(Math.floor((x + def.w / 2) / ts), gy)) continue;
      return { x, y };
    }
    return null;
  }

  function spawnDirector(dt) {
    spawnTimer -= dt;
    if (spawnTimer > 0) return;
    const p = TC.player,
      w = TC.world;
    if (!p || p.dead || !w) {
      spawnTimer = 0.5;
      return;
    }

    const C = TC.CONST,
      ts = C.TS;
    const dl = daylight();
    const pcol = clamp(Math.floor((p.x + p.w / 2) / ts), 0, w.width - 1);
    const surf = w.surfaceY ? w.surfaceY[pcol] : 0;
    const feetTy = (p.y + p.h) / ts;

    let zone;
    if (feetTy > surf + 15) zone = "cave";
    else if (dl > 0.5) zone = "day";
    else zone = "night";

    const key = "attempt" + zone.charAt(0).toUpperCase() + zone.slice(1);
    // blood moon: night spawn attempts roll 3x as often; progression adds a
    // small global rate bonus per defeated boss (default 1x when absent)
    let rate = zone === "night" && bloodMoon ? 3 : 1;
    if (
      TC.Progression &&
      typeof TC.Progression.spawnMultiplier === "function"
    ) {
      rate *= TC.Progression.spawnMultiplier();
    }
    spawnTimer = (C.SPAWN[key] || 2) / rate;

    if (list.length >= C.MAX_ENEMIES) return;
    const table = zoneTable(zone, pcol);
    if (!table || !table.length) return;

    const type = weightedPick(table);
    const def = TC.ENEMY_DEFS[type];
    if (!def) return;

    const prow = (p.y + p.h / 2) / ts;
    for (let attempt = 0; attempt < 14; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = rand(C.ENEMY_MIN_DIST, C.ENEMY_MAX_DIST);
      const tx = clamp(Math.round(pcol + Math.cos(ang) * dist), 1, w.width - 2);
      const ty = clamp(
        Math.round(prow + Math.sin(ang) * dist),
        1,
        w.height - 2,
      );
      const spot = findSpot(def, tx, ty, surf);
      if (spot) {
        list.push(makeEnemy(type, def, spot.x, spot.y));
        return;
      }
    }
  }

  // ---- boss summoning ----
  // Shed a servant of `type` beside the boss in free space. Links it to the
  // boss (dies with the boss, tracked via boss.servants). Returns the enemy.
  function spawnServantOf(boss, type, bx, by) {
    const def = TC.ENEMY_DEFS && TC.ENEMY_DEFS[type];
    if (!def) return null;
    for (let t = 0; t < 6; t++) {
      const x = bx + rand(-56, 24),
        y = by + rand(-56, 24);
      if (rectSolid(x, y, def.w, def.h)) continue;
      const s = makeEnemy(type, def, x, y);
      s.master = boss;
      boss.servants++;
      list.push(s);
      if (TC.Particles) {
        TC.Particles.burst(x + def.w / 2, y + def.h / 2, 8, {
          colors: [def.color, "#ffffff"],
          speed: 90,
          life: 0.4,
          size: 2,
          gravity: 0,
        });
      }
      return s;
    }
    return null;
  }

  // Summon boss `type` at (x,y) at full hp. Returns the enemy, or null when
  // MAX_BOSSES bosses already live (or the type is not a boss).
  // Special case: type '__blood_moon__' (blood_sigil item) starts the Blood
  // Moon event instead of spawning anything.
  function spawnBoss(type, x, y) {
    if (type === "__blood_moon__") {
      setBloodMoon(true);
      return null;
    }
    const def = TC.ENEMY_DEFS ? TC.ENEMY_DEFS[type] : null;
    if (!def || !def.boss) return null;
    let bosses = 0;
    for (let i = 0; i < list.length; i++)
      if (list[i].def && list[i].def.boss) bosses++;
    if (bosses >= (TC.CONST.MAX_BOSSES || 1)) return null;
    const p = TC.player;
    if (typeof x !== "number" || !isFinite(x))
      x = p ? p.x + p.w / 2 - def.w / 2 : 0;
    if (typeof y !== "number" || !isFinite(y))
      y = p ? p.y - def.h - 14 * TC.CONST.TS : 0;
    const e = makeEnemy(type, def, x, y);
    e.hoverH = rand(12, 16) * TC.CONST.TS; // preferred altitude above the player
    e.summonTimer = 5;

    if (type === "king_slime") {
      e.sitTimer = 1; // brief pause before the first hop
      e.summonTimer = 6;
    } else if (type === "skeletron") {
      // attach a hand to each side; parts persist but never count as bosses
      e.parts = [];
      e.dashTimer = 2.5;
      e.summonTimer = 4;
      for (let s = -1; s <= 1; s += 2) {
        const hdef = TC.ENEMY_DEFS.skele_hand;
        const h = makeEnemy(
          "skele_hand",
          hdef,
          x + s * (def.w / 2 + hdef.w),
          y + 10,
        );
        h.master = e;
        h.side = s;
        e.parts.push(h);
        list.push(h);
      }
    } else if (type === "wof") {
      // slide in from whichever side the player is closer to
      e.dir = p && p.x + p.w / 2 >= x + def.w / 2 ? 1 : -1;
      e.summonTimer = 7;
    }

    list.push(e);
    if (TC.Particles) {
      TC.Particles.burst(x + def.w / 2, y + def.h / 2, 30, {
        colors: [def.color, "#ffffff"],
        speed: 200,
        life: 0.8,
        size: 3,
        gravity: 0,
      });
    }
    if (TC.UI && typeof TC.UI.toast === "function") {
      TC.UI.toast(def.name + " has awoken!");
    }
    return e;
  }

  // ---- per-frame update ----
  function update(dt) {
    clock += dt;
    const p = TC.player;

    // blood moon lifecycle: ~1-in-8 roll at dusk, always ends at dawn
    const dl = daylight();
    if (prevDaylight >= 0.5 && dl < 0.5) bmRolledTonight = false; // dusk
    if (dl < 0.5) {
      if (!bmRolledTonight) {
        bmRolledTonight = true;
        if (!bloodMoon && Math.random() < 0.125) setBloodMoon(true);
      }
    } else if (bloodMoon) {
      setBloodMoon(false); // dawn
    }
    prevDaylight = dl;

    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];

      // despawn far from the player (bosses and boss parts persist)
      if (p && !e.def.boss && !e.def.part) {
        const dx = (e.x + e.w / 2 - (p.x + p.w / 2)) / TC.CONST.TS;
        const dy = (e.y + e.h / 2 - (p.y + p.h / 2)) / TC.CONST.TS;
        const max = TC.CONST.ENEMY_DESPAWN_DIST;
        if (dx * dx + dy * dy > max * max) {
          if (e.master && e.master.servants > 0) e.master.servants--;
          list.splice(i, 1);
          continue;
        }
      }

      e.flashTimer = Math.max(0, e.flashTimer - dt);
      e.touchTimer = Math.max(0, e.touchTimer - dt);

      if (runAI(e, dt) === false) {
        list.splice(i, 1);
        continue;
      }

      if (!isFlyer(e.def.ai)) {
        e.vy = Math.min(e.vy + TC.CONST.GRAVITY * dt, TC.CONST.MAX_FALL);
      }
      moveAndCollide(e, dt);

      // contact damage
      if (
        p &&
        !p.dead &&
        e.fade >= 1 &&
        e.touchTimer <= 0 &&
        e.x < p.x + p.w &&
        e.x + e.w > p.x &&
        e.y < p.y + p.h &&
        e.y + e.h > p.y &&
        TC.Combat &&
        typeof TC.Combat.hurtPlayer === "function"
      ) {
        const dir = p.x + p.w / 2 >= e.x + e.w / 2 ? 1 : -1;
        TC.Combat.hurtPlayer(
          e.def.dmg,
          dir * TOUCH_KB_X,
          TOUCH_KB_Y,
          e.def.name,
        );
        e.touchTimer = TC.CONST.ENEMY_TOUCH_COOLDOWN;
      }
    }
  }

  // ---- drawing (world-space) ----
  function drawSlime(c, e) {
    const w = e.w,
      h = e.h;
    // squish factor from vertical speed; idle breathing when settled
    const k = e.onGround
      ? Math.sin(clock * 2.2 + e.phase) * 0.05
      : clamp(Math.abs(e.vy) / 1400, 0, 0.28);
    const f = e.facing || 1;
    c.save();
    c.translate(e.x + w / 2, e.y + h);
    c.scale(1 - k * 0.7, 1 + k);

    // translucent rounded blob with a flat bottom
    const hw = w / 2;
    c.fillStyle = hexA(e.def.color, 0.78);
    c.beginPath();
    c.moveTo(-hw, 0);
    c.lineTo(hw, 0);
    c.quadraticCurveTo(hw + 1, -h * 0.55, hw * 0.55, -h * 0.85);
    c.quadraticCurveTo(0, -h * 1.08, -hw * 0.55, -h * 0.85);
    c.quadraticCurveTo(-hw - 1, -h * 0.55, -hw, 0);
    c.closePath();
    c.fill();

    // glossy highlight
    c.fillStyle = "rgba(255,255,255,0.28)";
    c.beginPath();
    c.ellipse(-hw * 0.35, -h * 0.68, hw * 0.28, h * 0.16, -0.5, 0, Math.PI * 2);
    c.fill();

    // eyes, shifted toward facing
    c.fillStyle = "rgba(8,28,12,0.9)";
    c.fillRect(f * 2 - w * 0.17, -h * 0.52, 3, 4);
    c.fillRect(f * 2 + w * 0.07, -h * 0.52, 3, 4);
    c.restore();
  }

  function drawZombie(c, e) {
    const w = e.w,
      h = e.h,
      x = e.x,
      y = e.y;
    const f = e.facing || 1;
    const skin = e.def.color;
    const walking = Math.abs(e.vx) > 8 && e.onGround;
    const step = walking ? Math.sin(clock * 9 + e.phase) : 0;

    // legs
    c.fillStyle = "#37432c";
    c.fillRect(x + w * 0.12 + step * 3, y + h * 0.62, w * 0.28, h * 0.38);
    c.fillRect(x + w * 0.56 - step * 3, y + h * 0.62, w * 0.28, h * 0.38);

    // torso
    c.fillStyle = "#4d6238";
    c.fillRect(x + w * 0.1, y + h * 0.3, w * 0.8, h * 0.36);
    c.fillStyle = "#2f3d24"; // rot patches
    c.fillRect(x + w * 0.52, y + h * 0.4, w * 0.22, h * 0.1);
    c.fillRect(x + w * 0.16, y + h * 0.54, w * 0.16, h * 0.09);

    // arms reaching forward
    c.fillStyle = skin;
    c.fillRect(
      f === 1 ? x + w * 0.42 : x - w * 0.85 + w * 0.43,
      y + h * 0.33,
      w * 0.85,
      h * 0.12,
    );

    // head
    c.fillRect(x + w * 0.15, y, w * 0.7, h * 0.26);
    c.fillStyle = "#2f3d24";
    c.fillRect(x + w * 0.15, y, w * 0.7, h * 0.06); // matted hair
    c.fillStyle = "#c03030";
    c.fillRect(x + (f === 1 ? w * 0.58 : w * 0.24), y + h * 0.11, 3, 3);
  }

  function drawEye(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      r = e.w / 2;
    const flap = Math.sin(clock * 18 + e.phase);

    // flapping triangle wings
    c.fillStyle = "#7a2323";
    c.beginPath();
    c.moveTo(cx - r * 0.5, cy - r * 0.15);
    c.lineTo(cx - r * 1.65, cy - r * (0.9 + flap * 0.55));
    c.lineTo(cx - r * 0.55, cy + r * 0.35);
    c.moveTo(cx + r * 0.5, cy - r * 0.15);
    c.lineTo(cx + r * 1.65, cy - r * (0.9 + flap * 0.55));
    c.lineTo(cx + r * 0.55, cy + r * 0.35);
    c.closePath();
    c.fill();

    // sclera
    c.fillStyle = "#e8ddce";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.35)";
    c.lineWidth = 1.5;
    c.stroke();

    // iris + pupil track the player
    let tx = e.facing || 1,
      ty = 0;
    const p = TC.player;
    if (p) {
      const dx = p.x + p.w / 2 - cx,
        dy = p.y + p.h / 2 - cy;
      const d = Math.hypot(dx, dy) || 1;
      tx = dx / d;
      ty = dy / d;
    }
    const ir = r * 0.55;
    const icx = cx + tx * r * 0.34,
      icy = cy + ty * r * 0.34;
    c.fillStyle = e.def.color;
    c.beginPath();
    c.arc(icx, icy, ir, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#200a0a";
    c.beginPath();
    c.arc(icx + tx * ir * 0.25, icy + ty * ir * 0.25, ir * 0.5, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.7)";
    c.fillRect(icx - ir * 0.5, icy - ir * 0.55, 2, 2);
  }

  function drawBat(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2;
    const bw = e.w / 2,
      bh = e.h / 2;
    const f = e.facing || 1;
    const flap = Math.sin(clock * 15 + e.phase);

    // scalloped membrane wings
    c.fillStyle = "#4e4236";
    for (let s = -1; s <= 1; s += 2) {
      const tipX = cx + s * bw * (1.5 + flap * 0.15);
      const tipY = cy - bh * (0.2 + flap * 0.7);
      c.beginPath();
      c.moveTo(cx + s * bw * 0.25, cy - bh * 0.15);
      c.quadraticCurveTo(
        cx + s * bw * 0.9,
        cy - bh * (0.55 + flap * 0.4),
        tipX,
        tipY,
      );
      c.quadraticCurveTo(
        cx + s * bw * 1.05,
        cy + bh * (0.1 - flap * 0.25),
        cx + s * bw * 0.68,
        cy + bh * (0.02 - flap * 0.3),
      );
      c.quadraticCurveTo(
        cx + s * bw * 0.46,
        cy + bh * (0.5 - flap * 0.15),
        cx + s * bw * 0.18,
        cy + bh * 0.3,
      );
      c.closePath();
      c.fill();
    }

    // furry body with a pale chest patch
    c.fillStyle = e.def.color;
    c.beginPath();
    c.ellipse(cx, cy, bw * 0.55, bh * 0.85, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(215,195,170,0.3)";
    c.beginPath();
    c.ellipse(cx, cy + bh * 0.28, bw * 0.3, bh * 0.4, 0, 0, Math.PI * 2);
    c.fill();

    // tiny ears
    c.fillStyle = e.def.color;
    c.beginPath();
    c.moveTo(cx - bw * 0.38, cy - bh * 0.5);
    c.lineTo(cx - bw * 0.26, cy - bh * 1.35);
    c.lineTo(cx - bw * 0.08, cy - bh * 0.62);
    c.moveTo(cx + bw * 0.08, cy - bh * 0.62);
    c.lineTo(cx + bw * 0.26, cy - bh * 1.35);
    c.lineTo(cx + bw * 0.38, cy - bh * 0.5);
    c.closePath();
    c.fill();

    // beady eyes, shifted toward travel direction
    c.fillStyle = "#1a1114";
    c.fillRect(cx + f * 1.5 - 3, cy - 2, 2, 2);
    c.fillRect(cx + f * 1.5 + 1, cy - 2, 2, 2);
  }

  function drawEyeBoss(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      r = e.w / 2;
    const p2 = !!e.phase2;

    c.save();
    if (e.bstate === "telegraph") {
      // pre-dash shudder
      c.translate(Math.sin(clock * 62) * 2.6, Math.cos(clock * 47) * 2.2);
    }

    // torn-back membrane tendrils trailing behind the motion
    const sp = Math.hypot(e.vx, e.vy);
    const bx = sp > 20 ? -e.vx / sp : 0,
      by = sp > 20 ? -e.vy / sp : -1;
    c.strokeStyle = hexA("#3d1558", 0.9);
    c.lineWidth = 4;
    c.lineCap = "round";
    for (let i = 0; i < 5; i++) {
      const a = (i - 2) * 0.55;
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const dx = bx * ca - by * sa,
        dy = bx * sa + by * ca; // fanned back dir
      const len = r * (0.5 + 0.16 * ((i * 2.3) % 1));
      const sw = Math.sin(clock * 2.6 + i * 1.9) * r * 0.3;
      c.beginPath();
      c.moveTo(cx + dx * r * 0.88, cy + dy * r * 0.88);
      c.quadraticCurveTo(
        cx + dx * (r * 0.88 + len * 0.5) - dy * sw * 0.5,
        cy + dy * (r * 0.88 + len * 0.5) + dx * sw * 0.5,
        cx + dx * (r * 0.88 + len) - dy * sw,
        cy + dy * (r * 0.88 + len) + dx * sw,
      );
      c.stroke();
    }

    // sclera
    c.fillStyle = "#ddd2c2";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.35)";
    c.lineWidth = 2;
    c.stroke();

    // veins creeping inward from the rim
    c.strokeStyle = p2 ? "rgba(205,40,50,0.65)" : "rgba(170,50,60,0.45)";
    c.lineWidth = 1.6;
    for (let i = 0; i < 7; i++) {
      const wig = Math.sin(clock * 1.4 + i * 2.1) * 0.08;
      let rr = r * 0.97,
        aa = (i / 7) * Math.PI * 2 + e.phase * 0.13;
      c.beginPath();
      c.moveTo(cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr);
      for (let k = 0; k < 3; k++) {
        rr -= r * 0.17;
        aa += wig + (k % 2 ? -0.09 : 0.09);
        c.lineTo(cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr);
      }
      c.stroke();
    }

    // iris + pupil track the player
    let tx = e.facing || 1,
      ty = 0;
    const p = TC.player;
    if (p) {
      const dx = p.x + p.w / 2 - cx,
        dy = p.y + p.h / 2 - cy;
      const d = Math.hypot(dx, dy) || 1;
      tx = dx / d;
      ty = dy / d;
    }
    const ir = r * 0.52;
    const icx = cx + tx * r * 0.3,
      icy = cy + ty * r * 0.3;
    if (p2) {
      // phase 2: pulsing red glow behind the iris
      c.fillStyle = hexA("#ff2038", 0.3 + Math.sin(clock * 6) * 0.1);
      c.beginPath();
      c.arc(icx, icy, ir * 1.45, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = p2 ? "#ad2f52" : e.def.color;
    c.beginPath();
    c.arc(icx, icy, ir, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#1c060c";
    c.beginPath();
    c.arc(
      icx + tx * ir * 0.28,
      icy + ty * ir * 0.28,
      ir * 0.48,
      0,
      Math.PI * 2,
    );
    c.fill();
    c.fillStyle = "rgba(255,255,255,0.75)";
    c.fillRect(icx - ir * 0.5, icy - ir * 0.55, 3, 3);

    if (p2) {
      // faint enraged wash over the whole eye
      c.fillStyle = "rgba(255,40,40,0.1)";
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  function drawKingSlime(c, e) {
    drawSlime(c, e);
    // golden crown perched on top, bobbing with the idle breath
    const cx = e.x + e.w / 2;
    const cy = e.y + 3 + Math.sin(clock * 2.2 + e.phase) * 1.2;
    c.fillStyle = "#ffd24a";
    c.beginPath();
    c.moveTo(cx - 9, cy + 6);
    c.lineTo(cx - 9, cy - 4);
    c.lineTo(cx - 4.5, cy);
    c.lineTo(cx, cy - 6);
    c.lineTo(cx + 4.5, cy);
    c.lineTo(cx + 9, cy - 4);
    c.lineTo(cx + 9, cy + 6);
    c.closePath();
    c.fill();
    c.fillStyle = "#c87137"; // jewel
    c.fillRect(cx - 1.5, cy + 1, 3, 3);
  }

  function drawWalker(c, e) {
    const w = e.w,
      h = e.h,
      x = e.x,
      y = e.y;
    const f = e.facing || 1;
    const walking = Math.abs(e.vx) > 8 && e.onGround;
    const step = walking ? Math.sin(clock * 9 + e.phase) : 0;
    const look = e.def.look;

    if (look === "skeleton") {
      // bones: pale ribcage, spine, dangling arm, skull
      c.strokeStyle = "#d8d2c0";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x + w * 0.35, y + h * 0.55);
      c.lineTo(x + w * 0.3 + step * 3, y + h);
      c.moveTo(x + w * 0.65, y + h * 0.55);
      c.lineTo(x + w * 0.7 - step * 3, y + h);
      c.moveTo(x + w * 0.5, y + h * 0.22);
      c.lineTo(x + w * 0.5, y + h * 0.58);
      c.moveTo(x + w * 0.5, y + h * 0.3);
      c.lineTo(x + w * (f === 1 ? 0.95 : 0.05), y + h * 0.42 + step * 2);
      for (let i = 0; i < 3; i++) {
        const ry = y + h * (0.3 + i * 0.09);
        c.moveTo(x + w * 0.28, ry);
        c.lineTo(x + w * 0.72, ry);
      }
      c.stroke();
      c.fillStyle = "#e4ddca";
      c.fillRect(x + w * 0.22, y, w * 0.56, h * 0.24);
      c.fillStyle = "#1a1a1a";
      c.fillRect(x + (f === 1 ? w * 0.52 : w * 0.26), y + h * 0.09, 3, 3);
      c.fillRect(x + (f === 1 ? w * 0.66 : w * 0.4), y + h * 0.09, 3, 3);
      c.fillStyle = "#b8b2a0";
      c.fillRect(x + w * 0.34, y + h * 0.17, w * 0.32, 2);
    } else if (look === "golem") {
      // bulky stone body with a pulsing energy core
      c.fillStyle = "#5a6874";
      c.fillRect(x + w * 0.1, y + h * 0.25, w * 0.8, h * 0.45);
      c.fillRect(x + w * 0.06 + step * 2, y + h * 0.3, w * 0.2, h * 0.34);
      c.fillRect(x + w * 0.74 - step * 2, y + h * 0.3, w * 0.2, h * 0.34);
      c.fillStyle = "#7a8a96";
      c.fillRect(x + w * 0.16, y + h * 0.62, w * 0.26, h * 0.38);
      c.fillRect(x + w * 0.58, y + h * 0.62, w * 0.26, h * 0.38);
      c.fillRect(x + w * 0.18, y, w * 0.64, h * 0.26);
      c.strokeStyle = "rgba(40,50,60,0.7)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x + w * 0.3, y + h * 0.32);
      c.lineTo(x + w * 0.45, y + h * 0.5);
      c.lineTo(x + w * 0.38, y + h * 0.62);
      c.stroke();
      c.fillStyle = hexA(
        "#8adfff",
        0.55 + Math.sin(clock * 4 + e.phase) * 0.25,
      );
      c.fillRect(x + w * 0.42, y + h * 0.38, w * 0.16, h * 0.14);
      c.fillStyle = "#3a4a56";
      c.fillRect(x + (f === 1 ? w * 0.58 : w * 0.26), y + h * 0.09, 4, 3);
    } else {
      // crawler: low, wide blood spider
      c.strokeStyle = "#701a1a";
      c.lineWidth = 2;
      c.beginPath();
      for (let i = 0; i < 3; i++) {
        const lx = x + w * (0.2 + i * 0.3);
        c.moveTo(lx, y + h * 0.55);
        c.lineTo(lx - 5 + step * 2, y + h);
        c.moveTo(lx + 4, y + h * 0.55);
        c.lineTo(lx + 9 - step * 2, y + h);
      }
      c.stroke();
      c.fillStyle = e.def.color;
      c.beginPath();
      c.ellipse(x + w / 2, y + h * 0.42, w * 0.42, h * 0.42, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#ffd24a";
      c.fillRect(x + w * (f === 1 ? 0.62 : 0.26), y + h * 0.3, 3, 3);
      c.fillRect(x + w * (f === 1 ? 0.72 : 0.16), y + h * 0.42, 3, 3);
    }
  }

  function drawHarpy(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2;
    const bw = e.w / 2,
      bh = e.h / 2;
    const f = e.facing || 1;
    const flap = Math.sin(clock * 10 + e.phase);
    const diving = e.astate === "dive";

    // broad feathered wings
    c.fillStyle = "#8a744a";
    for (let s = -1; s <= 1; s += 2) {
      const tipX = cx + s * bw * (1.7 + flap * 0.2);
      const tipY = cy - bh * (0.4 + flap * 0.9);
      c.beginPath();
      c.moveTo(cx + s * bw * 0.2, cy - bh * 0.2);
      c.quadraticCurveTo(
        cx + s * bw * 1.1,
        cy - bh * (0.7 + flap * 0.5),
        tipX,
        tipY,
      );
      c.quadraticCurveTo(
        cx + s * bw * 1.0,
        cy + bh * (0.2 - flap * 0.3),
        cx + s * bw * 0.5,
        cy + bh * 0.15,
      );
      c.closePath();
      c.fill();
    }

    // tail feathers trail behind travel
    c.fillStyle = "#7a643c";
    c.beginPath();
    c.moveTo(cx - f * bw * 0.4, cy);
    c.lineTo(cx - f * bw * 1.3, cy - bh * 0.3);
    c.lineTo(cx - f * bw * 1.25, cy + bh * 0.35);
    c.closePath();
    c.fill();

    // body tilts forward during a dive
    c.fillStyle = e.def.color;
    c.beginPath();
    c.ellipse(
      cx,
      cy,
      bw * 0.55,
      bh * 0.75,
      diving ? f * 0.5 : 0,
      0,
      Math.PI * 2,
    );
    c.fill();

    // pale head + beak
    c.fillStyle = "#e8d8b8";
    c.beginPath();
    c.arc(cx + f * bw * 0.42, cy - bh * 0.5, bh * 0.34, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#e8a53a";
    c.beginPath();
    c.moveTo(cx + f * bw * 0.62, cy - bh * 0.55);
    c.lineTo(cx + f * bw * 1.0, cy - bh * 0.45);
    c.lineTo(cx + f * bw * 0.62, cy - bh * 0.35);
    c.closePath();
    c.fill();
    c.fillStyle = "#2a1a10";
    c.fillRect(cx + f * bw * 0.48, cy - bh * 0.62, 2, 2);
  }

  function drawSkeletron(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      r = e.w / 2;
    const p2 = !!e.phase2;

    c.save();
    if (e.bstate === "telegraph") {
      // pre-dash shudder
      c.translate(Math.sin(clock * 62) * 2.6, Math.cos(clock * 47) * 2.2);
    }
    if (e.spin) {
      // spin-dash streaks
      c.strokeStyle = "rgba(220,215,195,0.4)";
      c.lineWidth = 3;
      for (let i = 0; i < 4; i++) {
        const a = clock * 18 + (i * Math.PI) / 2;
        c.beginPath();
        c.arc(cx, cy, r * (1.15 + i * 0.08), a, a + 1.1);
        c.stroke();
      }
    }

    // skull dome with squared jaw
    c.fillStyle = p2 ? "#efe8d2" : "#ddd6c2";
    c.beginPath();
    c.arc(cx, cy - r * 0.12, r * 0.82, Math.PI, 0);
    c.quadraticCurveTo(
      cx + r * 0.82,
      cy + r * 0.42,
      cx + r * 0.55,
      cy + r * 0.52,
    );
    c.lineTo(cx - r * 0.55, cy + r * 0.52);
    c.quadraticCurveTo(
      cx - r * 0.82,
      cy + r * 0.42,
      cx - r * 0.82,
      cy - r * 0.12,
    );
    c.closePath();
    c.fill();

    // eye sockets glow red once enraged
    c.fillStyle = p2
      ? hexA("#ff2038", 0.75 + Math.sin(clock * 6) * 0.2)
      : "#1c1814";
    c.beginPath();
    c.ellipse(
      cx - r * 0.36,
      cy - r * 0.16,
      r * 0.22,
      r * 0.27,
      0,
      0,
      Math.PI * 2,
    );
    c.ellipse(
      cx + r * 0.36,
      cy - r * 0.16,
      r * 0.22,
      r * 0.27,
      0,
      0,
      Math.PI * 2,
    );
    c.fill();

    // nose gap
    c.fillStyle = "#1c1814";
    c.beginPath();
    c.moveTo(cx, cy + r * 0.12);
    c.lineTo(cx - r * 0.1, cy + r * 0.3);
    c.lineTo(cx + r * 0.1, cy + r * 0.3);
    c.closePath();
    c.fill();

    // teeth row
    c.fillStyle = "#cfc8b0";
    c.fillRect(cx - r * 0.5, cy + r * 0.52, r, r * 0.22);
    c.strokeStyle = "#8a8474";
    c.lineWidth = 1.5;
    c.beginPath();
    for (let i = 0; i <= 5; i++) {
      const tx = cx - r * 0.5 + (r / 5) * i;
      c.moveTo(tx, cy + r * 0.52);
      c.lineTo(tx, cy + r * 0.74);
    }
    c.stroke();
    c.restore();
  }

  function drawSkeleHand(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2;
    const sp = Math.hypot(e.vx, e.vy);
    // fingers point along motion while flying fast, upright when slow
    const ang = sp > 60 ? Math.atan2(e.vy, e.vx) + Math.PI / 2 : 0;
    c.save();
    c.translate(cx, cy);
    c.rotate(ang);
    c.fillStyle = "#cfc8b8";
    c.fillRect(-4, e.h * 0.1, 8, e.h * 0.45); // forearm
    c.fillRect(-9, -e.h * 0.18, 18, e.h * 0.32); // palm
    c.fillStyle = "#e0dac8";
    for (let i = -2; i <= 2; i++) {
      // fingers
      c.save();
      c.translate(i * 4.5, -e.h * 0.18);
      c.rotate(i * 0.16);
      c.fillRect(-2, -e.h * 0.34, 4, e.h * 0.34);
      c.restore();
    }
    c.restore();
  }

  function drawWof(c, e) {
    const x = e.x,
      y = e.y,
      w = e.w,
      h = e.h;
    const rage = 1 - e.hp / e.maxHp;

    // fleshy slab with deterministic mottling
    c.fillStyle = "#a83232";
    c.fillRect(x, y, w, h);
    c.fillStyle = "rgba(90,20,20,0.55)";
    for (let i = 0; i < 6; i++) {
      const my = y + ((i * 37 + 13) % Math.max(1, h - 10));
      c.fillRect(x + (i % 2) * w * 0.4, my, w * 0.35, 8);
    }

    // pulsing veins brighten with damage
    c.strokeStyle = "rgba(255,120,120," + (0.3 + rage * 0.3).toFixed(2) + ")";
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i < 4; i++) {
      const vy = y + h * (0.15 + i * 0.22);
      c.moveTo(x + 4, vy);
      c.quadraticCurveTo(
        x + w * 0.5,
        vy + Math.sin(clock * 3 + i) * 6,
        x + w - 4,
        vy + 4,
      );
    }
    c.stroke();

    // central eye tracks the player
    const ecx = x + w / 2,
      ecy = y + h * 0.32,
      er = w * 0.3;
    let tx = e.dir || 1,
      ty = 0;
    const p = TC.player;
    if (p) {
      const dx = p.x + p.w / 2 - ecx,
        dy = p.y + p.h / 2 - ecy;
      const d = Math.hypot(dx, dy) || 1;
      tx = dx / d;
      ty = dy / d;
    }
    c.fillStyle = "#e8ddce";
    c.beginPath();
    c.arc(ecx, ecy, er, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = rage > 0.5 ? "#d42040" : "#8a2020";
    c.beginPath();
    c.arc(
      ecx + tx * er * 0.34,
      ecy + ty * er * 0.34,
      er * 0.52,
      0,
      Math.PI * 2,
    );
    c.fill();
    c.fillStyle = "#200a0a";
    c.beginPath();
    c.arc(
      ecx + tx * er * 0.48,
      ecy + ty * er * 0.48,
      er * 0.24,
      0,
      Math.PI * 2,
    );
    c.fill();

    // toothy maw
    const my = y + h * 0.58,
      mw = w * 0.7,
      mh = h * 0.16;
    c.fillStyle = "#4a0f0f";
    c.fillRect(x + w * 0.15, my, mw, mh);
    c.fillStyle = "#e8ddce";
    for (let i = 0; i < 5; i++) {
      const tw = mw / 5,
        mx = x + w * 0.15 + i * tw;
      c.beginPath(); // top teeth
      c.moveTo(mx, my);
      c.lineTo(mx + tw / 2, my + 7);
      c.lineTo(mx + tw, my);
      c.closePath();
      c.fill();
      c.beginPath(); // bottom teeth
      c.moveTo(mx, my + mh);
      c.lineTo(mx + tw / 2, my + mh - 7);
      c.lineTo(mx + tw, my + mh);
      c.closePath();
      c.fill();
    }
  }

  function drawHungry(c, e) {
    const cx = e.x + e.w / 2,
      cy = e.y + e.h / 2,
      r = e.w / 2;
    const bite = Math.abs(Math.sin(clock * 8 + e.phase)) * r * 0.4;
    c.fillStyle = "#8a2020";
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#4a0f0f";
    c.beginPath();
    c.ellipse(cx, cy, r * 0.72, bite + 2, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#e8ddce";
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + e.phase * 0.2;
      c.fillRect(
        cx + Math.cos(a) * r * 0.62 - 1.5,
        cy + Math.sin(a) * r * 0.62 - 1.5,
        3,
        3,
      );
    }
  }

  function drawFlash(c, e) {
    c.globalAlpha = Math.min(1, e.flashTimer / FLASH_TIME) * 0.8;
    c.fillStyle = "#ffffff";
    c.beginPath();
    c.ellipse(
      e.x + e.w / 2,
      e.y + e.h / 2,
      e.w / 2,
      e.h / 2,
      0,
      0,
      Math.PI * 2,
    );
    c.fill();
    c.globalAlpha = e.fade < 1 ? Math.max(0, e.fade) : 1;
  }

  function draw(ctx, cam) {
    if (!list.length) return;
    ctx.save();
    if (typeof TC.applyCam === "function") TC.applyCam(ctx);
    else if (cam)
      ctx.setTransform(
        cam.zoom,
        0,
        0,
        cam.zoom,
        -cam.x * cam.zoom,
        -cam.y * cam.zoom,
      );

    // cheap view culling
    let vw = 0,
      vh = 0;
    if (TC.canvas) {
      const z = cam ? cam.zoom : 1;
      vw = TC.canvas.width / z;
      vh = TC.canvas.height / z;
    }
    const vx0 = (cam ? cam.x : 0) - 64,
      vy0 = (cam ? cam.y : 0) - 64;
    const vx1 = vx0 + vw + 128,
      vy1 = vy0 + vh + 128;

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (vw && (e.x + e.w < vx0 || e.x > vx1 || e.y + e.h < vy0 || e.y > vy1))
        continue;
      ctx.save();
      if (e.fade < 1) ctx.globalAlpha = Math.max(0, e.fade);
      const ai = e.def.ai;
      if (ai === "slime") drawSlime(ctx, e);
      else if (ai === "king_slime") drawKingSlime(ctx, e);
      else if (ai === "zombie") drawZombie(ctx, e);
      else if (ai === "walker") drawWalker(ctx, e);
      else if (ai === "bat")
        drawBat(ctx, e); // vulture reuses this too
      else if (ai === "harpy") drawHarpy(ctx, e);
      else if (ai === "eye_boss") drawEyeBoss(ctx, e);
      else if (ai === "skeletron") drawSkeletron(ctx, e);
      else if (ai === "skele_hand") drawSkeleHand(ctx, e);
      else if (ai === "wof") drawWof(ctx, e);
      else if (ai === "hungry") drawHungry(ctx, e);
      else drawEye(ctx, e); // demon eye / eater of souls
      if (e.flashTimer > 0) drawFlash(ctx, e);
      ctx.restore();
    }
    ctx.restore();
  }

  // Generic deterministic spawner for regular enemy types (debug/test hooks
  // and future scripted events). Bosses keep going through spawnBoss so
  // MAX_BOSSES stays authoritative.
  function spawnEnemy(type, x, y) {
    const def = TC.ENEMY_DEFS ? TC.ENEMY_DEFS[type] : null;
    if (!def || def.boss) return null;
    const p = TC.player;
    if (typeof x !== "number" || !isFinite(x))
      x = p ? p.x + p.w / 2 - def.w / 2 : 0;
    if (typeof y !== "number" || !isFinite(y))
      y = p ? p.y - 3 * TC.CONST.TS : 0;
    const e = makeEnemy(type, def, x, y);
    list.push(e);
    return e;
  }

  function clear() {
    list.length = 0;
    spawnTimer = 2;
    bloodMoon = false; // a fresh world starts with a normal night
    prevDaylight = 1;
    bmRolledTonight = false;
  }

  TC.Enemies = {
    list,
    update,
    draw,
    spawnDirector,
    clear,
    damageEnemy,
    spawnBoss,
    spawnEnemy,
    isBloodMoon: () => bloodMoon,
    setBloodMoon: setBloodMoon, // lets UI/save owners trigger or inspect the event
  };
})();
