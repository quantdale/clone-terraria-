/* music.js — generative WebAudio soundtrack. Day pentatonic arpeggio, night drone,
   boss pulse, plus per-biome variations driven by TC.Biomes.musicTag (underworld
   drone, snow arpeggio, jungle percussion, desert phrygian plucks, ocean swells).
   Mood priority: boss > biome > day/night; crossfaded mood buses. Own independent
   AudioContext (lazy, after first gesture) so TC.Audio SFX throttling is unaffected.
   Failures never crash the game. */
'use strict';
(function () {
  window.TC = window.TC || {};
  const TC = window.TC;

  const MASTER_VOL = 0.12;       // quiet bed under SFX
  const LOOKAHEAD = 0.3;         // seconds of notes scheduled ahead of ctx.currentTime
  const FADE_TC = 0.7;           // crossfade time constant (~2s to settle)
  const MOODS = ['day', 'night', 'boss', 'underworld', 'snow', 'jungle', 'desert', 'ocean'];
  // Biome tags that select their own mood bus; forest/cave keep the day/night pair.
  const BIOME_MOODS = { underworld: 1, snow: 1, jungle: 1, desert: 1, ocean: 1 };

  let ctx = null;                // AudioContext, created lazily on first user gesture
  let master = null;             // master gain node
  const buses = {};              // mood name -> gain node feeding master
  let mood = '';                 // currently selected mood
  let mutedApplied = false;      // mute state last pushed to master gain

  // Per-layer scheduler clocks (absolute ctx time of next event).
  const layers = {
    arp:     { next: 0 },
    pad:     { next: 0 },
    drone:   { next: 0 },
    wash:    { next: 0 },
    bell:    { next: 0 },
    bass:    { next: 0 },
    udrone:  { next: 0 },        // underworld ominous drone
    snowarp: { next: 0 },        // snow hushed arpeggio
    perc:    { next: 0 },        // jungle percussion pulse
    dune:    { next: 0 },        // desert sparse plucks
    swell:   { next: 0 }         // ocean wave swells
  };
  let bassStep = 0;              // eighth-note counter for the boss bass pattern
  let percStep = 0;              // step counter for the jungle percussion accent

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function ensureCtx() {
    if (ctx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = mutedApplied ? 0 : MASTER_VOL;
      master.connect(ctx.destination);
      for (let i = 0; i < MOODS.length; i++) {
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(master);
        buses[MOODS[i]] = g;
      }
    } catch (e) {
      ctx = null; master = null;
      for (const k in buses) delete buses[k];
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
    retune(true);
  }
  window.addEventListener('keydown', unlock);
  window.addEventListener('mousedown', unlock);

  // Ramp mood buses toward their targets; optionally restart layer clocks so the
  // entering mood begins immediately (outgoing voices simply ring out under the fade).
  function retune(restart) {
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    for (const k in buses) {
      try {
        buses[k].gain.cancelScheduledValues(t);
        buses[k].gain.setTargetAtTime(k === mood ? 1 : 0, t, FADE_TC);
      } catch (e) { /* ignore */ }
    }
    if (restart) {
      for (const k in layers) layers[k].next = t + 0.06;
      bassStep = 0;
      percStep = 0;
    }
  }

  // ---- game-state sensing ----
  function senseMood() {
    try {
      if (TC.Enemies && TC.Enemies.list) {
        for (let i = 0; i < TC.Enemies.list.length; i++) {
          const e = TC.Enemies.list[i];
          if (e && e.def && e.def.boss) return 'boss';
        }
      }
      // Biome variation outranks day/night but never a living boss.
      const tag = TC.Biomes && TC.Biomes.musicTag;
      if (BIOME_MOODS[tag]) return tag;
      if (TC.Sky && typeof TC.Sky.daylight === 'function') {
        return TC.Sky.daylight() >= 0.5 ? 'day' : 'night';
      }
    } catch (e) { /* fall through to safest default */ }
    return 'night';
  }

  function followMute() {
    let m = false;
    try { m = !!(TC.Audio && TC.Audio.muted); } catch (e) { /* ignore */ }
    if (m === mutedApplied) return;
    mutedApplied = m;
    try {
      if (ctx && master) {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setTargetAtTime(m ? 0 : MASTER_VOL, ctx.currentTime, 0.4);
      }
    } catch (e) { /* ignore */ }
  }

  // ---- voice helpers ----
  // One decaying oscillator note into a mood bus.
  function note(bus, type, freq, t0, dur, vol) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(freq, 1), t0);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(bus);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  let noiseBuf = null;
  function getNoise() {
    if (noiseBuf || !ctx) return noiseBuf;
    try {
      const len = (ctx.sampleRate * 2) | 0;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { noiseBuf = null; }
    return noiseBuf;
  }

  // ---- day: pluck arpeggio + slow detuned-sine pads ----
  const ARP = [57, 60, 62, 64, 67];            // A minor pentatonic around A3
  function arpNote(t0) {
    let m = ARP[(Math.random() * ARP.length) | 0];
    const r = Math.random();
    if (r < 0.3) m += 12; else if (r > 0.92) m -= 12;
    note(buses.day, 'triangle', mtof(m), t0, 0.4, 0.22);
  }

  // i - VI - III - VII in A minor; index 0 is the bass tone.
  const PADS = [
    [45, 57, 60, 64],                          // Am
    [41, 53, 57, 60],                          // F
    [48, 55, 60, 64],                          // C
    [43, 55, 59, 62]                           // G
  ];
  let padIdx = 0;
  function padChord(t0) {
    const notes = PADS[padIdx % PADS.length];
    padIdx++;
    const end = t0 + 9.5;                      // 8s between changes + overlap tail
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 800;
    flt.connect(buses.day);
    for (let i = 0; i < notes.length; i++) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(i === 0 ? 0.16 : 0.08, t0 + 1.2);
      g.gain.linearRampToValueAtTime(0.0001, end);
      g.connect(flt);
      for (let d = -1; d <= 1; d += 2) {       // two slightly detuned sines per tone
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = mtof(notes[i]);
        o.detune.value = d * 5;
        o.connect(g);
        o.start(t0);
        o.stop(end + 0.05);
      }
    }
  }

  // ---- night: low drone + filtered noise wash + distant bells ----
  // Low sustained drone; parameterized so the underworld mood reuses it darker
  // (lower root, slowly beating detuned pair, faint tritone partial).
  function drone(t0, bus, f0, f1, peak, dur, beatCents, partialF, partialVol) {
    bus = bus || buses.night;
    f0 = f0 || 55;
    f1 = f1 == null ? 55.6 : f1;                 // barely-moving drift
    peak = peak || 0.22;
    dur = dur || 10;
    const end = t0 + dur;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + dur * 0.2);
    g.gain.linearRampToValueAtTime(0.0001, end);
    const osc = (fq, cents) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(fq, t0);
      o.frequency.linearRampToValueAtTime(f1, end);
      o.detune.value = cents || 0;
      o.connect(g);
      o.start(t0);
      o.stop(end + 0.05);
    };
    osc(f0, 0);
    if (beatCents) osc(f0, beatCents);           // slow-beating twin
    if (partialF) {                              // quiet dissonant color
      const pg = ctx.createGain();
      pg.gain.value = partialVol || 0.05;
      const po = ctx.createOscillator();
      po.type = 'triangle';
      po.frequency.setValueAtTime(partialF, t0);
      po.connect(pg).connect(g);
      po.start(t0);
      po.stop(end + 0.05);
    }
    g.connect(bus);
  }

  // Underworld: the night drone sunk to D1 with a beating twin and a
  // tritone shadow — low and ominous.
  function udrone(t0) {
    drone(t0, buses.underworld, 36.7, 37.3, 0.3, 12, 16, 51.9, 0.05);
  }

  // Filtered-noise swell; the night wash and ocean waves share this voice.
  // o: { bus, dur, atk, sweep, fLo, fHi, peak }
  function wash(t0, o) {
    const buf = getNoise();
    if (!buf) return;
    o = o || {};
    const bus = o.bus || buses.night;
    const dur = o.dur || 11;
    const atk = o.atk || 2.5;
    const sweep = o.sweep || 5.5;
    const fLo = o.fLo || 180;
    const fHi = o.fHi || 420;
    const end = t0 + dur;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.Q.value = 0.5;
    flt.frequency.setValueAtTime(fLo, t0);
    flt.frequency.linearRampToValueAtTime(fHi, t0 + sweep);
    flt.frequency.linearRampToValueAtTime(fLo, end);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.peak || 0.05, t0 + atk);
    g.gain.linearRampToValueAtTime(0.0001, end);
    src.connect(flt).connect(g).connect(bus);
    src.start(t0);
    src.stop(end + 0.05);
  }

  // Ocean: slow lowpass sweeps rolling in and out like waves.
  function swell(t0) {
    wash(t0, { bus: buses.ocean, dur: 13, atk: 4, sweep: 6.5, fLo: 110, fHi: 520, peak: 0.06 });
  }

  const BELLS = [81, 84, 88, 93];              // A4 C5 E5 A5
  function bellNote(t0) {
    note(buses.night, 'sine', mtof(BELLS[(Math.random() * BELLS.length) | 0]), t0, 3.5, 0.1);
  }

  // ---- snow: the day arpeggio hushed, raised an octave and stretched out ----
  function snowArp(t0) {
    let m = ARP[(Math.random() * ARP.length) | 0] + 12;
    if (Math.random() < 0.25) m -= 12;         // occasional low anchor tone
    note(buses.snow, 'sine', mtof(m), t0, 1.6, 0.11);
  }

  // ---- jungle: short bandpassed noise hits, accented on the quarter note ----
  function perc(t0, accent) {
    const buf = getNoise();
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.Q.value = 1.2;
    flt.frequency.value = accent ? 320 : 210;
    const g = ctx.createGain();
    g.gain.setValueAtTime(accent ? 0.14 : 0.06, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
    src.connect(flt).connect(g).connect(buses.jungle);
    src.start(t0, Math.random() * 1.5);        // fresh slice of the noise bed
    src.stop(t0 + 0.15);
  }

  // ---- desert: sparse plucks from A phrygian (the flat-2 gives the flavor) ----
  const PHRYGIAN = [57, 58, 60, 62, 64, 65, 67];
  function dunePluck(t0) {
    let m = PHRYGIAN[(Math.random() * PHRYGIAN.length) | 0];
    if (Math.random() < 0.25) m -= 12;
    note(buses.desert, 'triangle', mtof(m), t0, 1.1, 0.15);
  }

  // ---- boss: driving eighth pulse + minor-second stab each bar ----
  const EIGHTH = 60 / 140 / 2;                 // 140 bpm
  const BASS = [33, 33, 45, 33, 36, 33, 45, 31];
  function stab(t0) {
    note(buses.boss, 'square', mtof(69), t0, 0.22, 0.07);   // A4 + A#4 rub
    note(buses.boss, 'square', mtof(70), t0, 0.22, 0.07);
  }

  // ---- lookahead scheduler ----
  function schedule() {
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    // Clamp clocks stalled by tab suspension so they never burst-catch-up.
    for (const k in layers) if (layers[k].next < now - 0.5) layers[k].next = now;

    if (mood === 'day') {
      while (layers.arp.next < horizon) { arpNote(layers.arp.next); layers.arp.next += 0.5; }
      while (layers.pad.next < horizon) { padChord(layers.pad.next); layers.pad.next += 8; }
    } else if (mood === 'night') {
      while (layers.drone.next < horizon) { drone(layers.drone.next); layers.drone.next += 9; }
      while (layers.wash.next < horizon) { wash(layers.wash.next); layers.wash.next += 10.5; }
      while (layers.bell.next < horizon) { bellNote(layers.bell.next); layers.bell.next += 6 + Math.random() * 4; }
    } else if (mood === 'boss') {
      while (layers.bass.next < horizon) {
        note(buses.boss, 'square', mtof(BASS[bassStep % BASS.length]), layers.bass.next, 0.13, 0.18);
        if (bassStep % 8 === 0) stab(layers.bass.next);
        bassStep++;
        layers.bass.next += EIGHTH;
      }
    } else if (mood === 'underworld') {
      while (layers.udrone.next < horizon) { udrone(layers.udrone.next); layers.udrone.next += 11; }
    } else if (mood === 'snow') {
      while (layers.snowarp.next < horizon) { snowArp(layers.snowarp.next); layers.snowarp.next += 0.85; }
    } else if (mood === 'jungle') {
      while (layers.perc.next < horizon) {
        perc(layers.perc.next, percStep % 4 === 0);
        percStep++;
        layers.perc.next += 0.23;              // ~130 bpm eighths
      }
    } else if (mood === 'desert') {
      while (layers.dune.next < horizon) {
        dunePluck(layers.dune.next);
        layers.dune.next += 1.6 + Math.random() * 2.8;
      }
    } else if (mood === 'ocean') {
      while (layers.swell.next < horizon) { swell(layers.swell.next); layers.swell.next += 11.5; }
    }
  }

  TC.Music = {
    // Call once per simulation step; safe at 60Hz and safe before first gesture.
    update(dt) {
      try {
        followMute();
        const next = senseMood();
        if (next !== mood) { mood = next; retune(true); }
        if (!ctx || !master) return;
        schedule();
      } catch (e) { /* music must never crash the game */ }
    },
    // Passthrough: keep TC.Audio's mute flag in sync, then ramp our master gain.
    setMuted(b) {
      try {
        b = !!b;
        if (TC.Audio && typeof TC.Audio.toggleMuted === 'function') {
          let guard = 0;
          while (!!TC.Audio.muted !== b && guard++ < 2) TC.Audio.toggleMuted();
        }
        mutedApplied = b;
        if (ctx && master) {
          master.gain.cancelScheduledValues(ctx.currentTime);
          master.gain.setTargetAtTime(b ? 0 : MASTER_VOL, ctx.currentTime, 0.4);
        }
      } catch (e) { /* ignore */ }
    }
  };
})();
