# Tasks — fix-player-registry-world-transition

## 1. Make same-player registration idempotent

- [x] 1.1 Change `TC.Players.create` so a second registration of the same
      player object returns the existing record and id. Do not allocate a new
      id when the requested id is already held by that same object.
- [x] 1.2 Add a unit test that `create(player, { id: 'p1' })` twice yields one
      entry, id `p1`, and `Players.all().length === 1`.
- [x] 1.3 Confirm a different player object still cannot silently take an
      occupied id.

## 2. Reset only when world construction proceeds

- [x] 2.1 In `TC.newGame`, call `TC.Players.resetForNewWorld()` after the seed
      is chosen and before the new `Player` is constructed. Guard the call
      like the neighbouring optional resets.
- [x] 2.2 In `TC.continueGame`, call the reset only after pack classification
      succeeds and before the player is deserialized. A refused continue
      returns with the stored save and the registry untouched by this reset.
- [x] 2.3 In `TC.Runtime.createWorld`, reset before the new player object is
      used. Do not register a local primary there.
- [x] 2.4 Add the repair diagnostic (design D4) on a reset that finds a
      non-empty registry.

## 3. Re-seat the browser local player only

- [x] 3.1 After `TC.newGame` constructs the player and grants the starter kit,
      register that same object once with `{ primary: true }`.
- [x] 3.2 Do the equivalent after a successful `TC.continueGame` installs the
      deserialized or fallback player.
- [x] 3.3 Do not add that registration to `TC.Runtime.createWorld`.
- [x] 3.4 Confirm `actHostMultiplayer` (`newGame` then `attachLocal`) still
      has exactly one entry and that `attachLocal` returns the existing `p1`
      rather than allocating `p2`.

## 4. Preserve the host save

- [x] 4.1 Do not change `NetServer.prototype.stop` to remove the local primary.
      It must still drop remotes, parked reconnect identities, and their
      private region consumers.
- [x] 4.2 Confirm `quitToTitle` still calls `stop()` and then `TC.Save.save()`
      while `TC.player` is the host player, and that the saved character is
      loadable.

## 5. Regression coverage — lifecycle

- [x] 5.1 Add a headless lifecycle suite that walks: host a session, attach the
      local primary, join a client, have the client leave, quit to title, save,
      start a new world, and continue the saved world.
- [x] 5.2 Assert registry size, primary id, and primary/player identity at
      every step, including exactly one entry after `attachLocal`.
- [x] 5.3 Assert that after a new world following a host session the active
      player is the registry primary, the registry holds exactly one entry, and
      no entry references the previous world's player.
- [x] 5.4 Assert the simulation advances the new active player under gravity
      and does not advance the discarded previous-world player.
- [x] 5.5 Assert `TC.Targets` resolves to the active player and item-drop
      magnetization uses only that player.
- [x] 5.6 Assert the save written after `stop()` still contains the host
      player, and continuing it re-registers that character as the sole primary.
- [x] 5.7 Assert headless `createWorld` without `attachLocal` does not
      pre-register a local primary, and the first remote still receives `p1`.
- [x] 5.8 Assert a refused pack-incompatible continue does not reset the
      registry and does not mutate the stored save.

## 6. Regression coverage — browser

- [x] 6.1 Add or extend a Playwright journey that starts a host session,
      returns to title, and starts a new world, asserting the player moves
      under normal input afterwards and no page error occurs.

## 7. Verification

- [x] 7.1 Run `node --check js/main.js js/runtime.js js/players.js`.
- [ ] 7.2 Run `npm test` and confirm the full suite passes with the new
      lifecycle cases.
- [ ] 7.3 Run `npm run test:browser` and confirm journeys pass.
- [ ] 7.4 Run `npm run validate` end to end and record the result.
- [ ] 7.5 Manually verify the reported repro no longer reproduces: host, quit
      to title, new world, and confirm the player falls/moves and enemies chase
      the visible player. The host save must still load.
