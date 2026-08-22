/* input.js — keyboard/mouse state, hotbar wheel, tile cursor overlay. */
'use strict';
(function () {
  const TC = window.TC;

  const keys = new Set();        // e.code strings currently held
  const justPressed = new Set(); // codes that went down since last endFrame()

  const mouse = {
    x: 0, y: 0, down: false, rightDown: false, worldX: 0, worldY: 0,
    clicked: false, rightClicked: false // latched for one frame; survives press+release inside a single frame
  };

  // keys that would scroll/leave the page if unhandled
  const SCROLL_PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

  function updateWorldMouse() {
    const cam = TC.camera;
    const z = (cam && cam.zoom) ? cam.zoom : 1;
    mouse.worldX = mouse.x / z + (cam ? cam.x : 0);
    mouse.worldY = mouse.y / z + (cam ? cam.y : 0);
  }

  const input = {
    mouse,
    hotbarScroll: 0,             // accumulated wheel notches; player/UI reads then zeroes
    uiHover: false,              // TC.UI writes this every frame; see drawCursor

    init(cvs) {
      window.addEventListener('keydown', (e) => {
        if (SCROLL_PREVENT.has(e.code)) e.preventDefault();
        if (!e.repeat) justPressed.add(e.code);
        keys.add(e.code);
      });
      window.addEventListener('keyup', (e) => { keys.delete(e.code); });
      // avoid stuck keys/buttons when the tab loses focus mid-press
      window.addEventListener('blur', () => {
        keys.clear();
        mouse.down = false;
        mouse.rightDown = false;
      });

      cvs.addEventListener('mousedown', (e) => {
        if (e.button === 0) { mouse.down = true; mouse.clicked = true; }
        else if (e.button === 2) { mouse.rightDown = true; mouse.rightClicked = true; }
        updateWorldMouse();
      });
      // mouseup on window so a release outside the canvas still registers
      window.addEventListener('mouseup', (e) => {
        if (e.button === 0) mouse.down = false;
        else if (e.button === 2) mouse.rightDown = false;
      });
      cvs.addEventListener('mousemove', (e) => {
        const r = cvs.getBoundingClientRect();
        mouse.x = e.clientX - r.left;
        mouse.y = e.clientY - r.top;
        updateWorldMouse();
      });
      cvs.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY !== 0) {
          // one notch = +/-1 (down = +1); clamp so inertial trackpads can't run away
          input.hotbarScroll = Math.max(-8, Math.min(8, input.hotbarScroll + Math.sign(e.deltaY)));
        }
      }, { passive: false });
      cvs.addEventListener('contextmenu', (e) => e.preventDefault());
    },

    down(code) { return keys.has(code); },
    pressed(code) { return justPressed.has(code); },

    axis() {
      const l = keys.has('KeyA') || keys.has('ArrowLeft');
      const r = keys.has('KeyD') || keys.has('ArrowRight');
      return {
        x: (r ? 1 : 0) - (l ? 1 : 0),
        jump: keys.has('Space') || keys.has('KeyW') || keys.has('ArrowUp')
      };
    },

    // called by main after draw each frame: drops per-frame key edge state.
    // uiHover is deliberately NOT cleared here: draw order is cursor -> UI ->
    // endFrame, so the flag UI set last frame must survive until drawCursor
    // reads it (drawCursor consumes it instead).
    endFrame() {
      justPressed.clear();
      mouse.clicked = false;
      mouse.rightClicked = false;
      updateWorldMouse();
    },

    // Transition barrier for menu -> gameplay ownership (main.js calls this
    // whenever a state transition enters/exits gameplay). Any pointer/key
    // event consumed to drive the menu must not ALSO surface as a gameplay
    // action: held button/key state and every latched edge are dropped here,
    // so the simulation only reacts to input from a FRESH post-transition
    // press. This matters because a title click's mouseup can sit queued
    // behind synchronous worldgen, leaving mouse.down true across several
    // fixed steps of the first playing frames.
    barrier() {
      keys.clear();
      justPressed.clear();
      mouse.down = false;
      mouse.rightDown = false;
      mouse.clicked = false;
      mouse.rightClicked = false;
      input.hotbarScroll = 0;
      updateWorldMouse();
    },

    // screen-space tile outline; called by main between Lighting and UI
    drawCursor(ctx, cam) {
      const hover = input.uiHover;
      input.uiHover = false;     // consume; UI rewrites it during its draw pass
      if (TC.state !== 'playing' || hover || !TC.player) return;

      const ts = TC.CONST.TS;
      const tx = Math.floor(mouse.worldX / ts);
      const ty = Math.floor(mouse.worldY / ts);

      // white when the tile center is within REACH of the player center
      const cx = TC.player.x + TC.player.w / 2;
      const cy = TC.player.y + TC.player.h / 2;
      const dx = (tx + 0.5) * ts - cx;
      const dy = (ty + 0.5) * ts - cy;
      const inReach = dx * dx + dy * dy <= TC.CONST.REACH * TC.CONST.REACH;

      const z = (cam && cam.zoom) ? cam.zoom : 1;
      const sx = Math.round((tx * ts - cam.x) * z) + 0.5; // half-px offset = crisp 1px line
      const sy = Math.round((ty * ts - cam.y) * z) + 0.5;
      const s = ts * z;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.lineWidth = 1;
      ctx.strokeStyle = inReach ? 'rgba(255,255,255,0.85)' : 'rgba(255,70,50,0.4)';
      ctx.strokeRect(sx, sy, s, s);
      ctx.restore();
    }
  };

  TC.Input = input;
})();
