/* audio.js — procedural WebAudio SFX. No external assets; audio failures never crash the game. */
'use strict';
(function () {
  window.TC = window.TC || {};
  const TC = window.TC;

  const MASTER_VOL = 0.35;
  const RATE_MS = 40;            // min gap between identical sounds

  let ctx = null;                // AudioContext, created lazily on first user gesture
  let master = null;             // master gain node
  let muted = false;
  let noiseBuf = null;           // shared white-noise buffer
  const lastPlay = {};           // name -> performance.now() of last play

  function ensureCtx() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_VOL;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null; master = null;
      return false;
    }
    return true;
  }

  // Browsers require a user gesture before audio may start; create + resume there.
  function unlock() {
    window.removeEventListener('keydown', unlock);
    window.removeEventListener('mousedown', unlock);
    if (!ensureCtx()) return;
    try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) { /* ignore */ }
  }
  window.addEventListener('keydown', unlock);
  window.addEventListener('mousedown', unlock);

  function getNoise() {
    if (noiseBuf || !ctx) return noiseBuf;
    try {
      const len = (ctx.sampleRate * 0.5) | 0;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { noiseBuf = null; }
    return noiseBuf;
  }

  // Pitched voice gliding f0 -> f1 with exponential decay.
  function blip(type, f0, f1, dur, vol, when) {
    const t0 = ctx.currentTime + (when || 0);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(f0, 1), t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  // Filtered white-noise burst whose filter sweeps f0 -> f1.
  function hiss(type, q, f0, f1, dur, vol, when) {
    const buf = getNoise();
    if (!buf) return;
    const t0 = ctx.currentTime + (when || 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(Math.max(f0, 10), t0);
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(Math.max(f1, 10), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(flt).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // Sound recipes; volumes are relative to the master gain.
  const SOUNDS = {
    dig()    { blip('triangle', 150, 60, 0.09, 0.5); hiss('lowpass', 1, 380, 110, 0.08, 0.35); },
    place()  { blip('square', 1100, 700, 0.035, 0.18); hiss('highpass', 1, 2000, 2000, 0.03, 0.25); },
    break()  { hiss('bandpass', 0.7, 1600, 250, 0.17, 0.55); blip('triangle', 210, 80, 0.1, 0.4); },
    jump()   { blip('sine', 260, 520, 0.14, 0.14); },
    swing()  { hiss('bandpass', 1.2, 500, 2300, 0.16, 0.3); },
    hit()    { blip('sine', 180, 55, 0.1, 0.5); hiss('lowpass', 1, 1000, 250, 0.06, 0.25); },
    hurt()   { blip('sawtooth', 450, 130, 0.22, 0.3); },
    pickup() { blip('square', 750, 750, 0.06, 0.16); blip('square', 1125, 1125, 0.08, 0.16, 0.07); },
    craft()  { blip('triangle', 523, 523, 0.09, 0.26); blip('triangle', 784, 784, 0.13, 0.26, 0.1); },
    die()    { blip('sawtooth', 330, 40, 0.9, 0.28); hiss('lowpass', 1, 800, 90, 0.7, 0.2); },
    thunder() {
      // Distant rumble: long low-passed noise swell with a crack onset.
      hiss('lowpass', 0.6, 900, 60, 1.8, 0.5);
      hiss('bandpass', 2, 2400, 300, 0.25, 0.35);
      blip('sine', 55, 30, 1.6, 0.3, 0.05);
    }
  };

  TC.Audio = {
    play(name) {
      try {
        const fn = SOUNDS[name];
        if (!fn) return;                          // unknown names: silently ignored
        const now = performance.now();
        if (now - (lastPlay[name] || 0) < RATE_MS) return;
        lastPlay[name] = now;
        if (!ctx || !master) return;              // not unlocked by a gesture yet
        fn();
      } catch (e) { /* audio must never crash the game */ }
    },
    toggleMuted() {
      muted = !muted;
      try {
        if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : MASTER_VOL, ctx.currentTime, 0.01);
      } catch (e) { /* ignore */ }
      return muted;
    },
    get muted() { return muted; }
  };
})();
