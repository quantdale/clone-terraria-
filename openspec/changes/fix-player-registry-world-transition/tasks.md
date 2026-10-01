# Tasks — fix-player-registry-world-transition

## 1. Enforce the world-transition invariant

- [ ] 1.1 Call `TC.Players.resetForNewWorld()` as the first world-construction
      step in `TC.newGame` (`js/main.js`), guarded for optional dependency
      like the neighbouring resets.
- [ ] 1.2 Call the same reset as the first step of `TC.continueGame`
      (`js/main.js`), before the world is built and before the player is
      deserialized.
- [ ] 1.3 Call the same reset as the first step of `TC.Runtime.createWorld`
      (`js/runtime.js`), before `new TC.Player(...)`.
- [ ] 1.4 Confirm the host flow still seats its primary correctly: the title
      screen's host action calls `TC.newGame` *before* `NetServer.create()` and
      `attachLocal()`, so the registry must be empty when `attachLocal` runs.

## 2. Re-seat the solo local primary

- [ ] 2.1 After the new player is constructed and its starter kit granted in
      `TC.newGame`, register it with `TC.Players.create(player, { primary: true })`
      so the registry, the `TC.player` alias and all consumers agree on exactly
      one live player.
- [ ] 2.2 Do the equivalent in `TC.continueGame` for the deserialized (or
      freshly constructed fallback) player.
- [ ] 2.3 Do the equivalent in `TC.Runtime.createWorld`, keeping the headless
      boundary consistent with the browser host.
- [ ] 2.4 Verify the movement system no longer needs its `[TC.player]` fallback
      for normal play, and that the fallback still behaves correctly if the
      registry is ever empty.

## 3. Session teardown correctness

- [ ] 3.1 Review `NetServer.prototype.stop` and remove the retention of the
      local primary across the session boundary (design D3), keeping the
      existing removal of remotes, parked reconnect identities and their
      private region consumers.
- [ ] 3.2 Confirm `quitToTitle` still saves the host world before any state is
      cleared, and that a host-quit cycle leaves a loadable save.
- [ ] 3.3 Add the repair diagnostic (design D4): record when a world transition
      found a non-empty registry holding foreign players, using the existing
      observability conventions (`TC.Debug` counters or a `TC.Events` event).

## 4. Regression coverage — lifecycle

- [ ] 4.1 Add a headless lifecycle suite that boots the game and walks: host a
      session, attach the local primary, join a client, have the client leave,
      quit to title, start a new world, continue the saved world.
- [ ] 4.2 Assert registry size, primary id, and primary/player identity at
      every step of that lifecycle.
- [ ] 4.3 Assert that after a new world following a host session the active
      player is the registry primary, the registry holds exactly one entry, and
      no entry references the previous world's player.
- [ ] 4.4 Assert the simulation actually advances the new active player under
      gravity and does NOT advance the discarded previous-world player.
- [ ] 4.5 Assert `TC.Targets` resolves to the active player (anchor and
      nearest) and that item-drop magnetization uses only the active player.
- [ ] 4.6 Assert a save made before a host-quit reloads and re-registers a
      coherent single player.
- [ ] 4.7 Assert a joined client that reconnects after a world transition sees
      a coherent player set.

## 5. Regression coverage — browser

- [ ] 5.1 Add or extend a Playwright journey that starts a host session,
      returns to title, and starts a new world, asserting the player moves
      under normal input afterwards and no page error occurs.

## 6. Verification

- [ ] 6.1 Run `node --check js/main.js js/runtime.js js/players.js
      js/netserver.js`.
- [ ] 6.2 Run `npm test` and confirm the full suite passes with the new
      lifecycle cases.
- [ ] 6.3 Run `npm run test:browser` and confirm journeys pass.
- [ ] 6.4 Run `npm run validate` end to end and record the result.
- [ ] 6.5 Manually verify the reported repro no longer reproduces: host, quit
      to title, new world, and confirm the player falls/moves and enemies chase
      the visible player.
