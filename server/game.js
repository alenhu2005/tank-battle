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

function mapSizeFor(mode, sideCount, playerCount) {
  if (mode === 'ffa') return [21, 21, 21, 25, 27, 29, 31][sideCount] || 31;
  return Math.min(33, Math.max(21, 19 + 2 * playerCount, [21, 21, 21, 25, 27, 29, 31][sideCount] || 31));
}

function classStats(cls) {
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
    this.itemInterval = opts.itemInterval ? opts.itemInterval * C.TICK_RATE : C.ITEM_INTERVAL;
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

    const sides = opts.sides;
    const playerCount = sides.reduce((n, s) => n + s.members.length, 0);
    const size = opts.size || mapSizeFor(this.mode, sides.length, playerCount);
    const map = generateMap({
      anchors: sides.length,
      spawnsPerAnchor: sides.map(s => s.members.length * (opts.codeOnly ? 1 : 2)),
      size,
      baseMode: this.baseMode,
      breakableWalls: this.breakableWalls,
      style: opts.mapStyle,
      custom: opts.customMap || null,
    });
    this.size = size;
    this.tiles = map.tiles;
    this.center = (size - 1) / 2;

    this.sides = sides.map((s, i) => ({
      key: s.key, name: s.name, color: s.color,
      anchor: map.anchors[i],
      spawns: map.spawns[i],
      base: this.baseMode ? { x: map.anchors[i].x, y: map.anchors[i].y, alive: true } : null,
      eliminated: false,
    }));
    this.sideByKey = new Map(this.sides.map(s => [s.key, s]));

    this.tanks = [];
    let id = 1;
    sides.forEach((s, si) => {
      let slot = 0;
      for (const m of s.members) {
        // 純代碼對戰：每位玩家只派出一台電腦坦克
        for (const isBot of (this.codeOnly ? [true] : [false, true])) {
          const cls = isBot ? 'bot' : (C.CLASSES[m.cls] ? m.cls : 'assault');
          const stats = classStats(cls);
          const tank = {
            id: id++, side: s.key, owner: m.playerId, ownerName: m.name, isBot, cls, stats,
            lives: isBot ? C.BOT_LIVES : C.PLAYER_LIVES, hp: stats.hp,
            alive: false, x: 0, y: 0, dir: 'up',
            spawn: this.sides[si].spawns[slot++ % this.sides[si].spawns.length],
            respawnTimer: 0, shield: 0, cooldown: 0,
            input: { move: null, fire: false },
            kills: 0, deaths: 0, baseKills: 0,
            sandbox: null,
          };
          if (isBot || m.aiPilot) tank.sandbox = new BotSandbox(isBot ? m.code : (m.pilotCode || m.code), `${m.name}${isBot ? ' 電腦' : ''}`);
          this.tanks.push(tank);
        }
      }
    });
    this.tankById = new Map(this.tanks.map(t => [t.id, t]));
    for (const t of this.tanks) this._spawn(t, true);
    this.rowsCache = null;
  }

  // ---------- 對外介面 ----------

  setInput(playerId, input) {
    const t = this.playerTank(playerId);
    if (!t || t.sandbox) return;
    t.input = { move: C.DIRS.includes(input.move) ? input.move : null, fire: !!input.fire };
    if (Number.isInteger(input.seq)) t.inputSeq = input.seq;   // 手機預測用：回報處理到第幾個輸入
  }

  get playTick() { return Math.max(0, this.tick - this.startTicks); }

  playerTank(playerId) { return this.tanks.find(t => t.owner === playerId && !t.isBot); }

  meta() {
    return {
      size: this.size,
      tiles: this.tiles.join(''),
      mode: this.mode, baseMode: this.baseMode, fog: this.fog && !this.codeOnly, breakableWalls: this.breakableWalls,
      codeOnly: this.codeOnly, timeLimitTicks: this.timeLimitTicks, startTicks: this.startTicks, blastRadius: C.BLAST_RADIUS,
      ricochet: this.ricochet, items: this.itemsOn, itemTypes: C.ITEM_TYPES,
      alignRate: C.ALIGN_RATE, speedBuff: C.SPEED_BUFF, bulletBounces: C.BULLET_BOUNCES, bounceBuff: C.BOUNCE_BUFF,
      tickRate: C.TICK_RATE, tankSize: C.TANK_SIZE,
      sides: this.sides.map(s => ({ key: s.key, name: s.name, color: s.color, base: s.base ? { x: s.base.x, y: s.base.y } : null, anchor: s.anchor })),
      tanks: this.tanks.map(t => ({
        id: t.id, side: t.side, owner: t.owner, name: t.ownerName, isBot: t.isBot, cls: t.cls,
        maxLives: t.isBot ? C.BOT_LIVES : C.PLAYER_LIVES, maxHp: t.stats.hp, vision: t.stats.vision,
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
      let mv = t.input.move;
      if (mv && t.confused > 0) mv = OPPOSITE[mv];     // 混亂：方向顛倒
      if (mv) this._move(t, mv);
      if (t.input.fire) this._fire(t);
    }
    for (const t of this.tanks) if (!t.isBot) t.ackSeq = t.inputSeq || 0;

    // 3. 子彈
    this._updateBullets();

    // 3.5 場地道具
    if (this.itemsOn) this._updateItems();

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
      t.dir = Math.abs(p.y - this.center) >= Math.abs(p.x - this.center)
        ? (p.y < this.center ? 'down' : 'up')
        : (p.x < this.center ? 'right' : 'left');
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
    const step = t.stats.speed * (t.speedBuff > 0 ? C.SPEED_BUFF : 1) / C.TICK_RATE;
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
    const speed = t.stats.bulletSpeed * (t.swiftBuff > 0 ? C.SWIFT_BULLET : 1);
    const bounces = Math.max(this.ricochet ? C.BULLET_BOUNCES : 0, t.bounceBuff > 0 ? C.BOUNCE_BUFF : 0);
    const dirs = t.spreadBuff > 0 ? [t.dir, ...NEIGHBORS[t.dir]] : [t.dir];
    this.events.push(['shot', t.x, t.y]);   // 給手機播音效
    dirs.forEach((d, i) => {
      const [vx, vy] = C.DIR_VEC[d]; // 從砲口（斜向時為車身角落）射出
      this.bullets.push({
        id: this.nextBulletId++, owner: t.id, side: t.side, dir: d,
        x: t.x + vx * HALF, y: t.y + vy * HALF,
        speed, pierce, blast, freeze, confuse, bounces, extra: i > 0,
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
        if (!t.isBot && t.lives < C.PLAYER_LIVES) t.lives++;
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
        const [vx, vy] = UNIT[b.dir];
        const step = b.speed / C.TICK_RATE / BULLET_SUB;
        b.px = b.x; b.py = b.y;
        b.x += vx * step; b.y += vy * step;
        this._bulletHitWorld(b);
        if (!b.dead) this._bulletHitTank(b);
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
    let [vx, vy] = C.DIR_VEC[b.dir];
    const xHit = this._stopsBullet(b.x, b.py), yHit = this._stopsBullet(b.px, b.y);
    if (vx && vy) {
      if (xHit && !yHit) vx = -vx;
      else if (yHit && !xHit) vy = -vy;
      else { vx = -vx; vy = -vy; }
    } else { vx = -vx; vy = -vy; }
    b.x = b.px; b.y = b.py;
    b.dir = C.DIRS.find(d => C.DIR_VEC[d][0] === vx && C.DIR_VEC[d][1] === vy);
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
      if (this.breakableWalls) this._breakTile(tx, ty);
      if (b.blast) this._blast(b, tx + 0.5, ty + 0.5, null);
      else this.events.push([this.breakableWalls ? 'brick' : 'spark', tx + 0.5, ty + 0.5]);
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

  _breakTile(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.size || ty >= this.size) return;
    const idx = ty * this.size + tx;
    if (this.tiles[idx] !== '#') return;
    this.tiles[idx] = '.';
    this.tileChanges.push([idx, '.']);
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

  _bulletHitTank(b) {
    for (const t of this.tanks) {
      if (!t.alive || t.side === b.side) continue; // 沒有友軍傷害：子彈穿過隊友
      if (Math.abs(t.x - b.x) < HALF + C.HIT_MARGIN && Math.abs(t.y - b.y) < HALF + C.HIT_MARGIN) {
        b.dead = true;
        if (b.freeze || b.confuse) {   // 冰凍彈、混亂彈：不扣命，只上狀態
          if (t.shield > 0) { this.events.push(['spark', b.x, b.y]); return; }
          if (b.freeze) t.frozen = Math.max(t.frozen || 0, C.FREEZE_HIT_TICKS);
          else t.confused = Math.max(t.confused || 0, C.CONFUSE_TICKS);
          this.events.push([b.freeze ? 'freezeHit' : 'confuseHit', t.x, t.y]);
          return;
        }
        this._damage(t, this.tankById.get(b.owner), b.x, b.y, 'shot');
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
    t.alive = false;
    t.lives = Math.max(0, t.lives - 1);
    t.deaths++;
    t.respawnTimer = C.RESPAWN_DELAY;
    t.input = { move: null, fire: false };
    this.events.push(['boom', t.x, t.y]);
    this.kills.push([t.id, shooter ? shooter.id : 0, cause]);
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
      }
      t.lives = 0;
    }
  }

  _sideStrength(side) {
    let n = 0;
    for (const t of this.tanks) if (t.side === side.key) n += t.lives;
    return n;
  }

  _checkEnd() {
    if (this.endTimer >= 0) {
      if (--this.endTimer <= 0) this.over = true;
      return;
    }
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
      const score = s => this._sideStrength(s) * 1000 + this.tanks.filter(t => t.side === s.key).reduce((a, t) => a + t.kills, 0);
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
  }

  _finish(winner, reason) {
    this.result = {
      winner: winner ? winner.key : null,
      reason,
      ticks: this.playTick,
      tanks: this.tanks.map(t => ({
        id: t.id, side: t.side, owner: t.owner, name: t.ownerName, isBot: t.isBot, cls: t.cls,
        kills: t.kills, deaths: t.deaths, lives: t.lives, baseKills: t.baseKills,
      })),
    };
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
      id: t.id, x: t.x, y: t.y, dir: t.dir, isBot: t.isBot, owner: t.owner, cls: t.cls, lives: t.lives, hp: t.hp, shield: t.shield,
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
      if (t.side !== me.side && t.cloak > 0) continue;     // 隱形中的敵人看不到
      (t.side === me.side ? allies : enemies).push(this._tankView(t));
    }
    if (!this.classTable) {
      this.classTable = { bot: C.BOT_CLASS };
      for (const k in C.CLASSES) {
        const c = C.CLASSES[k];
        this.classTable[k] = { speed: c.speed, cooldown: c.cooldown, bulletSpeed: c.bulletSpeed, maxBullets: c.maxBullets, hp: c.hp, pierce: !!c.pierce, blast: !!c.blast };
      }
      this.classTable.bot = { speed: C.BOT_CLASS.speed, cooldown: C.BOT_CLASS.cooldown, bulletSpeed: C.BOT_CLASS.bulletSpeed, maxBullets: C.BOT_CLASS.maxBullets, hp: C.BOT_CLASS.hp, pierce: false, blast: false };
    }
    const view = {
      tick: this.playTick,
      ticksLeft: this.timeLimitTicks ? Math.max(0, this.timeLimitTicks - this.playTick) : null,
      me: {
        ...this._tankView(me),
        cooldown: me.cooldown,
        canFire: me.cooldown === 0 && this._ownBullets(me) < this._maxBullets(me),
      },
      allies,
      enemies,
      bullets: this.bullets.map(b => ({ x: b.x, y: b.y, dir: b.dir, speed: b.speed, ally: b.side === me.side, blast: b.blast, pierce: b.pierce, freeze: b.freeze, confuse: b.confuse, bounces: b.bounces })),
      items: this.items.map(it => ({ x: it.x, y: it.y, type: C.ITEM_TYPES[it.type].key, ticksLeft: it.until - this.playTick })),
      bases: this.baseMode ? this.sides.map(s => ({ x: s.base.x + 0.5, y: s.base.y + 0.5, ally: s.key === me.side, alive: s.base.alive })) : [],
      map: { width: this.size, height: this.size, tiles: this._rows() },
      rules: {
        tickRate: C.TICK_RATE, tankSize: C.TANK_SIZE, blastRadius: C.BLAST_RADIUS,
        mode: this.mode, baseMode: this.baseMode, fog: this.fog, breakableWalls: this.breakableWalls,
        codeOnly: this.codeOnly, classes: this.classTable,
        ricochet: this.ricochet, bulletBounces: C.BULLET_BOUNCES, items: this.itemsOn,
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
      if (t.cloak > 0 && viewerSide && t.side !== viewerSide) continue;    // 隱形
      const buffs = (t.speedBuff > 0 ? 1 : 0) | (t.rapidBuff > 0 ? 2 : 0)
        | (t.blastShots > 0 || t.pierceShots > 0 || t.freezeShots > 0 || t.confuseShots > 0 ? 4 : 0)
        | (t.cloak > 0 ? 8 : 0) | (t.radar > 0 ? 16 : 0) | (t.frozen > 0 ? 32 : 0) | (t.confused > 0 ? 64 : 0)
        | (t.phase > 0 ? 128 : 0) | (t.spreadBuff > 0 ? 256 : 0) | (t.bounceBuff > 0 ? 512 : 0) | (t.swiftBuff > 0 ? 1024 : 0);
      T.push([t.id, Math.round(t.x * 100), Math.round(t.y * 100), DIR_IDX[t.dir], t.shield > 0 ? 1 : 0, t.hp, buffs, t.ackSeq || 0]);
    }
    const B = [];
    for (const b of this.bullets) {
      if (vis && b.side !== vis.side && !vis.see(b.x, b.y)) continue;
      B.push([b.id, Math.round(b.x * 100), Math.round(b.y * 100), DIR_IDX[b.dir], b.freeze ? 3 : b.confuse ? 4 : b.blast ? 2 : b.pierce ? 1 : 0]);
    }
    const E = vis ? this.events.filter(e => vis.see(e[1], e[2]) || e[0] === 'baseBoom') : this.events;
    const snap = { t: 's', k: this.tick, T, B };
    if (this.tick <= this.startTicks) snap.c = this.startTicks - this.tick;
    if (this.kills.length) snap.K = this.kills;
    if (this.baseKillsNow.length) snap.X = this.baseKillsNow;
    if (E.length) snap.E = E.map(e => [e[0], Math.round(e[1] * 100), Math.round(e[2] * 100)]);
    if (this.tileChanges.length) snap.M = this.tileChanges;
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
    return snap;
  }

  // 每位玩家的代碼報告：bot = 電腦坦克，pilot = 由代碼駕駛的玩家坦克（純代碼對戰 / 電腦隊伍）
  // 需要每個玩家各自的快照（迷霧或有人隱形時）
  needsPerPlayerSnapshots() {
    return !this.codeOnly && (this.fog || this.tanks.some(t => t.alive && t.cloak > 0));
  }

  botReports() {
    const out = {};
    for (const t of this.tanks) {
      if (!t.sandbox) continue;
      out[t.owner] = out[t.owner] || {};
      out[t.owner][t.isBot ? 'bot' : 'pilot'] = t.sandbox.report();
    }
    return out;
  }

  dispose() {
    for (const t of this.tanks) if (t.sandbox) t.sandbox.dispose();
  }
}

module.exports = { Round, mapSizeFor };
