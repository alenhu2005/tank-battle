'use strict';

// 遊戲目標（模式）：
//   survival 生存：打到剩最後一隊（原本的玩法）
//   koth     佔點：地圖中央的區域，只有一隊在裡面時累積時間，先到目標秒數獲勝
//   ctf      搶旗：把敵方的旗子帶回自己的旗子旁邊，先搶到指定次數獲勝
//   pve      打怪：所有玩家同一隊，撐過一波波的怪物坦克

const C = require('./constants');
const { BotSandbox } = require('./botRunner');
const DEFAULT_BOT = require('./defaultBot');

module.exports = function install(Round) {
  const P = Round.prototype;

  // 在建構子產生地圖、坦克之後呼叫
  P._initObjective = function () {
    const o = this.objective;
    if (o === 'koth') {
      const c = Math.floor(this.center);
      this.hill = { x: c + 0.5, y: c + 0.5, r: C.KOTH_RADIUS };
      // 中央 5×5 清空（基地與出生點都離中央很遠）
      for (let y = c - 2; y <= c + 2; y++) for (let x = c - 2; x <= c + 2; x++) {
        const i = y * this.size + x;
        if (this.tiles[i] !== 'B') this.tiles[i] = '.';
      }
      this.objScore = Object.fromEntries(this.sides.map(s => [s.key, 0]));
      this.hillHolder = null;
    } else if (o === 'ctf') {
      this.flags = this.sides.map(s => ({
        side: s.key, home: { x: s.anchor.x + 0.5, y: s.anchor.y + 0.5 },
        x: s.anchor.x + 0.5, y: s.anchor.y + 0.5, carrier: null, atHome: true, dropTimer: 0,
      }));
      this.objScore = Object.fromEntries(this.sides.map(s => [s.key, 0]));
    } else if (o === 'escort') {
      this._initEscort();
    }
  };

  P._updateObjective = function () {
    const o = this.objective;
    if (o === 'koth') {
      const inside = new Set();
      for (const t of this.tanks) {
        if (t.alive && Math.abs(t.x - this.hill.x) <= this.hill.r && Math.abs(t.y - this.hill.y) <= this.hill.r) inside.add(t.side);
      }
      if (inside.size === 1) {
        const k = [...inside][0];
        this.objScore[k]++;
        this.hillHolder = k;
      } else this.hillHolder = inside.size > 1 ? 'contested' : null;
    } else if (o === 'ctf') {
      for (const f of this.flags) {
        if (f.carrier) {
          const c = this.tankById.get(f.carrier);
          if (c && c.alive) { f.x = c.x; f.y = c.y; }
        } else if (!f.atHome && --f.dropTimer <= 0) this._flagHome(f);
      }
      const near = (t, x, y) => Math.abs(t.x - x) <= C.ITEM_PICKUP_RANGE && Math.abs(t.y - y) <= C.ITEM_PICKUP_RANGE;
      for (const t of this.tanks) {
        if (!t.alive) continue;
        // 帶著敵旗回到自己的旗座就得分：不需要自己的旗子在家（避免雙方互搶後誰都得不了分）
        if (t.carrying) {
          const own = this.flags.find(x => x.side === t.side);
          if (own && near(t, own.home.x, own.home.y)) {
            const enemy = this.flags.find(x => x.side === t.carrying);
            this.objScore[t.side]++;
            t.captures++;
            t.carrying = null;
            this._flagHome(enemy);
            this.events.push(['capture', t.x, t.y]);
            this.objEvents.push(['capture', t.id, enemy.side]);
          }
        }
        for (const f of this.flags) {
          if (f.carrier) continue;
          if (!near(t, f.x, f.y)) continue;
          if (f.side === t.side) {
            if (!f.atHome) this._flagHome(f);                    // 撿回自己掉落的旗子
          } else if (!t.carrying) {                              // 搶走敵方旗子
            f.carrier = t.id; f.atHome = false;
            t.carrying = f.side;
            this.events.push(['pickup', f.x, f.y]);
            this.objEvents.push(['steal', t.id, f.side]);
          }
        }
      }
    } else if (o === 'escort') {
      const c = this.cart, pos = this._cartPos();
      let att = 0, def = 0;
      for (const t of this.tanks) {
        if (!t.alive || Math.hypot(t.x - pos[0], t.y - pos[1]) > C.CART_RADIUS) continue;
        if (t.side === c.attacker) att++; else def++;
      }
      if (att && !def) { c.i = Math.min(c.end, c.i + C.CART_SPEED * (1 + 0.25 * (att - 1)) / C.TICK_RATE); c.state = 'push'; }
      else if (def && !att) { c.i = Math.max(c.start, c.i - C.CART_BACK_SPEED / C.TICK_RATE); c.state = 'back'; }
      else c.state = att && def ? 'contested' : 'idle';
    }
  };

  // 護送：從進攻方出生區到防守方出生區挖一條路，礦車沿著走
  P._initEscort = function () {
    const atk = this.sides[this.attackerIndex % this.sides.length], def = this.sides[(this.attackerIndex + 1) % this.sides.length];
    const S = this.size, a = atk.anchor, b = def.anchor;
    const cost = c => c === '.' || c === '*' ? 1 : c === '#' ? 3 : 8;   // 盡量走空地，不得已才穿過牆和水
    const dist = new Array(S * S).fill(Infinity), prev = new Array(S * S).fill(-1);
    const start = a.y * S + a.x, goal = b.y * S + b.x, buckets = [[start]];
    dist[start] = 0;
    for (let d = 0; d < buckets.length; d++) {
      for (const cur of buckets[d] || []) {
        if (dist[cur] !== d) continue;
        if (cur === goal) { buckets.length = 0; break; }
        const cx = cur % S, cy = (cur - cx) / S;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const id = ny * S + nx, nd = d + cost(this.tiles[id]);
          if (nd >= dist[id]) continue;
          dist[id] = nd; prev[id] = cur;
          (buckets[nd] = buckets[nd] || []).push(id);
        }
      }
    }
    const cells = [];
    for (let c = goal; c !== -1; c = prev[c]) cells.unshift(c);
    for (const c of cells) if (this.tiles[c] !== '.' && this.tiles[c] !== '*') { this.tiles[c] = '.'; this.wallHp.delete(c); }   // 把路挖通
    const path = cells.map(c => [c % S + 0.5, Math.floor(c / S) + 0.5]);
    this.cart = { path, attacker: atk.key, defender: def.key, start: 3, end: Math.max(4, path.length - 4), i: 3, state: 'idle' };
    if (!this.timeLimitTicks) this.timeLimitTicks = C.ESCORT_DEFAULT_TIME * C.TICK_RATE;
  };

  P._cartPos = function () {
    const c = this.cart, k = Math.min(c.path.length - 1, Math.floor(c.i)), f = c.i - k, p = c.path[k], q = c.path[Math.min(c.path.length - 1, k + 1)];
    return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
  };

  P._flagHome = function (f) {
    if (f.carrier) { const c = this.tankById.get(f.carrier); if (c) c.carrying = null; }
    f.carrier = null; f.atHome = true; f.x = f.home.x; f.y = f.home.y;
    this.events.push(['spawn', f.x, f.y]);
  };

  // 坦克死掉時：搶旗模式掉落旗子
  P._onTankDeath = function (t) {
    if (this.objective !== 'ctf' || !t.carrying) return;
    const f = this.flags.find(x => x.side === t.carrying);
    t.carrying = null;
    if (!f) return;
    f.carrier = null; f.atHome = false; f.x = t.x; f.y = t.y;
    f.dropTimer = C.FLAG_RETURN_TICKS;
  };

  // 回傳 { winner, reason } 表示分出勝負；回傳 null 交給一般的勝負判斷；回傳 false 表示還沒結束且不要用一般判斷
  P._objectiveEnd = function () {
    const o = this.objective;
    if (o === 'koth') {
      const w = this.sides.find(s => this.objScore[s.key] >= C.KOTH_TARGET_TICKS);
      if (w) return { winner: w, reason: 'koth' };
    } else if (o === 'ctf') {
      const w = this.sides.find(s => this.objScore[s.key] >= C.CTF_CAPTURES);
      if (w) return { winner: w, reason: 'ctf' };
    } else if (o === 'escort') {
      const c = this.cart;
      if (c.i >= c.end) return { winner: this.sideByKey.get(c.attacker), reason: 'escortWin' };
      if (this.timeLimitTicks && this.playTick >= this.timeLimitTicks) return { winner: this.sideByKey.get(c.defender), reason: 'escortDefend' };
      return false;
    } else if (o === 'pve') {
      return this._pveEnd();
    }
    return null;
  };

  // 時間到時的比較分數（佔點秒數、搶旗次數優先）
  P._objectiveScore = function (side) {
    return this.objScore ? this.objScore[side.key] || 0 : 0;
  };

  P.objectiveSnapshot = function () {
    const o = this.objective;
    if (o === 'koth') return { type: 'koth', hill: [this.hill.x, this.hill.y, this.hill.r], s: this.sides.map(s => [s.key, this.objScore[s.key]]), h: this.hillHolder, target: C.KOTH_TARGET_TICKS };
    if (o === 'ctf') return { type: 'ctf', f: this.flags.map(f => [f.side, Math.round(f.x * 100), Math.round(f.y * 100), f.carrier || 0, f.atHome ? 1 : 0]), s: this.sides.map(s => [s.key, this.objScore[s.key]]), target: C.CTF_CAPTURES };
    if (o === 'pve') return { type: 'pve', wave: this.pve.wave };
    if (o === 'escort') return { type: 'escort', att: this.cart.attacker, i: Math.round(this.cart.i * 100) / 100, start: this.cart.start, end: this.cart.end, st: this.cart.state };
    return null;
  };

  P.objectiveView = function (me) {
    const o = this.objective;
    if (o === 'koth') {
      const enemyBest = Math.max(0, ...this.sides.filter(s => s.key !== me.side).map(s => this.objScore[s.key]));
      return {
        type: 'koth', x: this.hill.x, y: this.hill.y, radius: this.hill.r, target: C.KOTH_TARGET_TICKS,
        myScore: this.objScore[me.side], bestEnemyScore: enemyBest,
        holder: this.hillHolder === me.side ? 'me' : this.hillHolder === 'contested' ? 'contested' : this.hillHolder ? 'enemy' : null,
      };
    }
    if (o === 'ctf') {
      return {
        type: 'ctf', target: C.CTF_CAPTURES,
        myCaptures: this.objScore[me.side],
        bestEnemyCaptures: Math.max(0, ...this.sides.filter(s => s.key !== me.side).map(s => this.objScore[s.key])),
        flags: this.flags.map(f => ({ x: f.x, y: f.y, homeX: f.home.x, homeY: f.home.y, ally: f.side === me.side, atHome: f.atHome, carrier: f.carrier })),
      };
    }
    if (o === 'escort') {
      const c = this.cart, pos = this._cartPos();
      return {
        type: 'escort', attacking: me.side === c.attacker, cart: { x: pos[0], y: pos[1] }, radius: C.CART_RADIUS,
        progress: Math.round((c.i - c.start) / (c.end - c.start) * 1000) / 1000, state: c.state,
        path: c.path.map(p => ({ x: p[0], y: p[1] })),
      };
    }
    return { type: 'survival' };
  };
};
