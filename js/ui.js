/* ui.js — canvas-native UI: title screen, HUD (hearts + defense + hotbar),
   inventory drag & drop, equipment slots, chest panel, crafting column,
   pause overlay, death overlay, boss health bar, NPC dialog box, breath
   bubbles, toasts.
   All hit-testing is manual against TC.Input.mouse; sets TC.Input.uiHover. */
'use strict';
(function () {
  const TC = window.TC;

  const UI = TC.UI = {
    paused: false,   // pause overlay open (TC.state stays 'playing')
    invOpen: false,  // inventory panel visible
    chest: null,     // {tx,ty} while a chest panel is open (implies invOpen)
    dialog: null,    // {name,text,t} NPC speech box while t > 0
    selected: 0      // mirrored from TC.player.hotbarIndex (player.js owns selection)
  };

  // ---- tunables ----
  const SLOT = 46;            // hotbar/bag cell size (px)
  const SLOT_PAD = 6;
  const GAP = 5;
  const HOTBAR_N = 10;
  const BAG_ROWS = 4;         // bag grid under the hotbar: 4x10 (= slots 10..49)
  const INV_N = HOTBAR_N + BAG_ROWS * HOTBAR_N;  // 50 player inventory slots
  const CHEST_ROWS = 2;       // chest panel: 2x10 (= TC.Chests' 20 slots)
  const CHEST_N = CHEST_ROWS * HOTBAR_N;
  const HEART_SIZE = 22;
  const CRAFT_ROW_H = 30;
  const CRAFT_W = 212;
  const DIALOG_T = 6;         // NPC dialog auto-dismiss timer (seconds)
  const DIALOG_FADE = 0.2;    // NPC dialog fade-in/out duration
  const BUBBLE_N = 10;        // breath bubbles drawn (filled = ceil(breath*N))
  const BUBBLE_R = 4;         // bubble radius (~8px circle)
  const BUBBLE_GAP = 4;
  const BREATH_FADE = 0.25;   // breath bubble row fade-in/out duration (seconds)

  const GOLD = '#ffd24a';
  const GOLD_DIM = '#a8863a';
  const PANEL_BG = 'rgba(16,12,22,0.82)';
  const PANEL_EDGE = 'rgba(255,210,74,0.35)';
  const TEXT = '#e8e2d0';
  const TEXT_DIM = '#9a927e';

  // ---- runtime state ----
  let cursorStack = null;     // {id,count} held on the mouse cursor
  let deadT = 0;              // local fallback timer for the respawn countdown
  let wasDead = false;
  let prevState = null;
  let tooltip = null;         // {x,y,lines:[{text,color}]} rebuilt every frame
  const toasts = [];          // {msg,life}
  let breathT = 0;            // breath bubble row fade (0..1)

  // pixel heart bitmap, 7 wide x 6 tall
  const HEART_MAP = [
    '0110110',
    '1111111',
    '1111111',
    '0111110',
    '0011100',
    '0001000'
  ];

  // ---- small helpers ----
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function inRect(x, y, r) {
    return !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  }

  function itemDef(id) { return TC.ITEM_DEFS ? TC.ITEM_DEFS[id] : null; }
  function maxStack(id) { const d = itemDef(id); return (d && d.maxStack) || 999; }

  function mousePos() {
    const m = (TC.Input && TC.Input.mouse) || {};
    return { x: m.x || 0, y: m.y || 0 };
  }

  function pressed(code) {
    try { return !!(TC.Input && TC.Input.pressed && TC.Input.pressed(code)); }
    catch (e) { return false; }
  }

  function shiftHeld() {
    try {
      return !!(TC.Input && TC.Input.down &&
        (TC.Input.down('ShiftLeft') || TC.Input.down('ShiftRight')));
    } catch (e) { return false; }
  }

  function playerCenter() {
    const p = TC.player;
    if (!p) return { x: 0, y: 0 };
    return { x: p.x + (p.w || 16) / 2, y: p.y + (p.h || 16) / 2 };
  }

  // Inventory access. Drag & drop needs the raw slots array; crafting only
  // needs count/add/remove. Returns null until the player module is live.
  function getInv(needSlots) {
    const p = TC.player;
    if (!p) return null;
    const inv = p.inventory || p.inv || null;
    if (!inv || typeof inv.count !== 'function' ||
        typeof inv.add !== 'function' || typeof inv.remove !== 'function') return null;
    if (needSlots && !Array.isArray(inv.slots)) return null;
    return inv;
  }

  function liveSlot(arr, i) {
    const s = arr[i];
    return (s && s.id && s.count > 0) ? s : null;
  }

  function slotAt(inv, i) { return liveSlot(inv.slots, i); }

  // Raw slot array of the open chest (TC.Chests may not be live yet).
  function chestSlots() {
    if (!UI.chest || !TC.Chests || typeof TC.Chests.get !== 'function') return null;
    try {
      const a = TC.Chests.get(UI.chest.tx, UI.chest.ty);
      return Array.isArray(a) ? a : null;
    } catch (e) { return null; }
  }

  // ---- equipment access (player.js owns TC.player.equipment; may be absent) ----
  function equipMap() {
    const p = TC.player;
    const eq = p && p.equipment;
    return (eq && typeof eq === 'object') ? eq : null;
  }

  // Tolerates both id-string and {id,count} storage shapes.
  function equippedId(slot) {
    const eq = equipMap();
    if (!eq) return null;
    const v = eq[slot];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && v.id) return v.id;
    return null;
  }

  function setEquipped(slot, id) {
    const eq = equipMap();
    if (!eq) return;
    if (id == null) { eq[slot] = null; return; }
    // keep stack-shaped storage if that is what player.js uses
    eq[slot] = (eq[slot] && typeof eq[slot] === 'object')
      ? { id: id, count: 1 }
      : id;
  }

  // Prefers player.totalDefense(); falls back to summing ITEM_DEFS defense.
  function totalDefense() {
    const p = TC.player;
    if (!p) return 0;
    if (typeof p.totalDefense === 'function') {
      try { return Math.max(0, p.totalDefense() | 0); } catch (e) {}
    }
    const keys = (TC.CONST && TC.CONST.EQUIP_SLOTS) || ['head', 'body', 'feet'];
    let n = 0;
    for (let i = 0; i < keys.length; i++) {
      const d = itemDef(equippedId(keys[i]));
      if (d && d.defense > 0) n += d.defense;
    }
    return n;
  }

  function toast(msg) {
    toasts.push({ msg: String(msg), life: 2.4 });
    if (toasts.length > 4) toasts.shift();
  }
  UI.toast = toast;

  // NPC speech box (npcs.js calls this on RMB over an NPC). A new call
  // replaces the content and restarts the auto-dismiss timer.
  UI.showDialog = function (name, text) {
    UI.dialog = {
      name: String(name == null ? '' : name),
      text: String(text == null ? '' : text),
      t: DIALOG_T
    };
  };

  // Selected hotbar stack, for gameplay modules that need the held item.
  UI.getSelectedItem = function () {
    const inv = getInv(true);
    if (!inv) return null;
    const p = TC.player;
    const idx = (p && typeof p.hotbarIndex === 'number')
      ? ((p.hotbarIndex | 0) % HOTBAR_N + HOTBAR_N) % HOTBAR_N
      : UI.selected;
    return slotAt(inv, idx);
  };

  // Throw a stack into the world from the player, biased toward (towardX,towardY).
  function throwStack(stack, towardX, towardY) {
    if (!stack || !TC.Items || typeof TC.Items.spawnDrop !== 'function') return;
    const c = playerCenter();
    const drops = TC.Items.drops;
    const before = (drops && drops.length) || 0;
    TC.Items.spawnDrop(c.x, c.y - 6, stack.id, stack.count, true);
    // spawnDrop's contract has no velocity argument; nudge freshly spawned
    // drops toward the cursor when they expose velocity fields.
    if (!drops) return;
    const dx = towardX - c.x, dy = towardY - c.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    for (let i = before; i < drops.length; i++) {
      const dr = drops[i];
      if (!dr) continue;
      if (typeof dr.vx === 'number') dr.vx = dx / d * 230;
      if (typeof dr.vy === 'number') dr.vy = dy / d * 230 - 70;
    }
  }

  // Put the cursor stack back into the inventory; overflow goes to the world.
  function stashCursor(inv) {
    if (!cursorStack) return;
    let left = 0;
    try { left = inv.add(cursorStack.id, cursorStack.count); } catch (e) { left = 0; }
    if (typeof left !== 'number' || !isFinite(left)) left = 0;
    if (left > 0) {
      const m = mousePos();
      throwStack({ id: cursorStack.id, count: left }, m.x, m.y);
    }
    cursorStack = null;
  }

  // Stash whatever is held (inventory first, overflow to the world).
  function stashCursorOrThrow() {
    if (!cursorStack) return;
    const inv = getInv(true);
    if (inv) stashCursor(inv);
    else {
      const m = mousePos();
      throwStack(cursorStack, m.x, m.y);
      cursorStack = null;
    }
  }

  function closeInventory() {
    UI.invOpen = false;
    UI.chest = null;          // chest panel lives inside the inventory
    stashCursorOrThrow();
  }

  // ---- chest panel (player.js opens via right-click on a chest tile) ----
  UI.openChest = function (tx, ty) {
    tx |= 0; ty |= 0;
    if (!UI.chest || UI.chest.tx !== tx || UI.chest.ty !== ty) {
      UI.chest = { tx: tx, ty: ty };
    }
    if (!UI.invOpen) UI.invOpen = true;   // bag must be visible for transfers
  };

  UI.closeChest = function () {
    UI.chest = null;
    stashCursorOrThrow();
  };

  function resetPanels() {
    UI.paused = false;
    UI.invOpen = false;
    UI.chest = null;
    UI.dialog = null;
    cursorStack = null;
  }

  // ---- menu actions ----
  function actNewWorld() { TC.newGame(); resetPanels(); }
  function actContinue() { TC.continueGame(); resetPanels(); }
  function actCustomSeed() {
    const s = window.prompt('Enter a world seed (integer):');
    if (s == null) return; // cancelled
    const n = parseInt(s, 10);
    if (typeof n !== 'number' || !isFinite(n)) { toast('Invalid seed - enter an integer'); return; }
    TC.newGame(n);
    resetPanels();
  }
  function actSave() {
    const ok = TC.Save && typeof TC.Save.save === 'function' ? TC.Save.save() : false;
    toast(ok ? 'Saved' : 'Save failed');
  }
  function actSaveQuit() { if (TC.quitToTitle) TC.quitToTitle(); resetPanels(); }
  function actToggleSound() {
    if (!TC.Audio || typeof TC.Audio.toggleMuted !== 'function') return;
    toast(TC.Audio.toggleMuted() ? 'Sound off' : 'Sound on');
  }
  function actNewWorldConfirm() {
    const ok = window.confirm('Generate a new world? Unsaved changes since the last save will be lost.');
    if (!ok) return;
    TC.newGame();
    resetPanels();
  }
  function soundLabel() {
    return 'Sound: ' + ((TC.Audio && TC.Audio.muted) ? 'Off' : 'On');
  }

  // ---- crafting context (cheap: <=17 recipes, 11x11 tile scan) ----
  function getCraftContext() {
    const inv = getInv(false);
    if (!inv || !TC.Crafting || typeof TC.Crafting.available !== 'function') return null;
    const p = TC.player;
    let stations = null;
    if (TC.Crafting.stationsNearby && p) {
      try { stations = TC.Crafting.stationsNearby(p.x, p.y); } catch (e) { stations = null; }
    }
    let list = [];
    try { list = TC.Crafting.available(inv, stations) || []; } catch (e) { list = []; }
    return { inv: inv, stations: stations || new Set(), list: list };
  }

  // ---- layout ----
  // Recomputed every call so input handling and drawing always agree.
  function layout(w, h) {
    const L = {
      w: w, h: h,
      hotbar: [],
      bag: [],
      bagPanel: null,
      chestPanel: null,
      chestRects: [],
      equipPanel: null,
      equipRects: [],
      craftPanel: null,
      craftRects: [],
      craftCtx: null,
      craftList: [],
      craftMaxRows: 0,
      pausePanel: null,
      buttons: [],
      uiRects: []
    };

    const hx = 12, hy = 12;
    for (let i = 0; i < HOTBAR_N; i++) {
      L.hotbar.push({ x: hx + i * (SLOT + GAP), y: hy, w: SLOT, h: SLOT });
    }

    // bag panel: 4 rows x 10 columns under the hotbar
    const bagX = hx - 8, bagY = hy + SLOT + 14;
    const bagW = HOTBAR_N * SLOT + (HOTBAR_N - 1) * GAP + 16;
    const bagH = 22 + BAG_ROWS * SLOT + (BAG_ROWS - 1) * GAP + 8;
    L.bagPanel = { x: bagX, y: bagY, w: bagW, h: bagH };
    for (let r = 0; r < BAG_ROWS; r++) {
      for (let c = 0; c < HOTBAR_N; c++) {
        L.bag.push({
          x: bagX + 8 + c * (SLOT + GAP),
          y: bagY + 22 + r * (SLOT + GAP),
          w: SLOT, h: SLOT,
          index: 10 + r * HOTBAR_N + c
        });
      }
    }

    // chest panel: 2 rows x 10 columns under the bag panel, only while open
    const chestOpen = !!(UI.chest && UI.invOpen);
    let chestH = 0;
    if (chestOpen) {
      const cy = bagY + bagH + 14;
      chestH = 22 + CHEST_ROWS * SLOT + (CHEST_ROWS - 1) * GAP + 8;
      L.chestPanel = { x: bagX, y: cy, w: bagW, h: chestH };
      for (let r = 0; r < CHEST_ROWS; r++) {
        for (let c = 0; c < HOTBAR_N; c++) {
          L.chestRects.push({
            x: bagX + 8 + c * (SLOT + GAP),
            y: cy + 22 + r * (SLOT + GAP),
            w: SLOT, h: SLOT,
            index: r * HOTBAR_N + c
          });
        }
      }
    }

    // equipment column to the right of the bag grid
    const eqSlots = (TC.CONST && TC.CONST.EQUIP_SLOTS) || ['head', 'body', 'feet'];
    const eqX = bagX + bagW + 10;
    L.equipPanel = {
      x: eqX, y: bagY,
      w: SLOT + 16,
      h: 22 + eqSlots.length * SLOT + (eqSlots.length - 1) * GAP + 8
    };
    for (let i = 0; i < eqSlots.length; i++) {
      L.equipRects.push({
        x: eqX + 8,
        y: bagY + 22 + i * (SLOT + GAP),
        w: SLOT, h: SLOT,
        slot: eqSlots[i]
      });
    }

    // crafting column under the bag/chest panels, capped to the remaining height
    const craftTop = bagY + bagH + 14 + (chestOpen ? chestH + 14 : 0);
    const availH = h - craftTop - 56;
    L.craftMaxRows = clamp(Math.floor((availH - 44) / CRAFT_ROW_H), 1, 20);
    L.craftPanel = {
      x: 8, y: craftTop,
      w: CRAFT_W,
      h: 44 + L.craftMaxRows * CRAFT_ROW_H + 6
    };

    if (TC.state === 'playing' && UI.invOpen) {
      const cc = getCraftContext();
      if (cc) {
        L.craftCtx = cc;
        L.craftList = cc.list;
        const n = Math.min(cc.list.length, L.craftMaxRows);
        for (let i = 0; i < n; i++) {
          L.craftRects.push({
            x: L.craftPanel.x + 6,
            y: L.craftPanel.y + 40 + i * CRAFT_ROW_H,
            w: CRAFT_W - 12,
            h: CRAFT_ROW_H - 4
          });
        }
      }
    }

    // interactive regions for uiHover
    if (TC.state !== 'title') {
      for (let i = 0; i < L.hotbar.length; i++) L.uiRects.push(L.hotbar[i]);
    }
    if (UI.invOpen) {
      L.uiRects.push(L.bagPanel);
      if (L.chestPanel) L.uiRects.push(L.chestPanel);
      L.uiRects.push(L.equipPanel);
      L.uiRects.push(L.craftPanel);
    }

    // menu buttons
    if (TC.state === 'title') {
      const bw = 300, bh = 48;
      let by = Math.max(h * 0.44, h / 2 - 100);
      const defs = [
        { id: 'new', label: 'New World', act: actNewWorld },
        { id: 'seed', label: 'Custom Seed', act: actCustomSeed }
      ];
      let hasSave = false;
      try { hasSave = !!(TC.Save && TC.Save.hasSave && TC.Save.hasSave()); } catch (e) {}
      if (hasSave) defs.push({ id: 'continue', label: 'Continue World', act: actContinue });
      for (let i = 0; i < defs.length; i++) {
        L.buttons.push({
          id: defs[i].id, label: defs[i].label, act: defs[i].act,
          rect: { x: w / 2 - bw / 2, y: by, w: bw, h: bh }
        });
        by += bh + 14;
      }
    } else if (UI.paused) {
      const bw = 280, bh = 42;
      const pw = bw + 48, ph = 92 + 5 * (bh + 12);
      const px = w / 2 - pw / 2, py = Math.max(20, h / 2 - ph / 2);
      L.pausePanel = { x: px, y: py, w: pw, h: ph };
      const defs = [
        { id: 'resume', label: 'Resume', act: function () { UI.paused = false; } },
        { id: 'save', label: 'Save', act: actSave },
        { id: 'quit', label: 'Save & Quit to Title', act: actSaveQuit },
        { id: 'sound', label: soundLabel(), act: actToggleSound },
        { id: 'newworld', label: 'New World', act: actNewWorldConfirm }
      ];
      let by = py + 58;
      for (let i = 0; i < defs.length; i++) {
        L.buttons.push({
          id: defs[i].id, label: defs[i].label, act: defs[i].act,
          rect: { x: w / 2 - bw / 2, y: by, w: bw, h: bh }
        });
        by += bh + 12;
      }
    }

    return L;
  }

  // ---- drawing primitives ----
  function panel(ctx, x, y, w, h, emph) {
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = emph ? PANEL_EDGE : 'rgba(0,0,0,0.6)';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function txt(ctx, str, x, y, size, color, align, bold) {
    ctx.font = (bold ? 'bold ' : '') + size + 'px monospace';
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function txtShadow(ctx, str, x, y, size, color, align) {
    ctx.font = 'bold ' + size + 'px monospace';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(str, x + 2, y + 2);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function drawCount(ctx, str, x, y) {
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillText(str, x + 1, y + 1);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(str, x, y);
  }

  function drawIcon(ctx, id, x, y, size) {
    if (!TC.Items || typeof TC.Items.iconFor !== 'function') return;
    let ic = null;
    try { ic = TC.Items.iconFor(id); } catch (e) { ic = null; }
    if (!ic) return;
    try { ctx.drawImage(ic, x, y, size, size); } catch (e) { /* bad icon: skip */ }
  }

  function drawButton(ctx, b, mx, my) {
    const r = b.rect;
    const hov = inRect(mx, my, r);
    ctx.fillStyle = hov ? 'rgba(72,56,22,0.94)' : 'rgba(28,22,34,0.9)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.lineWidth = hov ? 2 : 1;
    ctx.strokeStyle = hov ? GOLD : 'rgba(255,210,74,0.4)';
    ctx.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    txt(ctx, b.label, r.x + r.w / 2, r.y + r.h / 2 + 1, 17, hov ? GOLD : TEXT, 'center', true);
  }

  function drawSlotBox(ctx, r, stack, opts) {
    opts = opts || {};
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.lineWidth = opts.selected ? 2 : 1;
    ctx.strokeStyle = opts.selected ? GOLD : 'rgba(255,235,180,0.28)';
    const o = opts.selected ? 1 : 0.5;
    ctx.strokeRect(r.x + o, r.y + o, r.w - o * 2, r.h - o * 2);
    if (opts.label) txt(ctx, opts.label, r.x + 5, r.y + 9, 11, TEXT_DIM, 'left');
    if (stack) {
      drawIcon(ctx, stack.id, r.x + SLOT_PAD, r.y + SLOT_PAD, SLOT - SLOT_PAD * 2);
      if (stack.count > 1) drawCount(ctx, String(stack.count), r.x + r.w - 4, r.y + r.h - 10);
    }
  }

  // ---- tooltips ----
  function itemLines(id) {
    const d = itemDef(id);
    const lines = [{ text: d ? d.name : String(id), color: GOLD }];
    if (!d) return lines;
    if (d.damage != null) lines.push({ text: 'damage ' + d.damage, color: TEXT });
    if (d.power != null) lines.push({ text: (d.tool || 'tool') + ' power ' + d.power + '%', color: TEXT });
    if (d.knockback != null) lines.push({ text: 'knockback ' + d.knockback, color: TEXT_DIM });
    if (d.kind === 'block') lines.push({ text: 'placeable', color: TEXT_DIM });
    else if (d.kind === 'material') lines.push({ text: 'crafting material', color: TEXT_DIM });
    else if (d.kind === 'ammo') lines.push({ text: 'ammunition', color: TEXT_DIM });
    lines.push({ text: 'max stack ' + maxStack(id), color: TEXT_DIM });
    return lines;
  }

  function hoverItemTooltip(mx, my, id) {
    if (!tooltip) tooltip = { x: mx + 18, y: my + 10, lines: itemLines(id) };
  }

  function craftTooltip(mx, my, rec, cc) {
    const d = itemDef(rec.out);
    const lines = [{
      text: (d ? d.name : String(rec.out)) + (rec.n > 1 ? ' x' + rec.n : ''),
      color: GOLD
    }];
    const cost = rec.cost || {};
    for (const id in cost) {
      const have = cc.inv.count(id) | 0;
      const need = cost[id];
      const cd = itemDef(id);
      lines.push({
        text: (cd ? cd.name : id) + ': ' + have + '/' + need,
        color: have >= need ? '#8fe08f' : '#ff7a6a'
      });
    }
    if (rec.station) lines.push({ text: 'requires: ' + rec.station, color: GOLD_DIM });
    tooltip = { x: mx + 18, y: my + 10, lines: lines };
  }

  function drawTooltip(ctx, w, h) {
    if (!tooltip) return;
    const pad = 8, lh = 17;
    let tw = 0;
    for (let i = 0; i < tooltip.lines.length; i++) {
      const ln = tooltip.lines[i];
      ctx.font = (ln.color === GOLD ? 'bold ' : '') + '13px monospace';
      tw = Math.max(tw, ctx.measureText(ln.text).width);
    }
    const bw = tw + pad * 2;
    const bh = tooltip.lines.length * lh + pad * 2 - 4;
    let x = tooltip.x, y = tooltip.y;
    if (x + bw > w - 6) x = Math.max(6, w - 6 - bw);
    if (y + bh > h - 6) y = Math.max(6, h - 6 - bh);
    panel(ctx, x, y, bw, bh, true);
    let yy = y + pad + 6;
    for (let i = 0; i < tooltip.lines.length; i++) {
      const ln = tooltip.lines[i];
      txt(ctx, ln.text, x + pad, yy, 13, ln.color, 'left', ln.color === GOLD);
      yy += lh;
    }
  }

  // ---- sections ----
  function drawHeart(ctx, x, y, frac) {
    const px = HEART_SIZE / 7;
    const cols = Math.round(clamp(frac, 0, 1) * 7);
    for (let r = 0; r < HEART_MAP.length; r++) {
      const row = HEART_MAP[r];
      for (let c = 0; c < 7; c++) {
        if (row.charAt(c) !== '1') continue;
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(x + c * px + 1, y + r * px + 1, Math.ceil(px), Math.ceil(px));
        ctx.fillStyle = c < cols ? '#e23b3b' : 'rgba(40,14,14,0.6)';
        ctx.fillRect(x + c * px, y + r * px, Math.ceil(px), Math.ceil(px));
      }
    }
    if (cols > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillRect(x + px, y + px, px, px);
    }
  }

  // tiny pixel shield for the defense readout
  function drawShieldGlyph(ctx, cx, cy, s) {
    const hw = s / 2, top = cy - hw;
    ctx.fillStyle = '#8d8d99';
    ctx.fillRect(cx - hw, top, s, s * 0.62);
    ctx.beginPath();
    ctx.moveTo(cx - hw, top + s * 0.5);
    ctx.lineTo(cx + hw, top + s * 0.5);
    ctx.lineTo(cx, top + s + 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c0c0cc';
    ctx.fillRect(cx - hw + 1.5, top + 1.5, s - 3, s * 0.42);
    ctx.beginPath();
    ctx.moveTo(cx - hw + 1.5, top + s * 0.44);
    ctx.lineTo(cx + hw - 1.5, top + s * 0.44);
    ctx.lineTo(cx, top + s - 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(cx - hw + 2, top + 2, 2, 3);
  }

  // one breath bubble: filled = air left, else a dim placeholder outline
  function drawBubble(ctx, x, y, filled) {
    ctx.beginPath();
    ctx.arc(x + BUBBLE_R, y + BUBBLE_R, BUBBLE_R, 0, Math.PI * 2);
    ctx.fillStyle = filled ? 'rgba(96,168,235,0.92)' : 'rgba(24,40,66,0.5)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = filled ? 'rgba(210,235,255,0.85)' : 'rgba(130,160,200,0.4)';
    ctx.stroke();
    if (filled) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(x + 2, y + 1, 2, 2);   // glint
    }
  }

  function drawHearts(ctx, w) {
    const p = TC.player;
    if (!p) return;
    const hp = Math.max(0, p.hp | 0);
    const maxHp = Math.max(1, p.maxHp | 0);
    const n = Math.ceil(maxHp / 20);
    const startX = w - 14 - n * (HEART_SIZE + 5) + 5;
    const y = 16;
    let x = startX;
    for (let i = 0; i < n; i++) {
      drawHeart(ctx, x, y, (hp - i * 20) / 20);
      x += HEART_SIZE + 5;
    }
    const def = totalDefense();          // shield glyph + number left of hearts
    if (def > 0) {
      const gy = y + HEART_SIZE / 2;
      drawShieldGlyph(ctx, startX - 24, gy, 13);
      txtShadow(ctx, String(def), startX - 38, gy + 1, 15, '#c0c0cc', 'center');
    }
    // breath bubbles under the hearts while air is draining (player.js sets .breath)
    if (breathT > 0 && typeof p.breath === 'number') {
      const filled = Math.ceil(clamp(p.breath, 0, 1) * BUBBLE_N);
      const bw = BUBBLE_N * BUBBLE_R * 2 + (BUBBLE_N - 1) * BUBBLE_GAP;
      const bx = w - 14 - bw;
      const by = y + HEART_SIZE + 6;
      ctx.save();
      ctx.globalAlpha = breathT;
      for (let i = 0; i < BUBBLE_N; i++) {
        drawBubble(ctx, bx + i * (BUBBLE_R * 2 + BUBBLE_GAP), by, i < filled);
      }
      ctx.restore();
    }
  }

  function drawHotbar(ctx, L, mx, my) {
    const inv = getInv(false);
    for (let i = 0; i < L.hotbar.length; i++) {
      const r = L.hotbar[i];
      const s = inv ? slotAt(inv, i) : null;
      drawSlotBox(ctx, r, s, { selected: UI.selected === i, label: String((i + 1) % 10) });
      if (s && inRect(mx, my, r)) hoverItemTooltip(mx, my, s.id);
    }
  }

  function drawInventory(ctx, L, mx, my) {
    const p = L.bagPanel;
    panel(ctx, p.x, p.y, p.w, p.h, true);
    txt(ctx, 'INVENTORY', p.x + 10, p.y + 12, 12, GOLD_DIM, 'left', true);
    const inv = getInv(true);
    if (!inv) {
      txt(ctx, '(inventory unavailable)', p.x + p.w / 2, p.y + p.h / 2, 13, TEXT_DIM, 'center');
      return;
    }
    for (let i = 0; i < L.bag.length; i++) {
      const r = L.bag[i];
      const s = slotAt(inv, r.index);
      drawSlotBox(ctx, r, s, {});
      if (s && inRect(mx, my, r)) hoverItemTooltip(mx, my, s.id);
    }
  }

  function drawChest(ctx, L, mx, my) {
    const p = L.chestPanel;
    panel(ctx, p.x, p.y, p.w, p.h, true);
    txt(ctx, 'CHEST', p.x + 10, p.y + 12, 12, GOLD_DIM, 'left', true);
    const cs = chestSlots();
    if (!cs) {
      txt(ctx, '(unavailable)', p.x + p.w / 2, p.y + p.h / 2, 13, TEXT_DIM, 'center');
      return;
    }
    for (let i = 0; i < L.chestRects.length; i++) {
      const r = L.chestRects[i];
      const s = liveSlot(cs, r.index);
      drawSlotBox(ctx, r, s, {});
      if (s && inRect(mx, my, r)) hoverItemTooltip(mx, my, s.id);
    }
  }

  function drawEquipment(ctx, L, mx, my) {
    const p = L.equipPanel;
    panel(ctx, p.x, p.y, p.w, p.h, true);
    txt(ctx, 'EQUIP', p.x + 10, p.y + 12, 12, GOLD_DIM, 'left', true);
    for (let i = 0; i < L.equipRects.length; i++) {
      const r = L.equipRects[i];
      const id = equippedId(r.slot);
      drawSlotBox(ctx, r, id ? { id: id, count: 1 } : null, { label: r.slot });
      if (id && inRect(mx, my, r) && !tooltip) {
        const d = itemDef(id);
        tooltip = {
          x: mx + 18, y: my + 10,
          lines: [
            { text: d ? d.name : String(id), color: GOLD },
            { text: '+' + ((d && d.defense) || 0) + ' defense', color: TEXT }
          ]
        };
      }
    }
  }

  function drawCraftColumn(ctx, L, mx, my) {
    const p = L.craftPanel;
    panel(ctx, p.x, p.y, p.w, p.h, true);
    txt(ctx, 'CRAFTING', p.x + 10, p.y + 15, 13, GOLD, 'left', true);
    const cc = L.craftCtx;
    if (!cc) {
      txt(ctx, '(unavailable)', p.x + p.w / 2, p.y + 36, 12, TEXT_DIM, 'center');
      return;
    }
    let stNames = '';
    cc.stations.forEach(function (s) { stNames += (stNames ? ', ' : '') + s; });
    txt(ctx, stNames ? 'nearby: ' + stNames : 'no station nearby',
        p.x + 10, p.y + 31, 11, TEXT_DIM, 'left');

    for (let i = 0; i < L.craftRects.length; i++) {
      const r = L.craftRects[i];
      const rec = L.craftList[i];
      if (!rec) continue;
      const hov = inRect(mx, my, r);
      if (hov) {
        ctx.fillStyle = 'rgba(255,210,74,0.12)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      drawIcon(ctx, rec.out, r.x + 4, r.y + 3, CRAFT_ROW_H - 10);
      const d = itemDef(rec.out);
      let label = d ? d.name : String(rec.out);
      if (rec.n > 1) label += ' x' + rec.n;
      txt(ctx, label, r.x + CRAFT_ROW_H + 4, r.y + r.h / 2, 13, hov ? GOLD : TEXT, 'left');
      if (hov) craftTooltip(mx, my, rec, cc);
    }
    if (L.craftList.length > L.craftRects.length) {
      txt(ctx, '+' + (L.craftList.length - L.craftRects.length) + ' more...',
          p.x + 10, p.y + 40 + L.craftRects.length * CRAFT_ROW_H + 8, 11, TEXT_DIM, 'left');
    }
  }

  function drawTitle(ctx, L, mx, my) {
    const w = L.w, h = L.h;

    // big pixel-style logo, drawn per character with layered shadows
    const str = 'TERRARIA CLONE';
    let size = 58;
    let spacing = size * 0.08;
    ctx.font = 'bold ' + size + 'px monospace';
    let total = str.length * ctx.measureText('M').width + (str.length - 1) * spacing;
    if (total > w - 40) {
      size = Math.max(18, Math.floor(size * (w - 40) / total));
      spacing = size * 0.08;
      ctx.font = 'bold ' + size + 'px monospace';
      total = str.length * ctx.measureText('M').width + (str.length - 1) * spacing;
    }
    const ly = Math.max(64, h * 0.2);
    let x = w / 2 - total / 2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold ' + size + 'px monospace';
    for (let i = 0; i < str.length; i++) {
      const ch = str.charAt(i);
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillText(ch, x + 4, ly + 4);
      ctx.fillStyle = '#7a4e2b';
      ctx.fillText(ch, x + 2, ly + 2);
      ctx.fillStyle = GOLD;
      ctx.fillText(ch, x, ly);
      x += ctx.measureText(ch).width + spacing;
    }
    txtShadow(ctx, 'an original-assets fan tribute', w / 2, ly + size * 0.8, 15,
              'rgba(255,236,180,0.9)', 'center');

    for (let i = 0; i < L.buttons.length; i++) drawButton(ctx, L.buttons[i], mx, my);

    // controls legend
    const legendY = h - 66;
    txt(ctx, 'WASD move · Space jump · LMB mine / place / attack', w / 2, legendY, 14, TEXT_DIM, 'center');
    txt(ctx, 'E inventory · Esc menu · M mute · F3 debug', w / 2, legendY + 22, 14, TEXT_DIM, 'center');
    txt(ctx, 'v' + (TC.VERSION || '?'), 10, h - 16, 12, TEXT_DIM, 'left');
  }

  function drawPause(ctx, L, mx, my) {
    ctx.fillStyle = 'rgba(8,6,14,0.55)';
    ctx.fillRect(0, 0, L.w, L.h);
    const p = L.pausePanel;
    panel(ctx, p.x, p.y, p.w, p.h, true);
    txtShadow(ctx, 'PAUSED', L.w / 2, p.y + 30, 24, GOLD, 'center');
    for (let i = 0; i < L.buttons.length; i++) drawButton(ctx, L.buttons[i], mx, my);
  }

  function respawnSeconds() {
    const p = TC.player;
    if (p) {
      const keys = ['respawnTimer', 'respawnT', 'respawnLeft', 'respawn'];
      for (let i = 0; i < keys.length; i++) {
        const v = p[keys[i]];
        if (typeof v === 'number' && isFinite(v) && v >= 0) return Math.ceil(v);
      }
    }
    const total = (TC.CONST && TC.CONST.RESPAWN_SECONDS) || 5;
    return Math.max(0, Math.ceil(total - deadT));
  }

  function drawDeath(ctx, w, h) {
    ctx.fillStyle = 'rgba(80,8,8,0.4)';
    ctx.fillRect(0, 0, w, h);
    txtShadow(ctx, 'You were slain...', w / 2, h / 2 - 30, 40, '#ff6a5a', 'center');
    const secs = respawnSeconds();
    txt(ctx, secs > 0 ? ('Respawning in ' + secs + '...') : 'Respawning...',
        w / 2, h / 2 + 18, 18, TEXT, 'center');
  }

  // ---- boss health bar ----
  function livingBoss() {
    const list = (TC.Enemies && Array.isArray(TC.Enemies.list)) ? TC.Enemies.list : null;
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e && e.def && e.def.boss && e.def.name &&
          typeof e.hp === 'number' && typeof e.maxHp === 'number') return e;
    }
    return null;
  }

  function drawBossBar(ctx, w, h) {
    const b = livingBoss();
    if (!b) return;
    const frac = clamp(b.hp / b.maxHp, 0, 1);
    const bw = Math.round(w * 0.4), bh = 14;
    const x = Math.round(w / 2 - bw / 2), y = h - bh - 26;
    txtShadow(ctx, b.def.name, w / 2, y - 11, 15, GOLD, 'center');
    ctx.fillStyle = 'rgba(10,8,16,0.78)';          // backing plate
    ctx.fillRect(x - 3, y - 3, bw + 6, bh + 6);
    ctx.fillStyle = 'rgba(30,16,26,0.9)';
    ctx.fillRect(x, y, bw, bh);
    if (frac > 0) {
      const grad = ctx.createLinearGradient(x, 0, x + bw, 0);   // red -> magenta
      grad.addColorStop(0, '#c92a3a');
      grad.addColorStop(1, '#c93ac9');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, Math.max(1, Math.round(bw * frac)), bh);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = GOLD;
    ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
  }

  // Word-wrap into lines fitting maxW; caller must set ctx.font first.
  function wrapText(ctx, str, maxW) {
    const words = String(str).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (let i = 0; i < words.length; i++) {
      const test = cur ? cur + ' ' + words[i] : words[i];
      if (!cur || ctx.measureText(test).width <= maxW) cur = test;
      else { lines.push(cur); cur = words[i]; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // Bottom-center NPC speech box: dark backing, gold border, gold speaker
  // name, white wrapped text; fades in/out over DIALOG_FADE seconds.
  function drawDialog(ctx, w, h) {
    const d = UI.dialog;
    if (!d) return;
    const alpha = clamp(Math.min(DIALOG_T - d.t, d.t) / DIALOG_FADE, 0, 1);
    const dw = Math.round(w * 0.6);
    ctx.font = '13px monospace';
    const lines = wrapText(ctx, d.text, dw - 24);
    const dh = 36 + lines.length * 18;
    const x = Math.round(w / 2 - dw / 2);
    const y = h - dh - 64;               // above the toast strip
    ctx.save();
    ctx.globalAlpha = alpha;
    panel(ctx, x, y, dw, dh, true);
    txt(ctx, d.name, x + 12, y + 16, 14, GOLD, 'left', true);
    let yy = y + 38;
    for (let i = 0; i < lines.length; i++) {
      txt(ctx, lines[i], x + 12, yy, 13, '#ffffff', 'left');
      yy += 18;
    }
    ctx.restore();
  }

  function drawToasts(ctx, w, h) {
    ctx.save();
    let y = h - 46;
    for (let i = toasts.length - 1; i >= 0; i--) {
      const t = toasts[i];
      ctx.globalAlpha = clamp(t.life / 0.4, 0, 1);
      ctx.font = 'bold 14px monospace';
      const bw = ctx.measureText(t.msg).width + 24;
      const x = w / 2 - bw / 2;
      ctx.fillStyle = 'rgba(16,12,22,0.85)';
      ctx.fillRect(x, y - 12, bw, 24);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,210,74,0.4)';
      ctx.strokeRect(x + 0.5, y - 11.5, bw - 1, 23);
      txt(ctx, t.msg, w / 2, y, 14, TEXT, 'center', true);
      y -= 32;
    }
    ctx.restore();
  }

  function drawCursorStack(ctx, mx, my) {
    if (!cursorStack) return;
    drawIcon(ctx, cursorStack.id, mx + 10, my + 8, 30);
    if (cursorStack.count > 1) drawCount(ctx, String(cursorStack.count), mx + 40, my + 36);
  }

  // ---- input ----
  function hitButton(L, x, y) {
    for (let i = 0; i < L.buttons.length; i++) {
      if (inRect(x, y, L.buttons[i].rect)) return L.buttons[i];
    }
    return null;
  }
  function hitHotbar(L, x, y) {
    for (let i = 0; i < L.hotbar.length; i++) {
      if (inRect(x, y, L.hotbar[i])) return i;
    }
    return -1;
  }
  function hitBag(L, x, y) {
    for (let i = 0; i < L.bag.length; i++) {
      if (inRect(x, y, L.bag[i])) return L.bag[i].index;
    }
    return -1;
  }
  function hitEquip(L, x, y) {
    for (let i = 0; i < L.equipRects.length; i++) {
      if (inRect(x, y, L.equipRects[i])) return L.equipRects[i].slot;
    }
    return null;
  }

  // LMB on an equipment slot: equip held armor (swap) or unequip into the bag.
  function equipClick(inv, slot, rightClick) {
    if (rightClick || !equipMap()) return;
    const cd = cursorStack ? itemDef(cursorStack.id) : null;
    if (cursorStack) {
      if (!cd || cd.kind !== 'armor') return;    // only armor may be equipped
      const target = cd.slot || slot;            // route to its own slot
      const worn = equippedId(target);
      setEquipped(target, cursorStack.id);
      cursorStack = worn ? { id: worn, count: 1 } : null;
      return;
    }
    const cur = equippedId(slot);
    if (!cur) return;
    let left = 1;
    try { left = inv.add(cur, 1); } catch (e) { left = 0; }
    if (typeof left !== 'number' || !isFinite(left)) left = 0;
    if (left > 0) { toast('Inventory full'); return; }   // stays equipped
    setEquipped(slot, null);
  }

  // Core LMB/RMB slot interaction shared by the bag and chest grids.
  // slots is a raw slot array ({id,count} stacks or null).
  function slotTransfer(slots, i, rightClick) {
    const s = liveSlot(slots, i);

    if (rightClick) {
      // place a single item from the cursor stack
      if (!cursorStack) return;
      if (!s) {
        slots[i] = { id: cursorStack.id, count: 1 };
        cursorStack.count--;
      } else if (s.id === cursorStack.id && s.count < maxStack(s.id)) {
        s.count++;
        cursorStack.count--;
      } else return;
      if (cursorStack.count <= 0) cursorStack = null;
      return;
    }

    if (!cursorStack) {
      if (!s) return;
      cursorStack = { id: s.id, count: s.count };
      slots[i] = null;
      return;
    }
    if (!s) {
      slots[i] = { id: cursorStack.id, count: cursorStack.count };
      cursorStack = null;
      return;
    }
    if (s.id === cursorStack.id) {
      const room = maxStack(s.id) - s.count;
      const move = Math.min(room, cursorStack.count);
      if (move > 0) {
        s.count += move;
        cursorStack.count -= move;
        if (cursorStack.count <= 0) cursorStack = null;
      } else {
        const oldId = s.id, oldCount = s.count; // both full: swap
        slots[i] = cursorStack;
        cursorStack = { id: oldId, count: oldCount };
      }
      return;
    }
    const oldId = s.id, oldCount = s.count;   // different items: swap
    slots[i] = cursorStack;
    cursorStack = { id: oldId, count: oldCount };
  }

  function slotClick(inv, i, rightClick) {
    const s = slotAt(inv, i);
    if (!rightClick && shiftHeld() && !cursorStack && s) {
      // with a chest open, shift moves between bag and chest; otherwise
      // it shuttles between the hotbar row and the bag rows
      const cs = UI.chest ? chestSlots() : null;
      if (cs) quickMoveRange(inv.slots, i, cs, 0, CHEST_N);
      else quickMove(inv, i);
      return;
    }
    slotTransfer(inv.slots, i, rightClick);
  }

  // shift-move src[i] into dst[lo..hi): merge into matching stacks first,
  // then the first empty slot; clears src[i] when fully moved.
  function quickMoveRange(src, i, dst, lo, hi) {
    const s = src[i];
    if (!s || !s.id || !(s.count > 0)) return;
    const max = maxStack(s.id);
    for (let j = lo; j < hi && s.count > 0; j++) {   // merge first
      const t = liveSlot(dst, j);
      if (t && t.id === s.id && t.count < max) {
        const move = Math.min(max - t.count, s.count);
        t.count += move;
        s.count -= move;
      }
    }
    for (let j = lo; j < hi && s.count > 0; j++) {   // then first empty slot
      if (!liveSlot(dst, j)) {
        dst[j] = { id: s.id, count: s.count };
        s.count = 0;
      }
    }
    if (s.count <= 0) src[i] = null;
  }

  // shift+LMB within the player inventory only: hotbar row <-> bag rows
  function quickMove(inv, i) {
    const fromHotbar = i < HOTBAR_N;
    quickMoveRange(inv.slots, i, inv.slots,
      fromHotbar ? HOTBAR_N : 0,
      fromHotbar ? INV_N : HOTBAR_N);
  }

  function onClick(L, mx, my, rightClick) {
    if (TC.state === 'title') {
      if (rightClick) return;
      const b = hitButton(L, mx, my);
      if (b && b.act) b.act();
      return;
    }
    if (TC.state !== 'playing') return;

    if (UI.paused) {           // modal: pause buttons only
      if (rightClick) return;
      const b = hitButton(L, mx, my);
      if (b && b.act) b.act();
      return;
    }

    if (!UI.invOpen) {
      const i = hitHotbar(L, mx, my);
      if (i >= 0 && !rightClick) {
        UI.selected = i;
        if (TC.player) TC.player.hotbarIndex = i; // keep player.js in sync
      }
      return;
    }

    const inv = getInv(true);
    if (!inv) return;

    // crafting rows
    if (!rightClick && L.craftCtx) {
      for (let i = 0; i < L.craftRects.length; i++) {
        if (inRect(mx, my, L.craftRects[i])) {
          let ok = false;
          try { ok = TC.Crafting.craft(L.craftList[i], L.craftCtx.inv, L.craftCtx.stations); }
          catch (e) { ok = false; }
          if (ok && TC.Audio) TC.Audio.play('craft');
          return;
        }
      }
    }

    // hotbar + bag slots
    let slot = hitHotbar(L, mx, my);
    if (slot < 0) slot = hitBag(L, mx, my);
    if (slot >= 0) { slotClick(inv, slot, rightClick); return; }

    // equipment slots
    const es = hitEquip(L, mx, my);
    if (es) { equipClick(inv, es, rightClick); return; }

    // chest grid (shift+LMB sends stacks to the player inventory)
    const cs = UI.chest ? chestSlots() : null;
    if (cs) {
      for (let i = 0; i < L.chestRects.length; i++) {
        const r = L.chestRects[i];
        if (!inRect(mx, my, r)) continue;
        const s = liveSlot(cs, r.index);
        if (!rightClick && shiftHeld() && !cursorStack && s) {
          quickMoveRange(cs, r.index, inv.slots, 0, INV_N);
          return;
        }
        slotTransfer(cs, r.index, rightClick);
        return;
      }
    }

    // outside every panel: throw the held stack toward the cursor
    let overUI = false;
    for (let i = 0; i < L.uiRects.length; i++) {
      if (inRect(mx, my, L.uiRects[i])) { overUI = true; break; }
    }
    if (!overUI && cursorStack && !rightClick) {
      throwStack(cursorStack, mx, my);
      cursorStack = null;
    }
  }

  // Runs every rendered frame (main calls Input.endFrame right after draw,
  // so per-frame latched keys/mouse edges are consumed exactly once here).
  function processInput(L) {
    const inp = TC.Input;
    if (!inp) return;

    if (TC.state === 'playing') {
      const dead = !!(TC.player && TC.player.dead);
      if (UI.dialog) {
        if (pressed('Escape')) UI.dialog = null;   // Esc dismisses the dialog first
      } else if (UI.paused) {
        if (pressed('Escape')) UI.paused = false;
      } else if (UI.invOpen) {
        if (pressed('Escape') || pressed('KeyE')) closeInventory();
      } else {
        if (pressed('KeyE') && !dead && getInv(true)) UI.invOpen = true;
        else if (pressed('Escape')) UI.paused = true;
      }
      // Hotbar digits/wheel are intentionally NOT handled here: player.js
      // readHotbar() owns selection (and consumes inp.hotbarScroll); the UI
      // mirrors TC.player.hotbarIndex in syncState().
    }
    // M (mute) and F3 (debug) are intentionally not bound here to avoid
    // double-toggling if the input module owns them.

    const m = inp.mouse || {};
    const mx = m.x | 0, my = m.y | 0;
    // clicked/rightClicked are latched by input.js for one frame, so a
    // press+release that lands entirely between two frames is still seen.
    // While a dialog is visible the first click only dismisses it: the latch
    // is swallowed here so it never reaches onClick; updateHover() also
    // raises uiHover for the dialog's lifetime so player.js world actions
    // (held mining, RMB interact) stay suppressed.
    if (UI.dialog && (m.clicked || m.rightClicked)) {
      UI.dialog = null;
    } else {
      if (m.clicked) onClick(L, mx, my, false);
      if (m.rightClicked) onClick(L, mx, my, true);
    }
  }

  // Mark frames where the pointer sits on any UI surface so world clicks
  // are suppressed; input.endFrame resets the flag each frame.
  function updateHover(L, mx, my) {
    if (TC.state === 'playing' && UI.dialog) {
      if (TC.Input) TC.Input.uiHover = true;   // visible dialog swallows clicks anywhere
      return;
    }
    if (TC.state === 'playing' && UI.paused) {
      if (TC.Input) TC.Input.uiHover = true;   // modal covers the screen
      return;
    }
    for (let i = 0; i < L.uiRects.length; i++) {
      if (inRect(mx, my, L.uiRects[i])) {
        if (TC.Input) TC.Input.uiHover = true;
        return;
      }
    }
    for (let i = 0; i < L.buttons.length; i++) {
      if (inRect(mx, my, L.buttons[i].rect)) {
        if (TC.Input) TC.Input.uiHover = true;
        return;
      }
    }
  }

  // ---- per-frame state sync ----
  function syncState() {
    if (prevState !== TC.state) {
      if (TC.state === 'title') resetPanels();
      prevState = TC.state;
    }
    // player.js owns hotbar selection (digits + wheel); mirror it for drawing
    const p = TC.player;
    if (p && typeof p.hotbarIndex === 'number') {
      UI.selected = ((p.hotbarIndex | 0) % HOTBAR_N + HOTBAR_N) % HOTBAR_N;
    }
    const dead = !!(p && p.dead);
    if (dead && !wasDead) {
      if (UI.invOpen) closeInventory();
      UI.paused = false;
      deadT = 0;
    }
    wasDead = dead;
    // the chest panel follows its tile: auto-close (re-stashing the cursor)
    // if the chest was mined or otherwise removed while open
    if (UI.chest && TC.state === 'playing' &&
        TC.world && typeof TC.world.get === 'function' && TC.TILE) {
      let id = null;
      try { id = TC.world.get(UI.chest.tx, UI.chest.ty); } catch (e) { id = null; }
      if (id !== TC.TILE.CHEST) {
        UI.chest = null;
        stashCursorOrThrow();
      }
    }
  }

  // ---- public API ----
  UI.update = function (dt) {
    if (TC.player && TC.player.dead) deadT += dt;
    // ease the breath bubble row in/out quickly as the player submerges/surfaces
    const br = TC.player ? TC.player.breath : null;
    const showBreath = typeof br === 'number' && br < 1;
    breathT = clamp(breathT + (showBreath ? dt : -dt) / BREATH_FADE, 0, 1);
    if (UI.dialog) {
      UI.dialog.t -= dt;
      if (UI.dialog.t <= 0) UI.dialog = null;
    }
    for (let i = toasts.length - 1; i >= 0; i--) {
      toasts[i].life -= dt;
      if (toasts[i].life <= 0) toasts.splice(i, 1);
    }
  };

  UI.draw = function (ctx, w, h) {
    syncState();
    const L = layout(w, h);
    processInput(L);

    const m = mousePos();
    const mx = m.x | 0, my = m.y | 0;
    tooltip = null;

    if (TC.state === 'title') {
      drawTitle(ctx, L, mx, my);
    } else {
      drawHearts(ctx, w);
      drawHotbar(ctx, L, mx, my);
      if (UI.invOpen) {
        drawInventory(ctx, L, mx, my);
        if (L.chestPanel) drawChest(ctx, L, mx, my);
        drawEquipment(ctx, L, mx, my);
        drawCraftColumn(ctx, L, mx, my);
      }
      drawBossBar(ctx, w, h);
      if (TC.player && TC.player.dead) drawDeath(ctx, w, h);
      if (UI.paused && L.pausePanel) drawPause(ctx, L, mx, my);
    }

    drawTooltip(ctx, w, h);
    if (TC.state === 'playing') drawDialog(ctx, w, h);   // NPC dialog, under toasts
    drawToasts(ctx, w, h);
    drawCursorStack(ctx, mx, my);
    updateHover(L, mx, my);
  };
})();
