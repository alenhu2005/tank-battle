'use strict';

// 畫面繪製：地形快取、坦克/子彈插值、特效、迷霧、鏡頭
(function () {
  const DIRS = ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright'];
  const ANGLE = [0, Math.PI, -Math.PI / 2, Math.PI / 2, -Math.PI / 4, Math.PI / 4, -Math.PI * 3 / 4, Math.PI * 3 / 4];
  const R2 = Math.SQRT1_2;
  // 子彈顏色：0 一般、1 穿甲、2 爆炸、3 冰凍、4 混亂
  const BULLET_COLORS = ['#fff4b0', '#e6ecff', '#ff9f43', '#7fdcff', '#d48bff'];
  const VEC = [[0, -1], [0, 1], [-1, 0], [1, 0], [-R2, -R2], [R2, -R2], [-R2, R2], [R2, R2]];
  const MIN_TILE_PX = 12;
  const INTERP_DELAY = 2;   // tick
  const REPLAY_BEFORE = 54; // 重播死前 1.8 秒（慢動作播完約 4.6 秒，比重生的 5 秒短）
  const REPLAY_AFTER = 12;  // 加上死後 0.4 秒
  const REPLAY_SPEED = 0.5; // 慢動作

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.max(0, Math.min(255, Math.round(r + amt * 255)));
    g = Math.max(0, Math.min(255, Math.round(g + amt * 255)));
    b = Math.max(0, Math.min(255, Math.round(b + amt * 255)));
    return `rgb(${r},${g},${b})`;
  }

  const CLOSE_VIEW = 11;   // 近距離鏡頭：畫面短邊看得到幾格
  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.meta = null;
      this.particles = [];
      this.buf = [];               // 快照緩衝（依伺服器 tick 排序）
      this.hist = [];              // 死亡重播用的歷史快照
      this.replay = null;
      this.lives = new Map();
      this.sideState = new Map();
      this.layout = { ctrlBottom: 0 };
      this.dirtyTerrain = true;
      this.onKill = null;          // (victimId, killerId, cause) => void
      this.showAim = true;         // 瞄準輔助線（設定裡可關）
      this.showBotDebug = true;    // 電腦代碼的除錯繪圖
      this.debugOps = null;
    }

    setRound(meta, myTankId) {
      this.meta = meta;
      this.myTankId = myTankId;
      this.size = meta.size;
      this.tiles = meta.tiles.split('');
      this.wallHp = new Map(meta.wallHp || []);
      this.baseWallHp = meta.baseWallHp || 3;
      this.wallShieldTicks = meta.baseWallShieldTicks || 0;
      this.liveTiles = meta.tiles.split('');
      this.latest = null;
      this.pred = null;                 // 自己坦克的預測位置 { x, y, dir }
      this.predOff = { x: 0, y: 0 };    // 預測修正時的視覺平滑
      this.tankMeta = new Map(meta.tanks.map(t => [t.id, t]));
      this.sideMeta = new Map(meta.sides.map(s => [s.key, s]));
      this.myTank = this.tankMeta.get(myTankId) || null;
      this.mySide = this.myTank ? this.myTank.side : null;
      this.buf = [];
      this.hist = [];
      this.replay = null;
      this.items = [];
      this.obj = null;
      this.smokes = [];
      this.mines = [];
      this.offset = null;
      this.appliedK = 0;
      this.renderTick = 0;
      this.particles = [];
      this.lives = new Map(meta.tanks.map(t => [t.id, { lives: Math.max(1, t.maxLives), alive: true }]));
      this.sideState = new Map(meta.sides.map(s => [s.key, { out: false, base: s.base ? 1 : -1 }]));
      this.tick = 0;
      this.camX = this.camY = null;
      this.dirtyTerrain = true;
      this.resize();
    }

    // 收到快照：放進緩衝區，並估計「伺服器時鐘」與本機時鐘的差
    applySnapshot(s, now) {
      const tickMs = 1000 / this.meta.tickRate;
      const tanks = new Map();
      for (const a of s.T) tanks.set(a[0], { x: a[1] / 100, y: a[2] / 100, dir: a[3], shield: a[4], hp: a[5], buffs: a[6] || 0, ack: a[7] || 0, skillCd: a[8] || 0 });
      const bullets = new Map();
      for (const a of s.B) bullets.set(a[0], { x: a[1] / 100, y: a[2] / 100, dir: a[3], kind: a[4] });
      const last = this.buf[this.buf.length - 1];
      if (last && s.k <= last.k) return;
      // 最新狀態（不延遲）：給自己坦克的預測用
      if (s.M) for (const [idx, ch] of s.M) this.liveTiles[idx] = ch;
      this.latest = { k: s.k, tanks, c: s.c };
      const snap = { k: s.k, tanks, bullets, M: s.M, L: s.L, S: s.S, E: s.E, K: s.K, X: s.X, I: s.I, P: s.P, O: s.O, OE: s.OE, W: s.W, Z: s.Z, N: s.N };
      this.buf.push(snap);
      // 死亡重播用：保留最近約 6 秒
      this.hist.push(snap);
      while (this.hist.length && this.hist[0].k < s.k - 180) this.hist.shift();
      const sample = now - s.k * tickMs;
      if (this.offset == null || sample < this.offset) this.offset = sample;
      else this.offset += (sample - this.offset) * 0.02; // 網路變慢時慢慢跟上
    }

    // 畫面播放到的伺服器 tick（比最新快照晚約 2 tick，用來吸收網路抖動）
    _renderTick(now) {
      if (!this.buf.length) return 0;
      if (this.fixedTick != null) {   // 重播：由播放器決定播到哪
        return Math.max(this.buf[0].k, Math.min(this.buf[this.buf.length - 1].k, this.fixedTick));
      }
      const tickMs = 1000 / this.meta.tickRate;
      let rt = (now - this.offset) / tickMs - INTERP_DELAY;
      const first = this.buf[0].k, last = this.buf[this.buf.length - 1].k;
      if (rt > last) rt = last;
      if (rt < first) rt = first;
      return rt;
    }

    // 快照裡的事件（爆炸、磚牆、命數、擊殺）在畫面播放到那個 tick 時才套用，跟子彈位置對齊
    _applyUpTo(rt, now) {
      for (const snap of this.buf) {
        if (snap.k <= this.appliedK) continue;
        if (snap.k > rt) break;
        if (snap.M) for (const [idx, ch] of snap.M) { this.tiles[idx] = ch; if (ch !== '#') this.wallHp.delete(idx); (this.dirtyTiles = this.dirtyTiles || []).push(idx); }
        if (snap.W) for (const [idx, hp] of snap.W) { this.wallHp.set(idx, hp); (this.dirtyTiles = this.dirtyTiles || []).push(idx); }
        if (snap.L) for (const [id, lives, alive] of snap.L) this.lives.set(id, { lives, alive: !!alive });
        if (snap.S) for (const [key, out, base] of snap.S) this.sideState.set(key, { out: !!out, base });
        if (snap.E) for (const [type, x, y, v] of snap.E) this.addEffect(type, x / 100, y / 100, now, v);
        if (snap.I) this.items = snap.I.map(a => ({ id: a[0], x: a[1] / 100, y: a[2] / 100, type: a[3], left: a[4], k: snap.k }));
        if (snap.P) for (const [tankId, type, x, y] of snap.P) {
          const it = this.meta.itemTypes[type];
          this.particles.push({ type: 'float', x: x / 100, y: y / 100, t0: now, dur: 1200, text: `${it.icon} ${it.name}`, bits: [] });
          if (this.onPickup) this.onPickup(tankId, type);
        }
        if (snap.O) this.obj = snap.O;
        if (snap.Z) this.smokes = snap.Z.map(a => ({ x: a[0] / 100, y: a[1] / 100, r: a[2] / 100, left: a[3], k: snap.k }));
        if (snap.N) this.mines = snap.N.map(a => ({ id: a[0], x: a[1] / 100, y: a[2] / 100, armed: a[3] }));
        if (snap.OE && this.onObjEvent) for (const e of snap.OE) this.onObjEvent(e);
        if (snap.X && this.onBaseKill) for (const [sideKey, shooter] of snap.X) this.onBaseKill(sideKey, shooter);
        if (snap.K) for (const [v, k, cause] of snap.K) {
          if (this.myTank && v === this.myTank.id && cause !== 'base') this._startReplay(snap.k, k, cause, now);
          if (this.onKill) this.onKill(v, k, cause);
        }
        this.appliedK = snap.k;
        this.tick = snap.k;
      }
      while (this.buf.length > 2 && this.buf[1].k < rt - 4 && this.buf[0].k <= this.appliedK) this.buf.shift();
    }

    // 開局倒數剩幾秒（null = 沒在倒數）
    countdownLeft() {
      if (!this.meta || !this.meta.startTicks) return null;
      const left = this.meta.startTicks - this.renderTick;
      return left > 0 ? left / this.meta.tickRate : null;
    }

    // 我的坦克目前的道具效果（bit：1 加速、2 速射、4 爆裂彈）
    myBuffs() {
      if (!this.myTank || !this.buf.length) return 0;
      let snap = this.buf[0];
      for (const s of this.buf) { if (s.k <= this.renderTick) snap = s; else break; }
      const t = snap.tanks.get(this.myTank.id);
      return t ? t.buffs : 0;
    }

    playTick() { return Math.max(0, this.renderTick - (this.meta ? this.meta.startTicks || 0 : 0)); }

    addEffect(type, x, y, now, v) {
      if (this.silent) return;        // 重播快轉時不產生特效
      if (this.onEvent) this.onEvent(type, x, y);
      if (type === 'shot') return;   // 只有音效，沒有畫面特效
      if (type === 'dmg') {          // 血量系統：飄出扣血數字
        this.particles.push({ type: 'float', x: x + (Math.random() - 0.5) * 0.4, y: y - 0.3, t0: now, dur: 800, text: '-' + v, color: '255, 110, 90', small: true, bits: [] });
        return;
      }
      if (type === 'heal') { this.particles.push({ type: 'float', x, y: y - 0.3, t0: now, dur: 900, text: '✚', color: '120, 240, 140', bits: [] }); }
      const dur = { skill: 400, wallHit: 250, capture: 900, waveStart: 1200, boom: 650, blast: 500, baseBoom: 1200, brick: 380, spark: 180, armor: 300, spawn: 500, emp: 600, timestop: 900, freezeHit: 400, confuseHit: 400, itemSpawn: 600, portal: 500 }[type] || 300;
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
      // 近距離鏡頭（房間設定）：只看得到自己周圍約 11 格；觀戰別人時也拉近
      const closeTile = Math.min(area.w, area.h) / CLOSE_VIEW;
      if (!spectator && this.meta.closeCam && closeTile > tile) { tile = closeTile; follow = true; }
      if (this.watchId != null && closeTile * 0.85 > tile) { tile = closeTile * 0.85; follow = true; }
      tile = Math.max(4, tile);
      if (tile !== this.tilePx) this.dirtyTerrain = true;
      this.tilePx = tile; this.fitTile = fit; this.follow = follow; this.area = area;
    }

    // ---------- 地形快取 ----------

    _buildTerrain() {
      const S = this.size, tp = this.tilePx;
      // 快取解析度：放大鏡頭時才不會太糊，但限制大小避免手機記憶體不夠
      const dpr = Math.min(this.dpr * 2, Math.max(this.dpr, 2400 / (S * tp)));
      this.cacheDpr = dpr;
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
        const whp = this.wallHp && this.wallHp.get(idx);
        if (whp) {
          // 加固的基地圍牆：鐵條＋依受損程度畫裂痕
          g.fillStyle = 'rgba(200, 210, 220, .55)';
          g.fillRect(x, y + tp * 0.12, tp, tp * 0.1);
          g.fillRect(x, y + tp * 0.78, tp, tp * 0.1);
          const dmg = this.baseWallHp - whp;
          if (dmg > 0) {
            g.strokeStyle = 'rgba(20, 10, 5, .85)'; g.lineWidth = Math.max(1, tp / 12);
            g.beginPath();
            g.moveTo(x + tp * 0.2, y + tp * 0.25); g.lineTo(x + tp * 0.45, y + tp * 0.5); g.lineTo(x + tp * 0.35, y + tp * 0.75);
            if (dmg > 1) { g.moveTo(x + tp * 0.8, y + tp * 0.2); g.lineTo(x + tp * 0.55, y + tp * 0.45); g.lineTo(x + tp * 0.75, y + tp * 0.8); }
            g.stroke();
          }
        }
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
      } else if (c === 'O') {      // 油桶
        const cx = x + tp / 2, cy = y + tp / 2;
        g.fillStyle = '#2a1a12'; g.beginPath(); g.ellipse(cx, cy + tp * 0.06, tp * 0.36, tp * 0.36, 0, 0, 7); g.fill();
        g.fillStyle = '#d6452f'; g.beginPath(); g.arc(cx, cy, tp * 0.34, 0, 7); g.fill();
        g.strokeStyle = '#7a1e10'; g.lineWidth = Math.max(1, tp / 14);
        g.beginPath(); g.arc(cx, cy, tp * 0.24, 0, 7); g.stroke();
        g.fillStyle = '#ffd23f';      // 警示三角形
        g.beginPath(); g.moveTo(cx, cy - tp * 0.15); g.lineTo(cx + tp * 0.14, cy + tp * 0.1); g.lineTo(cx - tp * 0.14, cy + tp * 0.1); g.closePath(); g.fill();
        g.fillStyle = '#2a1a12'; g.fillRect(cx - tp * 0.02, cy - tp * 0.07, tp * 0.04, tp * 0.09); g.fillRect(cx - tp * 0.02, cy + tp * 0.04, tp * 0.04, tp * 0.03);
      } else if (c === 'H') {      // 補血站
        g.fillStyle = '#123b24'; g.fillRect(x + tp * 0.06, y + tp * 0.06, tp * 0.88, tp * 0.88);
        g.strokeStyle = '#4ee08a'; g.lineWidth = Math.max(1, tp / 12); g.strokeRect(x + tp * 0.1, y + tp * 0.1, tp * 0.8, tp * 0.8);
        g.fillStyle = '#4ee08a';
        g.fillRect(x + tp * 0.42, y + tp * 0.22, tp * 0.16, tp * 0.56); g.fillRect(x + tp * 0.22, y + tp * 0.42, tp * 0.56, tp * 0.16);
      } else if (c === 'P') {      // 傳送門
        const cx = x + tp / 2, cy = y + tp / 2;
        for (const [r, col] of [[0.42, '#3b1d6e'], [0.32, '#7c4dff'], [0.2, '#b39dff'], [0.09, '#f3eaff']]) {
          g.fillStyle = col; g.beginPath(); g.arc(cx, cy, tp * r, 0, 7); g.fill();
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
      if (!this.meta || !this.buf.length) return;

      const rt = this._renderTick(now);
      this.renderTick = rt;
      this._applyUpTo(rt, now);
      if (this.dirtyTerrain) this._buildTerrain();
      else if (this.dirtyTiles) {
        const g = this.ground.getContext('2d'), gr = this.grass.getContext('2d');
        for (const idx of this.dirtyTiles) this._drawTile(g, gr, idx);
        this.dirtyTiles = null;
      }

      // 找出 rt 前後的兩張快照來插值
      let i = 0;
      while (i + 1 < this.buf.length && this.buf[i + 1].k <= rt) i++;
      const A = this.buf[i], B = this.buf[i + 1] || A;
      const alpha = B.k > A.k ? Math.min(1, Math.max(0, (rt - A.k) / (B.k - A.k))) : 0;
      const pos = (id, mapA, mapB) => {
        const a = mapA.get(id), b = mapB.get(id);
        if (!b || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 1.5) return [a.x, a.y];
        return [a.x + (b.x - a.x) * alpha, a.y + (b.y - a.y) * alpha];
      };

      const S = this.size;
      // 自己的坦克：用預測位置（馬上反應），其他坦克用伺服器時間軸插值
      this.predOff.x *= 0.82; this.predOff.y *= 0.82;
      const predPos = this.pred ? [this.pred.x + this.predOff.x, this.pred.y + this.predOff.y] : null;
      const myPos = predPos || (this.myTank && A.tanks.has(this.myTank.id) ? pos(this.myTank.id, A.tanks, B.tanks) : null);
      const sm = this.myTank ? this.sideMeta.get(this.mySide) : null;
      let homeX = myPos ? myPos[0] : sm ? sm.anchor.x + 0.5 : S / 2;
      let homeY = myPos ? myPos[1] : sm ? sm.anchor.y + 0.5 : S / 2;
      // 觀戰：鏡頭跟著選定的隊友
      if (this.watchId != null) {
        if (A.tanks.has(this.watchId)) [homeX, homeY] = pos(this.watchId, A.tanks, B.tanks);
      }

      // ---------- 鏡頭 ----------
      const area = this.area;
      const fullTile = Math.min(area.w / S, area.h / S);
      const full = { x: S / 2, y: S / 2, tile: fullTile };
      let normal;
      if (this.follow) {
        if (this.camX == null) { this.camX = homeX; this.camY = homeY; }
        this.camX += (homeX - this.camX) * 0.25; this.camY += (homeY - this.camY) * 0.25;
        const t = this.tilePx, half = { w: area.w / 2 / t, h: area.h / 2 / t };
        const cx = S * t <= area.w ? S / 2 : Math.min(S - half.w, Math.max(half.w, this.camX));
        const cy = S * t <= area.h ? S / 2 : Math.min(S - half.h, Math.max(half.h, this.camY));
        normal = { x: cx, y: cy, tile: t };
      } else normal = full;

      let cam = normal;
      const startTicks = this.meta.startTicks || 0;
      if (startTicks && rt < startTicks + 20) {
        // 開場：先拉近到自己 → 拉遠到全圖 → 倒數結束後回到一般視角
        const close = this.myTank ? { x: homeX, y: homeY, tile: Math.max(fullTile * 2.5, Math.min(area.w, area.h) / 7) } : full;
        const p = rt / startTicks;
        const ease = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tile: Math.exp(Math.log(a.tile) + (Math.log(b.tile) - Math.log(a.tile)) * t) });
        if (this.meta.closeCam && this.myTank) cam = rt < startTicks ? close : mix(close, normal, ease((rt - startTicks) / 20));   // 近距離鏡頭：不給看全圖
        else if (p < 0.3) cam = close;
        else if (p < 0.75) cam = mix(close, full, ease((p - 0.3) / 0.45));
        else if (rt < startTicks) cam = full;
        else cam = mix(full, normal, ease((rt - startTicks) / 20));
      }
      const tp = cam.tile;
      const ox = Math.round(area.x + area.w / 2 - cam.x * tp);
      const oy = Math.round(area.y + area.h / 2 - cam.y * tp);
      const mapW = S * tp;

      ctx.save();
      ctx.translate(ox, oy);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.ground, 0, 0, mapW, mapW);
      ctx.strokeStyle = '#2f3845'; ctx.lineWidth = 2; ctx.strokeRect(-1, -1, mapW + 2, mapW + 2);

      // 開局保護期：基地圍牆發光
      if (this.wallShieldTicks && this.playTick() < this.wallShieldTicks) {
        ctx.strokeStyle = `rgba(120, 220, 255, ${0.5 + 0.3 * Math.sin(now / 200)})`;
        ctx.lineWidth = Math.max(1.5, tp * 0.08);
        for (const [idx] of this.wallHp) {
          if (this.tiles[idx] !== '#') continue;
          ctx.strokeRect((idx % S) * tp + 1, Math.floor(idx / S) * tp + 1, tp - 2, tp - 2);
        }
      }

      // 基地
      for (const side of this.meta.sides) {
        if (!side.base) continue;
        const st = this.sideState.get(side.key);
        this._drawBase(ctx, side.base.x * tp, side.base.y * tp, tp, side.color, st && st.base === 1);
      }

      // 遊戲目標：佔點區域、旗子
      if (this.obj && this.obj.type === 'koth') {
        const [hx, hy, hr] = this.obj.hill;
        const holder = this.obj.h && this.obj.h !== 'contested' ? this.sideMeta.get(this.obj.h) : null;
        const pulse = 0.5 + 0.5 * Math.sin(now / 300);
        ctx.fillStyle = holder ? holder.color + '40' : this.obj.h === 'contested' ? 'rgba(255,80,80,.25)' : 'rgba(255,255,255,.08)';
        ctx.fillRect((hx - hr) * tp, (hy - hr) * tp, hr * 2 * tp, hr * 2 * tp);
        ctx.strokeStyle = holder ? holder.color : `rgba(255,255,255,${0.4 + 0.4 * pulse})`;
        ctx.lineWidth = Math.max(2, tp * 0.1); ctx.setLineDash([tp * 0.3, tp * 0.2]);
        ctx.strokeRect((hx - hr) * tp, (hy - hr) * tp, hr * 2 * tp, hr * 2 * tp);
        ctx.setLineDash([]);
      }
      if (this.obj && this.obj.type === 'escort' && this.meta.escortPath) {
        // 護送路線與礦車
        const path = this.meta.escortPath, o = this.obj, sm = this.sideMeta.get(o.att);
        ctx.save();
        ctx.strokeStyle = sm.color + '88'; ctx.lineWidth = Math.max(2, tp * 0.12); ctx.setLineDash([tp * 0.25, tp * 0.2]);
        ctx.beginPath(); path.forEach((p, i) => i ? ctx.lineTo(p[0] * tp, p[1] * tp) : ctx.moveTo(p[0] * tp, p[1] * tp)); ctx.stroke();
        ctx.setLineDash([]);
        const endP = path[Math.min(path.length - 1, o.end)];
        ctx.strokeStyle = sm.color; ctx.strokeRect((endP[0] - 0.5) * tp, (endP[1] - 0.5) * tp, tp, tp);
        const k = Math.min(path.length - 1, Math.floor(o.i)), f = o.i - k, p = path[k], q = path[Math.min(path.length - 1, k + 1)];
        const cx = (p[0] + (q[0] - p[0]) * f) * tp, cy = (p[1] + (q[1] - p[1]) * f) * tp;
        ctx.fillStyle = o.st === 'contested' ? 'rgba(255,80,80,.12)' : sm.color + '22';
        ctx.beginPath(); ctx.arc(cx, cy, (this.meta.cartRadius || 2) * tp, 0, 7); ctx.fill();
        ctx.fillStyle = '#6b4a2b'; ctx.fillRect(cx - tp * 0.45, cy - tp * 0.3, tp * 0.9, tp * 0.5);
        ctx.fillStyle = sm.color; ctx.fillRect(cx - tp * 0.45, cy - tp * 0.36, tp * 0.9, tp * 0.12);
        ctx.fillStyle = '#222';
        for (const wx of [-0.28, 0.28]) { ctx.beginPath(); ctx.arc(cx + wx * tp, cy + tp * 0.24, tp * 0.12, 0, 7); ctx.fill(); }
        ctx.restore();
      }
      if (this.obj && this.obj.type === 'ctf') {
        for (const [side, fx, fy, carrier, atHome] of this.obj.f) {
          const sm = this.sideMeta.get(side);
          let x = fx / 100, y = fy / 100;
          if (carrier && A.tanks.has(carrier)) { const p = pos(carrier, A.tanks, B.tanks); x = p[0]; y = p[1] - 0.55; }
          const px = x * tp, py = y * tp, h = tp * 0.9;
          ctx.fillStyle = '#e8edf3'; ctx.fillRect(px - tp * 0.05, py - h / 2, tp * 0.1, h);
          ctx.fillStyle = sm.color;
          ctx.beginPath(); ctx.moveTo(px + tp * 0.05, py - h / 2); ctx.lineTo(px + tp * 0.55, py - h / 4); ctx.lineTo(px + tp * 0.05, py); ctx.fill();
          if (!atHome && !carrier) { ctx.strokeStyle = sm.color; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px, py, tp * 0.6 * (1 + 0.15 * Math.sin(now / 150)), 0, 7); ctx.stroke(); }
        }
      }

      // 場地道具
      for (const it of this.items) {
        const left = it.left - (rt - it.k);
        if (left <= 0) continue;
        if (left < 90 && Math.floor(now / 150) % 2) continue;   // 快消失時閃爍
        const type = this.meta.itemTypes[it.type];
        const bob = Math.sin(now / 300 + it.id) * tp * 0.05;
        const cx = it.x * tp, cy = it.y * tp + bob, r = tp * 0.4;
        ctx.fillStyle = 'rgba(20, 24, 30, .85)';
        ctx.strokeStyle = '#f2c94c'; ctx.lineWidth = Math.max(1.5, tp * 0.06);
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(cx - r, cy - r, r * 2, r * 2, r * 0.35) : ctx.rect(cx - r, cy - r, r * 2, r * 2);
        ctx.fill(); ctx.stroke();
        ctx.font = `${Math.max(9, tp * 0.55)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(type.icon, cx, cy + tp * 0.03);
        if (tp >= 16) {   // 道具下方的兩字說明
          ctx.font = `800 ${Math.max(9, tp * 0.34)}px system-ui, sans-serif`;
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)';
          ctx.strokeText(type.label, cx, cy + r + tp * 0.22);
          ctx.fillStyle = '#ffe9a6';
          ctx.fillText(type.label, cx, cy + r + tp * 0.22);
        }
      }

      // 我方地雷
      for (const m of this.mines) {
        ctx.fillStyle = '#2b2f36'; ctx.strokeStyle = '#ff9f43'; ctx.lineWidth = Math.max(1, tp * 0.05);
        ctx.beginPath(); ctx.arc(m.x * tp, m.y * tp, tp * 0.22, 0, 7); ctx.fill(); ctx.stroke();
        if (m.armed && Math.floor(now / 400) % 2) { ctx.fillStyle = '#ff3b3b'; ctx.beginPath(); ctx.arc(m.x * tp, m.y * tp, tp * 0.08, 0, 7); ctx.fill(); }
      }

      // 子彈
      for (const [id, b] of A.bullets) {
        const [x, y] = pos(id, A.bullets, B.bullets);
        const r = (b.kind === 2 ? 0.15 : b.kind >= 3 ? 0.13 : 0.1) * tp;
        ctx.fillStyle = BULLET_COLORS[b.kind] || '#fff4b0';
        ctx.beginPath(); ctx.arc(x * tp, y * tp, Math.max(1.5, r), 0, 7); ctx.fill();
        if (b.kind === 1) { ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.stroke(); }
      }

      // 坦克
      const drawn = [];
      if (predPos && this.myTank && !A.tanks.has(this.myTank.id) && this.latest && this.latest.tanks.has(this.myTank.id)) {
        // 剛重生：伺服器時間軸還沒播到，但預測已經有位置
        const m = this.myTank, t = this.latest.tanks.get(m.id);
        this._drawTank(ctx, predPos[0] * tp, predPos[1] * tp, this.pred.angle, this.sideMeta.get(m.side).color, m, tp * this.meta.tankSize, t, now);
      }
      for (let [id, t] of A.tanks) {
        const m = this.tankMeta.get(id);
        if (!m) continue;
        let [x, y] = pos(id, A.tanks, B.tanks);
        if (predPos && this.myTank && id === this.myTank.id) {
          [x, y] = predPos;
          const latestMe = this.latest && this.latest.tanks.get(id);
          t = Object.assign({}, latestMe || t, { dir: this.pred.angle });
        }
        drawn.push([id, x, y, t.hp]);
        const ghost = t.buffs & (8 | 128);       // 隱形或穿牆：半透明
        if (ghost) ctx.globalAlpha = t.buffs & 8 ? 0.35 : 0.6;
        this._drawTank(ctx, x * tp, y * tp, t.dir, this.sideMeta.get(m.side).color, m, tp * this.meta.tankSize, t, now);
        ctx.globalAlpha = 1;
        if (t.buffs & 2048) {                     // 衝刺：殘影
          ctx.fillStyle = 'rgba(255,255,255,.18)';
          ctx.beginPath(); ctx.arc(x * tp, y * tp, tp * 0.6, 0, 7); ctx.fill();
        }
        if (t.buffs & 4096) {                     // 狙擊蓄力中
          ctx.strokeStyle = `rgba(255, 235, 59, ${0.5 + 0.4 * Math.sin(now / 90)})`; ctx.lineWidth = Math.max(1.5, tp * 0.08);
          ctx.beginPath(); ctx.arc(x * tp, y * tp, tp * 0.5, 0, 7); ctx.stroke();
        }
        if (t.buffs & 32) {                       // 冰凍
          ctx.fillStyle = 'rgba(150, 220, 255, .45)';
          ctx.fillRect((x - 0.48) * tp, (y - 0.48) * tp, 0.96 * tp, 0.96 * tp);
          ctx.strokeStyle = '#bfefff'; ctx.lineWidth = Math.max(1, tp * 0.05);
          ctx.strokeRect((x - 0.48) * tp, (y - 0.48) * tp, 0.96 * tp, 0.96 * tp);
        }
        if (t.buffs & 64) {                       // 混亂：頭上轉圈的星星
          ctx.font = `${Math.max(9, tp * 0.45)}px system-ui, "Apple Color Emoji", sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('💫', (x + Math.cos(now / 150) * 0.3) * tp, (y - 0.7) * tp);
        }
        if (t.buffs) {
          // 道具效果：坦克周圍的彩色光圈
          const colors = [];
          if (t.buffs & 1) colors.push('#4fd1ff');
          if (t.buffs & (2 | 256)) colors.push('#ff8a3d');
          if (t.buffs & (4 | 512 | 1024)) colors.push('#ff4d6d');
          colors.forEach((c, i) => {
            ctx.strokeStyle = c; ctx.lineWidth = Math.max(1, tp * 0.05);
            ctx.setLineDash([tp * 0.12, tp * 0.1]); ctx.lineDashOffset = -now / 40;
            ctx.beginPath(); ctx.arc(x * tp, y * tp, tp * (0.56 + i * 0.09), 0, 7); ctx.stroke();
          });
          ctx.setLineDash([]);
        }
      }

      // 草叢（偵察職業看得穿）
      const radarOn = this.myBuffs() & 16;
      ctx.globalAlpha = this.myTank && (this.myTank.grassSight || radarOn) ? 0.45 : 0.94;
      ctx.drawImage(this.grass, 0, 0, mapW, mapW);
      ctx.globalAlpha = 1;

      // 煙霧
      for (const s of this.smokes) {
        const left = s.left - (rt - s.k);
        if (left <= 0) continue;
        const fade = Math.min(1, left / 20);
        for (let i = 0; i < 7; i++) {
          const a = i / 7 * Math.PI * 2 + now / 3000;
          const ox2 = Math.cos(a) * s.r * 0.45, oy2 = Math.sin(a) * s.r * 0.45;
          ctx.fillStyle = `rgba(190, 196, 205, ${0.32 * fade})`;
          ctx.beginPath(); ctx.arc((s.x + ox2) * tp, (s.y + oy2) * tp, s.r * 0.65 * tp, 0, 7); ctx.fill();
        }
      }

      // 血條（血量系統）
      const hpOn = this.meta.hpSystem;
      if (hpOn && tp >= 7) {
        for (const [id, x, y, hp] of drawn) {
          const m = this.tankMeta.get(id);
          if (!m || !m.maxHp) continue;
          const w = 0.86 * tp, h = Math.max(3, 0.11 * tp), bx = x * tp - w / 2, by = (y - 0.62) * tp - h;
          const f = Math.max(0, Math.min(1, hp / m.maxHp)), over = Math.max(0, Math.min(0.5, hp / m.maxHp - 1));
          ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
          ctx.fillStyle = f > 0.6 ? '#5ee07a' : f > 0.3 ? '#ffd23f' : '#ff5a4f';
          ctx.fillRect(bx, by, w * f, h);
          if (over) { ctx.fillStyle = '#9fdcff'; ctx.fillRect(bx, by, w * over * 2, h * 0.45); }
          ctx.fillStyle = this.sideMeta.get(m.side).color; ctx.fillRect(bx - 1, by + h, w + 2, Math.max(1, h * 0.25));   // 隊伍色底線
        }
      }

      // 名字標籤
      if (tp >= 12) {
        ctx.font = `700 ${Math.max(9, Math.min(15, tp * 0.55))}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        for (const [id, x, y] of drawn) {
          const m = this.tankMeta.get(id);
          if (!m || (m.isBot && !this.meta.codeOnly)) continue;
          const label = m.name.length > 6 ? m.name.slice(0, 6) + '…' : m.name;
          ctx.fillStyle = 'rgba(0,0,0,.6)';
          const ly = (y - (hpOn ? 0.8 : 0.55)) * tp;
          ctx.fillText(label, x * tp + 1, ly + 1);
          ctx.fillStyle = this.sideMeta.get(m.side).color;
          ctx.fillText(label, x * tp, ly);
        }
      }

      // 縮圈：安全區外塗紅，縮圈開始前 10 秒先用虛線預告最後的範圍
      const Z = this.meta.zone;
      if (Z) {
        const pt = rt - startTicks;
        const k = Math.max(0, Math.min(1, (pt - Z.start) / (Z.end - Z.start)));
        const half = Z.full - (Z.full - Z.minHalf) * k, c = S / 2;
        if (k > 0) {
          ctx.fillStyle = 'rgba(220, 40, 40, .2)';
          ctx.beginPath();
          ctx.rect(0, 0, mapW, mapW);
          ctx.rect((c - half) * tp, (c - half) * tp, half * 2 * tp, half * 2 * tp);
          ctx.fill('evenodd');
          ctx.strokeStyle = `rgba(255, 90, 80, ${0.7 + 0.3 * Math.sin(now / 150)})`; ctx.lineWidth = Math.max(2, tp * 0.1);
          ctx.strokeRect((c - half) * tp, (c - half) * tp, half * 2 * tp, half * 2 * tp);
        }
        if (pt > Z.start - 10 * 30 && k < 1) {
          ctx.save(); ctx.setLineDash([tp * 0.3, tp * 0.25]);
          ctx.strokeStyle = 'rgba(255, 255, 255, .45)'; ctx.lineWidth = Math.max(1.5, tp * 0.06);
          ctx.strokeRect((c - Z.minHalf) * tp, (c - Z.minHalf) * tp, Z.minHalf * 2 * tp, Z.minHalf * 2 * tp);
          ctx.restore();
        }
      }

      // 特效
      this.particles = this.particles.filter(p => now - p.t0 < p.dur);
      for (const p of this.particles) this._drawEffect(ctx, p, (now - p.t0) / p.dur, tp);

      // 電腦代碼的除錯繪圖（只有代碼主人看得到）
      if (this.showBotDebug && this.debugOps && now - this.debugOps.at < 400) {
        ctx.save();
        ctx.lineWidth = Math.max(1.5, tp * 0.07);
        ctx.font = `700 ${Math.max(10, tp * 0.45)}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const ops of Object.values(this.debugOps.byTank)) for (const op of ops) {
          const col = op[op.length - 1];
          ctx.strokeStyle = col; ctx.fillStyle = col;
          if (op[0] === 'l') { ctx.beginPath(); ctx.moveTo(op[1] * tp, op[2] * tp); ctx.lineTo(op[3] * tp, op[4] * tp); ctx.stroke(); }
          else if (op[0] === 'c') { ctx.beginPath(); ctx.arc(op[1] * tp, op[2] * tp, Math.max(1, op[3] * tp), 0, 7); ctx.stroke(); }
          else if (op[0] === 't') { ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(op[3], op[1] * tp, op[2] * tp); ctx.fillText(op[3], op[1] * tp, op[2] * tp); ctx.lineWidth = Math.max(1.5, tp * 0.07); }
          else if (op[0] === 'p') { const f = op[1]; ctx.beginPath(); for (let i = 0; i + 1 < f.length; i += 2) i ? ctx.lineTo(f[i] * tp, f[i + 1] * tp) : ctx.moveTo(f[i] * tp, f[i + 1] * tp); ctx.stroke(); }
        }
        ctx.restore();
      }

      // 瞄準輔助線：子彈會飛到哪裡（包含反彈）
      if (this.showAim && this.pred && predPos && this.latest) {
        const me = this.latest.tanks.get(this.myTank.id);
        if (me) {
          const world = { size: S, tiles: this.liveTiles, tankSize: this.meta.tankSize };
          let bounces = this.meta.ricochet ? this.meta.bulletBounces : 0;
          if (me.buffs & 512) bounces = Math.max(bounces, this.meta.bounceBuff);
          const a0 = this.pred.angle, spread = this.meta.spreadAngle || 25;
          const dirs = me.buffs & 256 ? [a0, a0 - spread, a0 + spread] : [a0];
          ctx.save();
          ctx.setLineDash([tp * 0.18, tp * 0.16]);
          ctx.lineWidth = Math.max(1.2, tp * 0.06);
          ctx.strokeStyle = 'rgba(255, 255, 255, .6)';
          for (const d of dirs) {
            const mz = window.TankPhysics.muzzle(predPos[0], predPos[1], d, this.meta.tankSize / 2);
            const pts = window.TankPhysics.traceShot(world, mz[0], mz[1], d, bounces, 14, this.meta.breakableWalls !== false);
            ctx.beginPath();
            pts.forEach((p, i) => i ? ctx.lineTo(p[0] * tp, p[1] * tp) : ctx.moveTo(p[0] * tp, p[1] * tp));
            ctx.stroke();
            const end = pts[pts.length - 1];
            ctx.setLineDash([]);
            ctx.beginPath(); ctx.arc(end[0] * tp, end[1] * tp, Math.max(2, tp * 0.1), 0, 7); ctx.stroke();
            ctx.setLineDash([tp * 0.18, tp * 0.16]);
          }
          ctx.restore();
        }
      }

      // 迷霧
      if (this.meta.fog && this.myTank && !radarOn) {
        const r = this.myTank.vision * tp;
        const grad = ctx.createRadialGradient(homeX * tp, homeY * tp, r * 0.78, homeX * tp, homeY * tp, r);
        grad.addColorStop(0, 'rgba(4,6,9,0)');
        grad.addColorStop(1, 'rgba(4,6,9,0.86)');
        ctx.fillStyle = grad;
        ctx.fillRect(-ox, -oy, this.W, this.H);
      }

      // 我的坦克標記（倒數時加上醒目的光圈和「你」）
      if (myPos) {
        const mx = myPos[0] * tp, my = myPos[1] * tp;
        if (startTicks && rt < startTicks + 15) {
          const pulse = (now % 900) / 900;
          ctx.strokeStyle = `rgba(255,255,255,${1 - pulse})`;
          ctx.lineWidth = Math.max(2, tp * 0.1);
          ctx.beginPath(); ctx.arc(mx, my, tp * (0.7 + pulse * 1.3), 0, 7); ctx.stroke();
          ctx.font = `900 ${Math.max(14, Math.min(28, tp * 0.9))}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.7)';
          const ly = my - tp * 1.1 - Math.max(14, tp * 0.4);
          ctx.strokeText('你', mx, ly); ctx.fillStyle = '#fff'; ctx.fillText('你', mx, ly);
        }
        const bob = Math.sin(now / 200) * 0.08;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        const ty = (myPos[1] - 0.95 - bob) * tp;
        ctx.moveTo(mx - tp * 0.18, ty - tp * 0.2); ctx.lineTo(mx + tp * 0.18, ty - tp * 0.2); ctx.lineTo(mx, ty);
        ctx.fill();
      }
      ctx.restore();
      // 近距離鏡頭：視野邊緣漸暗，只看得清楚自己周圍
      if (this.meta.closeCam && this.myTank && rt >= startTicks) {
        const fx = ox + homeX * tp, fy = oy + homeY * tp, R = Math.min(area.w, area.h) * 0.5;
        const gr = ctx.createRadialGradient(fx, fy, R * 0.45, fx, fy, R * 1.0);
        gr.addColorStop(0, 'rgba(7, 9, 12, 0)'); gr.addColorStop(0.6, 'rgba(7, 9, 12, .55)'); gr.addColorStop(1, 'rgba(7, 9, 12, .98)');
        ctx.save(); ctx.beginPath(); ctx.rect(area.x, area.y, area.w, area.h); ctx.clip();
        ctx.fillStyle = gr; ctx.fillRect(area.x, area.y, area.w, area.h);
        ctx.restore();
      }
    }

    // ---------- 死亡重播 ----------

    _startReplay(kDeath, killerId, cause, now) {
      const before = this.hist.filter(f => f.k < kDeath && f.tanks.has(this.myTank.id));
      if (!before.length) return;
      const last = before[before.length - 1].tanks.get(this.myTank.id);
      const k0 = Math.max(this.hist[0].k, kDeath - REPLAY_BEFORE);
      this.replay = {
        kDeath, k0, k1: kDeath + REPLAY_AFTER, killerId, cause,
        x: last.x, y: last.y,
        start: now + 200,               // 先讓本體爆炸播一下
        durMs: (kDeath + REPLAY_AFTER - k0) * (1000 / this.meta.tickRate) / REPLAY_SPEED,
      };
    }

    replayActive(now) {
      const r = this.replay;
      if (!r) return false;
      if (now > r.start + r.durMs + 900) { this.replay = null; return false; }
      return now >= r.start;
    }

    closeReplay() { this.replay = null; }

    drawReplay(canvas, now) {
      const r = this.replay;
      if (!r || !this.ground) return;
      const dpr = this.dpr;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#07090c'; ctx.fillRect(0, 0, W, H);

      const p = Math.min(1, (now - r.start) / r.durMs);
      const rt = r.k0 + (r.k1 - r.k0) * p;
      const frames = this.hist.filter(f => f.k >= r.k0 - 1 && f.k <= r.k1 + 1);
      if (!frames.length) return;
      let i = 0;
      while (i + 1 < frames.length && frames[i + 1].k <= rt) i++;
      const A = frames[i], B = frames[i + 1] || A;
      const alpha = B.k > A.k ? Math.min(1, Math.max(0, (rt - A.k) / (B.k - A.k))) : 0;
      const pos = (id, ma, mb) => {
        const a = ma.get(id), b = mb.get(id);
        if (!b || Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 1.5) return [a.x, a.y];
        return [a.x + (b.x - a.x) * alpha, a.y + (b.y - a.y) * alpha];
      };

      const tp = Math.min(W, H) / 9;
      const ox = W / 2 - r.x * tp, oy = H / 2 - r.y * tp;
      const S = this.size;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.drawImage(this.ground, 0, 0, S * tp, S * tp);
      for (const side of this.meta.sides) if (side.base) this._drawBase(ctx, side.base.x * tp, side.base.y * tp, tp, side.color, true);

      // 子彈（拖尾讓軌跡更清楚）
      for (const [id, b] of A.bullets) {
        const [x, y] = pos(id, A.bullets, B.bullets);
        const v = this.meta.angles ? window.TankPhysics.vec(b.dir) : VEC[b.dir];
        ctx.strokeStyle = 'rgba(255, 240, 160, .45)'; ctx.lineWidth = Math.max(2, tp * 0.12);
        ctx.beginPath(); ctx.moveTo(x * tp, y * tp); ctx.lineTo((x - v[0] * 0.9) * tp, (y - v[1] * 0.9) * tp); ctx.stroke();
        ctx.fillStyle = b.kind === 2 ? '#ff9f43' : '#fff4b0';
        ctx.beginPath(); ctx.arc(x * tp, y * tp, Math.max(2, tp * 0.12), 0, 7); ctx.fill();
      }
      // 坦克
      for (const [id, t] of A.tanks) {
        const m = this.tankMeta.get(id);
        if (!m) continue;
        const [x, y] = pos(id, A.tanks, B.tanks);
        this._drawTank(ctx, x * tp, y * tp, t.dir, this.sideMeta.get(m.side).color, m, tp * this.meta.tankSize, t, now);
        if (id === r.killerId || id === this.myTank.id) {
          ctx.strokeStyle = id === r.killerId ? '#ff4d4d' : '#ffffff';
          ctx.lineWidth = Math.max(2, tp * 0.08);
          ctx.beginPath(); ctx.arc(x * tp, y * tp, tp * 0.62, 0, 7); ctx.stroke();
          ctx.font = `800 ${Math.max(10, tp * 0.36)}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillStyle = id === r.killerId ? '#ff4d4d' : '#ffffff';
          ctx.fillText(id === r.killerId ? '擊殺者' : '你', x * tp, (y - 0.7) * tp);
        }
      }
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.grass, 0, 0, S * tp, S * tp);
      ctx.globalAlpha = 1;
      // 死亡瞬間的爆炸
      if (rt >= r.kDeath) {
        const k = Math.min(1, (rt - r.kDeath) / REPLAY_AFTER);
        ctx.fillStyle = `rgba(255, ${Math.round(200 - 140 * k)}, 60, ${0.9 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(r.x * tp, r.y * tp, tp * (0.3 + 0.9 * k), 0, 7); ctx.fill();
      }
      ctx.restore();
      // 進度條
      ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(0, H - 4, W, 4);
      ctx.fillStyle = '#ff6b6b'; ctx.fillRect(0, H - 4, W * p, 4);
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
      // 新版快照是角度（度）；舊的重播檔是八方向編號
      ctx.rotate(this.meta && this.meta.angles ? dirIdx * Math.PI / 180 : ANGLE[dirIdx]);
      const cls = m.cls;
      const dark = shade(color, -0.35), darker = shade(color, -0.5), light = shade(color, 0.25);
      const R = (fx, fy, fw, fh) => ctx.fillRect(fx * s, fy * s, fw * s, fh * s);
      const poly = pts => { ctx.beginPath(); pts.forEach(([px, py], i) => i ? ctx.lineTo(px * s, py * s) : ctx.moveTo(px * s, py * s)); ctx.closePath(); ctx.fill(); };
      const circle = (cx, cy, r) => { ctx.beginPath(); ctx.arc(cx * s, cy * s, r * s, 0, 7); ctx.fill(); };
      const barrel = (w, len, off = 0) => R(off - w / 2, -len, w, len - 0.05);
      // 每個職業的外型：履帶寬、車身寬
      const hullW = { heavy: 0.37, scout: 0.25, sniper: 0.28, nurse: 0.3 }[cls] || 0.32;
      const treadW = 0.5 - hullW + 0.04;
      // 履帶（重裝有裝甲裙板、偵察履帶細）
      ctx.fillStyle = '#1d2026';
      R(-0.5, -0.5, treadW, 1); R(hullW - 0.04, -0.5, treadW, 1);
      ctx.fillStyle = '#3a3f48';
      const links = cls === 'scout' ? 4 : 5;
      for (let i = 0; i < links; i++) {
        const ty = -0.45 + i * (0.9 / links) + 0.02;
        R(-0.5, ty, treadW, 0.07); R(hullW - 0.04, ty, treadW, 0.07);
      }
      if (cls === 'heavy') {          // 裝甲裙板＋鉚釘
        ctx.fillStyle = darker;
        R(-0.52, -0.36, treadW + 0.02, 0.72); R(hullW - 0.04, -0.36, treadW + 0.02, 0.72);
        ctx.fillStyle = '#9aa3ad';
        for (let i = 0; i < 3; i++) { circle(-0.52 + (treadW + 0.02) / 2, -0.24 + i * 0.24, 0.025); circle(hullW - 0.04 + (treadW + 0.02) / 2, -0.24 + i * 0.24, 0.025); }
      }
      // 車身
      ctx.fillStyle = m.isBot ? dark : color;
      if (cls === 'scout') poly([[-hullW, 0.42], [-hullW, -0.2], [0, -0.5], [hullW, -0.2], [hullW, 0.42]]);           // 尖頭
      else if (cls === 'assault') poly([[-hullW, 0.42], [-hullW, -0.3], [-hullW + 0.1, -0.42], [hullW - 0.1, -0.42], [hullW, -0.3], [hullW, 0.42]]);   // 切角
      else R(-hullW, -0.42, hullW * 2, 0.84);
      if (m.isBot) { ctx.fillStyle = color; R(-hullW, -0.1, hullW * 2, 0.12); }      // 電腦：車身條紋
      // 車身細節
      if (cls === 'assault') { ctx.fillStyle = light; poly([[-0.14, 0.3], [0, 0.2], [0.14, 0.3], [0.14, 0.36], [0, 0.26], [-0.14, 0.36]]); }
      else if (cls === 'scout') { ctx.fillStyle = darker; R(-hullW + 0.03, 0.3, 0.06, 0.16); R(hullW - 0.09, 0.3, 0.06, 0.16); }   // 尾翼
      else if (cls === 'sniper') { ctx.fillStyle = darker; circle(-0.15, 0.25, 0.05); circle(0.13, 0.3, 0.04); circle(0.16, -0.28, 0.045); circle(-0.12, -0.3, 0.035); }   // 迷彩
      else if (cls === 'demo') {      // 尾部警示條紋
        ctx.save(); ctx.beginPath(); ctx.rect(-hullW * s, 0.24 * s, hullW * 2 * s, 0.18 * s); ctx.clip();
        ctx.fillStyle = '#1d2026'; R(-hullW, 0.24, hullW * 2, 0.18);
        ctx.fillStyle = '#ffb020';
        for (let i = -4; i < 5; i++) poly([[i * 0.12, 0.42], [i * 0.12 + 0.06, 0.42], [i * 0.12 + 0.14, 0.24], [i * 0.12 + 0.08, 0.24]]);
        ctx.restore();
      } else if (cls === 'engineer') {  // 推土鏟
        ctx.fillStyle = '#c9ced6'; R(-0.5, -0.58, 1, 0.12);
        ctx.fillStyle = '#7d848e'; R(-0.5, -0.48, 1, 0.04);
        ctx.fillStyle = '#ffcc33'; R(-hullW + 0.02, 0.3, 0.1, 0.1); R(hullW - 0.12, 0.3, 0.1, 0.1);
      } else if (cls === 'nurse') { ctx.fillStyle = '#f4f6f8'; R(-hullW, 0.22, hullW * 2, 0.08); }
      if (cls === 'heavy' && !(this.meta && this.meta.hpSystem)) {   // 沒開血量系統：還有第二層裝甲時亮白框
        ctx.strokeStyle = st.hp >= 2 ? '#e8edf3' : darker;
        ctx.lineWidth = Math.max(1, s * 0.07);
        ctx.strokeRect(-hullW * s, -0.42 * s, hullW * 2 * s, 0.84 * s);
      }
      // 砲管（先畫，砲塔蓋在上面）
      ctx.fillStyle = '#d9dee6';
      if (cls === 'assault') { barrel(0.07, 0.62, -0.07); barrel(0.07, 0.62, 0.07); }
      else if (cls === 'heavy') { barrel(0.16, 0.6); ctx.fillStyle = '#aeb5bf'; R(-0.12, -0.66, 0.24, 0.1); }   // 砲口制退器
      else if (cls === 'scout') barrel(0.06, 0.48);
      else if (cls === 'sniper') { barrel(0.06, 0.86); ctx.fillStyle = '#aeb5bf'; R(-0.055, -0.88, 0.11, 0.07); }
      else if (cls === 'demo') { barrel(0.22, 0.44); ctx.fillStyle = '#ff9f43'; R(-0.12, -0.5, 0.24, 0.08); }
      else if (cls === 'engineer') barrel(0.09, 0.5);
      else if (cls === 'nurse') barrel(0.07, 0.48);
      else barrel(0.09, 0.55);
      // 砲塔
      ctx.fillStyle = m.isBot ? color : dark;
      if (cls === 'bot' || cls === 'monster') R(-0.15, -0.15, 0.3, 0.3);
      else if (cls === 'heavy') R(-0.22, -0.22, 0.44, 0.44);
      else if (cls === 'assault') poly([[-0.2, -0.08], [-0.1, -0.2], [0.1, -0.2], [0.2, -0.08], [0.2, 0.12], [0.12, 0.2], [-0.12, 0.2], [-0.2, 0.12]]);
      else if (cls === 'scout') circle(0, 0.02, 0.15);
      else if (cls === 'demo') circle(0, 0, 0.23);
      else if (cls === 'nurse') { ctx.fillStyle = '#f4f6f8'; circle(0, 0, 0.2); }
      else circle(0, 0, 0.19);
      // 砲塔上的標記
      if (cls === 'sniper') { ctx.fillStyle = '#2b3038'; R(0.1, -0.2, 0.08, 0.26); ctx.fillStyle = '#7fdcff'; R(0.11, -0.22, 0.06, 0.05); }   // 瞄準鏡
      else if (cls === 'nurse') { ctx.fillStyle = '#e84a5f'; R(-0.04, -0.13, 0.08, 0.26); R(-0.13, -0.04, 0.26, 0.08); }     // 紅十字
      else if (cls === 'engineer') { ctx.strokeStyle = '#ffcc33'; ctx.lineWidth = Math.max(1, s * 0.05); ctx.beginPath(); ctx.arc(0, 0, 0.1 * s, 0, 7); ctx.stroke(); R(-0.02, -0.02, 0.04, 0.04); }   // 齒輪
      else if (cls === 'heavy') { ctx.fillStyle = darker; R(-0.14, 0.06, 0.28, 0.06); }
      else if (cls === 'demo') { ctx.fillStyle = '#ff9f43'; circle(0, 0, 0.07); }
      if (m.isBot) { // 天線
        ctx.strokeStyle = light; ctx.lineWidth = Math.max(1, s * 0.04);
        ctx.beginPath(); ctx.moveTo(0.2 * s, 0.3 * s); ctx.lineTo(0.3 * s, 0.48 * s); ctx.stroke();
        ctx.fillStyle = light; circle(0.3, 0.48, 0.04);
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
        const R = (p.type === 'baseBoom' ? 1.8 : p.type === 'blast' ? (this.meta.blastRadius || 1.1) + 0.3 : 0.9) * tp;
        ctx.fillStyle = `rgba(255, ${Math.round(200 - 140 * k)}, 60, ${0.85 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(x, y, R * (0.3 + 0.7 * ease), 0, 7); ctx.fill();
        ctx.fillStyle = `rgba(255, 250, 220, ${0.9 * (1 - k * 1.6)})`;
        if (k < 0.6) { ctx.beginPath(); ctx.arc(x, y, R * 0.35 * (1 - k), 0, 7); ctx.fill(); }
        ctx.fillStyle = `rgba(90, 90, 90, ${0.7 * (1 - k)})`;
        for (const b of p.bits) ctx.fillRect(x + b.vx * ease * tp - b.s * tp / 2, y + b.vy * ease * tp - b.s * tp / 2, b.s * tp, b.s * tp);
      } else if (p.type === 'brick') {
        ctx.fillStyle = `rgba(190, 100, 50, ${1 - k})`;
        for (const b of p.bits) ctx.fillRect(x + b.vx * ease * tp * 0.6, y + b.vy * ease * tp * 0.6, b.s * tp, b.s * tp);
      } else if (p.type === 'skill') {
        ctx.strokeStyle = `rgba(79, 209, 255, ${1 - k})`; ctx.lineWidth = Math.max(1.5, tp * 0.08);
        ctx.beginPath(); ctx.arc(x, y, tp * (0.4 + 0.6 * ease), 0, 7); ctx.stroke();
      } else if (p.type === 'spark' || p.type === 'wallHit') {
        ctx.fillStyle = `rgba(255, 255, 220, ${1 - k})`;
        ctx.beginPath(); ctx.arc(x, y, tp * 0.25 * (1 - k * 0.5), 0, 7); ctx.fill();
      } else if (p.type === 'portal') {
        ctx.strokeStyle = `rgba(179, 157, 255, ${1 - k})`; ctx.lineWidth = Math.max(2, tp * 0.1);
        ctx.beginPath(); ctx.arc(x, y, tp * (0.2 + 0.7 * ease), 0, 7); ctx.stroke();
      } else if (p.type === 'armor') {
        ctx.strokeStyle = `rgba(200, 230, 255, ${1 - k})`; ctx.lineWidth = Math.max(1, tp * 0.08);
        ctx.beginPath(); ctx.arc(x, y, tp * (0.4 + 0.4 * ease), 0, 7); ctx.stroke();
      } else if (p.type === 'float') {
        ctx.font = `800 ${Math.max(p.small ? 10 : 11, tp * (p.small ? 0.42 : 0.5))}px system-ui, "Apple Color Emoji", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = `rgba(${p.color || '255, 236, 160'}, ${1 - k})`;
        ctx.strokeStyle = `rgba(0, 0, 0, ${0.6 * (1 - k)})`; ctx.lineWidth = 3;
        ctx.strokeText(p.text, x, y - ease * tp * 1.2); ctx.fillText(p.text, x, y - ease * tp * 1.2);
      } else if (p.type === 'emp' || p.type === 'timestop') {
        const R = (p.type === 'emp' ? 6 : 3) * tp;
        ctx.strokeStyle = p.type === 'emp' ? `rgba(120, 200, 255, ${1 - k})` : `rgba(255, 255, 255, ${1 - k})`;
        ctx.lineWidth = Math.max(2, tp * 0.12);
        ctx.beginPath(); ctx.arc(x, y, R * ease, 0, 7); ctx.stroke();
      } else if (p.type === 'freezeHit' || p.type === 'confuseHit') {
        ctx.fillStyle = p.type === 'freezeHit' ? `rgba(160, 230, 255, ${0.8 * (1 - k)})` : `rgba(212, 139, 255, ${0.8 * (1 - k)})`;
        ctx.beginPath(); ctx.arc(x, y, tp * (0.4 + 0.5 * ease), 0, 7); ctx.fill();
      } else if (p.type === 'itemSpawn' || p.type === 'pickup') {
        ctx.strokeStyle = `rgba(242, 201, 76, ${1 - k})`; ctx.lineWidth = Math.max(1, tp * 0.06);
        ctx.beginPath(); ctx.arc(x, y, tp * (0.3 + 0.7 * ease), 0, 7); ctx.stroke();
      } else if (p.type === 'spawn') {
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * (1 - k)})`; ctx.lineWidth = Math.max(1, tp * 0.06);
        ctx.beginPath(); ctx.arc(x, y, tp * (1.2 - 0.8 * ease), 0, 7); ctx.stroke();
      }
    }
  }

  window.Renderer = Renderer;
  window.TANK_DIRS = DIRS;
})();
