/* tests/core/localization-npc.test.js — NPC/shop identity under locale switch (W20).
   Guards the historical display-name coupling bug class: the open dialog
   carries a STABLE npc type; switching locale while a dialog/shop is open
   must not change which NPC owns it, its stock, prices or progression gates,
   and Buy/Sell must keep targeting the same transaction context. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { loadGame } = require('../helpers/load-game.js');
const { slotOf, quietConsole } = require('./helpers.js');

function bootWithMerchant() {
  const g = loadGame({ hash: '#test' });
  const TC = g.TC;
  TC.Registry.syncFromTables();
  TC.newGame(4242);
  const p = TC.player;
  TC.NPCs.spawn('merchant', p.x + 24, p.y);
  return { g, TC, p };
}

test('npc identity: dialog stores type; shop resolution ignores display names', () => {
  const { TC, p } = bootWithMerchant();
  quietConsole(() => {
    // open by stable type + real catalog key (the W20 contract)
    TC.UI.showDialog('merchant', 'npc.core.merchant.dialogue.base_01');
    assert.equal(TC.UI.dialog.npcType, 'merchant');

    // rename every live NPC's frozen name field to garbage: identity must
    // NOT depend on it anymore
    for (const n of TC.NPCs.list) n.name = 'WRONG-' + n.type;
    TC.UI.draw(TC.canvas.getContext('2d'), 1280, 720);
    assert.equal(TC.UI.dialog.npcType, 'merchant', 'dialog identity stable');

    // stock + prices resolvable through the same context ShopBuy uses
    const stock = TC.NPCs.shopOf('merchant');
    assert.ok(stock && stock.length > 0, 'stock present');
    const torch = stock.find((e) => e.itemId === 'torch');
    assert.ok(torch && torch.price === 2, 'torch price unchanged');
    void p;
  });
});

test('npc identity: locale switch mid-dialog keeps shop, stock and gates', () => {
  const { TC } = bootWithMerchant();
  quietConsole(() => {
    TC.UI.showDialog('merchant', 'npc.core.merchant.dialogue.base_01');
    TC.UI.draw(TC.canvas.getContext('2d'), 1280, 720);

    const before = {
      npcType: TC.UI.dialog.npcType,
      lineKey: TC.UI.dialog.lineKey,
      stock: JSON.stringify(TC.NPCs.shopOf('merchant')),
    };

    TC.Localization.registerPseudoLocale('en-XA');
    assert.ok(TC.Localization.setLocale('en-XA'));

    // re-render under the new locale; dialog must survive untouched
    TC.UI.draw(TC.canvas.getContext('2d'), 1280, 720);
    assert.ok(TC.UI.dialog, 'dialog still open after locale switch');
    assert.equal(TC.UI.dialog.npcType, before.npcType, 'same NPC owns the shop');
    assert.equal(TC.UI.dialog.lineKey, before.lineKey, 'same dialogue entry selected');
    assert.equal(JSON.stringify(TC.NPCs.shopOf('merchant')), before.stock,
      'identical stock + prices + requires gates');

    // localized rendering actually changed
    const rendered = TC.Localization.t(before.lineKey);
    assert.notEqual(rendered, 'Bars, torches, arrows - everything a delver needs, at honest prices.');

    TC.Localization.setLocale('en');
  });
});

test('npc identity: ShopBuy targets the stable-type context after switches', () => {
  const { TC, p } = bootWithMerchant();
  quietConsole(() => {
    // fund the purse so affordability is not the failure mode under test
    TC.Economy.give(p.inventory, 1000);
    TC.UI.showDialog('merchant', 'npc.core.merchant.dialogue.base_01');
    const torchesBefore = p.inventory.count('torch');
    const price = TC.NPCs.shopOf('merchant').find((e) => e.itemId === 'torch').price;
    const purseBefore = TC.Economy.total(p.inventory);

    TC.Localization.registerPseudoLocale('en-XA');
    TC.Localization.setLocale('en-XA');

    const r = TC.Commands.submit('ShopBuy',
      { player: p, npcType: TC.UI.dialog.npcType, itemId: 'torch' });
    assert.ok(r.ok, 'purchase succeeds against stable identity post-switch');
    assert.equal(p.inventory.count('torch'), torchesBefore + 1, 'exactly one torch added');
    assert.equal(TC.Economy.total(p.inventory), purseBefore - price, 'exact charge');

    // sell path also keyed on stable type
    const slot = slotOf(p.inventory, 'torch');
    const r2 = TC.Commands.submit('ShopSell',
      { player: p, npcType: TC.UI.dialog.npcType, slot: slot, count: 1 });
    assert.ok(r2.ok, 'sell succeeds through the same stable context');

    TC.Localization.setLocale('en');
  });
});
