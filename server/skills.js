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
    // 玩家工兵的砲塔：開局就建好（不出場），客戶端的坦克清單在開局時固定
    for (const t of this.tanks.slice()) {
      if (t.isBot || t.structure || t.monster || t.npc || (t.cls !== 'engineer' && this.objective !== 'gungame')) continue;
      const tu = this._pveStructure('sturret', 0, 0, this.sideByKey.get(t.side), 1);
      Object.assign(tu, { alive: false, lives: 0, hp: 0, size: 0.8, playerTurret: true, ownerName: `${t.ownerName}的砲台`, reserved: true,
        stats: { speed: 0, cooldown: C.PERK.turretCooldown, bulletSpeed: 7, maxBullets: 1, hp: 1, vision: 0 }, turretDmg: C.PERK.turretDmg });
      t.turretId = tu.id;
    }
  };

  // 這個 tick 想用技能（玩家按鈕或電腦代碼回傳 skill: true）
  P._useSkill = function (t) {
    const sk = t.stats.skill;
    if (!sk || t.skillCd > 0 || !t.alive || t.frozen > 0) return false;
    const ok = this['_skill_' + sk.key](t);
    if (ok === false) return false;
    if (this.hpSystem && t.cls === 'engineer') t.hp = Math.max(t.hp, Math.min(t.maxHp, t.hp + Math.round(t.maxHp * C.HP.engineerHeal)));   // 工兵：築牆回血
    t.skillCd = Math.round(sk.cd * C.TICK_RATE * Math.max(0.2, 1 + (t.mods && t.mods.skillCd || 0)) * (this._perk(t) === 'engineer' ? C.PERK.engSkillCd : 1));
    if (t.mods && t.mods.teamShield) for (const o of this.tanks) if (o.alive && o.side === t.side && !o.structure) o.shield = Math.max(o.shield, Math.round(t.mods.teamShield * C.TICK_RATE));
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
    return !this.tanks.some(o => { if (!o.alive || o.flying) return false; const r = (o.size || C.TANK_SIZE) / 2 + 0.5; return Math.abs(o.x - (cx + 0.5)) < r && Math.abs(o.y - (cy + 0.5)) < r; });
  };

  P._setTile = function (idx, ch) {
    this.tiles[idx] = ch;
    this.tileChanges.push([idx, ch]);
  };

  // 突擊：衝刺
  P._skill_dash = function (t) { t.dashTicks = Math.round(0.5 * C.TICK_RATE); if (t.mods && t.mods.dashShield) t.shield = Math.max(t.shield, t.dashTicks); };

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

  // 護士：治療自己和身邊的隊友
  P._skill_heal = function (t) {
    for (const o of this.tanks) {
      const m = t.mods || {}, half = this.pve && this.pve.mods.includes('noheal') ? 0.5 : 1;
      if (!o.alive || o.side !== t.side || Math.hypot(o.x - t.x, o.y - t.y) > C.HP.nurseAura * (1 + (m.healRange || 0))) continue;
      if (this.hpSystem) { const before = o.hp; o.hp = Math.max(o.hp, Math.min(o.maxHp, o.hp + Math.round(o.maxHp * C.HP.healSkill * (1 + (m.healAmt || 0)) * half))); t.healed = (t.healed || 0) + (o.hp - before); }
      else { o.hp = Math.max(o.hp, o.maxHp || o.stats.hp); o.shield = Math.max(o.shield, Math.round(1.5 * C.TICK_RATE)); }
      o.hurtTick = Math.min(o.hurtTick || 0, this.tick);
      this.events.push(['heal', o.x, o.y]);
    }
  };

  // 工兵：在自家基地旁就修牆，否則在前方蓋一塊磚牆
  P._skill_build = function (t) {
    const fixed = this._repairBase(t);
    if (fixed !== null) return fixed;
    const { cx, cy } = frontCell(t);
    if (!this._cellFree(cx, cy)) return false;
    const idx = cy * this.size + cx;
    if (t.mods && t.mods.steelWall) { this._setTile(idx, '@'); this.tempWalls.push({ idx, prev: '#', until: this.playTick + 10 * C.TICK_RATE }); }
    else this._setTile(idx, '#');
    return true;
  };

  // 在自家基地旁：修補並加固圍牆（回傳 null 表示不在基地旁）
  P._repairBase = function (t) {
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
    return null;
  };

  // ---------- 玩家職業的強化版技能 ----------
  // 突擊：衝撞（衝刺中撞到敵人造成傷害並擊退）
  P._skill_ram = function (t) {
    t.dashTicks = C.PERK.ramTicks; t.ramHit = new Set();
    if (t.mods && t.mods.dashShield) t.shield = Math.max(t.shield, t.dashTicks);
  };
  // 重裝：5 格鋼牆，7 秒
  P._skill_bigwall = function (t) {
    const { cx, cy, v } = frontCell(t);
    const side = [v[1], v[0]];
    let built = 0;
    for (const k of [0, -1, 1, -2, 2]) {
      const x = cx + side[0] * k, y = cy + side[1] * k;
      if (!this._cellFree(x, y)) continue;
      const idx = y * this.size + x;
      this.tempWalls.push({ idx, prev: this.tiles[idx], until: this.playTick + 7 * C.TICK_RATE });
      this._setTile(idx, '@');
      built++;
    }
    return built > 0;
  };
  // 偵察：煙霧＋隱形 2 秒
  P._skill_ghost = function (t) { this._skill_smoke(t); t.cloak = Math.max(t.cloak || 0, 2 * C.TICK_RATE); };
  // 狙擊：標記射擊（下一發蓄力；命中的敵人被標記）
  P._skill_mark = function (t) { t.charged = 5 * C.TICK_RATE; };
  // 爆破：雷區（一次 3 顆，最多 6 顆）
  P._skill_minefield = function (t) {
    const mine = this.mines.filter(m => m.owner === t.id);
    const drop = Math.max(0, mine.length + 3 - 6);
    for (let i = 0; i < drop; i++) this.mines.splice(this.mines.indexOf(mine[i]), 1);
    for (const a of [0, 120, 240]) {
      const r = ((t.angle || 0) + 180 + a) * Math.PI / 180;
      this.mines.push({ id: this.nextMineId++, x: t.x + Math.sin(r) * 0.9, y: t.y - Math.cos(r) * 0.9, side: t.side, owner: t.id, armAt: this.playTick + Math.round(0.5 * C.TICK_RATE), until: this.playTick + 30 * C.TICK_RATE });
    }
    this.zonesChanged = true;
  };
  // 工兵：部署砲塔（在自家基地旁改為修補圍牆）
  P._skill_turret = function (t) {
    const fixed = this._repairBase(t);
    if (fixed !== null) return fixed;
    const tu = this.tankById.get(t.turretId);
    if (!tu) return false;
    const { cx, cy } = frontCell(t);
    if (!this._cellFree(cx, cy)) return false;
    const hp = this.hpSystem ? C.PERK.turretHp : C.PERK.turretHits;
    Object.assign(tu, { x: cx + 0.5, y: cy + 0.5, alive: true, hp, maxHp: hp, lives: 1, cooldown: 0, angle: t.angle || 0, aim: null, until: this.playTick + C.PERK.turretTicks, shield: 0 });
    this.events.push(['spawn', tu.x, tu.y]);
    return true;
  };
  // 護士：聖域（治療＋護盾）
  P._skill_sanctuary = function (t) {
    this._skill_heal(t);
    for (const o of this.tanks) if (o.alive && o.side === t.side && !o.structure && Math.hypot(o.x - t.x, o.y - t.y) <= C.HP.nurseAura) o.shield = Math.max(o.shield, Math.round(1.5 * C.TICK_RATE));
  };

  // 每 tick：衝撞判定、玩家砲塔
  P._playerSkillsTick = function () {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (t.ramHit && t.dashTicks > 0) {
        for (const o of this.tanks) {
          if (!o.alive || o.side === t.side || o.noCollide || t.ramHit.has(o.id)) continue;
          const reach = ((o.size || C.TANK_SIZE) + (t.size || C.TANK_SIZE)) / 2 + 0.15;
          if (Math.abs(o.x - t.x) > reach || Math.abs(o.y - t.y) > reach) continue;
          t.ramHit.add(o.id);
          this._damage(o, t, o.x, o.y, 'ram', C.PERK.ramDmg);
          if (o.alive && !o.structure && !o.boss && (o.size || C.TANK_SIZE) <= 1) this._bulletAfterHit({ knock: true, vx: o.x - t.x, vy: o.y - t.y }, o);
          this.events.push(['baseBoom', o.x, o.y]);
        }
      } else if (t.ramHit && !(t.dashTicks > 0)) t.ramHit = null;
      if (t.playerTurret) {
        if (this.playTick >= t.until) { t.alive = false; t.lives = 0; this.events.push(['spark', t.x, t.y]); continue; }
        let best = null, bd = C.PERK.turretRange;
        for (const e of this.tanks) {
          if (!e.alive || e.side === t.side || e.structure || e.noCollide && !e.monster) continue;
          const d = Math.hypot(e.x - t.x, e.y - t.y);
          if (d < bd && this._pveLos(t, e)) { bd = d; best = e; }
        }
        if (!best) continue;
        t.angle = t.aim = (Math.atan2(best.x - t.x, -(best.y - t.y)) * 180 / Math.PI + 360) % 360;
        if (t.cooldown === 0) this._fire(t);
      }
    }
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
      this._blast({ side: m.side, owner: m.owner, mine: true }, m.x, m.y, null);
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
