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
const installTerrain = require('./terrain');
const installPve = require('./pve');

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
// 玩家職業子彈的外觀編號（快照 B 的第 6 欄）
const PERK_STYLE = { assault: 1, heavy: 2, scout: 3, sniper: 4, demo: 5, engineer: 6, nurse: 7 };
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
    this.hpSystem = !!opts.hpSystem;     // 血量系統：每條命有血量，子彈依職業扣血
    this.closeCam = !!opts.closeCam;      // 近距離鏡頭：玩家畫面只看得到自己周圍（純畫面效果）
    this.regenOn = !!opts.regen;         // 自動回血（血量系統的子選項，預設關閉；偵察不管有沒有開都會回血）
    this.tankSize = C.TANK_SIZE;          // 給共用物理用
    this.alignRate = C.ALIGN_RATE;
    this.ricochet = !!opts.ricochet;
    this.itemsOn = !!opts.items;
    const off = new Set(opts.disabledItems || []);
    const usable = i => this.hpSystem || !C.ITEM_TYPES[i].hpOnly;
    this.allowedItems = C.ITEM_TYPES.map((t, i) => i).filter(i => !off.has(C.ITEM_TYPES[i].key) && usable(i));   // 房主可以關掉部分道具
    if (!this.allowedItems.length) this.allowedItems = C.ITEM_TYPES.map((t, i) => i).filter(usable);   // 留下的都用不到時：全部開放
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
    if (this.objective === 'ctf' || this.objective === 'escort' || this._modeHas()) this.baseMode = false;     // 搶旗的旗子、護送的終點都在基地的位置
    if (this.objective === 'pve') { this.hpSystem = true; this.baseMode = false; }          // 打怪：固定使用血量系統、沒有基地
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
      specials: !!opts.specialTerrain,
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
          // 電腦預設是標準規格（bot）；房間開了「電腦也有職業」時會帶 botCls
          const cls = isBot ? (C.CLASSES[m.botCls] ? m.botCls : 'bot') : (C.CLASSES[m.cls] ? m.cls : 'assault');
          const stats = this.statsFor(cls, isBot ? 'b' : 'p');
          const tank = {
            id: id++, side: s.key, owner: m.playerId, ownerName: m.name, isBot, cls, stats,
            lives: 1, hp: stats.hp,
            alive: false, x: 0, y: 0, dir: 'up', angle: 0,
            spawn: this.sides[si].spawns[slot++ % this.sides[si].spawns.length],
            respawnTimer: 0, shield: 0, cooldown: 0,
            input: { move: null, fire: false },
            kills: 0, deaths: 0, baseKills: 0, shots: 0, hits: 0, dodges: 0, itemsPicked: 0, captures: 0,
            dmgDealt: 0, assists: 0, healed: 0,
            sandbox: null,
          };
          // 命數：電腦和玩家分開設定，0 = 無限重生；玩家可以有讓分（多／少幾條命）
          const base = isBot ? R.botLives : R.playerLives;
          tank.unlimited = base === 0;
          tank.maxLives = tank.unlimited ? 1 : Math.max(1, base + (isBot ? 0 : (m.handicap || 0)));
          tank.lives = tank.maxLives;
          tank.maxHp = this._maxHpFor(cls, isBot);
          tank.hp = tank.maxHp;
          if (isBot || m.aiPilot) tank.sandbox = new BotSandbox(isBot ? m.code : (m.pilotCode || m.code), `${m.name}${isBot ? ' 電腦' : ''}`);
          this.tanks.push(tank);
        }
      }
    });
    this.nextTankId = id;
    this.botClassesOn = this.tanks.some(t => t.isBot && t.cls !== 'bot');
    this.tankById = new Map(this.tanks.map(t => [t.id, t]));
    for (const t of this.tanks) if (t.lives > 0) this._spawn(t, true);
    if (monsterSide) this._initPve(opts);
    this._initObjective();
    this._initSkills();
    this._initTerrain(opts);
    this._reinforceBaseWalls();
    this.rowsCache = null;
  }

  // ---------- 對外介面 ----------

  setInput(playerId, input) {
    const t = this.playerTank(playerId);
    if (!t || t.sandbox) return;
    t.input = { move: toAngle(input.move), aim: Number.isFinite(input.aim) ? Physics.norm(input.aim) : null, fire: !!input.fire };
    if (input.skill) t.skillQueued = true;   // 技能按鈕（一次性）
    if (Number.isInteger(input.seq)) t.inputSeq = input.seq;   // 手機預測用：回報處理到第幾個輸入
    if (Number.isFinite(input.view)) t.viewTick = input.view;   // 延遲補償：玩家畫面上正在顯示第幾個 tick
  }

  // MVP 分數：擊殺最重要，拆基地、搶旗也很重要；命中、閃避、撿道具加一點；陣亡扣分
  static mvpScore(t) {
    return Math.round(t.kills * 100 + t.baseKills * 150 + t.captures * 150 + t.hits * 10 + t.dodges * 5 + t.itemsPicked * 10 - t.deaths * 40
      + (t.assists || 0) * 50 + (t.healed || 0) * 0.8 + ((t.dmgDealt || 0) > 5 ? t.dmgDealt * 0.3 : 0));
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
      angles: true, hpSystem: this.hpSystem, zone: this.zone, pve: this.pve ? this._pveMeta() : null, closeCam: !!this.closeCam, spreadAngle: C.SPREAD_ANGLE, escortPath: this.cart ? this.cart.path : null,
      wallHp: [...this.wallHp], baseWallHp: C.BASE_WALL_HP, baseWallShieldTicks: C.BASE_WALL_SHIELD_TICKS, skills: C.SKILLS,   // 快照裡的方向是角度（度），不是八方向編號
      alignRate: C.ALIGN_RATE, speedBuff: C.SPEED_BUFF, bulletBounces: C.BULLET_BOUNCES, bounceBuff: C.BOUNCE_BUFF,
      tickRate: C.TICK_RATE, tankSize: C.TANK_SIZE,
      sides: this.sides.map(s => ({ key: s.key, name: s.name, color: s.color, base: s.base ? { x: s.base.x, y: s.base.y } : null, anchor: s.anchor })),
      tanks: this.tanks.map(t => ({
        id: t.id, side: t.side, owner: t.owner, name: t.ownerName, isBot: t.isBot, cls: t.cls,
        maxLives: t.unlimited ? -1 : t.maxLives || 1, maxHp: t.maxHp || t.stats.hp, vision: t.stats.vision, size: t.size || undefined, kind: t.structure || t.npc ? t.kind : undefined,
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
    if (this.pve) { this.pve.stateChanged = false; this.pve.hazardsChanged = false; }
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
      if (this.pve && action) this._pveBotDraft(t, action);
    }

    if (this.pve) this._pveThink();

    // 2. 移動與開火（順序每 tick 輪替，避免固定某台坦克永遠先動）
    const n = this.tanks.length;
    const offset = this.tick % n;
    for (let i = 0; i < n; i++) {
      const t = this.tanks[(i + offset) % n];
      if (!t.alive) continue;
      t.aim = t.input.aim ?? null;
      if (t.cooldown > 0) t.cooldown--;
      if (t.shield > 0) t.shield--;
      for (const k of TIMERS) if (t[k] > 0) t[k]--;
      if (t.frozen > 0) continue;                       // 被凍住：不能動也不能射
      let mv = toAngle(t.input.move);
      if (mv !== null && t.confused > 0) mv = Physics.norm(mv + 180);     // 混亂：方向顛倒
      if (mv !== null) this._move(t, mv);
      t.stillTicks = mv === null ? (t.stillTicks || 0) + 1 : 0;      // 狙擊專長「屏息」用
      if (t.input.fire) this._fire(t);
      if (t.input.skill || t.skillQueued) { this._useSkill(t); t.skillQueued = false; }
    }
    this._updateSkills();
    this._playerSkillsTick();
    this._updateTerrain();
    this._regen();
    this._engineerRepair();
    for (const t of this.tanks) if (!t.isBot) t.ackSeq = t.inputSeq || 0;
    this._recordHistory();
    this._analyze();

    // 3. 子彈
    this._updateBullets();

    // 3.5 場地道具
    if (this.itemsOn) this._updateItems();

    // 3.6 遊戲目標（佔點、搶旗、打怪）
    this._updateObjective();
    if (this.pve) this._updatePve();

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
      t.x = x; t.y = y; t.alive = true; t.hp = t.maxHp || t.stats.hp; t.hurtTick = -1e9; t.regenAcc = 0;
      t.zoneTicks = 0; t.portalCd = 0; t.padTicks = 0; t.padAcc = 0; if (t.hurtBy) t.hurtBy.clear();
      for (const k of TIMERS) t[k] = 0;
      t.markUntil = 0; t.ramHit = null;
      for (const k of SHOTS) t[k] = 0;
      t.dashTicks = 0; t.charged = 0;
      t.dir = Math.abs(p.y - this.center) >= Math.abs(p.x - this.center)
        ? (p.y < this.center ? 'down' : 'up')
        : (p.x < this.center ? 'right' : 'left');
      t.angle = Physics.ANGLE_OF[t.dir];
      t.aim = null;
      t.shield = C.SHIELD_TICKS; // 開局與重生都有短暫無敵
      t.cooldown = 0;
      t.input = { move: null, fire: false };
      if (!initial) this.events.push(['spawn', t.x, t.y]);
      return true;
    }
    return false; // 出生點被擋住，下個 tick 再試
  }

  // 移動物理與手機共用（public/physics.js），兩邊預測才會一致
  _tileBlocked(x, y, phase, size) { return Physics.tileBlocked(this, x, y, phase, size); }

  _tankAt(x, y, self) {
    for (const o of this.tanks) {
      if (o === self || !o.alive) continue;
      const S = ((o.size || C.TANK_SIZE) + (self && self.size || C.TANK_SIZE)) / 2 - 1e-6;
      if (!o.noCollide && Math.abs(o.x - x) < S && Math.abs(o.y - y) < S) return o;
    }
    return null;
  }

  _others(t) { return this.tanks.filter(o => o !== t && o.alive && !o.noCollide); }

  _blocked(t, x, y) { return Physics.blocked(this, t, x, y, this._others(t)); }

  _move(t, dir) {
    const step = t.stats.speed * (t.speedBuff > 0 ? C.SPEED_BUFF : 1) * (t.dashTicks > 0 ? C.DASH_SPEED : 1) * (t.slowTicks > 0 ? 0.6 : 1) * (t.id === this.itId ? C.TAG_SPEED : 1) / C.TICK_RATE;
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
    let dmg = this._damageOf(t), dmgMult = 1;
    const perk = this._perk(t), PK = C.PERK;
    let mark = false;
    if (t.charged > 0) {   // 狙擊蓄力射擊（玩家的「標記射擊」另外標記目標、多貫穿 1 台）
      speed *= 1.8; pierce = true; pierceTanks = 1; t.charged = 0; dmgMult = C.HP.chargedMult; dmg = Math.round(dmg * dmgMult);
      if (perk === 'sniper') { mark = true; pierceTanks = 2; }
    }
    if (perk === 'sniper') pierceTanks = Math.max(pierceTanks, 1);   // 穿甲彈
    if (perk === 'sniper' && (t.stillTicks || 0) >= PK.steadyTicks) {   // 屏息：靜止後的第一發
      speed *= PK.steadySpeed; t.stillTicks = 0;
      if (this.hpSystem) { dmgMult *= PK.steadyDmg; dmg = Math.round(dmg * PK.steadyDmg); } else pierceTanks = Math.max(pierceTanks, 1);
    }
    const m = t.mods || {};
    const bounces = Math.max(this.ricochet ? C.BULLET_BOUNCES : 0, t.bounceBuff > 0 ? C.BOUNCE_BUFF : 0) + (m.bounce || 0) + (perk === 'scout' ? PK.scoutBounces : 0);
    const twin = perk === 'assault';
    if (twin && this.hpSystem) dmg = Math.max(1, Math.round(dmg * PK.twinDmg));
    if (perk === 'heavy' && this.hpSystem) dmg = Math.round(dmg * PK.shellDmg);
    if (m.pierce) pierceTanks += m.pierce;
    if (m.blastEvery && (t.shotCount = (t.shotCount || 0) + 1) % m.blastEvery === 0) blast = true;
    const frost = !!(t.elite && t.elite.includes('frost'));
    const a0 = t.aim ?? t.angle ?? 0;
    // 延遲補償：玩家看到的敵人比伺服器晚一點，子彈用玩家畫面上的位置判定命中（最多 0.2 秒）
    const lag = t.sandbox || !Number.isFinite(t.viewTick) ? 0 : Math.max(0, Math.min(C.MAX_LAG_TICKS, Math.round(this.tick - t.viewTick)));
    const angles = t.spreadBuff > 0 ? [a0, a0 - C.SPREAD_ANGLE, a0 + C.SPREAD_ANGLE] : [a0];
    if (m.extraShot) angles.push(a0 + 12);
    this.events.push(['shot', t.x, t.y]);   // 給手機播音效
    t.shots++;
    const pk = PERK_STYLE[perk] || 0;   // 玩家職業子彈的外觀
    angles.forEach((ang, i) => {
      const a = Physics.norm(ang);
      const [vx, vy] = Physics.vec(a);
      const [mx, my] = Physics.muzzle(t.x, t.y, a, (t.size || C.TANK_SIZE) / 2);   // 從砲口（車身邊緣）射出
      const pairId = twin ? this.nextBulletId : 0;
      const gap = this.hpSystem ? PK.twinGap : PK.twinGap * 0.6;   // 經典模式：兩發靠近一點（不然太容易打中）
      for (const [k, off] of (twin ? [-gap, gap] : [0]).entries()) {   // 突擊雙管：兩發平行（第二發不佔額度）
        this.bullets.push({
          id: this.nextBulletId++, owner: t.id, side: t.side, angle: a, dir: Physics.dirOf(a), vx, vy,
          x: mx - vy * off, y: my + vx * off,
          speed, pierce, blast, freeze, confuse, bounces, extra: i > 0 || k > 0, lag, born: this.tick, ox: t.x, oy: t.y, pierceTanks, dmg, snipe: t.cls === 'sniper' ? dmgMult * (this._edge('sniper', this._role(t)).damage || 1) : 0,
          homing: m.homing ? true : perk === 'engineer' ? C.PERK.homingTurn : false, frost, blastMul: perk === 'demo' ? PK.demoBlast : 1, heal: perk === 'nurse',
          pk, pairId, bounceAll: perk === 'scout', knock: perk === 'heavy', cluster: perk === 'demo' && blast, mark,
        });
      }
    });
    t.cooldown = t.rapidBuff > 0 ? Math.ceil(t.stats.cooldown / 2) : t.stats.cooldown;
    if (perk === 'assault' && this.tick < (t.frenzyUntil || 0)) t.cooldown = Math.max(2, Math.round(t.cooldown * PK.frenzyCd));   // 腎上腺素
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
      if (!t.alive || t.monster || t.structure) continue;
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
      case 'armor':
        if (this.hpSystem) t.hp = Math.min(t.hp + Math.round(t.maxHp * C.HP.armor), Math.round(t.maxHp * C.HP.armorCap));
        else t.hp = Math.min(t.hp + 1, t.stats.hp + 2);
        break;
      case 'medkit': t.hp = Math.max(t.hp, Math.min(t.maxHp, t.hp + Math.round(t.maxHp * C.HP.medkit * this._healMult()))); break;
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
    for (const b of this.bullets) {
      if (b.homing && !b.dead) this._pveHome(b);
      if (b.until && this.tick > b.until) b.dead = true;     // 破片：短距離
    }
    for (let s = 0; s < BULLET_SUB; s++) {
      for (const b of this.bullets) {
        if (b.dead) continue;
        const vx = b.vx, vy = b.vy;
        const step = b.speed / C.TICK_RATE / BULLET_SUB;
        b.px = b.x; b.py = b.y;
        b.x += vx * step; b.y += vy * step;
        this._bulletHitWorld(b);
        if (!b.dead && this.ball) this._ballHit(b);
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
      if (c === '@' || (c === '#' && (!this.breakableWalls || b.bounceAll))) { this._bounce(b); return; }   // 偵察跳彈：磚牆也彈
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
    } else if (c === 'O') {        // 油桶：打到就爆炸
      b.dead = true;
      this._explodeBarrel(tx, ty, b);
      if (b.blast) this._blast(b, tx + 0.5, ty + 0.5, null);
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
      if ((b.blastMul || 1) > 1) for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) this._breakTile(cx + dx, cy + dy);   // 高爆：十字 5 格
    }
    if (b.cluster) {   // 爆破集束彈：向四個斜角噴出破片
      for (const a of [45, 135, 225, 315]) {
        const [vx, vy] = Physics.vec(a);
        this.bullets.push({ id: this.nextBulletId++, owner: b.owner, side: b.side, angle: a, dir: Physics.dirOf(a), vx, vy, x: x + vx * 0.5, y: y + vy * 0.5,
          speed: 9, pierce: false, blast: false, bounces: 0, extra: true, lag: 0, born: this.tick, ox: x, oy: y, pierceTanks: 0,
          dmg: Math.max(1, Math.round((b.dmg || 1) * C.PERK.shardDmg)), until: this.tick + C.PERK.shardTicks, pk: 8, shard: true });
      }
    }
    { const cx = Math.floor(x), cy = Math.floor(y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const tx = cx + dx, ty = cy + dy;
        if (tx >= 0 && ty >= 0 && tx < this.size && ty < this.size && this.tiles[ty * this.size + tx] === 'O') this._explodeBarrel(tx, ty, b);
      } }
    const shooter = this.tankById.get(b.owner);
    for (const t of this.tanks) {
      if (!t.alive || t === directHit || t.side === b.side) continue;
      const br = C.BLAST_RADIUS * (1 + (shooter && shooter.mods && shooter.mods.blastR || 0)) * (b.blastMul || 1) + ((t.size || C.TANK_SIZE) - C.TANK_SIZE) / 2;
      if (Math.hypot(t.x - x, t.y - y) <= br) this._damage(t, shooter, x, y, 'blast', b.mine ? C.HP.mine : Math.round((b.dmg || 1) * C.HP.splash));
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
      if (b.heal && t.alive && t.side === b.side && t.id !== b.owner && !t.structure) this._healBullet(b, t);
      if (!t.alive || t.side === b.side) continue; // 沒有友軍傷害：子彈穿過隊友
      const p = b.lag ? this._posAt(t, this.tick - b.lag) : [t.x, t.y];
      if (!p) continue;
      const half = (t.size || C.TANK_SIZE) / 2;
      if (Math.abs(p[0] - b.x) < half + C.HIT_MARGIN && Math.abs(p[1] - b.y) < half + C.HIT_MARGIN) {
        if (t.monster && this._pveBlockBullet(b, t)) return;
        const through = this._piercesThrough(b, t);
        if (through === 'skip') continue;
        if (through) {   // 蓄力射擊：打中這台後繼續飛
          const shooter0 = this.tankById.get(b.owner);
          if (shooter0) shooter0.hits++;
          this._lastHit = b; this._damage(t, shooter0, b.x, b.y, 'shot', this._bulletDmg(b)); this._lastHit = null;
          this._bulletAfterHit(b, t);
          continue;
        }
        b.dead = true;
        b.hitId = t.id;
        // 突擊雙管（經典模式）：兩發打中同一台只算一發
        if (b.pairId && !this.hpSystem) {
          if (t.pairHit === b.pairId) { this.events.push(['spark', b.x, b.y]); return; }
          t.pairHit = b.pairId;
        }
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
        this._damage(t, this.tankById.get(b.owner), b.x, b.y, 'shot', this._bulletDmg(b));
        this._lastHit = null;
        this._bulletAfterHit(b, t);
        if (b.frost && t.alive) t.slowTicks = Math.max(t.slowTicks || 0, 45);
        if (this.pve && shooter && shooter.mods) this._pveOnHit(shooter, t, b);
        if (b.blast) this._blast(b, b.x, b.y, t);
        return;
      }
    }
  }

  // 玩家職業子彈命中後：重砲彈擊退、標記射擊
  _bulletAfterHit(b, t) {
    if (!t.alive || t.structure) return;
    if (b.mark) { t.markUntil = this.tick + C.PERK.markTicks; this.events.push(['confuseHit', t.x, t.y]); }
    if (b.knock && !t.boss && !t.part && (t.size || C.TANK_SIZE) <= 1) {
      const sp = Math.hypot(b.vx, b.vy) || 1, ux = b.vx / sp, uy = b.vy / sp;
      for (let d = 0; d < C.PERK.knockback; d += 0.1) {
        const nx = t.x + ux * 0.1, ny = t.y + uy * 0.1;
        if (this._tileBlocked(nx, ny, t.phase > 0, t.size) || this._tankAt(nx, ny, t)) break;
        t.x = nx; t.y = ny;
      }
    }
  }

  // 護士專長：治療彈穿過隊友時治療（每發對同一台只治療一次）
  _healBullet(b, t) {
    const half = (t.size || C.TANK_SIZE) / 2;
    if (Math.abs(t.x - b.x) >= half + C.HIT_MARGIN || Math.abs(t.y - b.y) >= half + C.HIT_MARGIN) return;
    if ((b.healed || (b.healed = new Set())).has(t.id)) return;
    b.healed.add(t.id);
    if (t.hp >= t.maxHp) return;
    const amt = this.hpSystem ? Math.max(1, Math.round(t.maxHp * C.PERK.nurseHeal * this._healMult())) : 1;
    const before = t.hp;
    t.hp = Math.min(t.maxHp, t.hp + amt);
    const nurse = this.tankById.get(b.owner);
    if (nurse) nurse.healed = (nurse.healed || 0) + (t.hp - before);
    this.events.push(['heal', t.x, t.y]);
  }

  // amount：扣幾點血。沒開血量系統時一律 1（每條命的耐久就是能挨幾發）
  _damage(t, shooter, x, y, cause, amount) {
    if (!t.alive) return;
    if (this.objective === 'tag' && cause !== 'self') {      // 鬼抓人：沒有傷害
      if (cause === 'shot') this._tagShot(shooter, t);
      this.events.push(['spark', x, y]);
      return;
    }
    if (cause !== 'self' && (t.shield > 0 || t.invuln || t.dmgTaken === 0)) { this.events.push(['spark', x, y]); return; }
    // 重裝專長：前裝甲擋下正面飛來的子彈
    const hb = this._lastHit;
    if (cause === 'shot' && hb && this._perk(t) === 'heavy' && this.tick >= (t.plateReadyAt || 0)
      && Math.abs(((Physics.angleOfVec(-hb.vx, -hb.vy) - (t.angle || 0) + 540) % 360) - 180) <= C.PERK.plateArc) {
      t.plateReadyAt = this.tick + C.PERK.plateTicks;
      this.events.push(['spark', x, y]); this.events.push(['armor', t.x, t.y]);
      return;
    }
    if (cause === 'shot' && shooter && shooter.side !== t.side && this._perk(shooter) === 'scout') shooter.speedBuff = Math.max(shooter.speedBuff || 0, C.PERK.scoutRush);   // 打帶跑
    let dmg = this.hpSystem ? Math.max(1, Math.round(amount || 1)) : 1;
    if (this.pve && cause !== 'self') dmg = this._pveDamageMods(t, shooter, dmg, cause);
    if (this.hpSystem && cause !== 'self' && t.markUntil > this.tick) dmg = Math.round(dmg * C.PERK.markDmg);   // 狙擊標記
    if (this.hpSystem) {
      if (t.cls === 'heavy' && (cause === 'blast' || cause === 'barrel')) dmg = Math.max(1, Math.round(dmg / 2));     // 重裝：爆炸減半
      const pairHit = this._lastHit && this._lastHit.pairId && shooter && shooter.comboPair === this._lastHit.pairId;
      if (shooter && shooter.cls === 'assault' && cause === 'shot' && !pairHit) {                // 突擊：連擊（雙管同一組只算一次）
        shooter.comboPair = this._lastHit && this._lastHit.pairId;
        shooter.combo = shooter.comboTarget === t.id && this.tick - (shooter.comboTick ?? -1e9) <= C.TICK_RATE ? Math.min(C.HP.comboMax, (shooter.combo || 0) + 1) : 0;
        shooter.comboTarget = t.id; shooter.comboTick = this.tick;
        dmg += shooter.combo * C.HP.comboBonus;
      }
    }
    t.hurtTick = this.tick; t.regenAcc = 0;
    if (this.hpSystem) this.events.push(['dmg', t.x, t.y, dmg]);
    if (shooter && shooter.side !== t.side) {
      shooter.dmgDealt = (shooter.dmgDealt || 0) + Math.min(dmg, t.hp);
      (t.hurtBy || (t.hurtBy = new Map())).set(shooter.id, this.tick);
    }
    if (t.hp > dmg) { t.hp -= dmg; this.events.push(['armor', t.x, t.y]); return; }
    // 不屈：致命傷改為留 1 血（每波一次）
    if (t.mods && t.mods.cheat && !t.cheatUsed && cause !== 'self') { t.cheatUsed = true; t.hp = 1; t.shield = Math.max(t.shield, C.TICK_RATE); this.events.push(['heal', t.x, t.y]); return; }
    t.hp = 0;
    if (shooter) shooter.kills++;
    if (shooter && shooter.side !== t.side && this._perk(shooter) === 'assault') shooter.frenzyUntil = this.tick + C.PERK.frenzyTicks;   // 腎上腺素
    // 助攻：10 秒內也打過這台的其他敵人
    if (t.hurtBy) {
      for (const [id, tick] of t.hurtBy) {
        if (shooter && id === shooter.id) continue;
        const o = this.tankById.get(id);
        if (o && this.tick - tick <= 10 * C.TICK_RATE) o.assists = (o.assists || 0) + 1;
      }
      t.hurtBy.clear();
    }
    if (t.ana) this._recordDeath(t, shooter, cause);
    t.alive = false;
    t.deaths++;
    if ((C.RESPAWN_OBJECTIVES.includes(this.objective) && !t.structure) || t.unlimited) {
      // 佔點、搶旗、護送等目標或設定成無限命：直接重生（電腦等久一點）
      t.respawnTimer = t.isBot ? this.botRespawnTicks : this.respawnTicks;
    } else {
      t.lives = Math.max(0, t.lives - 1);
      t.respawnTimer = this.respawnTicks;
    }
    t.input = { move: null, fire: false };
    this.events.push(['boom', t.x, t.y]);
    this.kills.push([t.id, shooter ? shooter.id : 0, cause]);
    this._onTankDeath(t, shooter);
    if (this.pve) this._pveOnDeath(t, shooter);
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
        this._onTankDeath(t, null);
      }
      t.lives = 0;
    }
  }

  _sideStrength(side) {
    let n = 0;
    for (const t of this.tanks) if (t.side === side.key && !t.structure && !t.npc) n += t.unlimited && t.lives > 0 ? 100 : t.lives;
    return n;
  }

  // 血量系統：這台坦克每條命的血量；沒開時就是職業的耐久（能挨幾發）
  _maxHpFor(cls, isBot) {
    if (!this.hpSystem) return this.statsFor(cls).hp;
    const R = this.rules || C.ADV_DEFAULTS;
    const base = isBot && cls !== 'monster' ? (R.botHp || 100) : cls === 'monster' ? (R.botHp || 100) : (R.playerHp || 100);
    return Math.max(1, Math.round(base * (C.HP.hpFactor[cls] || 1) * (this._edge(cls, isBot ? 'b' : 'p').hp || 1)));
  }

  // 每週挑戰「斷補」：治療效果減半
  _healMult() { return this.pve && this.pve.mods.includes('noheal') ? 0.5 : 1; }

  _damageOf(t) {
    if (t.monster) return t.pveDmg || 10;
    if (t.turretDmg) return this.hpSystem ? t.turretDmg : 1;   // 玩家工兵的砲塔
    if (!this.hpSystem) return 1;
    const base = (C.HP.damage[t.cls] || 25) * (this._edge(t.cls, this._role(t)).damage || 1);
    return Math.round(t.mods && t.mods.dmg ? base * (1 + t.mods.dmg) : base);
  }

  // 血量系統：一段時間沒受傷就慢慢回血
  _regen() {
    if (!this.hpSystem) return;
    const nurses = this.tanks.filter(n => n.alive && n.cls === 'nurse');
    for (const t of this.tanks) {
      if (!t.alive || t.hp >= t.maxHp || t.structure || t.monster) continue;
      const scout = t.cls === 'scout';
      const delay = (scout ? C.HP.scoutRegenDelay : C.HP.regenDelay) * C.TICK_RATE;
      let rate = 0;
      if ((this.regenOn || scout) && this.tick - (t.hurtTick || 0) >= delay) rate += C.HP.regenPerSec * (scout && this.regenOn ? C.HP.scoutRegenMult : 1);
      const medic = nurses.find(n => n.side === t.side && Math.hypot(n.x - t.x, n.y - t.y) <= C.HP.nurseAura + (this._perk(n) === 'nurse' ? 1 : 0));
      if (medic) rate += C.HP.nurseAuraPerSec * this._healMult();   // 護士光環
      if (!rate) continue;
      t.regenAcc = (t.regenAcc || 0) + t.maxHp * rate / C.TICK_RATE;
      if (t.regenAcc >= 1) {
        const n = Math.floor(t.regenAcc), before = t.hp;
        t.regenAcc -= n; t.hp = Math.min(t.maxHp, t.hp + n);
        if (medic) medic.healed = (medic.healed || 0) + (t.hp - before) * (C.HP.nurseAuraPerSec / rate);
      }
    }
  }

  // 子彈實際傷害：狙擊依飛行距離加成
  _bulletDmg(b) {
    if (!this.hpSystem || !b.snipe) return b.dmg;
    const d = Math.hypot(b.x - b.ox, b.y - b.oy);
    const k = Math.max(0, Math.min(1, (d - 3) / 7));
    return Math.round((C.HP.sniperNear + (C.HP.sniperFar - C.HP.sniperNear) * k) * b.snipe);
  }

  // 這一局的職業數值（套用房主的速度／彈速／冷卻倍率）
  // role：'p' 玩家坦克（職業較強）、'b' 電腦坦克（狙擊較弱）、省略 = 原始職業數值
  statsFor(cls, role) {
    this._statsCache = this._statsCache || {};
    const key = role ? cls + '|' + role : cls;
    if (!this._statsCache[key]) {
      const s = Object.assign({}, classStats(cls));
      const R = this.rules || C.ADV_DEFAULTS;
      const edge = this._edge(cls, role);
      s.speed = Math.round(s.speed * R.speed * 100) / 100;
      s.bulletSpeed = Math.round(s.bulletSpeed * R.bullet * (edge.bulletSpeed || 1) * 100) / 100;
      s.cooldown = Math.max(3, Math.round(s.cooldown * R.fire * (edge.cooldown || 1)));
      if (role === 'p' && C.PLAYER_PERKS[cls]) {      // 玩家職業套件：強化版技能、重砲彈較慢
        s.skill = C.PLAYER_PERKS[cls].skill;
        if (cls === 'heavy') s.bulletSpeed = Math.round(s.bulletSpeed * C.PERK.shellSpeed * 100) / 100;
      }
      this._statsCache[key] = s;
    }
    return this._statsCache[key];
  }

  // 玩家／電腦的職業倍率（只套用在正式職業上，不影響標準電腦與怪物）
  _edge(cls, role) {
    if (!C.CLASSES[cls]) return {};
    if (role === 'p') return C.PLAYER_EDGE;
    if (role === 'b') return C.BOT_CLASS_EDGE[cls] || {};
    return {};
  }
  _role(t) { return t.monster || t.structure ? undefined : t.isBot ? 'b' : 'p'; }
  // 工兵專長：3 格內受損的加固牆（基地圍牆、城牆、自己築的牆）每 2 秒修復 1 點
  _engineerRepair() {
    if (!this.wallHp.size) return;
    for (const t of this.tanks) {
      if (!t.alive || this._perk(t) !== 'engineer' || (this.tick + t.id) % C.PERK.engRepairTicks) continue;
      for (const [idx, hp] of this.wallHp) {
        if (hp >= C.BASE_WALL_HP || this.tiles[idx] !== '#') continue;
        const x = idx % this.size + 0.5, y = Math.floor(idx / this.size) + 0.5;
        if (Math.hypot(x - t.x, y - t.y) > 3) continue;
        this.wallHp.set(idx, hp + 1); this.wallChanges.push([idx, hp + 1]);
      }
    }
  }

  // 專長發動中／就緒（畫面上顯示）：突擊擊殺後、重裝前裝甲就緒、狙擊屏息完成
  _perkReady(t) {
    const k = this._perk(t);
    return k === 'assault' ? this.tick < (t.frenzyUntil || 0) : k === 'heavy' ? this.tick >= (t.plateReadyAt || 0) : k === 'sniper' ? (t.stillTicks || 0) >= C.PERK.steadyTicks : false;
  }
  // 玩家職業專長：只有玩家坦克有
  _perk(t) { return t && !t.isBot && !t.structure && !t.monster && !t.npc && C.PLAYER_PERKS[t.cls] ? t.cls : null; }

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
      objective: this.objective, hpSystem: this.hpSystem, pve: this.pve ? this._pveSummary() : undefined,
      objScore: this.objScore || null,
      pveWave: this.pveWave || 0,
      tanks: this.tanks.filter(t => !t.monster && !t.structure && !t.npc).map(t => ({
        id: t.id, side: t.side, owner: t.owner, name: t.ownerName, isBot: t.isBot, cls: t.cls,
        kills: t.kills, deaths: t.deaths, lives: t.lives, baseKills: t.baseKills,
        shots: t.shots, hits: t.hits, dodges: t.dodges, items: t.itemsPicked, captures: t.captures,
        dmg: Math.round(t.dmgDealt || 0), assists: t.assists || 0, healed: Math.round(t.healed || 0),
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
      id: t.id, x: t.x, y: t.y, dir: t.dir, angle: Math.round((t.angle || 0) * 10) / 10,
      aim: Math.round((t.aim ?? t.angle ?? 0) * 10) / 10,
      isBot: t.isBot, owner: t.owner, cls: t.cls, lives: t.lives, hp: t.hp, maxHp: t.maxHp || t.stats.hp, shield: t.shield,
      carrying: !!t.carrying,
      ...(t.monster ? { kind: t.kind, elite: t.elite || [], size: t.size, boss: !!t.boss, invulnerable: !!(t.invuln || t.dmgTaken === 0) } : {}),
      ...(t.structure || t.npc ? { kind: t.kind } : {}),
      cards: t.cards ? t.cards.slice() : undefined,
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
        this.classTable[k] = { speed: c.speed, cooldown: c.cooldown, bulletSpeed: c.bulletSpeed, maxBullets: c.maxBullets, hp: c.hp, pierce: !!c.pierce, blast: !!c.blast, skill: c.skill || null,
          hpFactor: C.HP.hpFactor[k] || 1, damage: C.HP.damage[k] || 25, hpTrait: C.HP.traits[k] || null };
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
      objective: this.pve ? this._pveView(me) : this.objectiveView(me),
      ...this._skillView(me),
      ...this._terrainView(),
      items: this.items.map(it => ({ x: it.x, y: it.y, type: C.ITEM_TYPES[it.type].key, ticksLeft: it.until - this.playTick })),
      bases: this.baseMode ? this.sides.filter(s => s.base).map(s => ({ x: s.base.x + 0.5, y: s.base.y + 0.5, ally: s.key === me.side, alive: s.base.alive })) : [],
      map: {
        width: this.size, height: this.size, tiles: this._rows(),
        wallHp: [...this.wallHp].map(([i, hp]) => ({ x: i % this.size, y: Math.floor(i / this.size), hp })),
      },
      rules: {
        tickRate: C.TICK_RATE, tankSize: C.TANK_SIZE, blastRadius: C.BLAST_RADIUS,
        mode: this.mode, baseMode: this.baseMode, fog: this.fog, breakableWalls: this.breakableWalls,
        specVersion: C.SPEC_VERSION,
        playerEdge: C.PLAYER_EDGE, botClassEdge: C.BOT_CLASS_EDGE, playerPerks: C.PLAYER_PERKS,
        codeOnly: this.codeOnly, classes: this.classTable, hpSystem: this.hpSystem, regen: this.hpSystem && this.regenOn,
        playerHp: this.rules.playerHp, botHp: this.rules.botHp,
        botClasses: this.botClassesOn,
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
    const T = [], A = [];
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (vis && t.side !== vis.side && !vis.see(t.x, t.y)) continue;
      if ((t.cloak > 0 && !t.monster || this._inSmoke(t)) && viewerSide && t.side !== viewerSide) continue;    // 隱形、煙霧（潛伏者畫成殘影）
      const buffs = (t.speedBuff > 0 ? 1 : 0) | (t.rapidBuff > 0 ? 2 : 0)
        | (t.blastShots > 0 || t.pierceShots > 0 || t.freezeShots > 0 || t.confuseShots > 0 ? 4 : 0)
        | (t.cloak > 0 ? 8 : 0) | (t.radar > 0 ? 16 : 0) | (t.frozen > 0 ? 32 : 0) | (t.confused > 0 ? 64 : 0)
        | (t.phase > 0 ? 128 : 0) | (t.spreadBuff > 0 ? 256 : 0) | (t.bounceBuff > 0 ? 512 : 0) | (t.swiftBuff > 0 ? 1024 : 0)
        | (t.dashTicks > 0 ? 2048 : 0) | (t.charged > 0 ? 4096 : 0) | (this._perkReady(t) ? 8192 : 0) | (t.markUntil > this.tick ? 16384 : 0);
      const row = [t.id, Math.round(t.x * 100), Math.round(t.y * 100), Math.round(t.angle || 0), t.shield > 0 ? 1 : 0, t.hp, buffs, t.ackSeq || 0, t.skillCd || 0];
      if (t.monster || t.structure || t.npc) row.push(...this._pveTankExtra(t));
      T.push(row);
      if (t.aim != null) A.push([t.id, Math.round(t.aim * 10) / 10]);
    }
    const B = [];
    for (const b of this.bullets) {
      if (vis && b.side !== vis.side && !vis.see(b.x, b.y)) continue;
      B.push(b.pk ? [b.id, Math.round(b.x * 100), Math.round(b.y * 100), Math.round(b.angle), b.freeze ? 3 : b.confuse ? 4 : b.blast ? 2 : b.pierce ? 1 : 0, b.pk] : [b.id, Math.round(b.x * 100), Math.round(b.y * 100), Math.round(b.angle), b.freeze ? 3 : b.confuse ? 4 : b.blast ? 2 : b.pierce ? 1 : 0]);
    }
    const E = vis ? this.events.filter(e => vis.see(e[1], e[2]) || e[0] === 'baseBoom') : this.events;
    const snap = { t: 's', k: this.tick, T, B };
    if (A.length) snap.A = A;
    if (this.tick <= this.startTicks) snap.c = this.startTicks - this.tick;
    if (this.kills.length) snap.K = this.kills;
    if (this.objective !== 'survival' && (this.tick % 5 === 1 || this.objEvents.length)) {
      snap.O = this.objectiveSnapshot();
      if (this.objEvents.length) snap.OE = this.objEvents;
    }
    if (this.ball) this._modeSnapExtra(snap);
    if (this.baseKillsNow.length) snap.X = this.baseKillsNow;
    if (E.length) snap.E = E.map(e => e.length > 3 ? [e[0], Math.round(e[1] * 100), Math.round(e[2] * 100), e[3]] : [e[0], Math.round(e[1] * 100), Math.round(e[2] * 100)]);
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
    if (this.pve) this._pveSnapshot(snap, playerId);
    return snap;
  }

  // 每位玩家的代碼報告：bot = 電腦坦克，pilot = 由代碼駕駛的玩家坦克（純代碼對戰 / 電腦隊伍）
  // 需要每個玩家各自的快照（迷霧或有人隱形時）
  needsPerPlayerSnapshots() {
    return !this.codeOnly && (this.fog || (this.pve && this.pve.phase === 'draft') || this.mines.length > 0 || this.smokes.length > 0 || this.tanks.some(t => t.alive && t.cloak > 0 && !t.monster));   // 潛伏者對所有人都送（帶隱形旗標），不需要個別快照
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
installTerrain(Round);
installPve(Round);
require('./modes')(Round);
Round.TIMERS = TIMERS;
Round.SHOTS = SHOTS;

module.exports = { Round, mapSizeFor };
