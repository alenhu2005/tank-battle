'use strict';

// 一局遊戲的模擬（伺服器說了算）。
// 「side」= 同一隊（彼此不會傷害）：
//   大亂鬥 ffa：每位玩家和他的電腦自成一隊
//   陣營戰 faction：red / blue 兩隊
//   組隊 team：玩家自選 1~6 號隊伍

const C = require('./constants');
const { generateMap } = require('./mapgen');
const { BotSandbox } = require('./botRunner');

const DIR_IDX = { up: 0, down: 1, left: 2, right: 3 };
const TANK_SOLID = new Set(['#', '@', '~', 'B']);
const HALF = C.TANK_SIZE / 2;
const BULLET_SUB = 8;

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
    this.timeLimitTicks = opts.timeLimit ? opts.timeLimit * C.TICK_RATE : 0;
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
          if (isBot || m.aiPilot) tank.sandbox = new BotSandbox(m.code, `${m.name}${isBot ? ' 電腦' : ''}`);
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
  }

  playerTank(playerId) { return this.tanks.find(t => t.owner === playerId && !t.isBot); }

  meta() {
    return {
      size: this.size,
      tiles: this.tiles.join(''),
      mode: this.mode, baseMode: this.baseMode, fog: this.fog && !this.codeOnly, breakableWalls: this.breakableWalls,
      codeOnly: this.codeOnly, timeLimitTicks: this.timeLimitTicks,
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
      if (t.input.move) this._move(t, t.input.move);
      if (t.input.fire) this._fire(t);
    }

    // 3. 子彈
    this._updateBullets();

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

  _tileBlocked(x, y) {
    const x0 = Math.floor(x - HALF + 1e-6), x1 = Math.floor(x + HALF - 1e-6);
    const y0 = Math.floor(y - HALF + 1e-6), y1 = Math.floor(y + HALF - 1e-6);
    if (x0 < 0 || y0 < 0 || x1 >= this.size || y1 >= this.size) return true;
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++)
        if (TANK_SOLID.has(this.tiles[ty * this.size + tx])) return true;
    return false;
  }

  _tankAt(x, y, self) {
    for (const o of this.tanks) {
      if (o === self || !o.alive) continue;
      if (Math.abs(o.x - x) < C.TANK_SIZE - 1e-6 && Math.abs(o.y - y) < C.TANK_SIZE - 1e-6) return o;
    }
    return null;
  }

  _blocked(t, x, y) {
    if (this._tileBlocked(x, y)) return true;
    // 已經重疊的坦克（例如剛重生）允許彼此分開，不允許新的重疊
    for (const o of this.tanks) {
      if (o === t || !o.alive) continue;
      const overlapNew = Math.abs(o.x - x) < C.TANK_SIZE - 1e-6 && Math.abs(o.y - y) < C.TANK_SIZE - 1e-6;
      if (!overlapNew) continue;
      const overlapOld = Math.abs(o.x - t.x) < C.TANK_SIZE - 1e-6 && Math.abs(o.y - t.y) < C.TANK_SIZE - 1e-6;
      if (!overlapOld) return true;
      const dOld = Math.abs(o.x - t.x) + Math.abs(o.y - t.y);
      const dNew = Math.abs(o.x - x) + Math.abs(o.y - y);
      if (dNew < dOld) return true;
    }
    return false;
  }

  _move(t, dir) {
    const [vx, vy] = C.DIR_VEC[dir];
    const turning = (vx !== 0) !== (C.DIR_VEC[t.dir][0] !== 0);
    t.dir = dir;
    if (turning) {
      // 轉向時另一軸對齊到格子中心
      if (vx !== 0) { const ny = Math.floor(t.y) + 0.5; if (!this._blocked(t, t.x, ny)) t.y = ny; }
      else { const nx = Math.floor(t.x) + 0.5; if (!this._blocked(t, nx, t.y)) t.x = nx; }
    }
    const step = t.stats.speed / C.TICK_RATE;
    const parts = 8;
    for (let i = 0; i < parts; i++) {
      const nx = t.x + (vx * step) / parts, ny = t.y + (vy * step) / parts;
      if (this._blocked(t, nx, ny)) break;
      t.x = nx; t.y = ny;
    }
    t.x = Math.round(t.x * 1e4) / 1e4;
    t.y = Math.round(t.y * 1e4) / 1e4;
  }

  _ownBullets(t) {
    let n = 0;
    for (const b of this.bullets) if (b.owner === t.id) n++;
    return n;
  }

  _fire(t) {
    if (t.cooldown > 0 || this._ownBullets(t) >= t.stats.maxBullets) return;
    const [vx, vy] = C.DIR_VEC[t.dir];
    this.bullets.push({
      id: this.nextBulletId++, owner: t.id, side: t.side, dir: t.dir,
      x: t.x + vx * HALF, y: t.y + vy * HALF,
      speed: t.stats.bulletSpeed, pierce: !!t.stats.pierce, blast: !!t.stats.blast,
    });
    t.cooldown = t.stats.cooldown;
  }

  _updateBullets() {
    for (let s = 0; s < BULLET_SUB; s++) {
      for (const b of this.bullets) {
        if (b.dead) continue;
        const [vx, vy] = C.DIR_VEC[b.dir];
        const step = b.speed / C.TICK_RATE / BULLET_SUB;
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

  _bulletHitWorld(b) {
    const tx = Math.floor(b.x), ty = Math.floor(b.y);
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
      if (Math.abs(t.x - x) <= C.BLAST_RADIUS && Math.abs(t.y - y) <= C.BLAST_RADIUS) this._damage(t, shooter, x, y);
    }
  }

  _bulletHitTank(b) {
    for (const t of this.tanks) {
      if (!t.alive || t.side === b.side) continue; // 沒有友軍傷害：子彈穿過隊友
      if (Math.abs(t.x - b.x) < HALF + 0.08 && Math.abs(t.y - b.y) < HALF + 0.08) {
        b.dead = true;
        this._damage(t, this.tankById.get(b.owner), b.x, b.y);
        if (b.blast) this._blast(b, b.x, b.y, t);
        return;
      }
    }
  }

  _damage(t, shooter, x, y) {
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
  }

  _destroyBase(side, b) {
    side.base.alive = false;
    const idx = side.base.y * this.size + side.base.x;
    this.tiles[idx] = '.';
    this.tileChanges.push([idx, '.']);
    this.events.push(['baseBoom', side.base.x + 0.5, side.base.y + 0.5]);
    const shooter = this.tankById.get(b.owner);
    if (shooter) shooter.baseKills++;
    this._eliminate(side);
  }

  _eliminate(side) {
    side.eliminated = true;
    for (const t of this.tanks) {
      if (t.side !== side.key) continue;
      if (t.alive) { t.alive = false; t.deaths++; this.events.push(['boom', t.x, t.y]); }
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
    } else if (this.timeLimitTicks && this.tick >= this.timeLimitTicks) {
      // 時間到：剩餘命數多的獲勝，再比擊殺數
      const score = s => this._sideStrength(s) * 1000 + this.tanks.filter(t => t.side === s.key).reduce((a, t) => a + t.kills, 0);
      const sorted = alive.slice().sort((a, b) => score(b) - score(a));
      winner = score(sorted[0]) > score(sorted[1]) ? sorted[0] : null;
      reason = winner ? 'time' : 'timeDraw';
    } else return;

    this.result = {
      winner: winner ? winner.key : null,
      reason,
      ticks: this.tick,
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
    return { id: t.id, x: t.x, y: t.y, dir: t.dir, isBot: t.isBot, owner: t.owner, cls: t.cls, lives: t.lives, hp: t.hp, shield: t.shield };
  }

  _viewFor(me) {
    const allies = [], enemies = [];
    for (const t of this.tanks) {
      if (!t.alive || t === me) continue;
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
      tick: this.tick,
      ticksLeft: this.timeLimitTicks ? Math.max(0, this.timeLimitTicks - this.tick) : null,
      me: {
        ...this._tankView(me),
        cooldown: me.cooldown,
        canFire: me.cooldown === 0 && this._ownBullets(me) < me.stats.maxBullets,
      },
      allies,
      enemies,
      bullets: this.bullets.map(b => ({ x: b.x, y: b.y, dir: b.dir, speed: b.speed, ally: b.side === me.side, pierce: b.pierce, blast: b.blast })),
      bases: this.baseMode ? this.sides.map(s => ({ x: s.base.x + 0.5, y: s.base.y + 0.5, ally: s.key === me.side, alive: s.base.alive })) : [],
      map: { width: this.size, height: this.size, tiles: this._rows() },
      rules: {
        tickRate: C.TICK_RATE, tankSize: C.TANK_SIZE, blastRadius: C.BLAST_RADIUS,
        mode: this.mode, baseMode: this.baseMode, fog: this.fog, breakableWalls: this.breakableWalls,
        codeOnly: this.codeOnly, classes: this.classTable,
      },
    };
    return JSON.stringify(view);
  }

  // ---------- 給畫面的快照 ----------

  snapshotFor(playerId) {
    // 迷霧模式：玩家只看得到自己周圍的敵人與敵方子彈；隊友永遠看得到
    let vis = null;
    if (this.fog && !this.codeOnly && playerId) {
      const me = this.playerTank(playerId);
      if (me) {
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
      T.push([t.id, Math.round(t.x * 100), Math.round(t.y * 100), DIR_IDX[t.dir], t.shield > 0 ? 1 : 0, t.hp]);
    }
    const B = [];
    for (const b of this.bullets) {
      if (vis && b.side !== vis.side && !vis.see(b.x, b.y)) continue;
      B.push([b.id, Math.round(b.x * 100), Math.round(b.y * 100), DIR_IDX[b.dir], b.blast ? 2 : b.pierce ? 1 : 0]);
    }
    const E = vis ? this.events.filter(e => vis.see(e[1], e[2]) || e[0] === 'baseBoom') : this.events;
    const snap = { t: 's', k: this.tick, T, B };
    if (E.length) snap.E = E.map(e => [e[0], Math.round(e[1] * 100), Math.round(e[2] * 100)]);
    if (this.tileChanges.length) snap.M = this.tileChanges;
    if (this.tick % 10 === 1 || this.events.length) {
      snap.L = this.tanks.map(t => [t.id, t.lives, t.alive ? 1 : 0]);
      snap.S = this.sides.map(s => [s.key, s.eliminated ? 1 : 0, s.base ? (s.base.alive ? 1 : 0) : -1]);
    }
    return snap;
  }

  // 每位玩家的代碼報告：bot = 電腦坦克，pilot = 由代碼駕駛的玩家坦克（純代碼對戰 / 電腦隊伍）
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
