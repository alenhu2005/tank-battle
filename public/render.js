'use strict';

// 畫面繪製：地形快取、坦克/子彈插值、特效、迷霧、鏡頭
(function () {
  const DIRS = ['up', 'down', 'left', 'right'];
  const ANGLE = [0, Math.PI, -Math.PI / 2, Math.PI / 2];
  const MIN_TILE_PX = 12;

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.max(0, Math.min(255, Math.round(r + amt * 255)));
    g = Math.max(0, Math.min(255, Math.round(g + amt * 255)));
    b = Math.max(0, Math.min(255, Math.round(b + amt * 255)));
    return `rgb(${r},${g},${b})`;
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.meta = null;
      this.particles = [];
      this.prev = null; this.cur = null;
      this.lives = new Map();
      this.sideState = new Map();
      this.layout = { ctrlBottom: 0 };
      this.dirtyTerrain = true;
    }

    setRound(meta, myTankId) {
      this.meta = meta;
      this.myTankId = myTankId;
      this.size = meta.size;
      this.tiles = meta.tiles.split('');
      this.tankMeta = new Map(meta.tanks.map(t => [t.id, t]));
      this.sideMeta = new Map(meta.sides.map(s => [s.key, s]));
      this.myTank = this.tankMeta.get(myTankId) || null;
      this.mySide = this.myTank ? this.myTank.side : null;
      this.prev = this.cur = null;
      this.particles = [];
      this.lives = new Map(meta.tanks.map(t => [t.id, { lives: t.maxLives, alive: true }]));
      this.sideState = new Map(meta.sides.map(s => [s.key, { out: false, base: s.base ? 1 : -1 }]));
      this.tick = 0;
      this.camX = this.camY = null;
      this.dirtyTerrain = true;
      this.resize();
    }

    applySnapshot(s, now) {
      const tanks = new Map();
      for (const a of s.T) tanks.set(a[0], { x: a[1] / 100, y: a[2] / 100, dir: a[3], shield: a[4], hp: a[5] });
      const bullets = new Map();
      for (const a of s.B) bullets.set(a[0], { x: a[1] / 100, y: a[2] / 100, dir: a[3], kind: a[4] });
      this.prev = this.cur;
      this.cur = { tanks, bullets, at: now, tick: s.k };
      this.tick = s.k;
      if (s.M) {
        for (const [idx, ch] of s.M) {
          this.tiles[idx] = ch;
          this.dirtyTiles = this.dirtyTiles || [];
          this.dirtyTiles.push(idx);
        }
      }
      if (s.L) for (const [id, lives, alive] of s.L) this.lives.set(id, { lives, alive: !!alive });
      if (s.S) for (const [key, out, base] of s.S) this.sideState.set(key, { out: !!out, base });
      if (s.E) for (const [type, x, y] of s.E) this.addEffect(type, x / 100, y / 100, now);
    }

    addEffect(type, x, y, now) {
      const dur = { boom: 650, blast: 500, baseBoom: 1200, brick: 380, spark: 180, armor: 300, spawn: 500 }[type] || 300;
      const p = { type, x, y, t0: now, dur, bits: [] };
      if (type === 'brick' || type === 'boom' || type === 'baseBoom' || type === 'blast') {
        const n = type === 'brick' ? 6 : type === 'baseBoom' ? 24 : 12;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, v = 0.6 + Math.random() * (type === 'baseBoom' ? 2.5 : 1.4);
          p.bits.push({ vx: Math.cos(a) * v, vy: Math.sin(a) * v, s: 0.06 + Math.random() * 0.1 });
        }
      }
      this.particles.push(p);
    }

    // 版面：地圖區域、格子像素、是否跟隨鏡頭
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
      if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
        this.canvas.width = Math.round(W * dpr);
        this.canvas.height = Math.round(H * dpr);
      }
      this.dpr = dpr; this.W = W; this.H = H;
      if (!this.meta) return;
      const topPad = (this.layout.top || 0);
      const bottomPad = this.layout.ctrlBottom || 0;
      const area = { x: 0, y: topPad, w: W, h: Math.max(100, H - topPad - bottomPad) };
      const fit = Math.min(area.w / this.size, area.h / this.size);
      const spectator = !this.myTank;
      let tile = fit, follow = false;
      if (!spectator && fit < MIN_TILE_PX) { tile = MIN_TILE_PX; follow = true; }
      tile = Math.max(4, tile);
      if (tile !== this.tilePx) this.dirtyTerrain = true;
      this.tilePx = tile; this.follow = follow; this.area = area;
    }

    // ---------- 地形快取 ----------

    _buildTerrain() {
      const S = this.size, tp = this.tilePx, dpr = this.dpr;
      const mk = () => { const c = document.createElement('canvas'); c.width = Math.ceil(S * tp * dpr); c.height = Math.ceil(S * tp * dpr); return c; };
      this.ground = this.ground && this.ground.width === Math.ceil(S * tp * dpr) ? this.ground : mk();
      this.grass = this.grass && this.grass.width === this.ground.width ? this.grass : mk();
      const g = this.ground.getContext('2d'), gr = this.grass.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); gr.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, S * tp, S * tp); gr.clearRect(0, 0, S * tp, S * tp);
      for (let i = 0; i < S * S; i++) this._drawTile(g, gr, i);
      this.dirtyTerrain = false;
      this.dirtyTiles = null;
    }

    _drawTile(g, gr, idx) {
      const S = this.size, tp = this.tilePx;
      const x = (idx % S) * tp, y = Math.floor(idx / S) * tp;
      const c = this.tiles[idx];
      g.clearRect(x, y, tp, tp);
      gr.clearRect(x, y, tp, tp);
      // 地板
      g.fillStyle = ((idx % S) + Math.floor(idx / S)) % 2 ? '#171a20' : '#191d23';
      g.fillRect(x, y, tp, tp);
      if (c === '#') {
        const hard = this.meta && this.meta.breakableWalls === false;
        g.fillStyle = hard ? '#6e5d55' : '#a9552c';
        g.fillRect(x, y, tp, tp);
        g.strokeStyle = hard ? '#3d322d' : '#5c2a12';
        g.lineWidth = Math.max(1, tp / 14);
        g.beginPath();
        g.moveTo(x, y + tp / 2); g.lineTo(x + tp, y + tp / 2);
        g.moveTo(x + tp / 2, y); g.lineTo(x + tp / 2, y + tp / 2);
        g.moveTo(x + tp / 4, y + tp / 2); g.lineTo(x + tp / 4, y + tp);
        g.moveTo(x + tp * 3 / 4, y + tp / 2); g.lineTo(x + tp * 3 / 4, y + tp);
        g.stroke();
        g.strokeRect(x + g.lineWidth / 2, y + g.lineWidth / 2, tp - g.lineWidth, tp - g.lineWidth);
        if (hard) {
          g.fillStyle = '#b8aaa2';
          const r = Math.max(1, tp / 12);
          for (const [fx, fy] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]]) { g.beginPath(); g.arc(x + fx * tp, y + fy * tp, r, 0, 7); g.fill(); }
        }
      } else if (c === '@') {
        g.fillStyle = '#7f8a95'; g.fillRect(x, y, tp, tp);
        g.fillStyle = '#b7c1ca'; g.fillRect(x + tp * 0.18, y + tp * 0.18, tp * 0.64, tp * 0.64);
        g.fillStyle = '#9aa5af'; g.fillRect(x + tp * 0.3, y + tp * 0.3, tp * 0.4, tp * 0.4);
        g.strokeStyle = '#4b535b'; g.lineWidth = Math.max(1, tp / 16); g.strokeRect(x + 0.5, y + 0.5, tp - 1, tp - 1);
      } else if (c === '~') {
        g.fillStyle = '#1b4b8a'; g.fillRect(x, y, tp, tp);
        g.strokeStyle = '#4a8ad6'; g.lineWidth = Math.max(1, tp / 14);
        for (const fy of [0.3, 0.7]) {
          g.beginPath();
          g.moveTo(x + tp * 0.1, y + tp * fy);
          g.quadraticCurveTo(x + tp * 0.3, y + tp * (fy - 0.12), x + tp * 0.5, y + tp * fy);
          g.quadraticCurveTo(x + tp * 0.7, y + tp * (fy + 0.12), x + tp * 0.9, y + tp * fy);
          g.stroke();
        }
      } else if (c === '*') {
        gr.fillStyle = '#2e7d32';
        gr.fillRect(x, y, tp, tp);
        gr.fillStyle = '#4caf50';
        for (const [fx, fy, r] of [[0.25, 0.3, 0.22], [0.7, 0.25, 0.2], [0.35, 0.72, 0.24], [0.75, 0.7, 0.2], [0.5, 0.5, 0.18]]) {
          gr.beginPath(); gr.arc(x + fx * tp, y + fy * tp, r * tp, 0, 7); gr.fill();
        }
      }
    }

    // ---------- 主繪製 ----------

    draw(now) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#07090c';
      ctx.fillRect(0, 0, this.W, this.H);
      if (!this.meta || !this.cur) return;
      if (this.dirtyTerrain) this._buildTerrain();
      else if (this.dirtyTiles) {
        const g = this.ground.getContext('2d'), gr = this.grass.getContext('2d');
        for (const idx of this.dirtyTiles) this._drawTile(g, gr, idx);
        this.dirtyTiles = null;
      }

      const tp = this.tilePx, S = this.size;
      const tickMs = 1000 / this.meta.tickRate;
      const alpha = this.prev ? Math.min(1, Math.max(0, (now - this.cur.at) / tickMs)) : 1;
      const lerpPos = (id, map, prevMap) => {
        const c = map.get(id); const p = prevMap && prevMap.get(id);
        if (!p || Math.abs(p.x - c.x) + Math.abs(p.y - c.y) > 1.5) return [c.x, c.y];
        return [p.x + (c.x - p.x) * alpha, p.y + (c.y - p.y) * alpha];
      };

      // 鏡頭
      let ox, oy;
      const mapW = S * tp;
      const myPos = this.myTank && this.cur.tanks.has(this.myTank.id) ? lerpPos(this.myTank.id, this.cur.tanks, this.prev && this.prev.tanks) : null;
      if (this.follow) {
        let fx, fy;
        if (myPos) { fx = myPos[0]; fy = myPos[1]; }
        else { const sm = this.sideMeta.get(this.mySide); fx = sm.anchor.x + 0.5; fy = sm.anchor.y + 0.5; }
        if (this.camX == null) { this.camX = fx; this.camY = fy; }
        this.camX += (fx - this.camX) * 0.25; this.camY += (fy - this.camY) * 0.25;
        ox = this.area.x + this.area.w / 2 - this.camX * tp;
        oy = this.area.y + this.area.h / 2 - this.camY * tp;
        if (mapW <= this.area.w) ox = this.area.x + (this.area.w - mapW) / 2;
        else ox = Math.min(this.area.x, Math.max(this.area.x + this.area.w - mapW, ox));
        if (mapW <= this.area.h) oy = this.area.y + (this.area.h - mapW) / 2;
        else oy = Math.min(this.area.y, Math.max(this.area.y + this.area.h - mapW, oy));
      } else {
        ox = this.area.x + (this.area.w - mapW) / 2;
        oy = this.area.y + (this.area.h - mapW) / 2;
      }
      ox = Math.round(ox); oy = Math.round(oy);

      ctx.save();
      ctx.translate(ox, oy);
      ctx.drawImage(this.ground, 0, 0, mapW, mapW);
      ctx.strokeStyle = '#2f3845'; ctx.lineWidth = 2; ctx.strokeRect(-1, -1, mapW + 2, mapW + 2);

      // 基地
      for (const s of this.meta.sides) {
        if (!s.base) continue;
        const st = this.sideState.get(s.key);
        this._drawBase(ctx, s.base.x * tp, s.base.y * tp, tp, s.color, st && st.base === 1);
      }

      // 子彈
      for (const [id, b] of this.cur.bullets) {
        const [x, y] = lerpPos(id, this.cur.bullets, this.prev && this.prev.bullets);
        const r = (b.kind === 2 ? 0.15 : 0.1) * tp;
        ctx.fillStyle = b.kind === 2 ? '#ff9f43' : '#fff4b0';
        ctx.beginPath(); ctx.arc(x * tp, y * tp, Math.max(1.5, r), 0, 7); ctx.fill();
      }

      // 坦克
      for (const [id, t] of this.cur.tanks) {
        const m = this.tankMeta.get(id);
        if (!m) continue;
        const [x, y] = lerpPos(id, this.cur.tanks, this.prev && this.prev.tanks);
        const color = this.sideMeta.get(m.side).color;
        this._drawTank(ctx, x * tp, y * tp, t.dir, color, m, tp * this.meta.tankSize, t, now);
      }

      // 草叢（偵察職業看得穿）
      const seeThroughGrass = this.myTank && this.myTank.grassSight;
      ctx.globalAlpha = seeThroughGrass ? 0.45 : 0.94;
      ctx.drawImage(this.grass, 0, 0, mapW, mapW);
      ctx.globalAlpha = 1;

      // 名字標籤
      if (tp >= 12) {
        ctx.font = `700 ${Math.max(9, Math.min(13, tp * 0.55))}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        for (const [id] of this.cur.tanks) {
          const m = this.tankMeta.get(id);
          if (!m || (m.isBot && !this.meta.codeOnly)) continue;
          const [x, y] = lerpPos(id, this.cur.tanks, this.prev && this.prev.tanks);
          const label = m.name.length > 6 ? m.name.slice(0, 6) + '…' : m.name;
          ctx.fillStyle = 'rgba(0,0,0,.6)';
          ctx.fillText(label, x * tp + 1, (y - 0.55) * tp + 1);
          ctx.fillStyle = this.sideMeta.get(m.side).color;
          ctx.fillText(label, x * tp, (y - 0.55) * tp);
        }
      }

      // 特效
      this.particles = this.particles.filter(p => now - p.t0 < p.dur);
      for (const p of this.particles) this._drawEffect(ctx, p, (now - p.t0) / p.dur, tp);

      // 我的坦克標記
      if (myPos) {
        const bob = Math.sin(now / 200) * 0.08;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        const mx = myPos[0] * tp, my = (myPos[1] - 0.95 - bob) * tp;
        ctx.moveTo(mx - tp * 0.18, my - tp * 0.2); ctx.lineTo(mx + tp * 0.18, my - tp * 0.2); ctx.lineTo(mx, my);
        ctx.fill();
      }

      // 迷霧
      if (this.meta.fog && this.myTank) {
        let cx, cy;
        if (myPos) { cx = myPos[0]; cy = myPos[1]; }
        else { const sm = this.sideMeta.get(this.mySide); cx = sm.anchor.x + 0.5; cy = sm.anchor.y + 0.5; }
        const r = this.myTank.vision * tp;
        const grad = ctx.createRadialGradient(cx * tp, cy * tp, r * 0.78, cx * tp, cy * tp, r);
        grad.addColorStop(0, 'rgba(4,6,9,0)');
        grad.addColorStop(1, 'rgba(4,6,9,0.86)');
        ctx.fillStyle = grad;
        ctx.fillRect(-ox, -oy, this.W, this.H);
      }
      ctx.restore();
    }

    _drawBase(ctx, x, y, tp, color, alive) {
      if (!alive) {
        ctx.fillStyle = '#3a3d42';
        for (const [fx, fy, s] of [[0.2, 0.55, 0.3], [0.5, 0.35, 0.25], [0.6, 0.65, 0.3], [0.3, 0.25, 0.2]]) ctx.fillRect(x + fx * tp, y + fy * tp, s * tp, s * tp * 0.7);
        return;
      }
      ctx.fillStyle = '#0d0f12'; ctx.fillRect(x, y, tp, tp);
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, tp / 12); ctx.strokeRect(x + tp * 0.08, y + tp * 0.08, tp * 0.84, tp * 0.84);
      // 旗子
      ctx.fillStyle = '#ddd'; ctx.fillRect(x + tp * 0.3, y + tp * 0.18, tp * 0.07, tp * 0.66);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x + tp * 0.37, y + tp * 0.18); ctx.lineTo(x + tp * 0.8, y + tp * 0.33); ctx.lineTo(x + tp * 0.37, y + tp * 0.5);
      ctx.fill();
      ctx.fillStyle = '#ddd'; ctx.fillRect(x + tp * 0.2, y + tp * 0.78, tp * 0.6, tp * 0.08);
    }

    _drawTank(ctx, x, y, dirIdx, color, m, s, st, now) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ANGLE[dirIdx]);
      const cls = m.cls;
      const dark = shade(color, -0.35), darker = shade(color, -0.5), light = shade(color, 0.15);
      // 履帶
      const hullW = cls === 'heavy' ? 0.36 : cls === 'scout' ? 0.27 : 0.32;
      ctx.fillStyle = '#1d2026';
      ctx.fillRect(-0.5 * s, -0.5 * s, (0.5 - hullW + 0.04) * s, s);
      ctx.fillRect((hullW - 0.04) * s, -0.5 * s, (0.5 - hullW + 0.04) * s, s);
      ctx.fillStyle = '#3a3f48';
      const treadW = (0.5 - hullW + 0.04) * s;
      for (let i = 0; i < 5; i++) {
        const ty = (-0.45 + i * 0.2) * s;
        ctx.fillRect(-0.5 * s, ty, treadW, 0.07 * s);
        ctx.fillRect((hullW - 0.04) * s, ty, treadW, 0.07 * s);
      }
      // 車身
      ctx.fillStyle = m.isBot ? dark : color;
      ctx.fillRect(-hullW * s, -0.42 * s, hullW * 2 * s, 0.84 * s);
      if (m.isBot) { // 電腦：車身條紋
        ctx.fillStyle = color;
        ctx.fillRect(-hullW * s, -0.1 * s, hullW * 2 * s, 0.12 * s);
      }
      if (cls === 'heavy') {
        ctx.strokeStyle = st.hp >= 2 ? '#e8edf3' : darker;
        ctx.lineWidth = Math.max(1, s * 0.07);
        ctx.strokeRect(-hullW * s, -0.42 * s, hullW * 2 * s, 0.84 * s);
      }
      // 砲塔
      ctx.fillStyle = m.isBot ? color : dark;
      if (m.isBot) ctx.fillRect(-0.15 * s, -0.15 * s, 0.3 * s, 0.3 * s);
      else { ctx.beginPath(); ctx.arc(0, 0, (cls === 'heavy' ? 0.22 : 0.19) * s, 0, 7); ctx.fill(); }
      // 砲管
      ctx.fillStyle = '#d9dee6';
      const barrel = (w, len, off = 0) => ctx.fillRect((off - w / 2) * s, -len * s, w * s, (len - 0.05) * s);
      if (cls === 'assault') { barrel(0.07, 0.6, -0.06); barrel(0.07, 0.6, 0.06); }
      else if (cls === 'heavy') barrel(0.16, 0.6);
      else if (cls === 'scout') barrel(0.07, 0.52);
      else if (cls === 'sniper') barrel(0.07, 0.8);
      else if (cls === 'demo') { barrel(0.2, 0.45); ctx.fillStyle = '#ff9f43'; ctx.fillRect(-0.12 * s, -0.5 * s, 0.24 * s, 0.08 * s); }
      else barrel(0.09, 0.55);
      if (m.isBot) { // 天線
        ctx.strokeStyle = light; ctx.lineWidth = Math.max(1, s * 0.04);
        ctx.beginPath(); ctx.moveTo(0.2 * s, 0.3 * s); ctx.lineTo(0.3 * s, 0.48 * s); ctx.stroke();
      }
      ctx.restore();
      if (st.shield) {
        ctx.strokeStyle = `rgba(120, 220, 255, ${0.5 + 0.3 * Math.sin(now / 80)})`;
        ctx.lineWidth = Math.max(1.5, s * 0.08);
        ctx.beginPath(); ctx.arc(x, y, s * 0.68, 0, 7); ctx.stroke();
      }
    }

    _drawEffect(ctx, p, k, tp) {
      const x = p.x * tp, y = p.y * tp;
      const ease = 1 - (1 - k) * (1 - k);
      if (p.type === 'boom' || p.type === 'baseBoom' || p.type === 'blast') {
        const R = (p.type === 'baseBoom' ? 1.8 : p.type === 'blast' ? 1.3 : 0.9) * tp;
        ctx.fillStyle = `rgba(255, ${Math.round(200 - 140 * k)}, 60, ${0.85 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(x, y, R * (0.3 + 0.7 * ease), 0, 7); ctx.fill();
        ctx.fillStyle = `rgba(255, 250, 220, ${0.9 * (1 - k * 1.6)})`;
        if (k < 0.6) { ctx.beginPath(); ctx.arc(x, y, R * 0.35 * (1 - k), 0, 7); ctx.fill(); }
        ctx.fillStyle = `rgba(90, 90, 90, ${0.7 * (1 - k)})`;
        for (const b of p.bits) ctx.fillRect(x + b.vx * ease * tp - b.s * tp / 2, y + b.vy * ease * tp - b.s * tp / 2, b.s * tp, b.s * tp);
      } else if (p.type === 'brick') {
        ctx.fillStyle = `rgba(190, 100, 50, ${1 - k})`;
        for (const b of p.bits) ctx.fillRect(x + b.vx * ease * tp * 0.6, y + b.vy * ease * tp * 0.6, b.s * tp, b.s * tp);
      } else if (p.type === 'spark') {
        ctx.fillStyle = `rgba(255, 255, 220, ${1 - k})`;
        ctx.beginPath(); ctx.arc(x, y, tp * 0.25 * (1 - k * 0.5), 0, 7); ctx.fill();
      } else if (p.type === 'armor') {
        ctx.strokeStyle = `rgba(200, 230, 255, ${1 - k})`; ctx.lineWidth = Math.max(1, tp * 0.08);
        ctx.beginPath(); ctx.arc(x, y, tp * (0.4 + 0.4 * ease), 0, 7); ctx.stroke();
      } else if (p.type === 'spawn') {
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * (1 - k)})`; ctx.lineWidth = Math.max(1, tp * 0.06);
        ctx.beginPath(); ctx.arc(x, y, tp * (1.2 - 0.8 * ease), 0, 7); ctx.stroke();
      }
    }
  }

  window.Renderer = Renderer;
  window.TANK_DIRS = DIRS;
})();
