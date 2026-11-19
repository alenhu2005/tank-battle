'use strict';

// 音效：全部用 Web Audio 即時合成，不需要下載任何音檔
(function () {
  let ctx = null, master = null, noiseBuf = null;
  let volume = 0.7, enabled = true;
  const lastPlayed = {};

  function ensure() {
    if (!enabled) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // 手機要在使用者點擊後才能發聲
  ['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => ensure(), { passive: true }));

  function tone({ type = 'square', from, to = from, dur = 0.1, gain = 0.2, delay = 0 }) {
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  function noise({ dur = 0.3, gain = 0.4, freq = 800, q = 0.8, type = 'lowpass', delay = 0 }) {
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + delay;
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    src.buffer = noiseBuf;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  const SOUNDS = {
    shot:      v => tone({ type: 'square', from: 720, to: 260, dur: 0.07, gain: 0.12 * v }),
    boom:      v => { noise({ dur: 0.5, gain: 0.55 * v, freq: 500 }); tone({ type: 'sine', from: 120, to: 40, dur: 0.35, gain: 0.35 * v }); },
    blast:     v => { noise({ dur: 0.4, gain: 0.45 * v, freq: 700 }); tone({ type: 'sine', from: 160, to: 50, dur: 0.25, gain: 0.25 * v }); },
    baseBoom:  v => { noise({ dur: 1.2, gain: 0.7 * v, freq: 350 }); tone({ type: 'sawtooth', from: 90, to: 30, dur: 1, gain: 0.3 * v }); },
    brick:     v => noise({ dur: 0.09, gain: 0.25 * v, freq: 1800, type: 'bandpass', q: 1.2 }),
    skill:     v => { tone({ type: 'sine', from: 500, to: 1400, dur: 0.18, gain: 0.14 * v }); },
    wallHit:   v => { noise({ dur: 0.06, gain: 0.2 * v, freq: 900, type: 'bandpass', q: 2 }); tone({ type: 'square', from: 220, to: 160, dur: 0.06, gain: 0.08 * v }); },
    spark:     v => tone({ type: 'triangle', from: 1800, to: 900, dur: 0.04, gain: 0.08 * v }),
    armor:     v => tone({ type: 'square', from: 300, to: 200, dur: 0.12, gain: 0.15 * v }),
    heal:      v => { tone({ type: 'sine', from: 600, to: 1200, dur: 0.2, gain: 0.1 * v }); },
    portal:    v => { tone({ type: 'sine', from: 300, to: 1500, dur: 0.25, gain: 0.1 * v }); },
    laser:     v => { tone({ type: 'sawtooth', from: 1800, to: 200, dur: 0.35, gain: 0.14 * v }); noise({ dur: 0.3, gain: 0.25 * v, freq: 1200 }); },
    spawn:     v => tone({ type: 'sine', from: 400, to: 900, dur: 0.25, gain: 0.12 * v }),
    pickup:    v => { tone({ type: 'square', from: 660, dur: 0.08, gain: 0.12 * v }); tone({ type: 'square', from: 990, dur: 0.12, gain: 0.12 * v, delay: 0.08 }); },
    itemSpawn: v => tone({ type: 'triangle', from: 1200, to: 1600, dur: 0.15, gain: 0.07 * v }),
    freezeHit: v => tone({ type: 'sine', from: 2400, to: 1200, dur: 0.3, gain: 0.12 * v }),
    confuseHit:v => { tone({ type: 'sine', from: 500, to: 900, dur: 0.15, gain: 0.12 * v }); tone({ type: 'sine', from: 900, to: 500, dur: 0.15, gain: 0.12 * v, delay: 0.15 }); },
    emp:       v => tone({ type: 'sawtooth', from: 80, to: 1600, dur: 0.5, gain: 0.15 * v }),
    timestop:  v => tone({ type: 'sine', from: 1000, to: 100, dur: 0.9, gain: 0.2 * v }),
    // 介面音效
    beep:      () => tone({ type: 'square', from: 520, dur: 0.12, gain: 0.15 }),
    go:        () => { tone({ type: 'square', from: 880, dur: 0.25, gain: 0.18 }); tone({ type: 'square', from: 1320, dur: 0.3, gain: 0.12, delay: 0.05 }); },
    die:       () => tone({ type: 'sawtooth', from: 400, to: 60, dur: 0.6, gain: 0.2 }),
    kill:      () => { tone({ type: 'triangle', from: 880, dur: 0.1, gain: 0.15 }); tone({ type: 'triangle', from: 1175, dur: 0.18, gain: 0.15, delay: 0.1 }); },
    win:       () => [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'square', from: f, dur: 0.18, gain: 0.13, delay: i * 0.12 })),
    lose:      () => [392, 330, 262].forEach((f, i) => tone({ type: 'triangle', from: f, dur: 0.25, gain: 0.15, delay: i * 0.18 })),
  };
  const MIN_GAP = { shot: 45, spark: 40, brick: 50, itemSpawn: 200 };   // 同一種音效的最短間隔（毫秒），避免太吵

  window.Sfx = {
    // v：音量係數（依距離衰減）
    play(name, v = 1) {
      if (!enabled || !SOUNDS[name] || v <= 0.02) return;
      const now = performance.now();
      if (MIN_GAP[name] && now - (lastPlayed[name] || 0) < MIN_GAP[name]) return;
      lastPlayed[name] = now;
      try { SOUNDS[name](Math.min(1, v)); } catch { /* 部分瀏覽器不支援某些節點，忽略 */ }
    },
    // 依和自己坦克的距離決定音量
    playAt(name, x, y, me) {
      if (!me) return this.play(name, 0.6);
      const d = Math.hypot(x - me[0], y - me[1]);
      this.play(name, Math.max(0, 1 - d / 16));
    },
    setVolume(v) { volume = v; if (master) master.gain.value = v; },
    setEnabled(on) { enabled = on; if (on) ensure(); },
  };
})();
