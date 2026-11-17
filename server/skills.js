'use strict';

// 職業主動技能：每個職業一個技能，用了之後要等冷卻。
//   突擊 衝刺、重裝 護盾牆、偵察 煙霧、狙擊 蓄力射擊、爆破 地雷、工兵 築牆／修基地

const C = require('./constants');
const Physics = require('../public/physics');

module.exports = function install(Round) {
  const P = Round.prototype;

  P._initSkills = function () {
    this.tempWalls = [];   // 護盾牆：{ idx, prev, until }
    this.smokes = [];      // 煙霧：{ x, y, r, until }
    this.mines = [];       // 地雷：{ id, x, y, side, owner, armAt, until }
    this.nextMineId = 1;
    this.zonesChanged = false;
  };

  // 這個 tick 想用技能（玩家按鈕或電腦代碼回傳 skill: true）
  P._useSkill = function (t) {
    const sk = t.stats.skill;
    if (!sk || t.skillCd > 0 || !t.alive || t.frozen > 0) return false;
    const ok = this['_skill_' + sk.key](t);
    if (ok === false) return false;
    t.skillCd = Math.round(sk.cd * C.TICK_RATE);
    t.skillsUsed = (t.skillsUsed || 0) + 1;
    this.events.push(['skill', t.x, t.y]);
    return true;
  };

  // 面向的正前方格子（取最接近的正上下左右）
  function frontCell(t) {
    const card = (Math.round((t.angle || 0) / 90) * 90) % 360;
    const v = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] }[card];
    return { cx: Math.floor(t.x) + v[0], cy: Math.floor(t.y) + v[1], v };
  }

  P._cellFree = function (cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.size || cy >= this.size) return false;
    const c = this.tiles[cy * this.size + cx];
    if (c !== '.' && c !== '*') return false;
    return !this.tanks.some(o => o.alive && Math.abs(o.x - (cx + 0.5)) < 0.92 && Math.abs(o.y - (cy + 0.5)) < 0.92);
  };

  P._setTile = function (idx, ch) {
    this.tiles[idx] = ch;
    this.tileChanges.push([idx, ch]);
  };

  // 突擊：衝刺
  P._skill_dash = function (t) { t.dashTicks = Math.round(0.5 * C.TICK_RATE); };

  // 重裝：前方立起 3 格鋼牆，5 秒後消失
  P._skill_wall = function (t) {
    const { cx, cy, v } = frontCell(t);
    const side = [v[1], v[0]];   // 垂直方向
    let built = 0;
    for (const k of [0, -1, 1]) {
      const x = cx + side[0] * k, y = cy + side[1] * k;
      if (!this._cellFree(x, y)) continue;
      const idx = y * this.size + x;
      this.tempWalls.push({ idx, prev: this.tiles[idx], until: this.playTick + 5 * C.TICK_RATE });
      this._setTile(idx, '@');
      built++;
    }
    return built > 0;
  };

  // 偵察：煙霧
  P._skill_smoke = function (t) {
    this.smokes.push({ x: t.x, y: t.y, r: 2.5, until: this.playTick + 5 * C.TICK_RATE });
    this.zonesChanged = true;
  };

  // 狙擊：下一發蓄力射擊（5 秒內有效）
  P._skill_charge = function (t) { t.charged = 5 * C.TICK_RATE; };

  // 爆破：地雷（最多 3 個）
  P._skill_mine = function (t) {
    const mine = this.mines.filter(m => m.owner === t.id);
    if (mine.length >= 3) this.mines.splice(this.mines.indexOf(mine[0]), 1);
    this.mines.push({ id: this.nextMineId++, x: t.x, y: t.y, side: t.side, owner: t.id, armAt: this.playTick + C.TICK_RATE, until: this.playTick + 30 * C.TICK_RATE });
    this.zonesChanged = true;
  };

  // 工兵：在自家基地旁就修牆，否則在前方蓋一塊磚牆
  P._skill_build = function (t) {
    const side = this.sideByKey.get(t.side);
    if (side.base && side.base.alive && this.breakableWalls && Math.hypot(t.x - (side.base.x + 0.5), t.y - (side.base.y + 0.5)) < 3) {
      let fixed = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = side.base.x + dx, y = side.base.y + dy, idx = y * this.size + x;
        if (this.tiles[idx] === '#') { if (this.wallHp.get(idx) !== C.BASE_WALL_HP) fixed++; }
        else if (this._cellFree(x, y)) { this._setTile(idx, '#'); fixed++; }
      }
      this._reinforceBaseWalls(side);
      return fixed > 0;
    }
    const { cx, cy } = frontCell(t);
    if (!this._cellFree(cx, cy)) return false;
    this._setTile(cy * this.size + cx, '#');
    return true;
  };

  // 每 tick：技能冷卻、煙霧和護盾牆到期、地雷觸發
  P._updateSkills = function () {
    for (const t of this.tanks) {
      if (t.skillCd > 0) t.skillCd--;
      if (t.dashTicks > 0) t.dashTicks--;
      if (t.charged > 0) t.charged--;
    }
    for (const w of this.tempWalls) if (this.playTick >= w.until && this.tiles[w.idx] === '@') this._setTile(w.idx, w.prev);
    this.tempWalls = this.tempWalls.filter(w => this.playTick < w.until);
    const before = this.smokes.length + this.mines.length;
    this.smokes = this.smokes.filter(s => this.playTick < s.until);
    this.mines = this.mines.filter(m => this.playTick < m.until);
    for (const m of this.mines.slice()) {
      if (this.playTick < m.armAt) continue;
      const victim = this.tanks.find(o => o.alive && o.side !== m.side && Math.abs(o.x - m.x) < 0.6 && Math.abs(o.y - m.y) < 0.6);
      if (!victim) continue;
      this.mines.splice(this.mines.indexOf(m), 1);
      this._blast({ side: m.side, owner: m.owner }, m.x, m.y, null);
    }
    if (this.smokes.length + this.mines.length !== before) this.zonesChanged = true;
  };

  P._inSmoke = function (t) {
    return this.smokes.some(s => Math.hypot(t.x - s.x, t.y - s.y) <= s.r);
  };

  // 子彈打中坦克時：蓄力射擊會穿過第一台坦克
  P._piercesThrough = function (b, t) {
    if (!b.pierceTanks) return false;
    b.passed = b.passed || new Set();
    if (b.passed.has(t.id)) return 'skip';
    b.passed.add(t.id);
    b.pierceTanks--;
    return true;
  };

  P._skillSnapshot = function (snap, viewerSide) {
    if (this.zonesChanged || this.tick % 15 === 1) {
      if (this.smokes.length || this.zonesChanged) snap.Z = this.smokes.map(s => [Math.round(s.x * 100), Math.round(s.y * 100), Math.round(s.r * 100), s.until - this.playTick]);
      const mines = viewerSide === undefined ? this.mines : this.mines.filter(m => m.side === viewerSide);
      if (this.mines.length || this.zonesChanged) snap.N = mines.map(m => [m.id, Math.round(m.x * 100), Math.round(m.y * 100), this.playTick >= m.armAt ? 1 : 0]);
    }
  };

  P._skillView = function (me) {
    return {
      smokes: this.smokes.map(s => ({ x: s.x, y: s.y, r: s.r, ticksLeft: s.until - this.playTick })),
      mines: this.mines.filter(m => m.side === me.side).map(m => ({ x: m.x, y: m.y, armed: this.playTick >= m.armAt, mine: m.owner === me.id })),
    };
  };

  void Physics;
};
