'use strict';

// 更多遊戲目標：
//   siege    攻城戰：防守方有加固城牆、砲台與城堡核心；進攻方時間內拆掉核心獲勝（每局交換攻守，限兩隊）
//   mkoth    移動佔點：佔點區每 30 秒換位置
//   crystals 晶礦收集：撿地上的晶礦帶回自家旗座得分；被擊殺會掉光身上的晶礦
//   soccer   坦克足球：用子彈或車身把球推進對方球門（限兩隊）
//   gungame  職業輪換：每擊殺一次換下一個職業，最先用完 7 個職業的人獲勝
//   tag      鬼抓人：鬼碰到或射到別人就換人當鬼；時間到時當鬼時間最短的隊伍獲勝（沒有傷害）
// 這些目標都是無限重生。

const C = require('./constants');

const T = C.TICK_RATE;
const MODE_KEYS = ['siege', 'mkoth', 'crystals', 'soccer', 'gungame', 'tag'];
const LADDER = ['assault', 'scout', 'heavy', 'demo', 'engineer', 'nurse', 'sniper'];
const angleTo = (a, b) => (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
const r2 = v => Math.round(v * 100) / 100;

module.exports = function install(Round) {
  const P = Round.prototype;

  P._modeHas = function (o = this.objective) { return MODE_KEYS.includes(o); };
  P._modeTime = function () { return this.timeLimitTicks; };
  P._combatants = function () { return this.tanks.filter(t => !t.structure && !t.monster && !t.npc); };
  P._setTileQuiet = function (x, y, ch) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = y * this.size + x;
    if (this.tiles[i] === 'B') return;
    this.tiles[i] = ch;
    if (ch !== '#') this.wallHp.delete(i);
  };

  // ---------- 建立 ----------
  P._modeInit = function () {
    const o = this.objective, S = this.size;
    this.objScore = Object.fromEntries(this.sides.map(s => [s.key, 0]));
    if (!this.timeLimitTicks) this.timeLimitTicks = (o === 'siege' ? C.SIEGE.defaultSeconds : C.MODE_DEFAULT_SECONDS) * T;
    if (o === 'siege') {
      const att = this.sides[this.attackerIndex % this.sides.length], def = this.sides[(this.attackerIndex + 1) % this.sides.length];
      const a = def.anchor;
      this.siege = { attacker: att.key, defender: def.key, turrets: [] };
      // 城堡：中心 9×9 清空，距離 4 的一圈加固磚牆（上下左右留城門），四個斜角放砲台
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = a.x + dx, y = a.y + dy, wall = Math.max(Math.abs(dx), Math.abs(dy)) === 4 && Math.abs(dx) > 1 && Math.abs(dy) > 1;   // 城門 3 格寬
        this._setTileQuiet(x, y, wall ? '#' : '.');
        if (wall && x >= 0 && y >= 0 && x < S && y < S) this.wallHp.set(y * S + x, C.BASE_WALL_HP);
      }
      const core = this._pveStructure('core', a.x + 0.5, a.y + 0.5, def, this.hpSystem ? C.SIEGE.coreHp : C.SIEGE.coreHits);
      this.siege.core = core.id;
      for (const [dx, dy] of [[-3, -3], [3, -3], [3, 3], [-3, 3]]) {
        const x = Math.min(S - 2, Math.max(1, a.x + dx)), y = Math.min(S - 2, Math.max(1, a.y + dy));
        const tu = this._pveStructure('sturret', x + 0.5, y + 0.5, def, this.hpSystem ? C.SIEGE.turretHp : C.SIEGE.turretHits);
        tu.size = 0.9;
        tu.stats = { speed: 0, cooldown: C.SIEGE.turretCooldown, bulletSpeed: C.SIEGE.turretBulletSpeed, maxBullets: 2, hp: 1, vision: 0 };
        this.siege.turrets.push(tu.id);
      }
    } else if (o === 'mkoth') {
      const c = Math.floor(this.center);
      this.hill = { x: c + 0.5, y: c + 0.5, r: C.KOTH_RADIUS };
      for (let y = c - 2; y <= c + 2; y++) for (let x = c - 2; x <= c + 2; x++) this._setTileQuiet(x, y, '.');
      this.hillHolder = null;
      this.hillMoveAt = C.MKOTH_MOVE_SECONDS * T;
    } else if (o === 'crystals') {
      this.crystals = [];
      this.nextCrystal = 1;
      this.crystalTimer = 2 * T;
      for (const t of this.tanks) t.crystals = 0;
    } else if (o === 'soccer') {
      // 球場：內部全部清空，四根鋼柱；兩隊的球門在各自出生區那一側的地圖邊緣
      const c = Math.floor(this.center);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) this._setTileQuiet(x, y, '.');
      for (const [dx, dy] of [[-5, -3], [5, -3], [-5, 3], [5, 3]]) this._setTileQuiet(c + dx, c + dy, '@');
      this.goals = this.sides.slice(0, 2).map(s => {
        const top = s.anchor.y < this.center;
        return { side: s.key, x0: c - 2.5, x1: c + 3.5, y0: top ? 0 : S - 1.5, y1: top ? 1.5 : S };
      });
      this.ball = { x: this.center + 0.5, y: this.center + 0.5, vx: 0, vy: 0, r: 0.35, frozen: 2 * T };
    } else if (o === 'gungame') {
      this.ladder = LADDER;
      for (const t of this._ggMains()) { t.ggLevel = 0; this._setClass(t, LADDER[0]); }
    } else if (o === 'tag') {
      const all = this._combatants();
      for (const t of all) t.itTicks = 0;
      const pick = all[Math.floor(Math.random() * all.length)];
      this.itId = pick ? pick.id : 0;
    }
    // 地形改過了：開局就卡在牆裡或疊在建築上的坦克移到附近空地
    for (const t of this._combatants()) {
      if (!t.alive) continue;
      const hit = this.tanks.some(o => o !== t && o.alive && o.structure && Math.abs(o.x - t.x) < ((o.size || C.TANK_SIZE) + (t.size || C.TANK_SIZE)) / 2 && Math.abs(o.y - t.y) < ((o.size || C.TANK_SIZE) + (t.size || C.TANK_SIZE)) / 2);
      if (hit || this._tileBlocked(t.x, t.y)) { const p = this._pveFreeCellNear(t.x, t.y); t.x = p.x; t.y = p.y; }
    }
  };

  // 職業輪換：每位玩家「主要」的那台坦克（純代碼對戰時是電腦）
  P._ggMains = function () { return this.tanks.filter(t => !t.structure && !t.monster && !t.npc && (this.codeOnly ? t.isBot : !t.isBot)); };

  P._setClass = function (t, cls) {
    t.cls = cls;
    t.stats = this.statsFor(cls, this._role(t));
    t.maxHp = this._maxHpFor(cls, t.isBot);
    t.hp = t.maxHp;
    t.skillCd = 0; t.charged = 0; t.dashTicks = 0;
  };

  // ---------- 每 tick ----------
  P._modeUpdate = function () {
    const o = this.objective;
    if (o === 'siege') this._siegeTurrets();
    else if (o === 'mkoth') this._mkothUpdate();
    else if (o === 'crystals') this._crystalsUpdate();
    else if (o === 'soccer') this._soccerUpdate();
    else if (o === 'tag') this._tagUpdate();
  };

  P._siegeTurrets = function () {
    for (const id of this.siege.turrets) {
      const tu = this.tankById.get(id);
      if (!tu || !tu.alive) continue;
      let best = null, bd = C.SIEGE.turretRange;
      for (const e of this.tanks) {
        if (!e.alive || e.side === tu.side || e.structure) continue;
        const d = Math.hypot(e.x - tu.x, e.y - tu.y);
        if (d < bd && this._pveLos(tu, e)) { bd = d; best = e; }
      }
      if (!best) continue;
      tu.angle = tu.aim = angleTo(tu, best);
      if (tu.cooldown === 0) this._fire(tu);
    }
  };

  P._mkothUpdate = function () {
    // 計分同一般佔點
    const inside = new Set();
    for (const t of this._combatants()) {
      if (t.alive && Math.abs(t.x - this.hill.x) <= this.hill.r && Math.abs(t.y - this.hill.y) <= this.hill.r) inside.add(t.side);
    }
    if (inside.size === 1) { const k = [...inside][0]; this.objScore[k]++; this.hillHolder = k; }
    else this.hillHolder = inside.size > 1 ? 'contested' : null;
    // 每 30 秒換位置
    if (this.playTick >= this.hillMoveAt) {
      this.hillMoveAt = this.playTick + C.MKOTH_MOVE_SECONDS * T;
      const S = this.size, old = this.hill;
      const ok = (x, y) => {
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = this.tiles[(y + dy) * S + x + dx]; if (c !== '.' && c !== '*') return false; }
        return true;
      };
      let spot = null;
      for (let tries = 0; tries < 300 && !spot; tries++) {
        const x = 2 + Math.floor(Math.random() * (S - 4)), y = 2 + Math.floor(Math.random() * (S - 4));
        if (Math.hypot(x + 0.5 - old.x, y + 0.5 - old.y) < 6) continue;
        if (this.sides.some(s => Math.max(Math.abs(s.anchor.x - x), Math.abs(s.anchor.y - y)) < 5)) continue;
        if (tries < 200 && !ok(x, y)) continue;
        spot = { x, y };
      }
      if (!spot) return;
      // 找不到乾淨的地方時，把新佔點範圍清空
      if (!ok(spot.x, spot.y)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const i = (spot.y + dy) * S + spot.x + dx;
        if (this.tiles[i] !== '.' && this.tiles[i] !== '*' && this.tiles[i] !== 'B') { this.wallHp.delete(i); this._setTile(i, '.'); }
      }
      this.hill = { x: spot.x + 0.5, y: spot.y + 0.5, r: C.KOTH_RADIUS };
      this.events.push(['capture', this.hill.x, this.hill.y]);
      this.objEvents.push(['hillMove', this.hill.x, this.hill.y]);
    }
  };

  P._crystalsUpdate = function () {
    const S = this.size, K = C.CRYSTALS;
    if (--this.crystalTimer <= 0) {
      this.crystalTimer = K.everySeconds * T;
      const total = this.crystals.reduce((a, c) => a + c.n, 0);
      if (total < K.maxOnMap) {
        for (let tries = 0; tries < 100; tries++) {
          const x = 1 + Math.floor(Math.random() * (S - 2)), y = 1 + Math.floor(Math.random() * (S - 2));
          if (this.tiles[y * S + x] !== '.') continue;
          if (this.sides.some(s => Math.max(Math.abs(s.anchor.x - x), Math.abs(s.anchor.y - y)) < 4)) continue;
          this.crystals.push({ id: this.nextCrystal++, x: x + 0.5, y: y + 0.5, n: 1 });
          this.events.push(['itemSpawn', x + 0.5, y + 0.5]);
          break;
        }
      }
    }
    for (const t of this._combatants()) {
      if (!t.alive) continue;
      // 撿起
      for (let i = this.crystals.length - 1; i >= 0; i--) {
        const c = this.crystals[i];
        if (t.crystals >= K.carryMax) break;
        if (Math.abs(t.x - c.x) < 0.6 && Math.abs(t.y - c.y) < 0.6) {
          const take = Math.min(c.n, K.carryMax - t.crystals);
          t.crystals += take; c.n -= take;
          if (c.n <= 0) this.crystals.splice(i, 1);
          this.events.push(['pickup', c.x, c.y]);
        }
      }
      // 帶回自家旗座
      const home = this.sideByKey.get(t.side).anchor;
      if (t.crystals > 0 && Math.hypot(t.x - home.x - 0.5, t.y - home.y - 0.5) < K.homeRadius) {
        this.objScore[t.side] += t.crystals;
        t.captures++;
        this.objEvents.push(['deposit', t.id, t.crystals]);
        this.events.push(['capture', t.x, t.y]);
        t.crystals = 0;
      }
    }
  };

  P._soccerUpdate = function () {
    const b = this.ball, S = this.size;
    if (b.frozen > 0) { b.frozen--; return; }
    // 車身推球
    for (const t of this._combatants()) {
      if (!t.alive) continue;
      const dx = b.x - t.x, dy = b.y - t.y, d = Math.hypot(dx, dy) || 0.01;
      const reach = (t.size || C.TANK_SIZE) / 2 + b.r + 0.02;
      if (d >= reach) continue;
      const nx = dx / d, ny = dy / d;
      const px = t.x + nx * reach, py = t.y + ny * reach;
      if (!this._ballSolid(px, py)) { b.x = px; b.y = py; }
      const kick = C.SOCCER.push + (t.input && t.input.move !== null ? t.stats.speed * 0.6 : 0);
      b.vx = nx * kick; b.vy = ny * kick;
    }
    // 移動與反彈（分三段，避免穿牆）
    const solid = (x, y) => this._ballSolid(x, y);
    for (let k = 0; k < 3; k++) {
      const nx = b.x + b.vx / T / 3, ny = b.y + b.vy / T / 3;
      if (solid(nx + Math.sign(b.vx) * b.r, b.y)) b.vx = -b.vx * 0.7; else b.x = nx;
      if (solid(b.x, ny + Math.sign(b.vy) * b.r)) b.vy = -b.vy * 0.7; else b.y = ny;
    }
    b.vx *= C.SOCCER.friction; b.vy *= C.SOCCER.friction;
    if (Math.hypot(b.vx, b.vy) < 0.05) b.vx = b.vy = 0;
    // 進球
    for (const g of this.goals) {
      if (b.x >= g.x0 && b.x <= g.x1 && b.y >= g.y0 && b.y <= g.y1) {
        const scorer = this.sides.find(s => s.key !== g.side);
        this.objScore[scorer.key]++;
        this.events.push(['baseBoom', b.x, b.y]);
        this.objEvents.push(['goal', scorer.key]);
        Object.assign(b, { x: this.center + 0.5, y: this.center + 0.5, vx: 0, vy: 0, frozen: 2 * T });
        break;
      }
    }
  };

  P._ballSolid = function (x, y) {
    const S = this.size, r = this.ball.r;
    return x < r || y < r || x > S - r || y > S - r || '#@~BO'.includes(this.tiles[Math.floor(y) * S + Math.floor(x)]);
  };

  // 子彈打到球：給球一個衝量（回傳 true 表示子彈被球擋下）
  P._ballHit = function (bl) {
    const b = this.ball;
    if (!b || Math.hypot(bl.x - b.x, bl.y - b.y) > b.r + 0.1) return false;
    b.vx += bl.vx * C.SOCCER.shot; b.vy += bl.vy * C.SOCCER.shot;
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > C.SOCCER.maxSpeed) { b.vx *= C.SOCCER.maxSpeed / sp; b.vy *= C.SOCCER.maxSpeed / sp; }
    b.frozen = 0;
    bl.dead = true;
    this.events.push(['spark', bl.x, bl.y]);
    return true;
  };

  P._tagUpdate = function () {
    const it = this.tankById.get(this.itId);
    if (!it) return;
    it.itTicks++;
    if (!it.alive) return;
    for (const o of this._combatants()) {
      if (o === it || !o.alive || o.side === it.side) continue;
      if (Math.hypot(o.x - it.x, o.y - it.y) < 0.95) { this._tagPass(it, o); break; }
    }
  };

  // 鬼換人：被換掉的人 2 秒內不會被新的鬼抓回去；新的鬼愣住 0.7 秒
  P._tagPass = function (from, to) {
    if (to.tagImmuneFrom === from.id && this.tick < to.tagImmuneUntil) return;
    this.itId = to.id;
    from.tagImmuneFrom = to.id; from.tagImmuneUntil = this.tick + 2 * T;
    to.frozen = Math.max(to.frozen || 0, Math.round(0.7 * T));
    this.events.push(['confuseHit', to.x, to.y]);
    this.objEvents.push(['tag', from.id, to.id]);
  };

  // 鬼抓人的子彈：鬼射到人就換人，其他人射到鬼會讓鬼減速 1 秒；沒有傷害
  P._tagShot = function (shooter, t) {
    if (!shooter) return;
    if (shooter.id === this.itId && t.side !== shooter.side) this._tagPass(shooter, t);
    else if (t.id === this.itId) t.slowTicks = Math.max(t.slowTicks || 0, T);
  };

  // ---------- 死亡 ----------
  P._modeDeath = function (t, shooter) {
    const o = this.objective;
    if (o === 'crystals' && t.crystals > 0) {
      this.crystals.push({ id: this.nextCrystal++, x: t.x, y: t.y, n: t.crystals });
      t.crystals = 0;
    }
    if (o === 'gungame' && shooter && shooter !== t && shooter.ggLevel !== undefined && shooter.side !== t.side && !this.ggWinner) {
      shooter.ggLevel++;
      this.objEvents.push(['level', shooter.id, shooter.ggLevel]);
      if (shooter.ggLevel >= LADDER.length) { this.ggWinner = shooter.side; return; }
      this._setClass(shooter, LADDER[shooter.ggLevel]);
      this.events.push(['skill', shooter.x, shooter.y]);
    }
  };

  // ---------- 勝負 ----------
  P._modeEnd = function () {
    const o = this.objective, timeUp = this.playTick >= this._modeTime();
    const best = (score, lowWins) => {
      const list = this.sides.map(s => [s, score(s)]).sort((a, b) => lowWins ? a[1] - b[1] : b[1] - a[1]);
      return list.length > 1 && list[0][1] === list[1][1] ? null : list[0][0];
    };
    if (o === 'siege') {
      const core = this.tankById.get(this.siege.core);
      if (!core.alive) return { winner: this.sideByKey.get(this.siege.attacker), reason: 'siegeWin' };
      if (timeUp) return { winner: this.sideByKey.get(this.siege.defender), reason: 'siegeHold' };
      return false;
    }
    if (o === 'mkoth') {
      const w = this.sides.find(s => this.objScore[s.key] >= C.KOTH_TARGET_TICKS);
      if (w) return { winner: w, reason: 'koth' };
    }
    if (o === 'crystals') {
      const w = this.sides.find(s => this.objScore[s.key] >= C.CRYSTALS.target);
      if (w) return { winner: w, reason: 'crystals' };
    }
    if (o === 'soccer') {
      const w = this.sides.find(s => this.objScore[s.key] >= C.SOCCER.target);
      if (w) return { winner: w, reason: 'soccer' };
    }
    if (o === 'gungame' && this.ggWinner) return { winner: this.sideByKey.get(this.ggWinner), reason: 'gungame' };
    if (!timeUp) return false;
    if (o === 'tag') {
      const sum = s => this._combatants().filter(t => t.side === s.key).reduce((a, t) => a + (t.itTicks || 0), 0);
      const w = best(sum, true);
      return { winner: w, reason: w ? 'tag' : 'timeDraw' };
    }
    if (o === 'gungame') {
      const lv = s => Math.max(0, ...this._ggMains().filter(t => t.side === s.key).map(t => t.ggLevel || 0));
      const w = best(lv);
      return { winner: w, reason: w ? 'time' : 'timeDraw' };
    }
    const w = best(s => this.objScore[s.key]);
    return { winner: w, reason: w ? 'time' : 'timeDraw' };
  };

  // ---------- 快照（給畫面）----------
  P._modeSnapshot = function () {
    const o = this.objective;
    const s = this.sides.map(x => [x.key, this.objScore[x.key]]);
    if (o === 'siege') {
      const core = this.tankById.get(this.siege.core);
      return { type: 'siege', att: this.siege.attacker, def: this.siege.defender, core: [core.hp, core.maxHp], tur: this.siege.turrets.filter(id => this.tankById.get(id).alive).length, left: Math.max(0, this._modeTime() - this.playTick) };
    }
    if (o === 'mkoth') return { type: 'koth', hill: [this.hill.x, this.hill.y, this.hill.r], s, h: this.hillHolder, target: C.KOTH_TARGET_TICKS, move: Math.max(0, this.hillMoveAt - this.playTick) };
    if (o === 'crystals') return { type: 'crystals', c: this.crystals.map(c => [c.id, Math.round(c.x * 100), Math.round(c.y * 100), c.n]), s, target: C.CRYSTALS.target, car: this._combatants().filter(t => t.crystals).map(t => [t.id, t.crystals]), home: C.CRYSTALS.homeRadius };
    if (o === 'soccer') return { type: 'soccer', s, target: C.SOCCER.target, goals: this.goals.map(g => [g.side, g.x0, g.y0, g.x1, g.y1]) };
    if (o === 'gungame') return { type: 'gungame', ladder: LADDER, lv: this._ggMains().map(t => [t.id, t.ggLevel || 0, t.maxHp]) };
    if (o === 'tag') return { type: 'tag', it: this.itId, t: this._combatants().map(t => [t.id, t.itTicks || 0]), left: Math.max(0, this._modeTime() - this.playTick) };
    return null;
  };

  // ---------- 給電腦代碼 ----------
  P._modeView = function (me) {
    const o = this.objective;
    const enemyBest = () => Math.max(0, ...this.sides.filter(s => s.key !== me.side).map(s => this.objScore[s.key]));
    const ticksLeft = Math.max(0, this._modeTime() - this.playTick);
    if (o === 'siege') {
      const core = this.tankById.get(this.siege.core);
      return {
        type: 'siege', attacking: me.side === this.siege.attacker, ticksLeft,
        core: { x: core.x, y: core.y, hp: core.hp, maxHp: core.maxHp, alive: core.alive },
        turrets: this.siege.turrets.map(id => this.tankById.get(id)).filter(t => t.alive).map(t => ({ x: t.x, y: t.y, hp: t.hp, maxHp: t.maxHp })),
      };
    }
    if (o === 'mkoth') {
      return {
        type: 'koth', moving: true, nextMoveIn: Math.max(0, this.hillMoveAt - this.playTick),
        x: this.hill.x, y: this.hill.y, radius: this.hill.r, target: C.KOTH_TARGET_TICKS,
        myScore: this.objScore[me.side], bestEnemyScore: enemyBest(),
        holder: this.hillHolder === me.side ? 'me' : this.hillHolder === 'contested' ? 'contested' : this.hillHolder ? 'enemy' : null,
      };
    }
    if (o === 'crystals') {
      const home = this.sideByKey.get(me.side).anchor;
      return {
        type: 'crystals', crystals: this.crystals.map(c => ({ x: c.x, y: c.y, n: c.n })), carrying: me.crystals || 0, carryMax: C.CRYSTALS.carryMax,
        home: { x: home.x + 0.5, y: home.y + 0.5, radius: C.CRYSTALS.homeRadius },
        carriers: this._combatants().filter(t => t.crystals && t.alive).map(t => ({ id: t.id, n: t.crystals, ally: t.side === me.side })),
        myScore: this.objScore[me.side], bestEnemyScore: enemyBest(), target: C.CRYSTALS.target, ticksLeft,
      };
    }
    if (o === 'soccer') {
      const mine = this.goals.find(g => g.side === me.side), theirs = this.goals.find(g => g.side !== me.side);
      const rect = g => g ? { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2 } : null;
      return {
        type: 'soccer', ball: { x: r2(this.ball.x), y: r2(this.ball.y), vx: r2(this.ball.vx), vy: r2(this.ball.vy), r: this.ball.r },
        myGoal: rect(mine), enemyGoal: rect(theirs), myScore: this.objScore[me.side], enemyScore: enemyBest(), target: C.SOCCER.target, ticksLeft,
      };
    }
    if (o === 'gungame') {
      const mains = this._ggMains();
      return { type: 'gungame', ladder: LADDER, myLevel: me.ggLevel ?? null, leaderLevel: Math.max(0, ...mains.map(t => t.ggLevel || 0)), levels: mains.map(t => ({ id: t.id, level: t.ggLevel || 0, ally: t.side === me.side })) };
    }
    if (o === 'tag') {
      return {
        type: 'tag', it: this.itId, iAmIt: me.id === this.itId, myTicks: me.itTicks || 0, ticksLeft,
        immuneFrom: me.tagImmuneFrom && this.tick < me.tagImmuneUntil ? me.tagImmuneFrom : null,
        times: this._combatants().map(t => ({ id: t.id, ticks: t.itTicks || 0, ally: t.side === me.side })),
      };
    }
    return null;
  };

  // 給客戶端：球每 tick 都要送（畫面平滑）
  P._modeSnapExtra = function (snap) {
    if (this.ball) snap.BL = [Math.round(this.ball.x * 100), Math.round(this.ball.y * 100)];
  };
};

module.exports.MODE_KEYS = MODE_KEYS;
module.exports.LADDER = LADDER;
