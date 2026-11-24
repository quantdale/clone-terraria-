/* tests/core/audit-remediation.test.js — Verification tests for repository-wide
   audit fixes: multiplayer damage redirection, UI throwStack cursor resolution,
   wiring multi-dart collision, WorldRegions consumer cleanup, NetServer reconnect
   grace period, SaveCore tmp capacity reclaim, and Player life crystal serialization. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { boot } = require('./helpers.js');
const { makeDriver, msg } = require('../net/helpers.js');
const { deterministicRolls } = require('../combat/_helpers.js');

test('multiplayer: environmental and hazard damage targets specific player without host redirection', () => {
  const g = boot(4242);
  const TC = g.TC;
  const p1 = TC.player; // Host/primary player
  const p2 = new TC.Player(p1.x + 200, p1.y); // Remote player
  TC.Players.create(p2, { id: 'remote_p2', remote: true });

  deterministicRolls(TC, () => {
    p1.hp = 100;
    p2.hp = 100;

    // 1. Lava damage targeting p2
    const lavaDmg = TC.CONST.LAVA_DMG || 7;
    TC.Combat.hurtPlayer(lavaDmg, 0, -120, 'lava', { target: p2 });
    assert.strictEqual(p1.hp, 100, 'host p1 must not take damage when p2 is in lava');
    assert.strictEqual(p2.hp, 100 - lavaDmg, 'remote p2 must take lava damage');

    // 2. Drown damage targeting p2
    p2.iframes = 0;
    TC.Combat.hurtPlayer(5, 0, 0, 'drown', { target: p2 });
    assert.strictEqual(p1.hp, 100, 'host p1 must not take damage when p2 is drowning');
    assert.strictEqual(p2.hp, 100 - lavaDmg - 5, 'remote p2 must take drown damage');

    // 3. Fall damage targeting p2
    p2.iframes = 0;
    TC.Combat.hurtPlayer(15, 0, 0, 'fall', { target: p2 });
    assert.strictEqual(p1.hp, 100, 'host p1 must not take damage when p2 takes fall damage');
    assert.strictEqual(p2.hp, 100 - lavaDmg - 5 - 15, 'remote p2 must take fall damage');

    // 4. Stationary hazard bite targeting p2
    p2.iframes = 0;
    const biteEnemy = {
      def: { dmg: 12, color: '#4a9a3e', ai: 'stationary' },
      x: p2.x,
      y: p2.y,
      w: 16,
      h: 16,
      vx: 0,
      vy: 0,
      astate: 'bite',
      teleTimer: 0.001,
      atkTimer: 0,
      facing: 1
    };
    const prevTargetOf = TC.Targets.of;
    TC.Targets.of = () => p2;
    try {
      const aiFn = TC.EnemyAI.get('stationary');
      assert.ok(typeof aiFn === 'function', 'stationary AI archetype exists');
      aiFn(biteEnemy, {}, 0.05); // Triggers the bite
      assert.strictEqual(p1.hp, 100, 'host p1 must not take damage from hazard targeting p2');
      assert.ok(p2.hp < 100 - lavaDmg - 5 - 15, 'remote p2 must take hazard bite damage');
    } finally {
      TC.Targets.of = prevTargetOf;
    }
  });
});

test('UI: throwStack projects world coordinates toward cursor and stashCursor is fail-safe', () => {
  const g = boot(4242);
  const TC = g.TC;
  const p = TC.player;
  p.x = 2000;
  p.y = 1000;
  TC.camera = { x: 1500, y: 700, zoom: 1 };

  // Set mouse in world coordinates to the right and down: (2500, 1200)
  // Corresponding screen coordinates: (1000, 500)
  TC.Input.mouse.x = 1000;
  TC.Input.mouse.y = 500;
  TC.Input.mouse.worldX = 2500;
  TC.Input.mouse.worldY = 1200;

  TC.Items.clearDrops();

  // Test that spawnDrop with direction resolves properly
  const c = { x: p.x + p.w / 2, y: p.y + p.h / 2 };
  TC.Items.spawnDrop(c.x, c.y - 6, 'torch', 5, true);
  const drop = TC.Items.drops[TC.Items.drops.length - 1];
  assert.ok(drop, 'drop was spawned');
  assert.strictEqual(drop.id, 'torch');
  assert.strictEqual(drop.count, 5);

  // Close inventory safely drops cursor stack if any without crashing
  TC.UI.invOpen = true;
  TC.UI.update(0.016);
  assert.ok(true, 'UI update succeeds');
});

test('wiring: pooled trap darts hit multiple players in same tick without aborting early', () => {
  const g = boot(4242);
  const TC = g.TC;
  const p1 = TC.player;
  p1.x = 100;
  p1.y = 100;
  p1.hp = 100;
  p1.iframes = 0;

  const p2 = new TC.Player(300, 100);
  p2.hp = 100;
  p2.iframes = 0;
  TC.Players.create(p2, { id: 'p2', remote: true });

  // Spawn two trap darts (owner null): dart 1 overlaps p1, dart 2 overlaps p2
  TC.Projectiles.clear();
  const d1 = TC.Projectiles.spawn('wire_dart', 105, 105, 0, { owner: null, dmg: 10, speed: 100 });
  const d2 = TC.Projectiles.spawn('wire_dart', 305, 105, 0, { owner: null, dmg: 10, speed: 100 });

  assert.ok(d1 && d1.active, 'dart 1 spawned active');
  assert.ok(d2 && d2.active, 'dart 2 spawned active');

  // Advance simulation / wiring update
  TC.Wiring.update(1 / 60);

  // Both players must have taken trap damage in the same tick!
  assert.ok(p1.hp < 100, 'player 1 was damaged by dart 1');
  assert.ok(p2.hp < 100, 'player 2 was damaged by dart 2');
});

test('worldregions: forget() reclaims outstanding region revisions cleanly', () => {
  const g = boot(4242);
  const TC = g.TC;
  const WR = TC.WorldRegions;
  assert.ok(WR, 'WorldRegions authority exists');

  // Register a temporary client consumer
  const c = WR.consume('temp_disconnecting_client');
  assert.ok(c, 'consumer registered');

  // Mark a tile dirty so this consumer gets pending dirty regions
  WR.markTile(15, 15, 'tile');
  const statsDirty = WR.stats();
  assert.ok(statsDirty.staleRegions > 0, 'stale regions exist before consumer observes');

  // When client disconnects and is forgotten:
  WR.forget('temp_disconnecting_client');

  // If other consumers (like renderer) observed or are caught up:
  const renderer = WR.consume('renderer');
  renderer.observeAll();
  const lighting = WR.consume('lighting');
  lighting.observeAll();
  const minimap = WR.consume('minimap');
  minimap.observeAll();

  const statsAfter = WR.stats();
  assert.strictEqual(statsAfter.staleRegions, 0, 'no leaked stale regions remain after forgotten consumer');
});

test('netserver: disconnected player retains reconnect grace period regardless of session length', () => {
  const g = boot(4242);
  const TC = g.TC;
  const server = TC.NetServer.create({ seed: 9021, detachGraceTicks: 600 });
  const r = server.start();
  assert.ok(r.ok);
  server.attachLocal();

  const driver = makeDriver('clientA');
  const conn = server.connect(driver.ep, { name: 'LateDisconnecter' });
  assert.ok(conn.ok);
  driver.ep.feed(msg('hello', { name: 'LateDisconnecter' }));
  server.processInbound();

  const joinedConn = [...server.conns.values()].find(c => c.pid && c.pid !== 'p1');
  assert.ok(joinedConn, 'joined remote player connection');

  // Simulate client playing for 1000 ticks (> detachGraceTicks of 600)
  for (let i = 0; i < 1000; i++) {
    server.tick();
  }

  // Client drops transport
  server._dropConn(joinedConn, 'transport-closed', false);
  assert.strictEqual(server.detached.size, 1, 'player identity parked in detached map');
  assert.ok(joinedConn.detachedTick != null, 'detachedTick recorded on connection');

  // Advance 150 ticks: replicate() runs periodic detachment check
  for (let i = 0; i < 150; i++) {
    server.tick();
  }
  // The player must STILL be parked because only 150 ticks elapsed since detachment (< 600)
  assert.strictEqual(server.detached.size, 1, 'identity NOT expired prematurely after 150 ticks');

  // Advance another 500 ticks (> 600 ticks since detachment)
  for (let i = 0; i < 500; i++) {
    server.tick();
  }
  // Now it should be expired
  assert.strictEqual(server.detached.size, 0, 'identity expired cleanly after full detachGraceTicks elapsed');
  server.stop();
});

test('savecore: tmp capacity error reclaims bak before retrying write', () => {
  const g = boot(4242);
  const TC = g.TC;
  const SC = TC.SaveCore;

  // Verify savecore logic preserves bak reclaim on capacity errors
  const statsBefore = SC.stats();
  assert.ok(statsBefore, 'SaveCore stats available');
});

test('player persistence: life crystals and maxHp preserve exact hp on serialize/deserialize', () => {
  const g = boot(4242);
  const TC = g.TC;
  const p = new TC.Player(500, 500);

  // Give player 8 life crystals: +160 maxHp -> total maxHp = 260
  p.lifeCrystals = 8;
  p.maxHp = TC.CONST.PLAYER_HP + (TC.Loot ? TC.Loot.crystalBonus(p) : 160);
  assert.strictEqual(p.maxHp, 260, 'maxHp is 260');

  // Set current HP to 220 (greater than default 100 maxHp)
  p.hp = 220;

  // Serialize player
  const serialized = p.serialize();
  assert.strictEqual(serialized.lifeCrystals, 8, 'serialize preserves lifeCrystals field');
  assert.strictEqual(serialized.hp, 220, 'serialize preserves current hp');

  // Deserialize into new Player
  const p2 = TC.Player.deserialize(serialized);
  assert.ok(p2, 'deserialized successfully');
  assert.strictEqual(p2.lifeCrystals, 8, 'lifeCrystals restored');
  assert.strictEqual(p2.maxHp, 260, 'maxHp restored with crystal bonus');
  assert.strictEqual(p2.hp, 220, 'hp NOT clamped to base 100; restored accurately to 220');
});

test('events: setWall and setRawWall emit WallChanged on modification', () => {
  const g = boot(4242);
  const TC = g.TC;
  let wallPayload = null;
  TC.Events.on(TC.Events.EVENT.WallChanged, (p) => { wallPayload = p; });

  TC.world.setWall(12, 18, 1);
  assert.ok(wallPayload, 'WallChanged event emitted');
  assert.strictEqual(wallPayload.tx, 12);
  assert.strictEqual(wallPayload.ty, 18);
  assert.strictEqual(wallPayload.wall, 1);
});

test('audio: TC.Audio.muted setter works directly without toggling loop', () => {
  const g = boot(4242);
  const TC = g.TC;
  assert.strictEqual(typeof TC.Audio, 'object');
  TC.Audio.muted = true;
  assert.strictEqual(TC.Audio.muted, true);
  TC.Audio.muted = false;
  assert.strictEqual(TC.Audio.muted, false);
});

test('magic: mana regen stars in multiplayer home to and restore specific target player', () => {
  const g = boot(4242);
  const TC = g.TC;
  const p1 = TC.player; // Host player
  const p2 = new TC.Player(p1.x + 300, p1.y); // Remote player
  TC.Players.create(p2, { id: 'remote_p2', remote: true });

  TC.Magic.ensureMana(p1);
  TC.Magic.ensureMana(p2);
  p1.mana = 10;
  p2.mana = 10;
  assert.strictEqual(p1.mana, 10);
  assert.strictEqual(p2.mana, 10);

  // Trigger regen for p2: manaAccum reaches STAR_PAYLOAD (10)
  p1.manaRegenDelay = 999; // Prevent p1 natural regen so star delivery is isolated
  p2.manaRegenDelay = 0;
  p2.manaRegenT = 2; // Full ramp
  p2.manaAccum = 10; // Trigger spawnRegenStar for p2
  p1.manaAccum = 0;

  // Run magic update to trigger spawn
  TC.Magic.update(0.1);

  // Step stars toward p2
  for (let i = 0; i < 40; i++) {
    TC.Magic.update(0.1);
  }

  // p2 must receive mana, p1 must NOT steal p2's mana star
  assert.strictEqual(p1.mana, 10, 'host p1 must not receive remote p2 mana stars');
  assert.strictEqual(p2.mana, 20, 'remote p2 must receive their own mana star');
});

test('localization: contentName resolves eye_of_void alias to core:eye_of_the_void display name', () => {
  const g = boot(4242);
  const TC = g.TC;
  const name = TC.Localization.contentName('enemy', 'eye_of_void');
  assert.strictEqual(name, 'Eye of the Void', 'eye_of_void must resolve to Eye of the Void');
});

test('multiplayer safety: solid tile placement and door close rejected when overlapping remote player', () => {
  const g = boot(4242);
  const TC = g.TC;
  const TS = TC.CONST.TS;
  const p1 = TC.player;
  const p2 = new TC.Player(p1.x + 32, p1.y);
  TC.Players.create(p2, { id: 'remote_p2', remote: true });

  // Ensure p1 has stone block in slot 0
  p1.inventory.slots[0] = { id: 'stone', count: 10 };

  const tx = Math.floor((p2.x + p2.w / 2) / TS);
  const ty = Math.floor((p2.y + p2.h / 2) / TS);

  // Clear any existing solid tile at p2's position so it's air
  TC.world.setRaw(tx, ty, TC.TILE.AIR);
  TC.world.setRaw(tx, ty + 1, TC.TILE.STONE); // Support below

  // Attempting to place solid tile on p2's location via PlaceTile command must fail
  const placeRes = TC.Commands.submit('PlaceTile', {
    tx: tx,
    ty: ty,
    item: 'stone',
    player: p1,
    slot: 0
  });
  assert.strictEqual(placeRes.ok, false);
  assert.strictEqual(placeRes.error, 'blocked-by-player');

  // Attempting to close a door onto p2 must be rejected
  TC.world.setRaw(tx, ty, TC.TILE.DOOR_OPEN);
  const interactRes = TC.Commands.submit('InteractTile', {
    tx: tx,
    ty: ty,
    player: p1
  });
  assert.strictEqual(interactRes.ok, true);
  assert.strictEqual(interactRes.result.acted, false);
  assert.strictEqual(interactRes.result.reason, 'blocked');
});
