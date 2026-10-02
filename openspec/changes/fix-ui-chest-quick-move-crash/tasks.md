# Tasks — fix-ui-chest-quick-move-crash

## 1. Restore the container quick-move path

- [x] 1.1 Add a file-local `joinedActive()` helper next to `shiftHeld()` /
      `ctrlHeld()`. It returns true only when `TC.NetClient.active().isActive()`
      is true. Do not call `drivesTick()`. If a client authority exists and the
      query throws, return true. If no client authority exists, return false.
      The helper itself must not throw (design D1/D2).
- [x] 1.2 Confirm both existing call sites now resolve: the inventory→chest
      direction in `slotClick(inv, i, rightClick)` and the chest-grid
      chest→inventory direction in the click handler. Do not add a third
      duplicate predicate.
- [x] 1.3 Re-read both branches and confirm the local fallback still performs
      the merge-then-first-empty transfer through the existing
      `quickMoveRange` helper, with the source slot cleared only on a full
      move.
- [x] 1.4 Submit joined `ContainerMove` intents through `TC.NetClient.intent`,
      not `txSubmit`. A null intent result must return without local mutation.
      Keep the existing `from`/`to` endpoints and the open chest's `tx`/`ty`.

## 2. Regression coverage — headless

- [x] 2.1 Add a headless suite (new file under `tests/player/` or
      `tests/npc/`, following the existing `loadGame` helper convention) that
      boots the game, creates a world, places a chest, opens it, and drives
      `TC.UI.draw` with a real click on a filled inventory slot while Shift is
      held.
- [x] 2.2 Assert the merge case: source inventory slot emptied, matching chest
      stack increased by exactly the moved count, and total item count
      conserved.
- [x] 2.3 Assert the no-matching-stack case: first empty chest slot receives
      the stack, source emptied.
- [x] 2.4 Assert the chest→inventory direction with a Shift-click on a filled
      chest-grid slot.
- [x] 2.5 Assert the no-modifier and empty-source cases do not transfer and do
      not raise.
- [x] 2.6 Assert the joined path with `active().isActive()` true submits a
      `ContainerMove` intent and does not mutate the local inventory or chest.
      Assert a `connecting` client, where `drivesTick()` would be true but
      `isActive()` is false, does not take the joined branch solely because
      tick ownership is true.
- [x] 2.7 Assert the absent-authority case: with `TC.NetClient` removed, a
      Shift-click performs the local quick-move and raises nothing.
- [x] 2.8 Assert zero UI-layer errors after each interaction by reading the
      `core.ui` entry's error counter from `TC.RenderLayers.list()` (see design
      D3).

## 3. Regression coverage — browser

- [x] 3.1 Extend the existing Playwright inventory/container journey to hold
      Shift across a click on a filled inventory slot with a chest open and
      assert the item lands in the chest (and back again), so the real browser
      event path is covered.
- [x] 3.2 Add an assertion in that journey that no page/console error was
      raised during the interaction.

## 4. Verification

- [x] 4.1 Run `node --check js/ui.js`.
- [x] 4.2 Run `npm test` and confirm the full node:test suite passes with the
      new cases included.
- [x] 4.3 Run `npm run test:browser` and confirm all journeys pass.
- [x] 4.4 Run `npm run validate` end to end (syntax + i18n + tests + build +
      verify-dist + browser) and record the result.
- [ ] 4.5 Manually verify in a browser: solo, open chest, Shift-click moves the
      stack both directions with no visible error; repeat with a joined client.
