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
    } else if (o === 'pve') {
      this.pveWave = 0;
      this.pveDelay = 2 * C.TICK_RATE;
    }
  };

  // 打怪模式：預先建立一批怪物坦克（一開始都還沒上場）
  P._createMonsterPool = function (side) {
    for (let i = 0; i < C.PVE_MAX_MONSTERS; i++) {
      this.tanks.push({
        id: this.nextTankId++, side: side.key, owner: 'monster', ownerName: '怪物', isBot: true,
        cls: 'monster', stats: C.MONSTER_CLASS, lives: 0, hp: 1,
        alive: false, x: 0, y: 0, dir: 'down', spawn: side.spawns[i % side.spawns.length],
        respawnTimer: 0, shield: 0, cooldown: 0, input: { move: null, fire: false },
        kills: 0, deaths: 0, baseKills: 0, sandbox: null, monster: true,
      });
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
      for (const t of this.tanks) {
        if (!t.alive) continue;
        for (const f of this.flags) {
          if (f.carrier) continue;
          if (Math.abs(t.x - f.x) > C.ITEM_PICKUP_RANGE || Math.abs(t.y - f.y) > C.ITEM_PICKUP_RANGE) continue;
          if (f.side === t.side) {
            if (!f.atHome) this._flagHome(f);                    // 撿回自己掉落的旗子
            else if (t.carrying) {                               // 帶著敵旗回到自己旗子旁：得分
              const enemy = this.flags.find(x => x.side === t.carrying);
              this.objScore[t.side]++;
              t.carrying = null;
              this._flagHome(enemy);
              this.events.push(['capture', t.x, t.y]);
              this.objEvents.push(['capture', t.id, enemy.side]);
            }
          } else if (!t.carrying) {                              // 搶走敵方旗子
            f.carrier = t.id; f.atHome = false;
            t.carrying = f.side;
            this.events.push(['pickup', f.x, f.y]);
            this.objEvents.push(['steal', t.id, f.side]);
          }
        }
      }
    } else if (o === 'pve') {
      const monsters = this.tanks.filter(t => t.monster);
      const remaining = monsters.filter(t => t.alive || t.lives > 0).length;
      if (remaining === 0 && this.pveWave < C.PVE_WAVES) {
        if (--this.pveDelay > 0) return;
        this.pveWave++;
        this.pveDelay = 3 * C.TICK_RATE;
        const n = Math.min(C.PVE_MAX_MONSTERS, 1 + this.pveWave * 2);
        if (this.pveWave > 1) {
          // 撐過一波：玩家坦克回 1 條命（最多 3 條）
          for (const t of this.tanks) if (t.side === 'players' && !t.isBot && t.lives > 0 && t.lives < C.PLAYER_LIVES) t.lives++;
        }
        monsters.slice(0, n).forEach((t, i) => {
          if (t.sandbox) t.sandbox.dispose();
          t.sandbox = new BotSandbox(DEFAULT_BOT, '怪物');
          t.lives = 1;
          t.respawnTimer = i * 8;     // 錯開出場
        });
        this.events.push(['waveStart', this.center, this.center]);
        this.objEvents.push(['wave', this.pveWave, n]);
      }
    }
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
    } else if (o === 'pve') {
      const players = this.sideByKey.get('players');
      if (players.eliminated || this._sideStrength(players) === 0) { players.eliminated = true; return { winner: null, reason: 'pveLose' }; }
      const left = this.tanks.filter(t => t.monster && (t.alive || t.lives > 0)).length;
      if (this.pveWave >= C.PVE_WAVES && left === 0) return { winner: players, reason: 'pveWin' };
      return false;
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
    if (o === 'pve') return { type: 'pve', wave: this.pveWave, waves: C.PVE_WAVES, left: this.tanks.filter(t => t.monster && (t.alive || t.lives > 0)).length };
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
    if (o === 'pve') return { type: 'pve', wave: this.pveWave, waves: C.PVE_WAVES, monstersLeft: this.tanks.filter(t => t.monster && (t.alive || t.lives > 0)).length };
    return { type: 'survival' };
  };
};
