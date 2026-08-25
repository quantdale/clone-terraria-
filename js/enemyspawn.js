/* enemyspawn.js — TC.EnemySpawn: spawning rules/director + Blood Moon event
   (W13 decomposition of enemies.js). Owns WHERE and WHEN enemies appear:

     - zone tables: lead-owned TC.CONST.SPAWN merged with biome extras,
       depth/biome gating and the Blood Moon night replacement
     - depth-first zone classification (zoneOf): the Underworld is a DEPTH
       zone derived from the shared TC.Biomes.underworldTopPx boundary — it
       always outranks the generic 'cave' classification, so underworld
       players get the Underworld ecology instead of vanilla cave mobs
     - placement search (findSpot) over world tiles
     - the director tick: rate limiting, progression spawn multiplier,
       weighted pick, entity creation through TC.Enemies.makeEnemy
     - the Blood Moon lifecycle: dusk roll (~1 in 8 nights), dawn end with
       'event.blood_moon.completed' recorded through TC.Progression

   It never touches entity internals beyond the factory call — damage,
   death, loot and rendering stay in enemies.js. Public surface consumed by
   enemies.js (facade) and tests: update/spawnDirector/zoneOf/zoneTable/
   findSpot/setBloodMoon/isBloodMoon/reset. */
'use strict';
(function () {
  window.TC = window.TC || {};
  const TC = window.TC;
  if (TC.EnemySpawn) return;

  // ---- helpers (gameplay randomness rides the seeded GameRng 'spawn'
  // stream for deterministic authoritative replay; W23) ----
  function rand(a, b) {
    return a + TC.GameRng.stream('spawn').float() * (b - a);
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function daylight() {
    return TC.Sky && typeof TC.Sky.daylight === "function"
      ? TC.Sky.daylight()
      : 1;
  }
  function weightedPick(table) {
    let total = 0;
    for (let i = 0; i < table.length; i++) total += table[i][1];
    let r = TC.GameRng.stream('spawn').float() * total;
    for (let i = 0; i < table.length; i++) {
      r -= table[i][1];
      if (r <= 0) return table[i][0];
    }
    return table[table.length - 1][0];
  }
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
  // Flyer classification lives with the AI archetypes (single authority);
  // absent module degrades to ground-physics placement.
  function isFlyer(aiName) {
    return TC.EnemyAI && typeof TC.EnemyAI.isFlyer === "function"
      ? TC.EnemyAI.isFlyer(aiName)
      : false;
  }

  // ---- state ----
  let spawnTimer = 2; // grace period before the director starts rolling

  // ---- blood moon event ----
  // Active only at night. While up: night spawn attempts are 3x faster and
  // the night table is replaced with blood-moon-only enemies; kills drop
  // extra blood shards (enemies.js consults isBloodMoon()). Starts either by
  // using a blood_sigil (spawnBoss special case) or by a random roll at dusk
  // (~1 in 8 nights); ends at dawn, recording 'event.blood_moon.completed'
  // via TC.Progression.
  let bloodMoon = false;
  let prevDaylight = 1; // for dusk/dawn edge detection
  let bmRolledTonight = false;

  function setBloodMoon(v) {
    if (!!v === bloodMoon) return;
    bloodMoon = !!v;
    if (bloodMoon) {
      if (TC.UI && typeof TC.UI.toast === "function")
        TC.UI.toast(TC.Localization
          ? TC.Localization.t("event.blood_moon_rising")
          : "The Blood Moon is rising...");
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
          TC.UI.toast(TC.Localization
            ? TC.Localization.t("event.blood_moon_set")
            : "The Blood Moon has set.");
      }
    }
  }

  function isBloodMoon() {
    return bloodMoon;
  }

  // Dusk/dawn lifecycle step; enemies.update calls this every frame.
  function tickEvent(dt) {
    void dt;
    const dl = daylight();
    if (prevDaylight >= 0.5 && dl < 0.5) bmRolledTonight = false; // dusk
    if (dl < 0.5) {
      if (!bmRolledTonight) {
        bmRolledTonight = true;
        if (!bloodMoon && TC.GameRng.stream('spawn').chance(0.125)) setBloodMoon(true);
      }
    } else if (bloodMoon) {
      setBloodMoon(false); // dawn
    }
    prevDaylight = dl;
  }

  // ---- spawn tables (extensions merged over lead-owned TC.CONST.SPAWN) ----
  // Biome extras are appended to the base zone table when the surface tile
  // under the player matches; blood-moon entries replace the night table.
  // Entries may carry an optional third element: a W14 progression condition
  // ([type, weight, cond]) evaluated through TC.Progression.test — spawns
  // join the shared gating grammar instead of bespoke flag checks.
  const EXTRA_SPAWN = {
    day: [
      ["harpy", 0.7],
      ["vulture", 0.6],
      ["ice_slime", 1.2],
      ["sand_slime", 1.0],
      ["dune_stalker", 0.9],
      ["frost_wolf", 1.0],
      ["snapvine", 0.8],
    ],
    night: [
      ["eater_of_souls", 0.8],
      ["void_wisp", 0.7],
      ["snapvine", 0.5],
    ],
    cave: [
      ["skeleton", 1.4],
      ["granite_golem", 0.7],
      ["jungle_bat", 0.8],
      ["rock_charger", 0.8],
      ["gloom_bat", 0.7],
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
    if (id === TC.TILE.EBONGRASS || id === TC.TILE.EBONSTONE)
      return "corruption";
    return "";
  }

  // ---- zone classification (W19 truth-sync) ----
  // Depth-first: a player whose feet reach the shared Underworld boundary
  // (TC.Biomes.isUnderworldAt — the same query summon validation uses)
  // spawns from the Underworld ecology even though the generic depth rule
  // below would classify the position as ordinary 'cave'. Every shallower
  // depth keeps the unchanged cave/day/night behavior. Blood Moon
  // precedence stays on the surface 'night' zone only; underground zones
  // keep their own ecology by design.
  function zoneOf(p, w, dl) {
    if (!p || !w) return "day";
    const ts = TC.CONST.TS;
    const feetPy = p.y + p.h;
    if (
      TC.Biomes &&
      typeof TC.Biomes.isUnderworldAt === "function" &&
      TC.Biomes.isUnderworldAt(p.x, feetPy)
    )
      return "underworld";
    const pcol = clamp(Math.floor((p.x + p.w / 2) / ts), 0, w.width - 1);
    const surf = w.surfaceY ? w.surfaceY[pcol] : 0;
    if (feetPy / ts > surf + 15) return "cave";
    return dl > 0.5 ? "day" : "night";
  }

  // Player depth below the local surface, in tiles (depth-gated cave picks).
  function playerDepthT() {
    const w = TC.world,
      p = TC.player;
    if (!w || !p || !w.surfaceY) return 0;
    const col = clamp(Math.floor((p.x + p.w / 2) / TC.CONST.TS), 0, w.width - 1);
    return (p.y + p.h / 2) / TC.CONST.TS - (w.surfaceY[col] || 0);
  }

  // A table entry may carry an optional third element: a progression
  // condition string/object evaluated through TC.Progression.test.
  // Malformed or false conditions fail CLOSED (entry dropped).
  function entryConditionOk(entry) {
    if (entry.length > 2 && TC.Progression &&
        typeof TC.Progression.test === 'function') {
      try { if (!TC.Progression.test(entry[2])) return false; } catch (e) { return false; }
    }
    return true;
  }

  function zoneTable(zone, pcol) {
    const C = TC.CONST;
    const bio =
      TC.Biomes && typeof TC.Biomes.getSpawnOverride === "function"
        ? TC.Biomes.getSpawnOverride()
        : null;
    // Biome override (incl. the Underworld ecology + post-Wall supplement)
    // replaces the vanilla table for every zone except ordinary 'cave'.
    // Condition-carrying entries are filtered EVERYWHERE (base + extras).
    const base = (
      bio && zone !== "cave" ? bio : (C.SPAWN && C.SPAWN[zone]) || []
    ).filter(entryConditionOk);
    if (zone === "night" && bloodMoon) return BLOOD_MOON_TABLE;
    const b = surfaceBiome(pcol);
    const depth = playerDepthT();
    const extra = (EXTRA_SPAWN[zone] || []).filter((entry) => {
      if (!entryConditionOk(entry)) return false;
      const def = TC.ENEMY_DEFS[entry[0]];
      if (def && def.bloodMoonOnly && !bloodMoon) return false;
      if (entry[0] === "ice_slime") return b === "snow";
      if (entry[0] === "sand_slime") return b === "desert";
      if (entry[0] === "vulture") return b === "desert";
      if (entry[0] === "jungle_bat") return true; // cave-adjacent jungle bat
      if (entry[0] === "dune_stalker") return b === "desert";
      if (entry[0] === "frost_wolf") return b === "snow";
      if (entry[0] === "snapvine") return b === "jungle";
      if (entry[0] === "void_wisp") return b === "corruption"; // night only
      if (entry[0] === "rock_charger") return depth > 16;
      if (entry[0] === "gloom_bat") return depth > 42; // deep underground
      return true;
    });
    return base.concat(extra);
  }

  // ---- placement ----
  // Find a placement (world px) near tile (tx,ty). Ground walkers scan down
  // from min(surfaceY, ty) up to 12 tiles for `need` free tiles above solid
  // ground; flyers just need an open-air box.
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

  // ---- director ----
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

    const zone = zoneOf(p, w, dl);

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

    const list = TC.Enemies ? TC.Enemies.list : null;
    if (!list || list.length >= C.MAX_ENEMIES) return;
    const table = zoneTable(zone, pcol);
    if (!table || !table.length) return;

    const type = weightedPick(table);
    const def = TC.ENEMY_DEFS[type];
    if (!def) return;

    const prow = (p.y + p.h / 2) / ts;
    for (let attempt = 0; attempt < 14; attempt++) {
      const ang = TC.GameRng.stream('spawn').float() * Math.PI * 2;
      const dist = rand(C.ENEMY_MIN_DIST, C.ENEMY_MAX_DIST);
      const tx = clamp(Math.round(pcol + Math.cos(ang) * dist), 1, w.width - 2);
      const ty = clamp(
        Math.round(prow + Math.sin(ang) * dist),
        1,
        w.height - 2,
      );
      const spot = findSpot(def, tx, ty, surf);
      if (spot) {
        list.push(TC.Enemies.makeEnemy(type, def, spot.x, spot.y));
        return;
      }
    }
  }

  function reset() {
    spawnTimer = 2;
    bloodMoon = false; // a fresh world starts with a normal night
    prevDaylight = 1;
    bmRolledTonight = false;
  }

  TC.EnemySpawn = {
    update(dt) {
      tickEvent(dt);
      spawnDirector(dt);
    },
    spawnDirector,
    tickEvent,
    zoneOf,
    zoneTable,
    findSpot,
    surfaceBiome,
    playerDepthT,
    setBloodMoon,
    isBloodMoon,
    reset,
    BLOOD_MOON_TABLE,
  };
})();
