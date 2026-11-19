// 打怪模式的繪圖：10 種怪物、4 隻 Boss、預警區、地圖物件（核心、出口、發電機、軌道）
(function () {
  'use strict';
  const KINDS = ['crawler', 'charger', 'turret', 'sniper', 'bomber', 'shield', 'healer', 'summoner', 'lurker', 'builder', 'bunker', 'fturret', 'qclone', 'tcar', 'fortress', 'queen', 'train', 'colossus'];
  const AFFIX_COLORS = ['#ff5a4f', '#c9a227', '#7ee0ff', '#9fdcff', '#e0e0ff', '#9be15d'];   // 與伺服器 AFFIXES 順序相同
  const PURPLE = '#9b59ff', DARK = '#3d2370', MID = '#6b3fc4', LIGHT = '#cdb3ff';

  function rect(ctx, x, y, w, h, s) { ctx.fillRect(x * s, y * s, w * s, h * s); }
  function circle(ctx, x, y, r, s) { ctx.beginPath(); ctx.arc(x * s, y * s, r * s, 0, 7); ctx.fill(); }
  function poly(ctx, pts, s) { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)); ctx.closePath(); ctx.fill(); }
  function barrel(ctx, w, len, s, off = 0) { ctx.fillStyle = '#e8dcff'; ctx.fillRect((off - w / 2) * s, -len * s, w * s, (len - 0.05) * s); }

  // x, y：畫面像素；angle：度；tp：一格的像素；st：快照狀態（kind、flags、size、elite）
  function drawMonster(ctx, x, y, angle, st, tp, now) {
    const kind = st.kindName || KINDS[st.kind] || 'crawler';
    const size = st.size || 0.84, s = size * tp, f = st.flags || 0;
    ctx.save();
    ctx.translate(x, y);
    // 精英光環
    if (st.elite) {
      let i = 0;
      for (let b = 0; b < AFFIX_COLORS.length; b++) if (st.elite & (1 << b)) {
        ctx.strokeStyle = AFFIX_COLORS[b]; ctx.lineWidth = Math.max(1.5, tp * 0.06);
        ctx.beginPath(); ctx.arc(0, 0, s * (0.66 + i * 0.1) + Math.sin(now / 200 + i) * tp * 0.03, 0, 7); ctx.stroke();
        i++;
      }
    }
    // 女王真身的影子
    if (f & 8) { ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.ellipse(tp * 0.15, tp * 0.5, s * 0.5, s * 0.22, 0, 0, 7); ctx.fill(); }
    ctx.rotate(angle * Math.PI / 180);
    const fn = DRAW[kind] || DRAW.crawler;
    fn(ctx, s, f, now, tp);
    ctx.restore();
    // 正面護盾
    if (f & 2) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(angle * Math.PI / 180);
      ctx.strokeStyle = `rgba(120, 220, 255, ${0.7 + 0.2 * Math.sin(now / 150)})`; ctx.lineWidth = Math.max(2, tp * 0.12);
      ctx.beginPath(); ctx.arc(0, 0, s * 0.72, -Math.PI / 2 - 0.9, -Math.PI / 2 + 0.9); ctx.stroke();
      ctx.restore();
    }
    // 無敵（巨像護甲、車廂）
    if (f & 4) { ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 2; ctx.strokeRect(x - s * 0.55, y - s * 0.55, s * 1.1, s * 1.1); }
    // 暈眩
    if (f & 64) { ctx.fillStyle = '#ffd23f'; ctx.font = `${Math.max(10, tp * 0.5)}px system-ui`; ctx.textAlign = 'center'; ctx.fillText('💫', x, y - s * 0.6); }
  }

  const DRAW = {
    crawler(ctx, s, f, now) {
      ctx.strokeStyle = DARK; ctx.lineWidth = Math.max(1, s * 0.07);
      const w = Math.sin(now / 80) * 0.05;
      for (const sy of [-0.25, 0, 0.25]) for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(sx * 0.2 * s, sy * s); ctx.lineTo(sx * 0.48 * s, (sy + w * sx) * s); ctx.stroke(); }
      ctx.fillStyle = PURPLE; ctx.beginPath(); ctx.ellipse(0, 0.05 * s, 0.3 * s, 0.4 * s, 0, 0, 7); ctx.fill();
      ctx.fillStyle = MID; circle(ctx, 0, -0.18, 0.16, s);
      barrel(ctx, 0.09, 0.5, s);
      ctx.fillStyle = '#ff4d6d'; circle(ctx, -0.07, -0.25, 0.04, s); circle(ctx, 0.07, -0.25, 0.04, s);
    },
    charger(ctx, s, f, now) {
      ctx.fillStyle = f & 1 ? `rgba(255, 80, 60, ${0.35 + 0.3 * Math.sin(now / 40)})` : 'transparent';
      if (f & 1) circle(ctx, 0, 0, 0.62, s);
      ctx.fillStyle = MID; poly(ctx, [[-0.42, 0.45], [-0.45, -0.1], [0, -0.42], [0.45, -0.1], [0.42, 0.45]], s);
      ctx.fillStyle = PURPLE; poly(ctx, [[-0.3, 0.38], [-0.32, -0.05], [0, -0.3], [0.32, -0.05], [0.3, 0.38]], s);
      ctx.fillStyle = '#f0e6ff'; poly(ctx, [[-0.08, -0.32], [0, -0.62], [0.08, -0.32]], s);   // 角
      ctx.fillStyle = '#ff4d6d'; rect(ctx, -0.18, -0.1, 0.36, 0.06, s);
    },
    turret(ctx, s) {
      ctx.fillStyle = DARK; rect(ctx, -0.48, -0.48, 0.96, 0.96, s);
      ctx.fillStyle = MID; rect(ctx, -0.4, -0.4, 0.8, 0.8, s);
      barrel(ctx, 0.07, 0.62, s, -0.12); barrel(ctx, 0.07, 0.66, s, 0); barrel(ctx, 0.07, 0.62, s, 0.12);
      ctx.fillStyle = PURPLE; circle(ctx, 0, 0, 0.24, s);
    },
    sniper(ctx, s) {
      ctx.fillStyle = MID; poly(ctx, [[-0.22, 0.45], [-0.28, -0.1], [0, -0.35], [0.28, -0.1], [0.22, 0.45]], s);
      barrel(ctx, 0.06, 0.95, s);
      ctx.fillStyle = PURPLE; circle(ctx, 0, 0.05, 0.17, s);
      ctx.fillStyle = '#ff3b3b'; circle(ctx, 0, -0.12, 0.06, s);
    },
    bomber(ctx, s, f, now) {
      const blink = f & 128 ? Math.sin(now / 35) > 0 : Math.sin(now / 250) > 0.6;
      ctx.fillStyle = '#ff8a3d';
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; poly(ctx, [[Math.cos(a) * 0.3, Math.sin(a) * 0.3], [Math.cos(a + 0.2) * 0.5, Math.sin(a + 0.2) * 0.5], [Math.cos(a + 0.4) * 0.3, Math.sin(a + 0.4) * 0.3]], s); }
      ctx.fillStyle = blink ? '#ffef5a' : '#c2410c'; circle(ctx, 0, 0, 0.34, s);
      ctx.fillStyle = '#1d1d1d'; circle(ctx, 0, 0, 0.12, s);
    },
    shield(ctx, s) {
      ctx.fillStyle = DARK; rect(ctx, -0.45, -0.4, 0.9, 0.85, s);
      ctx.fillStyle = MID; rect(ctx, -0.36, -0.32, 0.72, 0.7, s);
      barrel(ctx, 0.08, 0.45, s, 0.22);
      ctx.fillStyle = '#7fd7ff'; ctx.beginPath(); ctx.ellipse(0, -0.42 * s, 0.5 * s, 0.16 * s, 0, Math.PI, 0); ctx.fill();
    },
    healer(ctx, s, f, now) {
      ctx.strokeStyle = `rgba(90, 230, 130, ${0.3 + 0.2 * Math.sin(now / 300)})`; ctx.lineWidth = Math.max(1, s * 0.05);
      ctx.beginPath(); ctx.arc(0, 0, s * 0.8, 0, 7); ctx.stroke();
      ctx.fillStyle = MID; circle(ctx, 0, 0, 0.42, s);
      ctx.fillStyle = '#5ee07a'; rect(ctx, -0.07, -0.25, 0.14, 0.5, s); rect(ctx, -0.25, -0.07, 0.5, 0.14, s);
    },
    summoner(ctx, s, f, now) {
      ctx.fillStyle = DARK; poly(ctx, [0, 1, 2, 3, 4, 5].map(i => [Math.cos(i * Math.PI / 3) * 0.45, Math.sin(i * Math.PI / 3) * 0.45]), s);
      ctx.fillStyle = PURPLE; circle(ctx, 0, 0, 0.22, s);
      ctx.fillStyle = LIGHT;
      for (let i = 0; i < 3; i++) { const a = now / 400 + i * 2.1; circle(ctx, Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0.08, s); }
    },
    lurker(ctx, s) {
      ctx.fillStyle = '#2a1840'; poly(ctx, [[0, -0.5], [0.42, 0.42], [0, 0.22], [-0.42, 0.42]], s);
      barrel(ctx, 0.06, 0.45, s);
      ctx.fillStyle = '#b388ff'; circle(ctx, -0.1, 0, 0.05, s); circle(ctx, 0.1, 0, 0.05, s);
    },
    builder(ctx, s) {
      ctx.fillStyle = DARK; rect(ctx, -0.46, -0.42, 0.92, 0.88, s);
      ctx.fillStyle = MID; rect(ctx, -0.36, -0.34, 0.72, 0.72, s);
      ctx.fillStyle = '#ffcc33'; rect(ctx, -0.46, 0.3, 0.92, 0.1, s);
      ctx.strokeStyle = '#ffcc33'; ctx.lineWidth = Math.max(1, s * 0.07);
      ctx.beginPath(); ctx.moveTo(0.15 * s, 0); ctx.lineTo(0.15 * s, -0.55 * s); ctx.lineTo(-0.15 * s, -0.55 * s); ctx.stroke();
      barrel(ctx, 0.08, 0.4, s, -0.18);
    },
    bunker(ctx, s) {
      ctx.fillStyle = '#2b1d45'; rect(ctx, -0.5, -0.5, 1, 1, s);
      ctx.fillStyle = MID; rect(ctx, -0.42, -0.42, 0.84, 0.84, s);
      ctx.fillStyle = DARK; for (let i = 0; i < 4; i++) rect(ctx, -0.42 + i * 0.24, -0.5, 0.12, 0.12, s);
      ctx.fillStyle = '#ff4d6d'; rect(ctx, -0.15, -0.05, 0.3, 0.1, s);
    },
    fturret(ctx, s) {
      ctx.fillStyle = '#4b4f63'; rect(ctx, -0.45, -0.45, 0.9, 0.9, s);
      ctx.fillStyle = '#7a7f99'; circle(ctx, 0, 0, 0.3, s);
      barrel(ctx, 0.14, 0.7, s);
    },
    tcar(ctx, s) {
      ctx.fillStyle = '#3a3150'; rect(ctx, -0.42, -0.5, 0.84, 1, s);
      ctx.fillStyle = '#7d6aa8'; rect(ctx, -0.34, -0.4, 0.68, 0.8, s);
      ctx.fillStyle = '#ffcc33'; rect(ctx, -0.42, -0.06, 0.84, 0.12, s);
    },
    qclone(ctx, s, f, now) { DRAW.queen(ctx, s, f, now, 0.75); },
    fortress(ctx, s, f, now) {
      ctx.fillStyle = '#2c2440'; rect(ctx, -0.5, -0.5, 1, 1, s);
      ctx.fillStyle = '#5a4a80'; rect(ctx, -0.42, -0.42, 0.84, 0.84, s);
      ctx.fillStyle = '#8c7ab8';
      for (let i = -2; i <= 2; i++) { circle(ctx, i * 0.17, -0.46, 0.025, s); circle(ctx, i * 0.17, 0.46, 0.025, s); circle(ctx, -0.46, i * 0.17, 0.025, s); circle(ctx, 0.46, i * 0.17, 0.025, s); }
      ctx.fillStyle = f & 1 ? `rgba(255, 70, 50, ${0.6 + 0.3 * Math.sin(now / 50)})` : '#ff4d6d';
      circle(ctx, 0, 0, 0.16, s);
      ctx.fillStyle = '#3d2f5c'; rect(ctx, -0.08, -0.58, 0.16, 0.2, s);
    },
    queen(ctx, s, f, now, alpha = 1) {
      const flap = Math.sin(now / 120) * 0.12;
      ctx.globalAlpha *= alpha;
      ctx.fillStyle = 'rgba(155, 89, 255, .85)';
      ctx.beginPath(); ctx.ellipse(-0.3 * s, -0.08 * s, (0.32 + flap) * s, 0.24 * s, -0.5, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0.3 * s, -0.08 * s, (0.32 + flap) * s, 0.24 * s, 0.5, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(94, 224, 122, .8)';
      ctx.beginPath(); ctx.ellipse(-0.24 * s, 0.22 * s, (0.2 + flap) * s, 0.16 * s, 0.4, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(0.24 * s, 0.22 * s, (0.2 + flap) * s, 0.16 * s, -0.4, 0, 7); ctx.fill();
      ctx.fillStyle = '#2a1840'; ctx.beginPath(); ctx.ellipse(0, 0, 0.08 * s, 0.34 * s, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#e0ccff'; circle(ctx, 0, -0.3, 0.06, s);
    },
    train(ctx, s, f, now) {
      ctx.fillStyle = '#3a2d5c'; rect(ctx, -0.42, -0.5, 0.84, 1, s);
      ctx.fillStyle = '#7d5cc9'; rect(ctx, -0.34, -0.3, 0.68, 0.72, s);
      ctx.fillStyle = '#2a2140'; rect(ctx, -0.12, -0.15, 0.24, 0.24, s);          // 煙囪
      ctx.fillStyle = `rgba(255, 240, 150, ${0.7 + 0.3 * Math.sin(now / 90)})`; circle(ctx, 0, -0.44, 0.1, s);   // 頭燈
      ctx.fillStyle = 'rgba(200,200,200,.35)'; circle(ctx, 0, 0.1 - ((now / 300) % 1) * 0.6, 0.12 + ((now / 300) % 1) * 0.1, s);
    },
    colossus(ctx, s, f, now) {
      ctx.fillStyle = '#1f1830'; rect(ctx, -0.5, -0.5, 1, 1, s);
      ctx.fillStyle = '#3d2f5c'; rect(ctx, -0.44, -0.44, 0.88, 0.88, s);
      ctx.strokeStyle = '#6b55a0'; ctx.lineWidth = Math.max(2, s * 0.02);
      for (const r of [0.38, 0.28]) { ctx.beginPath(); ctx.arc(0, 0, r * s, 0, 7); ctx.stroke(); }
      const open = f & 16, armored = f & 4;
      ctx.fillStyle = open ? `rgba(94, 224, 122, ${0.7 + 0.3 * Math.sin(now / 80)})` : armored ? '#55456f' : '#ff4d6d';
      circle(ctx, 0, 0, open ? 0.2 : 0.14, s);
      ctx.fillStyle = '#8c7ab8';
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + now / 2000; rect(ctx, Math.cos(a) * 0.36 - 0.04, Math.sin(a) * 0.36 - 0.04, 0.08, 0.08, s); }
    },
  };

  // 預警區：tick = 畫面目前的 tick
  function drawHazard(ctx, h, tp, tick, now, mapW) {
    const warn = tick < h.f, k = warn ? 1 - (h.f - tick) / 40 : 1;
    ctx.save();
    if (h.k === 'line') {
      const pulse = 0.35 + 0.25 * Math.sin(now / 70);
      ctx.strokeStyle = warn ? `rgba(255, 60, 60, ${pulse})` : 'rgba(255, 240, 200, .95)';
      ctx.lineWidth = Math.max(2, (h.w || 0.4) * tp * (warn ? 1 : 1.3));
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(h.x * tp, h.y * tp); ctx.lineTo(h.x2 * tp, h.y2 * tp); ctx.stroke();
    } else if (h.k === 'circle') {
      ctx.fillStyle = warn ? `rgba(255, 120, 40, ${0.15 + 0.25 * Math.max(0, k)})` : 'rgba(255, 220, 120, .7)';
      ctx.beginPath(); ctx.arc(h.x * tp, h.y * tp, h.r * tp, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255, 90, 40, .9)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(h.x * tp, h.y * tp, h.r * tp * Math.max(0.05, Math.min(1, k)), 0, 7); ctx.stroke();
    } else if (h.k === 'poison') {
      ctx.fillStyle = warn ? `rgba(120, 230, 90, ${0.12 + 0.1 * Math.sin(now / 90)})` : `rgba(90, 200, 60, ${0.38 + 0.06 * Math.sin(now / 300)})`;
      ctx.beginPath(); ctx.arc(h.x * tp, h.y * tp, h.r * tp, 0, 7); ctx.fill();
      if (warn) { ctx.strokeStyle = 'rgba(120, 230, 90, .8)'; ctx.lineWidth = 2; ctx.stroke(); }
    } else if (h.k === 'map') {
      ctx.fillStyle = warn ? 'rgba(90, 200, 60, .12)' : `rgba(70, 170, 50, ${0.32 + 0.05 * Math.sin(now / 400)})`;
      ctx.beginPath(); ctx.rect(0, 0, mapW, mapW);
      for (const [x, y, r] of h.isl || []) { ctx.moveTo((x + r) * tp, y * tp); ctx.arc(x * tp, y * tp, r * tp, 0, Math.PI * 2, true); }
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(230, 255, 230, .7)'; ctx.lineWidth = 2;
      for (const [x, y, r] of h.isl || []) { ctx.beginPath(); ctx.arc(x * tp, y * tp, r * tp, 0, 7); ctx.stroke(); }
    }
    ctx.restore();
  }

  // 地圖物件：軌道、出口、發電機
  function drawFeatures(ctx, pve, state, tp, now) {
    if (!pve) return;
    if (pve.track) {
      ctx.save();
      ctx.strokeStyle = 'rgba(160, 140, 200, .55)'; ctx.lineWidth = Math.max(2, tp * 0.08);
      for (const off of [-0.28, 0.28]) {
        ctx.beginPath();
        pve.track.forEach(([x, y], i) => {
          const [nx, ny] = pve.track[(i + 1) % pve.track.length];
          const dx = nx - x, dy = ny - y, L = Math.hypot(dx, dy) || 1;
          const px = (x - dy / L * off) * tp, py = (y + dx / L * off) * tp;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        });
        ctx.closePath(); ctx.stroke();
      }
      ctx.restore();
    }
    if (pve.exit) {
      const x = pve.exit.x * tp, y = pve.exit.y * tp;
      ctx.fillStyle = `rgba(94, 224, 122, ${0.25 + 0.15 * Math.sin(now / 250)})`;
      ctx.beginPath(); ctx.arc(x, y, tp * 0.9, 0, 7); ctx.fill();
      ctx.font = `${Math.max(12, tp * 0.7)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🏁', x, y);
    }
    if (pve.gens) {
      pve.gens.forEach((g, i) => {
        const [prog, done] = state && state.gens ? state.gens[i] : [0, 0];
        const active = state && state.gi === i;
        const x = g.x * tp, y = g.y * tp;
        ctx.fillStyle = done ? '#2f6b3f' : active ? '#4a3d14' : '#2a2d36';
        ctx.fillRect(x - tp * 0.45, y - tp * 0.45, tp * 0.9, tp * 0.9);
        ctx.strokeStyle = done ? '#5ee07a' : active ? '#ffd23f' : '#5b6170'; ctx.lineWidth = Math.max(2, tp * 0.08);
        ctx.strokeRect(x - tp * 0.45, y - tp * 0.45, tp * 0.9, tp * 0.9);
        if (active && prog > 0) { ctx.beginPath(); ctx.arc(x, y, tp * 0.7, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke(); }
        ctx.font = `${Math.max(10, tp * 0.5)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(done ? '✅' : '⚡', x, y);
      });
    }
  }

  // 核心
  function drawCore(ctx, x, y, s, hpRatio, now) {
    ctx.save(); ctx.translate(x, y);
    ctx.fillStyle = '#16323f'; ctx.fillRect(-s / 2, -s / 2, s, s);
    ctx.strokeStyle = '#4fd1ff'; ctx.lineWidth = Math.max(2, s * 0.05); ctx.strokeRect(-s / 2 + 2, -s / 2 + 2, s - 4, s - 4);
    const g = 0.5 + 0.5 * Math.sin(now / 300);
    ctx.fillStyle = hpRatio > 0.3 ? `rgba(79, 209, 255, ${0.6 + 0.3 * g})` : `rgba(255, 90, 80, ${0.6 + 0.3 * g})`;
    ctx.beginPath(); ctx.arc(0, 0, s * 0.28, 0, 7); ctx.fill();
    ctx.restore();
  }

  // 圖鑑用：在小畫布上畫一隻怪物
  function icon(canvas, kind) {
    const ctx = canvas.getContext('2d'), w = canvas.width;
    ctx.clearRect(0, 0, w, w);
    const big = { fortress: 0.62, colossus: 0.62, queen: 0.75, train: 0.6, bunker: 0.6 }[kind] || 0.5;
    drawMonster(ctx, w / 2, w / 2, 0, { kind: KINDS.indexOf(kind), size: 1, flags: kind === 'turret' || kind === 'shield' ? 2 : 0, elite: 0 }, w * big, 0);
  }

  window.PveDraw = { KINDS, drawMonster, drawHazard, drawFeatures, drawCore, icon, AFFIX_COLORS };
})();
