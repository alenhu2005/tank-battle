'use strict';

// 一局遊戲的模擬（伺服器說了算）。
// 「side」= 同一隊（彼此不會傷害）：
//   大亂鬥 ffa：每位玩家和他的電腦自成一隊
//   陣營戰 faction：red / blue 兩隊
//   組隊 team：玩家自選 1~6 號隊伍

const C = require('./constants');
const { generateMap } = require('./mapgen');
const { BotSandbox } = require('./botRunner');
const Physics = require('../public/physics');
const installObjectives = require('./objectives');
const installSkills = require('./skills');

const DIR_IDX = Object.fromEntries(C.DIRS.map((d, i) => [d, i]));
// 單位向量（斜向為 1/√2）
const UNIT = Object.fromEntries(C.DIRS.map(d => {
  const [x, y] = C.DIR_VEC[d], n = Math.hypot(x, y);
  return [d, [x / n, y / n]];
}));
const TANK_SOLID = new Set(['#', '@', '~', 'B']);
const HALF = C.TANK_SIZE / 2;
const BULLET_SUB = 8;
// 道具效果的計時器（每 tick 減 1）與子彈發數
const TIMERS = ['speedBuff', 'rapidBuff', 'spreadBuff', 'bounceBuff', 'swiftBuff', 'cloak', 'phase', 'radar', 'frozen', 'confused'];
const SHOTS = ['blastShots', 'pierceShots', 'freezeShots', 'confuseShots'];
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left', upleft: 'downright', downright: 'upleft', upright: 'downleft', downleft: 'upright' };
const RING = ['up', 'upright', 'right', 'downright', 'down', 'downleft', 'left', 'upleft'];
const NEIGHBORS = Object.fromEntries(RING.map((d, i) => [d, [RING[(i + 7) % 8], RING[(i + 1) % 8]]]));
const PHASE_SOLID = new Set(['@', 'B']);

// 移動指令轉成角度（0 = 上，順時針）；接受數字（度）或八方向名稱，其他都當作不動
function toAngle(m) {
  if (typeof m === 'number' && Number.isFinite(m)) return Physics.norm(m);
  if (typeof m === 'string' && m in Physics.ANGLE_OF) return Physics.ANGLE_OF[m];
  return null;
}

function mapSizeFor(mode, sideCount, playerCount) {
  if (mode === 'ffa') return [21, 21, 21, 25, 27, 29, 31][sideCount] || 31;
  return Math.min(33, Math.max(21, 19 + 2 * playerCount, [21, 21, 21, 25, 27, 29, 31][sideCount] || 31));
}

function classStats(cls) {
  if (cls === 'monster') return C.MONSTER_CLASS;
  return cls === 'bot' ? C.BOT_CLASS : (C.CLASSES[cls] || C.CLASSES.assault);
}

class Round {
  /**
   * opts.mode: 'ffa' | 'faction' | 'team'
   * opts.baseMode, opts.fog: boolean；opts.breakableWalls: 預設 true
   * opts.timeLimit: 秒（0 = 不限）
   * opts.sides: [{ key, name, color, members: [{ playerId, name, code, cls, aiPilot }] }]
   *   aiPilot = true 時，玩家坦克也由代碼控制（內建電腦隊伍 / 驗證用）
   */
  constructor(opts) {
    this.mode = opts.mode;
    this.baseMode = !!opts.baseMode;
    this.fog = !!opts.fog;
    this.breakableWalls = opts.breakableWalls !== false;
    this.codeOnly = !!opts.codeOnly;
    this.tankSize = C.TANK_SIZE;          // 給共用物理用
    this.alignRate = C.ALIGN_RATE;
    this.ricochet = !!opts.ricochet;
    this.itemsOn = !!opts.items;
    const off = new Set(opts.disabledItems || []);
    this.allowedItems = C.ITEM_TYPES.map((t, i) => i).filter(i => !off.has(C.ITEM_TYPES[i].key));   // 房主可以關掉部分道具
    this.items = [];
    this.nextItemId = 1;
    // 進階規則：命數（0 = 無限）、速度／彈速／冷卻倍率、重生時間
    const R = Object.assign({}, C.ADV_DEFAULTS, opts.rules || {});
    this.rules = R;
    this.respawnTicks = Math.round(R.respawn * C.TICK_RATE);
    this.botRespawnTicks = this.respawnTicks + C.TICK_RATE;
    this.itemInterval = opts.itemInterval ? opts.itemInterval * C.TICK_RATE : Math.round((R.itemSec || 10) * C.TICK_RATE);
    this.itemTimer = opts.itemFirstDelay ? opts.itemFirstDelay * C.TICK_RATE : C.ITEM_FIRST_DELAY;
    this.itemsChanged = false;
    this.pickups = [];
    this.timeLimitTicks = opts.timeLimit ? opts.timeLimit * C.TICK_RATE : 0;
    this.startTicks = Math.round((opts.countdown || 0) * C.TICK_RATE); // 開局倒數，期間不模擬
    this.kills = [];
    this.baseKillsNow = [];
    this.tick = 0;
    this.over = false;
    this.endTimer = -1;
    this.result = null;
    this.events = [];
    this.tileChanges = [];
    this.bullets = [];
    this.nextBulletId = 1;

    this.objective = C.OBJECTIVES.includes(opts.objective) ? opts.objective : 'survival';
    if (this.objective === 'ctf' || this.objective === 'escort') this.baseMode = false;     // 搶旗的旗子、護送的終點都在基地的位置
    this.attackerIndex = opts.attackerIndex || 0;              // 護送：哪一隊進攻
    this.objEvents = [];
    let sides = opts.sides;
    if (this.objective === 'pve') {
      // 打怪：所有玩家一隊，加上一隊怪物
      sides = [...sides, { key: 'monsters', name: '怪物', color: '#b06cff', members: [] }];
    }
    const playerCount = sides.reduce((n, s) => n + s.members.length, 0);
    const size = opts.size || mapSizeFor(this.mode, sides.length, playerCount);
    const map = generateMap({
      anchors: sides.length,
      spawnsPerAnchor: sides.map(s => s.key === 'monsters' ? C.PVE_MAX_MONSTERS : s.members.length * (opts.codeOnly ? 1 : 2)),
      size,
      baseMode: this.baseMode,
      breakableWalls: this.breakableWalls,
      style: opts.mapStyle,
      custom: opts.customMap || null,
    });
    this.size = size;
    this.tiles = map.tiles;
    this.wallHp = new Map();      // 基地周圍加固的磚牆：格子編號 -> 剩餘耐久
    this.wallChanges = [];
    this.center = (size - 1) / 2;

    this.sides = sides.map((s, i) => ({
      key: s.key, name: s.name, color: s.color,
      anchor: map.anchors[i],
      spawns: map.spawns[i],
      base: this.baseMode ? { x: map.anchors[i].x, y: map.anchors[i].y, alive: true } : null,
      eliminated: false,
    }));
    this.sideByKey = new Map(this.sides.map(s => [s.key, s]));
    const monsterSide = this.sideByKey.get('monsters');
    if (monsterSide && monsterSide.base) {      // 怪物沒有基地
      this.tiles[monsterSide.base.y * this.size + monsterSide.base.x] = '.';
      monsterSide.base = null;
    }

    this.tanks = [];
    let id = 1;
    sides.forEach((s, si) => {
      let slot = 0;
      for (const m of s.members) {
        // 純代碼對戰：每位玩家只派出一台電腦坦克
        for (const isBot of (this.codeOnly ? [true] : [false, true])) {
          const cls = isBot ? 'bot' : (C.CLASSES[m.cls] ? m.cls : 'assault');
          const stats = this.statsFor(cls);
          const tank = {
            id: id++, side: s.key, owner: m.playerId, ownerName: m.name, isBot, cls, stats,
            lives: 1, hp: stats.hp,
            alive: false, x: 0, y: 0, dir: 'up', angle: 0,
            spawn: this.sides[si].spawns[slot++ % this.sides[si].spawns.length],
            respawnTimer: 0, shield: 0, cooldown: 0,
            input: { move: null, fire: false },
            kills: 0, deaths: 0, baseKills: 0, shots: 0, hits: 0, dodges: 0, itemsPicked: 0, captures: 0,
            sandbox: null,
          };
          // 命數：電腦和玩家分開設定，0 = 無限重生；玩家可以有讓分（多／少幾條命）
          const base = isBot ? R.botLives : R.playerLives;
          tank.unlimited = base === 0;
          tank.maxLives = tank.unlimited ? 1 : Math.max(1, base + (isBot ? 0 : (m.handicap || 0)));
          tank.lives = tank.maxLives;
          if (isBot || m.aiPilot) tank.sandbox = new BotSandbox(isBot ? m.code : (m.pilotCode || m.code), `${m.name}${isBot ? ' 電腦' : ''}`);
          this.tanks.push(tank);
        }
      }
    });
    this.nextTankId = id;
    if (monsterSide) this._createMonsterPool(monsterSide);
    this.tankById = new Map(this.tanks.map(t => [t.id, t]));
    for (const t of this.tanks) if (t.lives > 0) this._spawn(t, true);
    this._initObjective();
    this._initSkills();
    this._reinforceBaseWalls();
    this.rowsCache = null;
  }

  // ---------- 對外介面 ----------

  setInput(playerId, input) {
    const t = this.playerTank(playerId);
    if (!t || t.sandbox) return;
    t.input = { move: toAngle(input.move), fire: !!input.fire };
    if (input.skill) t.skillQueued = true;   // 技能按鈕（一次性）
    if (Number.isInteger(input.seq)) t.inputSeq = input.seq;   // 手機預測用：回報處理到第幾個輸入
    if (Number.isFinite(input.view)) t.viewTick = input.view;   // 延遲補償：玩家畫面上正在顯示第幾個 tick
  }

  // MVP 分數：擊殺最重要，拆基地、搶旗也很重要；命中、閃避、撿道具加一點；陣亡扣分
  static mvpScore(t) {
    return t.kills * 100 + t.baseKills * 150 + t.captures * 150 + t.hits * 10 + t.dodges * 5 + t.itemsPicked * 10 - t.deaths * 40;
  }

  get playTick() { return Math.max(0, this.tick - this.startTicks); }

  playerTank(playerId) { return this.tanks.find(t => t.owner === playerId && !t.isBot); }

  meta() {
    return {
      size: this.size,
      tiles: this.tiles.join(''),
      mode: this.mode, baseMode: this.baseMode, fog: this.fog && !this.codeOnly, breakableWalls: this.breakableWalls,
      codeOnly: this.codeOnly, timeLimitTicks: this.timeLimitTicks, startTicks: this.startTicks, blastRadius: C.BLAST_RADIUS,
      ricochet: this.ricochet, items: this.itemsOn, itemTypes: C.ITEM_TYPES, objective: this.objective,
      angles: true, spreadAngle: C.SPREAD_ANGLE, escortPath: this.cart ? this.cart.path : null,
      wallHp: [...this.wallHp], baseWallHp: C.BASE_WALL_HP, baseWallShieldTicks: C.BASE_WALL_SHIELD_TICKS, skills: C.SKILLS,   // 快照裡的方向是角度（度），不是八方向編號
      alignRate: C.ALIGN_RATE, speedBuff: C.SPEED_BUFF, bulletBounces: C.BULLET_BOUNCES, bounceBuff: C.BOUNCE_BUFF,
      tickRate: C.TICK_RATE, tankSize: C.TANK_SIZE,
      sides: this.sides.map(s => ({ key: s.key, name: s.name, color: s.color, base: s.base ? { x: s.base.x, y: s.base.y } : null, anchor: s.anchor })),
      tanks: this.tanks.map(t => ({
        id: t.id, side: t.side, owner: t.owner, name: t.ownerName, isBot: t.isBot, cls: t.cls,
        maxLives: t.unlimited ? -1 : t.maxLives || 1, maxHp: t.stats.hp, vision: t.stats.vision,
        grassSight: !!t.stats.grassSight,
      })),
    };
  }

  // ---------- 模擬 ----------

  step() {
    if (this.over) return;
    this.tick++;
    this.events = [];
    this.tileChanges = [];
    this.kills = [];
    this.baseKillsNow = [];
    this.objEvents = [];
    this.wallChanges = [];
    this.zonesChanged = false;
    this.pickups = [];
    this.itemsChanged = false;
    if (this.tick <= this.startTicks) return; // 倒數中

    // 1. 電腦代碼決策
    this.rowsCache = null;
    for (const t of this.tanks) {
      if (!t.sandbox || !t.alive) continue;
      const action = t.sandbox.think(this._viewFor(t), this.tick);
      t.input = action || { move: null, fire: false };
    }

    // 2. 移動與開火（順序每 tick 輪替，避免固定某台坦克永遠先動）
    const n = this.tanks.length;
    const offset = this.tick % n;
    for (let i = 0; i < n; i++) {
      const t = this.tanks[(i + offset) % n];
      if (!t.alive) continue;
      if (t.cooldown > 0) t.cooldown--;
      if (t.shield > 0) t.shield--;
      for (const k of TIMERS) if (t[k] > 0) t[k]--;
      if (t.frozen > 0) continue;                       // 被凍住：不能動也不能射
      let mv = toAngle(t.input.move);
      if (mv !== null && t.confused > 0) mv = Physics.norm(mv + 180);     // 混亂：方向顛倒
      if (mv !== null) this._move(t, mv);
      if (t.input.fire) this._fire(t);
      if (t.input.skill || t.skillQueued) { this._useSkill(t); t.skillQueued = false; }
    }
    this._updateSkills();
    for (const t of this.tanks) if (!t.isBot) t.ackSeq = t.inputSeq || 0;
    this._recordHistory();
    this._analyze();

    // 3. 子彈
    this._updateBullets();

    // 3.5 場地道具
    if (this.itemsOn) this._updateItems();

    // 3.6 遊戲目標（佔點、搶旗、打怪）
    this._updateObjective();

    // 4. 重生
    for (const t of this.tanks) {
      if (t.alive || t.lives <= 0) continue;
      if (this.sideByKey.get(t.side).eliminated) continue;
      if (t.respawnTimer > 0) t.respawnTimer--;
      if (t.respawnTimer <= 0) this._spawn(t, false);
    }

    // 5. 勝負
    this._checkEnd();
  }

  _spawn(t, initial) {
    const candidates = [t.spawn, ...this.sideByKey.get(t.side).spawns];
    for (const p of candidates) {
      const x = p.x + 0.5, y = p.y + 0.5;
      if (this._tileBlocked(x, y) || this._tankAt(x, y, t)) continue;
      t.x = x; t.y = y; t.alive = true; t.hp = t.stats.hp;
      for (const k of TIMERS) t[k] = 0;
      for (const k of SHOTS) t[k] = 0;
      t.dashTicks = 0; t.charged = 0;
      t.dir = Math.abs(p.y - this.center) >= Math.abs(p.x - this.center)
        ? (p.y < this.center ? 'down' : 'up')
        : (p.x < this.center ? 'right' : 'left');
      t.angle = Physics.ANGLE_OF[t.dir];
      t.shield = C.SHIELD_TICKS; // 開局與重生都有短暫無敵
      t.cooldown = 0;
      t.input = { move: null, fire: false };
      if (!initial) this.events.push(['spawn', t.x, t.y]);
      return true;
    }
    return false; // 出生點被擋住，下個 tick 再試
  }

  // 移動物理與手機共用（public/physics.js），兩邊預測才會一致
  _tileBlocked(x, y, phase) { return Physics.tileBlocked(this, x, y, phase); }

  _tankAt(x, y, self) {
    for (const o of this.tanks) {
      if (o === self || !o.alive) continue;
      if (Math.abs(o.x - x) < C.TANK_SIZE - 1e-6 && Math.abs(o.y - y) < C.TANK_SIZE - 1e-6) return o;
    }
    return null;
  }

  _others(t) { return this.tanks.filter(o => o !== t && o.alive); }

  _blocked(t, x, y) { return Physics.blocked(this, t, x, y, this._others(t)); }

  _move(t, dir) {
    const step = t.stats.speed * (t.speedBuff > 0 ? C.SPEED_BUFF : 1) * (t.dashTicks > 0 ? C.DASH_SPEED : 1) / C.TICK_RATE;
    Physics.move(this, t, dir, step, this._others(t));
  }

  _ownBullets(t) {
    let n = 0;
    for (const b of this.bullets) if (b.owner === t.id && !b.extra) n++;
    return n;
  }

  _fire(t) {
    if (t.cooldown > 0 || this._ownBullets(t) >= this._maxBullets(t)) return;
    let blast = !!t.stats.blast, pierce = !!t.stats.pierce, freeze = false, confuse = false;
    if (t.freezeShots > 0) { freeze = true; t.freezeShots--; }
    else if (t.confuseShots > 0) { confuse = true; t.confuseShots--; }
    else if (!blast && t.blastShots > 0) { blast = true; t.blastShots--; }
    if (!pierce && t.pierceShots > 0) { pierce = true; t.pierceShots--; }
    if (freeze || confuse) blast = false;
    let speed = t.stats.bulletSpeed * (t.swiftBuff > 0 ? C.SWIFT_BULLET : 1);
    let pierceTanks = 0;
    if (t.charged > 0) { speed *= 1.8; pierce = true; pierceTanks = 1; t.charged = 0; }   // 狙擊蓄力射擊
    const bounces = Math.max(this.ricochet ? C.BULLET_BOUNCES : 0, t.bounceBuff > 0 ? C.BOUNCE_BUFF : 0);
    const a0 = t.angle || 0;
    // 延遲補償：玩家看到的敵人比伺服器晚一點，子彈用玩家畫面上的位置判定命中（最多 0.2 秒）
    const lag = t.sandbox || !Number.isFinite(t.viewTick) ? 0 : Math.max(0, Math.min(C.MAX_LAG_TICKS, Math.round(this.tick - t.viewTick)));
    const angles = t.spreadBuff > 0 ? [a0, a0 - C.SPREAD_ANGLE, a0 + C.SPREAD_ANGLE] : [a0];
    this.events.push(['shot', t.x, t.y]);   // 給手機播音效
    t.shots++;
    angles.forEach((ang, i) => {
      const a = Physics.norm(ang);
      const [vx, vy] = Physics.vec(a);
      const [mx, my] = Physics.muzzle(t.x, t.y, a, HALF);   // 從砲口（車身邊緣）射出
      this.bullets.push({
        id: this.nextBulletId++, owner: t.id, side: t.side, angle: a, dir: Physics.dirOf(a), vx, vy,
        x: mx, y: my,
        speed, pierce, blast, freeze, confuse, bounces, extra: i > 0, lag, born: this.tick, ox: t.x, oy: t.y, pierceTanks,
      });
    });
    t.cooldown = t.rapidBuff > 0 ? Math.ceil(t.stats.cooldown / 2) : t.stats.cooldown;
  }

  _maxBullets(t) { return t.stats.maxBullets + (t.rapidBuff > 0 ? 1 : 0); }

  // ---------- 場地道具 ----------

  _updateItems() {
    // 過期
    const before = this.items.length;
    this.items = this.items.filter(it => this.playTick < it.until);
    if (this.items.length !== before) this.itemsChanged = true;
    // 撿取
    for (const t of this.tanks) {
      if (!t.alive) continue;
      for (let i = 0; i < this.items.length; i++) {
        const it = this.items[i];
        if (Math.abs(t.x - it.x) < C.ITEM_PICKUP_RANGE && Math.abs(t.y - it.y) < C.ITEM_PICKUP_RANGE) {
          this._applyItem(t, it.type);
          t.itemsPicked++;
          this.items.splice(i, 1);
          this.itemsChanged = true;
          this.events.push(['pickup', it.x, it.y]);
          this.pickups.push([t.id, it.type, it.x, it.y]);
          break;
        }
      }
    }
    // 刷新
    if (--this.itemTimer <= 0) {
      this.itemTimer = this.itemInterval;
      if (this.items.length < C.ITEM_MAX) this._spawnItem();
    }
  }

  _spawnItem() {
    for (let tries = 0; tries < 200; tries++) {
      const cx = Math.floor(Math.random() * this.size), cy = Math.floor(Math.random() * this.size);
      if (this.tiles[cy * this.size + cx] !== '.') continue;
      if (this.sides.some(s => Math.max(Math.abs(s.anchor.x - cx), Math.abs(s.anchor.y - cy)) <= 4)) continue;
      const x = cx + 0.5, y = cy + 0.5;
      if (this.tanks.some(t => t.alive && Math.abs(t.x - x) < 1.5 && Math.abs(t.y - y) < 1.5)) continue;
      if (this.items.some(it => Math.abs(it.x - x) < 2 && Math.abs(it.y - y) < 2)) continue;
      if (!this.allowedItems.length) return;
      const total = this.allowedItems.reduce((a, i) => a + C.ITEM_TYPES[i].weight, 0);
      let roll = Math.random() * total, k = 0;
      while (roll >= C.ITEM_TYPES[this.allowedItems[k]].weight) { roll -= C.ITEM_TYPES[this.allowedItems[k]].weight; k++; }
      const type = this.allowedItems[k];
      this.items.push({ id: this.nextItemId++, x, y, type, until: this.playTick + C.ITEM_LIFETIME });
      this.itemsChanged = true;
      this.events.push(['itemSpawn', x, y]);
      return;
    }
  }

  _applyItem(t, type) {
    switch (C.ITEM_TYPES[type].key) {
      case 'shield': t.shield = Math.max(t.shield, C.ITEM_SHIELD_TICKS); break;
      case 'speed': t.speedBuff = C.BUFF_TICKS; break;
      case 'rapid': t.rapidBuff = C.BUFF_TICKS; break;
      case 'blast': t.blastShots = C.BLAST_SHOTS; break;
      case 'life':
        if (!t.isBot && !t.unlimited && t.lives < (t.maxLives || 1)) t.lives++;
        else t.shield = Math.max(t.shield, C.ITEM_SHIELD_TICKS);
        break;
      case 'pierce': t.pierceShots = C.PIERCE_SHOTS; break;
      case 'spread': t.spreadBuff = C.BUFF_TICKS; break;
      case 'bounce': t.bounceBuff = C.BUFF_TICKS; break;
      case 'swift': t.swiftBuff = C.BUFF_TICKS; break;
      case 'armor': t.hp = Math.min(t.hp + 1, t.stats.hp + 2); break;
      case 'cloak': t.cloak = C.CLOAK_TICKS; break;
      case 'phase': t.phase = C.PHASE_TICKS; break;
      case 'radar': t.radar = C.RADAR_TICKS; break;
      case 'freeze': t.freezeShots = C.STATUS_SHOTS; break;
      case 'confuse': t.confuseShots = C.STATUS_SHOTS; break;
      case 'emp':
        this.events.push(['emp', t.x, t.y]);
        for (const o of this.tanks) {
          if (o.alive && o.side !== t.side && !o.shield && Math.hypot(o.x - t.x, o.y - t.y) <= C.EMP_RADIUS) o.frozen = Math.max(o.frozen || 0, C.EMP_TICKS);
        }
        break;
      case 'timestop':
        for (const o of this.tanks) if (o.alive && o.side !== t.side && !o.shield) o.frozen = Math.max(o.frozen || 0, C.EMP_TICKS);
        this.events.push(['timestop', t.x, t.y]);
        break;
      case 'revive': {
        const bot = this.tanks.find(o => o.owner === t.owner && o.isBot);
        if (bot && !bot.alive && !this.sideByKey.get(bot.side).eliminated) { bot.lives = 1; bot.respawnTimer = 0; }
        else if (bot && bot.alive) bot.shield = Math.max(bot.shield, C.ITEM_SHIELD_TICKS);
        else t.shield = Math.max(t.shield, C.ITEM_SHIELD_TICKS);
        break;
      }
      case 'fortify': {
        const side = this.sideByKey.get(t.side);
        if (!side.base || !side.base.alive || !this.breakableWalls) { t.shield = Math.max(t.shield, C.ITEM_SHIELD_TICKS); break; }
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const cx = side.base.x + dx, cy = side.base.y + dy;
          if (cx < 0 || cy < 0 || cx >= this.size || cy >= this.size) continue;
          const idx = cy * this.size + cx;
          if (this.tiles[idx] !== '.' && this.tiles[idx] !== '*') continue;
          if (this.tanks.some(o => o.alive && Math.abs(o.x - (cx + 0.5)) < 0.92 && Math.abs(o.y - (cy + 0.5)) < 0.92)) continue;
          this.tiles[idx] = '#';
          this.tileChanges.push([idx, '#']);
        }
        this._reinforceBaseWalls(side);
        this.events.push(['spawn', side.base.x + 0.5, side.base.y + 0.5]);
        break;
      }
      case 'quake': {
        if (!this.breakableWalls) { t.shield = Math.max(t.shield, C.ITEM_SHIELD_TICKS); break; }
        const cx = Math.floor(t.x), cy = Math.floor(t.y);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this._breakTile(cx + dx, cy + dy);
        this.events.push(['blast', t.x, t.y]);
        break;
      }
      case 'home': {
        const side = this.sideByKey.get(t.side);
        for (const p of [t.spawn, ...side.spawns]) {
          const x = p.x + 0.5, y = p.y + 0.5;
          if (this._tileBlocked(x, y) || this._tankAt(x, y, t)) continue;
          this.events.push(['spawn', t.x, t.y]);
          t.x = x; t.y = y;
          t.shield = Math.max(t.shield, C.TICK_RATE);
          this.events.push(['spawn', x, y]);
          break;
        }
        break;
      }
      case 'swap': {
        let best = null, bd = Infinity;
        for (const o of this.tanks) {
          if (!o.alive || o.side === t.side) continue;
          const d = Math.hypot(o.x - t.x, o.y - t.y);
          if (d < bd) { bd = d; best = o; }
        }
        if (!best) { t.shield = Math.max(t.shield, C.ITEM_SHIELD_TICKS); break; }
        [t.x, best.x] = [best.x, t.x];
        [t.y, best.y] = [best.y, t.y];
        this.events.push(['spawn', t.x, t.y], ['spawn', best.x, best.y]);
        break;
      }
    }
  }

  _updateBullets() {
    for (let s = 0; s < BULLET_SUB; s++) {
      for (const b of this.bullets) {
        if (b.dead) continue;
        const vx = b.vx, vy = b.vy;
        const step = b.speed / C.TICK_RATE / BULLET_SUB;
        b.px = b.x; b.py = b.y;
        b.x += vx * step; b.y += vy * step;
        this._bulletHitWorld(b);
        if (!b.dead) this._bulletHitTank(b);
        if (!b.dead) {
          for (const t of this.tanks) {   // 閃避統計：敵方子彈擦身而過（1 格內）卻沒打中
            if (t.alive && t.side !== b.side && Math.abs(t.x - b.x) < 1 && Math.abs(t.y - b.y) < 1) (b.near || (b.near = new Set())).add(t.id);
          }
        }
      }
      // 敵我子彈相撞：互相抵消；狙擊子彈會擊穿一般子彈
      for (let i = 0; i < this.bullets.length; i++) {
        const a = this.bullets[i];
        if (a.dead) continue;
        for (let j = i + 1; j < this.bullets.length; j++) {
          const b = this.bullets[j];
          if (b.dead || a.side === b.side) continue;
          if (Math.abs(a.x - b.x) < 0.3 && Math.abs(a.y - b.y) < 0.3) {
            if (a.pierce && !b.pierce) b.dead = true;
            else if (b.pierce && !a.pierce) a.dead = true;
            else a.dead = b.dead = true;
            this.events.push(['spark', (a.x + b.x) / 2, (a.y + b.y) / 2]);
            for (const x of [a, b]) if (x.dead && x.blast) this._blast(x, x.x, x.y, null);
            if (a.dead) break;
          }
        }
      }
      for (const b of this.bullets) {
        if (!b.dead || !b.near) continue;
        for (const id of b.near) if (id !== b.hitId) { const t = this.tankById.get(id); if (t) t.dodges++; }
      }
      this.bullets = this.bullets.filter(b => !b.dead);
    }
  }

  // 子彈會被擋下的格子（含地圖外）
  _stopsBullet(x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return true;
    const c = this.tiles[ty * this.size + tx];
    return c === '#' || c === '@' || c === 'B';
  }

  // 反彈：判斷撞到的是哪一面，翻轉對應的方向分量
  _bounce(b) {
    const v = [b.vx, b.vy];
    Physics.bounceVec(v, this._stopsBullet(b.x, b.py), this._stopsBullet(b.px, b.y));
    b.vx = v[0]; b.vy = v[1];
    b.x = b.px; b.y = b.py;
    b.angle = Physics.angleOfVec(b.vx, b.vy);
    b.dir = Physics.dirOf(b.angle);
    b.bounces--;
    this.events.push(['spark', b.x, b.y]);
  }

  _bulletHitWorld(b) {
    const tx = Math.floor(b.x), ty = Math.floor(b.y);
    if (b.bounces > 0 && !b.blast) {
      const outside = tx < 0 || ty < 0 || tx >= this.size || ty >= this.size;
      const c = outside ? '@' : this.tiles[ty * this.size + tx];
      if (c === '@' || (c === '#' && !this.breakableWalls)) { this._bounce(b); return; }
    }
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) {
      b.dead = true;
      if (b.blast) this._blast(b, b.x, b.y, null);
      else this.events.push(['spark', b.x, b.y]);
      return;
    }
    const idx = ty * this.size + tx;
    const c = this.tiles[idx];
    if (c === '#') {
      b.dead = true;
      const broke = this.breakableWalls && this._breakTile(tx, ty);
      if (b.blast) this._blast(b, tx + 0.5, ty + 0.5, null);
      else this.events.push([broke ? 'brick' : this.breakableWalls ? 'wallHit' : 'spark', tx + 0.5, ty + 0.5]);
    } else if (c === '@') {
      b.dead = true;
      if (b.blast) this._blast(b, b.x, b.y, null);
      else this.events.push(['spark', b.x, b.y]);
    } else if (c === 'B') {
      b.dead = true;
      const side = this.sides.find(s => s.base && s.base.alive && s.base.x === tx && s.base.y === ty);
      if (side && side.key !== b.side) this._destroyBase(side, b);
      else if (b.blast) this._blast(b, b.x, b.y, null);
      else this.events.push(['spark', b.x, b.y]);
    }
  }

  // 打磚牆：加固的基地圍牆要打好幾下；回傳 true 表示這塊牆被打掉了
  _breakTile(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return false;
    const idx = ty * this.size + tx;
    if (this.tiles[idx] !== '#') return false;
    const hp = this.wallHp.get(idx);
    if (hp && this.playTick < C.BASE_WALL_SHIELD_TICKS) return false;   // 開局保護期：基地圍牆打不壞
    if (hp > 1) {
      this.wallHp.set(idx, hp - 1);
      this.wallChanges.push([idx, hp - 1]);
      return false;
    }
    this.wallHp.delete(idx);
    this.tiles[idx] = '.';
    this.tileChanges.push([idx, '.']);
    return true;
  }

  // 基地周圍 8 格的磚牆加固（牆打不破的模式不需要）
  _reinforceBaseWalls(sideFilter) {
    if (!this.breakableWalls) return;
    for (const s of this.sides) {
      if (!s.base || !s.base.alive || (sideFilter && s !== sideFilter)) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = s.base.x + dx, y = s.base.y + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const idx = y * this.size + x;
        if (this.tiles[idx] !== '#') continue;
        if (this.wallHp.get(idx) !== C.BASE_WALL_HP) { this.wallHp.set(idx, C.BASE_WALL_HP); this.wallChanges.push([idx, C.BASE_WALL_HP]); }
      }
    }
  }

  // 爆破子彈：炸毀 3×3 磚牆（牆壁可破時），並傷害半徑內的敵方坦克
  _blast(b, x, y, directHit) {
    this.events.push(['blast', x, y]);
    if (this.breakableWalls) {
      const cx = Math.floor(x), cy = Math.floor(y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this._breakTile(cx + dx, cy + dy);
    }
    const shooter = this.tankById.get(b.owner);
    for (const t of this.tanks) {
      if (!t.alive || t === directHit || t.side === b.side) continue;
      if (Math.hypot(t.x - x, t.y - y) <= C.BLAST_RADIUS) this._damage(t, shooter, x, y, 'blast');
    }
  }

  // 位置歷史：最近 16 個 tick 每台坦克的位置（延遲補償用）
  _recordHistory() {
    const snap = new Map();
    for (const t of this.tanks) if (t.alive) snap.set(t.id, [t.x, t.y]);
    this.posHist = this.posHist || [];
    this.posHist[this.tick % 16] = { tick: this.tick, snap };
  }

  _posAt(t, tick) {
    const h = this.posHist && this.posHist[((tick % 16) + 16) % 16];
    if (!h || h.tick !== tick) return [t.x, t.y];
    return h.snap.get(t.id) || null;     // 那時候還沒活著：不判定
  }

  _bulletHitTank(b) {
    for (const t of this.tanks) {
      if (!t.alive || t.side === b.side) continue; // 沒有友軍傷害：子彈穿過隊友
      const p = b.lag ? this._posAt(t, this.tick - b.lag) : [t.x, t.y];
      if (!p) continue;
      if (Math.abs(p[0] - b.x) < HALF + C.HIT_MARGIN && Math.abs(p[1] - b.y) < HALF + C.HIT_MARGIN) {
        const through = this._piercesThrough(b, t);
        if (through === 'skip') continue;
        if (through) {   // 蓄力射擊：打中這台後繼續飛
          const shooter0 = this.tankById.get(b.owner);
          if (shooter0) shooter0.hits++;
          this._lastHit = b; this._damage(t, shooter0, b.x, b.y, 'shot'); this._lastHit = null;
          continue;
        }
        b.dead = true;
        b.hitId = t.id;
        const shooter = this.tankById.get(b.owner);
        if (shooter) shooter.hits++;
        if (b.freeze || b.confuse) {   // 冰凍彈、混亂彈：不扣命，只上狀態
          if (t.shield > 0) { this.events.push(['spark', b.x, b.y]); return; }
          if (b.freeze) t.frozen = Math.max(t.frozen || 0, C.FREEZE_HIT_TICKS);
          else t.confused = Math.max(t.confused || 0, C.CONFUSE_TICKS);
          this.events.push([b.freeze ? 'freezeHit' : 'confuseHit', t.x, t.y]);
          return;
        }
        this._lastHit = b;
        this._damage(t, this.tankById.get(b.owner), b.x, b.y, 'shot');
        this._lastHit = null;
        if (b.blast) this._blast(b, b.x, b.y, t);
        return;
      }
    }
  }

  _damage(t, shooter, x, y, cause) {
    if (!t.alive) return;
    if (t.shield > 0) { this.events.push(['spark', x, y]); return; }
    if (t.hp > 1) { t.hp--; this.events.push(['armor', t.x, t.y]); return; }
    if (shooter) shooter.kills++;
    if (t.ana) this._recordDeath(t, shooter, cause);
    t.alive = false;
    t.deaths++;
    if (this.objective === 'koth' || this.objective === 'ctf' || this.objective === 'escort' || t.unlimited) {
      // 佔點、搶旗、護送或設定成無限命：直接重生（電腦等久一點）
      t.respawnTimer = t.isBot ? this.botRespawnTicks : this.respawnTicks;
    } else {
      t.lives = Math.max(0, t.lives - 1);
      t.respawnTimer = this.respawnTicks;
    }
    t.input = { move: null, fire: false };
    this.events.push(['boom', t.x, t.y]);
    this.kills.push([t.id, shooter ? shooter.id : 0, cause]);
    this._onTankDeath(t);
  }

  _destroyBase(side, b) {
    side.base.alive = false;
    const idx = side.base.y * this.size + side.base.x;
    this.tiles[idx] = '.';
    this.tileChanges.push([idx, '.']);
    this.events.push(['baseBoom', side.base.x + 0.5, side.base.y + 0.5]);
    const shooter = this.tankById.get(b.owner);
    if (shooter) shooter.baseKills++;
    this.baseKillsNow.push([side.key, shooter ? shooter.id : 0]);
    this._eliminate(side, shooter);
  }

  _eliminate(side, shooter) {
    side.eliminated = true;
    for (const t of this.tanks) {
      if (t.side !== side.key) continue;
      if (t.alive) {
        t.alive = false; t.deaths++;
        this.events.push(['boom', t.x, t.y]);
        this.kills.push([t.id, shooter ? shooter.id : 0, 'base']);
        this._onTankDeath(t);
      }
      t.lives = 0;
    }
  }

  _sideStrength(side) {
    let n = 0;
    for (const t of this.tanks) if (t.side === side.key) n += t.unlimited && t.lives > 0 ? 100 : t.lives;
    return n;
  }

  // 這一局的職業數值（套用房主的速度／彈速／冷卻倍率）
  statsFor(cls) {
    this._statsCache = this._statsCache || {};
    if (!this._statsCache[cls]) {
      const s = Object.assign({}, classStats(cls));
      const R = this.rules || C.ADV_DEFAULTS;
      s.speed = Math.round(s.speed * R.speed * 100) / 100;
      s.bulletSpeed = Math.round(s.bulletSpeed * R.bullet * 100) / 100;
      s.cooldown = Math.max(3, Math.round(s.cooldown * R.fire));
      this._statsCache[cls] = s;
    }
    return this._statsCache[cls];
  }

  _checkEnd() {
    if (this.endTimer >= 0) {
      if (--this.endTimer <= 0) this.over = true;
      return;
    }
    const oe = this._objectiveEnd();
    if (oe) return this._finish(oe.winner, oe.reason);
    if (oe === false) return;     // 打怪模式：只看自己的條件
    for (const s of this.sides) {
      if (!s.eliminated && this._sideStrength(s) === 0) s.eliminated = true; // 玩家沒命、電腦也死了
    }
    const alive = this.sides.filter(s => !s.eliminated);
    let winner, reason;
    if (alive.length <= 1) {
      winner = alive[0] || null;
      reason = alive.length ? 'last' : 'draw';
    } else if (this.timeLimitTicks && this.playTick >= this.timeLimitTicks) {
      // 時間到：剩餘命數多的獲勝，再比擊殺數
      // 佔點秒數／搶旗次數優先，再比剩餘命數、擊殺數
      const score = s => this._objectiveScore(s) * 1e6 + this._sideStrength(s) * 1000 + this.tanks.filter(t => t.side === s.key).reduce((a, t) => a + t.kills, 0);
      const sorted = alive.slice().sort((a, b) => score(b) - score(a));
      winner = score(sorted[0]) > score(sorted[1]) ? sorted[0] : null;
      reason = winner ? 'time' : 'timeDraw';
    } else return;
    this._finish(winner, reason);
  }

  // 房主強制結束：這局算平手
  forceEnd() {
    if (this.result) return;
    this._finish(null, 'forced');
    this.endTimer = 1;
    if (this.tick <= this.startTicks) this.over = true;   // 倒數中也能結束
  }

  _finish(winner, reason) {
    this.result = {
      winner: winner ? winner.key : null,
      reason,
      ticks: this.playTick,
      objective: this.objective,
      objScore: this.objScore || null,
      pveWave: this.pveWave || 0,
      tanks: this.tanks.filter(t => !t.monster).map(t => ({
        id: t.id, side: t.side, owner: t.owner, name: t.ownerName, isBot: t.isBot, cls: t.cls,
        kills: t.kills, deaths: t.deaths, lives: t.lives, baseKills: t.baseKills,
        shots: t.shots, hits: t.hits, dodges: t.dodges, items: t.itemsPicked, captures: t.captures,
        score: Round.mvpScore(t),
      })),
    };
    // MVP：分數最高的坦克（同分取擊殺多的）
    const best = this.result.tanks.slice().sort((a, b) => b.score - a.score || b.kills - a.kills)[0];
    if (best && best.score > 0) best.mvp = true;
    this.endTimer = C.END_DELAY;
  }

  // ---------- 給電腦代碼的 view ----------

  _rows() {
    if (!this.rowsCache) {
      const rows = [];
      const all = this.tiles.join('');
      for (let y = 0; y < this.size; y++) rows.push(all.slice(y * this.size, (y + 1) * this.size));
      this.rowsCache = rows;
    }
    return this.rowsCache;
  }

  _tankView(t) {
    return {
      id: t.id, x: t.x, y: t.y, dir: t.dir, angle: Math.round((t.angle || 0) * 10) / 10, isBot: t.isBot, owner: t.owner, cls: t.cls, lives: t.lives, hp: t.hp, shield: t.shield,
      carrying: !!t.carrying,
      buffs: {
        speed: t.speedBuff || 0, rapid: t.rapidBuff || 0, spread: t.spreadBuff || 0, bounce: t.bounceBuff || 0, swift: t.swiftBuff || 0,
        cloak: t.cloak || 0, phase: t.phase || 0, radar: t.radar || 0, frozen: t.frozen || 0, confused: t.confused || 0,
        blastShots: t.blastShots || 0, pierceShots: t.pierceShots || 0, freezeShots: t.freezeShots || 0, confuseShots: t.confuseShots || 0,
      },
    };
  }

  _viewFor(me) {
    const allies = [], enemies = [];
    for (const t of this.tanks) {
      if (!t.alive || t === me) continue;
      if (t.side !== me.side && (t.cloak > 0 || this._inSmoke(t))) continue;     // 隱形或躲在煙霧裡的敵人看不到
      (t.side === me.side ? allies : enemies).push(this._tankView(t));
    }
    if (!this.classTable) {
      this.classTable = {};
      for (const k of [...Object.keys(C.CLASSES), 'bot', 'monster']) {
        const c = this.statsFor(k);
        this.classTable[k] = { speed: c.speed, cooldown: c.cooldown, bulletSpeed: c.bulletSpeed, maxBullets: c.maxBullets, hp: c.hp, pierce: !!c.pierce, blast: !!c.blast, skill: c.skill || null };
      }
    }
    const view = {
      tick: this.playTick,
      ticksLeft: this.timeLimitTicks ? Math.max(0, this.timeLimitTicks - this.playTick) : null,
      me: {
        ...this._tankView(me),
        cooldown: me.cooldown,
        canFire: me.cooldown === 0 && this._ownBullets(me) < this._maxBullets(me),
        skill: me.stats.skill ? me.stats.skill.key : null,
        skillCd: me.skillCd || 0,
        skillReady: !!me.stats.skill && !(me.skillCd > 0),
        charged: (me.charged || 0) > 0,
      },
      allies,
      enemies,
      bullets: this.bullets.map(b => ({ x: b.x, y: b.y, dir: b.dir, angle: Math.round(b.angle * 10) / 10, vx: b.vx * b.speed, vy: b.vy * b.speed, speed: b.speed, ally: b.side === me.side, blast: b.blast, pierce: b.pierce, freeze: b.freeze, confuse: b.confuse, bounces: b.bounces })),
      objective: this.objectiveView(me),
      ...this._skillView(me),
      items: this.items.map(it => ({ x: it.x, y: it.y, type: C.ITEM_TYPES[it.type].key, ticksLeft: it.until - this.playTick })),
      bases: this.baseMode ? this.sides.filter(s => s.base).map(s => ({ x: s.base.x + 0.5, y: s.base.y + 0.5, ally: s.key === me.side, alive: s.base.alive })) : [],
      map: {
        width: this.size, height: this.size, tiles: this._rows(),
        wallHp: [...this.wallHp].map(([i, hp]) => ({ x: i % this.size, y: Math.floor(i / this.size), hp })),
      },
      rules: {
        tickRate: C.TICK_RATE, tankSize: C.TANK_SIZE, blastRadius: C.BLAST_RADIUS,
        mode: this.mode, baseMode: this.baseMode, fog: this.fog, breakableWalls: this.breakableWalls,
        codeOnly: this.codeOnly, classes: this.classTable,
        playerLives: this.rules.playerLives, botLives: this.rules.botLives, respawnTicks: this.respawnTicks,
        ricochet: this.ricochet, bulletBounces: C.BULLET_BOUNCES, items: this.itemsOn,
        baseWallShieldLeft: Math.max(0, C.BASE_WALL_SHIELD_TICKS - this.playTick),
      },
    };
    return JSON.stringify(view);
  }

  // ---------- 給畫面的快照 ----------

  snapshotFor(playerId) {
    // 迷霧模式：玩家只看得到自己周圍的敵人與敵方子彈；隊友永遠看得到
    let vis = null;
    const viewer = playerId ? this.playerTank(playerId) : null;
    const viewerSide = viewer ? viewer.side : null;
    if (this.fog && !this.codeOnly && viewer && !(viewer.radar > 0)) {   // 全視道具：無視迷霧
      const me = viewer;
      {
        const cx = me.alive ? me.x : me.spawn.x + 0.5;
        const cy = me.alive ? me.y : me.spawn.y + 0.5;
        const r2 = me.stats.vision * me.stats.vision;
        vis = { side: me.side, see: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r2 };
      }
    }
    const T = [];
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (vis && t.side !== vis.side && !vis.see(t.x, t.y)) continue;
      if ((t.cloak > 0 || this._inSmoke(t)) && viewerSide && t.side !== viewerSide) continue;    // 隱形、煙霧
      const buffs = (t.speedBuff > 0 ? 1 : 0) | (t.rapidBuff > 0 ? 2 : 0)
        | (t.blastShots > 0 || t.pierceShots > 0 || t.freezeShots > 0 || t.confuseShots > 0 ? 4 : 0)
        | (t.cloak > 0 ? 8 : 0) | (t.radar > 0 ? 16 : 0) | (t.frozen > 0 ? 32 : 0) | (t.confused > 0 ? 64 : 0)
        | (t.phase > 0 ? 128 : 0) | (t.spreadBuff > 0 ? 256 : 0) | (t.bounceBuff > 0 ? 512 : 0) | (t.swiftBuff > 0 ? 1024 : 0)
        | (t.dashTicks > 0 ? 2048 : 0) | (t.charged > 0 ? 4096 : 0);
      T.push([t.id, Math.round(t.x * 100), Math.round(t.y * 100), Math.round(t.angle || 0), t.shield > 0 ? 1 : 0, t.hp, buffs, t.ackSeq || 0, t.skillCd || 0]);
    }
    const B = [];
    for (const b of this.bullets) {
      if (vis && b.side !== vis.side && !vis.see(b.x, b.y)) continue;
      B.push([b.id, Math.round(b.x * 100), Math.round(b.y * 100), Math.round(b.angle), b.freeze ? 3 : b.confuse ? 4 : b.blast ? 2 : b.pierce ? 1 : 0]);
    }
    const E = vis ? this.events.filter(e => vis.see(e[1], e[2]) || e[0] === 'baseBoom') : this.events;
    const snap = { t: 's', k: this.tick, T, B };
    if (this.tick <= this.startTicks) snap.c = this.startTicks - this.tick;
    if (this.kills.length) snap.K = this.kills;
    if (this.objective !== 'survival' && (this.tick % 5 === 1 || this.objEvents.length)) {
      snap.O = this.objectiveSnapshot();
      if (this.objEvents.length) snap.OE = this.objEvents;
    }
    if (this.baseKillsNow.length) snap.X = this.baseKillsNow;
    if (E.length) snap.E = E.map(e => [e[0], Math.round(e[1] * 100), Math.round(e[2] * 100)]);
    if (this.tileChanges.length) snap.M = this.tileChanges;
    if (this.wallChanges.length) snap.W = this.wallChanges;
    if (this.tick % 10 === 1 || this.events.length) {
      snap.L = this.tanks.map(t => [t.id, t.lives, t.alive ? 1 : 0]);
      snap.S = this.sides.map(s => [s.key, s.eliminated ? 1 : 0, s.base ? (s.base.alive ? 1 : 0) : -1]);
    }
    if (this.itemsOn && (this.itemsChanged || this.tick % 15 === 1)) {
      snap.I = this.items.map(it => [it.id, Math.round(it.x * 100), Math.round(it.y * 100), it.type, it.until - this.playTick]);
    }
    if (this.pickups.length) {
      snap.P = this.pickups.map(p => [p[0], p[1], Math.round(p[2] * 100), Math.round(p[3] * 100)]);
    }
    this._skillSnapshot(snap, viewer ? viewerSide : undefined);
    return snap;
  }

  // 每位玩家的代碼報告：bot = 電腦坦克，pilot = 由代碼駕駛的玩家坦克（純代碼對戰 / 電腦隊伍）
  // 需要每個玩家各自的快照（迷霧或有人隱形時）
  needsPerPlayerSnapshots() {
    return !this.codeOnly && (this.fog || this.mines.length > 0 || this.smokes.length > 0 || this.tanks.some(t => t.alive && t.cloak > 0));
  }

  botReports() {
    const out = {};
    for (const t of this.tanks) {
      if (!t.sandbox || t.monster) continue;
      out[t.owner] = out[t.owner] || {};
      const rep = t.sandbox.report();
      rep.analysis = this._analysisReport(t);
      out[t.owner][t.isBot ? 'bot' : 'pilot'] = rep;
    }
    return out;
  }

  // ---------- 電腦表現分析 ----------

  // 每個 tick 記錄代碼控制的坦克：有沒有在發呆、有沒有卡住
  _analyze() {
    if (this.tick <= this.startTicks) return;
    const enemiesAlive = side => this.tanks.some(o => o.alive && o.side !== side);
    for (const t of this.tanks) {
      if (!t.sandbox || t.monster) continue;
      const a = t.ana || (t.ana = { alive: 0, idle: 0, idleRuns: [], stuckRuns: [], curIdle: null, curStuck: null, deaths: [], last: null });
      if (!t.alive) { this._closeRun(a, 'curIdle', 'idleRuns'); this._closeRun(a, 'curStuck', 'stuckRuns'); a.last = null; continue; }
      a.alive++;
      const moved = a.last && Math.abs(t.x - a.last[0]) + Math.abs(t.y - a.last[1]) > 0.002;
      const wantsMove = t.input.move !== null && t.input.move !== undefined;
      const idle = !wantsMove && !t.input.fire && enemiesAlive(t.side) && !(t.frozen > 0);
      const stuck = wantsMove && a.last && !moved && !(t.frozen > 0);
      if (idle) { a.idle++; if (!a.curIdle) a.curIdle = [this.playTick, this.playTick]; else a.curIdle[1] = this.playTick; }
      else this._closeRun(a, 'curIdle', 'idleRuns');
      if (stuck) { if (!a.curStuck) a.curStuck = [this.playTick, this.playTick]; else a.curStuck[1] = this.playTick; }
      else this._closeRun(a, 'curStuck', 'stuckRuns');
      a.last = [t.x, t.y];
    }
  }

  _closeRun(a, cur, list) {
    if (a[cur] && a[cur][1] - a[cur][0] >= C.TICK_RATE) a[list].push(a[cur].slice());   // 只記 1 秒以上的
    a[cur] = null;
  }

  _recordDeath(t, shooter, cause) {
    const b = this._lastHit;
    t.ana.deaths.push({
      at: this.playTick, cause,
      by: shooter ? (shooter.monster ? '怪物' : shooter.ownerName + (shooter.isBot ? '的電腦' : '')) : null,
      flight: b ? this.tick - b.born : null,                                  // 子彈飛了幾個 tick 才打到
      range: b ? Math.round(Math.hypot(b.ox - t.x, b.oy - t.y) * 10) / 10 : null,
    });
  }

  _analysisReport(t) {
    const a = t.ana;
    if (!a) return null;
    this._closeRun(a, 'curIdle', 'idleRuns'); this._closeRun(a, 'curStuck', 'stuckRuns');
    const sec = v => Math.round(v / C.TICK_RATE * 10) / 10;
    const runs = list => list.slice().sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, 5).map(r => [sec(r[0]), sec(r[1])]);
    return {
      aliveSec: sec(a.alive), idleSec: sec(a.idle),
      idleRuns: runs(a.idleRuns), stuckRuns: runs(a.stuckRuns), stuckCount: a.stuckRuns.length,
      shots: t.shots, hits: t.hits, dodges: t.dodges, kills: t.kills, items: t.itemsPicked,
      deaths: a.deaths.map(d => ({ at: sec(d.at), cause: d.cause, by: d.by, flightSec: d.flight === null ? null : sec(d.flight), range: d.range, dodgeable: d.flight !== null && d.flight >= 15 })),
    };
  }

  dispose() {
    for (const t of this.tanks) if (t.sandbox) t.sandbox.dispose();
  }
}

installObjectives(Round);
installSkills(Round);

module.exports = { Round, mapSizeFor };
