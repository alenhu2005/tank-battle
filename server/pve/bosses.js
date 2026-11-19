'use strict';

// Boss：每隻一個狀態機。招式出手前都有預警區（_pveHazard），躲得掉才公平。
//   鋼鐵堡壘 fortress：四座砲塔（可個別擊毀）→ 旋轉掃射＋召喚 → 衝撞
//   毒霧女王 queen：飛行、毒霧 → 分身 → 全場毒霧只剩移動的安全島
//   雷霆列車 train：沿軌道繞行，只有車頭會受傷，路口丟炸彈，每圈撞核心
//   機械巨像 colossus：雷射（重裝與牆可擋）、砲台 → 地圖崩塌 → 核心週期性開放

const C = require('../constants');
const Physics = require('../../public/physics');
const D = require('./data');

const T = C.TICK_RATE;
const angleTo = (a, b) => (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const vec = a => { const r = a * Math.PI / 180; return [Math.sin(r), -Math.cos(r)]; };

module.exports = function install(Round) {
  const P = Round.prototype;

  // 不佔「同時子彈」數量的子彈（Boss 招式用）
  P._pveBullet = function (owner, x, y, angle, speed, dmg, extra = {}) {
    const [vx, vy] = vec(angle);
    this.bullets.push({
      id: this.nextBulletId++, owner: owner.id, side: owner.side, angle, dir: Physics.dirOf(angle), vx, vy, x, y,
      speed: speed * this.pve.diff.bulletSpeed, pierce: false, blast: false, freeze: false, confuse: false, bounces: 0, extra: true,
      lag: 0, born: this.tick, ox: x, oy: y, pierceTanks: 0, dmg, snipe: 0, ...extra,
    });
  };

  P._pvePlayers = function () { return this.tanks.filter(t => t.alive && t.side === 'players' && !t.structure); };

  P._pveSpawnBoss = function (kind, mult = 1) {
    const p = this.pve, c = this.center + 0.5;
    p.bossKind = kind;
    let boss = null;
    if (kind === 'fortress') {
      // 砲塔先建立（排在坦克陣列前面，子彈先判定打到砲塔）
      const turrets = [];
      for (const [dx, dy] of [[-1.7, -1.7], [1.7, -1.7], [1.7, 1.7], [-1.7, 1.7]]) {
        const t = this._pveSpawn('fturret', c + dx, c + dy, { noElite: true, shield: 30, bossMult: mult });
        if (t) { t.reserved = true; t.ai.off = [dx, dy]; turrets.push(t); }
      }
      boss = this._pveSpawn('fortress', c, c, { noElite: true, shield: 30, bossMult: mult });
      for (const t of turrets) t.ai.parent = boss.id;
      boss.ai.turrets = turrets.map(t => t.id);
    } else if (kind === 'queen') {
      boss = this._pveSpawn('queen', c, c - 3, { noElite: true, shield: 30, noCollide: true, bossMult: mult });
    } else if (kind === 'train') {
      const track = p.track;
      boss = this._pveSpawn('train', track[0][0], track[0][1], { noElite: true, shield: 0, noCollide: true, bossMult: mult });
      boss.ai.pos = 0; boss.ai.cars = [];
      for (let i = 1; i <= 5; i++) {
        const k = (track.length - i * 1.4 + track.length) % track.length;
        const car = this._pveSpawn('tcar', track[Math.floor(k)][0], track[Math.floor(k)][1], { noElite: true, shield: 0, noCollide: true });
        if (car) { car.reserved = true; car.ai.parent = boss.id; car.ai.idx = i; boss.ai.cars.push(car.id); }
      }
    } else if (kind === 'colossus') {
      boss = this._pveSpawn('colossus', c, c, { noElite: true, shield: 30, bossMult: mult });
      boss.dmgTaken = 0.3;
    }
    if (!boss) return;
    boss.reserved = true;
    boss.ai.phase = 1;
    boss.ai.start = this.tick;
    p.bossId = boss.id;
    p.stateChanged = true;
    this.objEvents.push(['bossIntro', kind, boss.x, boss.y]);
  };

  P._pveBossPhase = function (t, thresholds) {
    const r = t.hp / t.maxHp;
    let ph = 1;
    thresholds.forEach((th, i) => { if (r <= th) ph = i + 2; });
    if (ph !== t.ai.phase) {
      t.ai.phase = ph;
      this.pve.stateChanged = true;
      this.objEvents.push(['bossPhase', t.kind, ph]);
      this.events.push(['baseBoom', t.x, t.y]);
      return true;
    }
    return false;
  };

  P._pveBossThink = function (t) {
    const fn = this['_boss_' + t.kind];
    if (fn) fn.call(this, t);
  };

  // 附屬單位（堡壘砲塔、女王分身、列車車廂）
  P._pvePartThink = function (t) {
    const parent = t.ai.parent && this.tankById.get(t.ai.parent);
    if (t.kind === 'fturret') {
      if (!parent || !parent.alive) return;
      t.x = parent.x + t.ai.off[0]; t.y = parent.y + t.ai.off[1];
      const target = this._pveTarget(t);
      if (!target || dist(t, target) > 13) return;
      t.angle = this._pveAim(t, target);
      t.input.fire = t.cooldown === 0 && parent.ai.phase < 3;
    } else if (t.kind === 'qclone') {
      if (this.tick - t.ai.born > 12 * T) { this._damage(t, null, t.x, t.y, 'self', 1e9); return; }
      this._pveFly(t, t.ai);
      const target = this._pveTarget(t);
      if (target && this.tick % 60 === t.ai.born % 60) this._pveBullet(t, t.x, t.y, angleTo(t, target), 5, t.pveDmg);
    }
    // 車廂由車頭帶著走（見 _boss_train）
  };

  // 飛行移動：直接改座標，不受地形阻擋
  P._pveFly = function (t, a) {
    const S = this.size, c = this.center + 0.5;
    if (!a.wp || dist(t, a.wp) < 0.5 || this.tick > (a.wpUntil || 0)) {
      a.wp = { x: c + (Math.random() * 2 - 1) * Math.min(7, S / 2 - 3), y: c + (Math.random() * 2 - 1) * Math.min(7, S / 2 - 3) };
      a.wpUntil = this.tick + 4 * T;
    }
    const sp = (t.stats.speed || 2) / T, d = dist(t, a.wp);
    if (d > 0.01) { t.x += (a.wp.x - t.x) / d * Math.min(sp, d); t.y += (a.wp.y - t.y) / d * Math.min(sp, d); }
    t.angle = angleTo(t, a.wp);
  };

  // ---------- 鋼鐵堡壘 ----------
  P._boss_fortress = function (t) {
    const a = t.ai;
    this._pveBossPhase(t, [0.6, 0.25]);
    const players = this._pvePlayers();
    if (!players.length) return;
    // 第 2 階段起：本體旋轉掃射＋召喚
    if (a.phase >= 2 && !a.dash && !a.prep && this.tick % 7 === 0) {
      a.sweep = ((a.sweep || 0) + 23) % 360;
      for (const off of [0, 180]) this._pveBullet(t, t.x, t.y, (a.sweep + off) % 360, 5, Math.round(t.pveDmg * 0.35));
    }
    if (a.phase >= 2 && this.tick - (a.summonAt || 0) > 8 * T) {
      a.summonAt = this.tick;
      for (let i = 0; i < 2; i++) { const c = this._pveSpawn('crawler', t.x + (i ? 2 : -2), t.y + 2, { noElite: true }); if (c) c.summoned = true; }
    }
    // 第 3 階段：預警後衝撞
    if (a.phase >= 3) {
      if (a.dash) {
        a.dash--;
        const [ux, uy] = vec(a.dashA), step = 6 / T, half = t.size / 2;
        const nx = t.x + ux * step, ny = t.y + uy * step;
        const S = this.size;
        let blocked = nx - half < 0.5 || ny - half < 0.5 || nx + half > S - 0.5 || ny + half > S - 0.5;
        for (let y = Math.floor(ny - half); y <= Math.floor(ny + half - 1e-6) && !blocked; y++)
          for (let x = Math.floor(nx - half); x <= Math.floor(nx + half - 1e-6); x++) {
            const c = this.tiles[y * S + x];
            if (c === '@' || c === 'B' || c === '~') { blocked = true; break; }
            if (c === '#' || c === 'O') { this.wallHp.delete(y * S + x); this._setTile(y * S + x, '.'); this.events.push(['brick', x + 0.5, y + 0.5]); }
          }
        if (blocked) { a.dash = 0; a.stunned = 1.5 * T; this.events.push(['blast', t.x, t.y]); }
        else {
          t.x = nx; t.y = ny;
          // 砲塔超出本體的部分也會壓碎磚牆
          for (const id of a.turrets || []) {
            const tu = this.tankById.get(id);
            if (!tu || !tu.alive || tu.kind !== 'fturret' || tu.ai.parent !== t.id) continue;   // 欄位可能已被別的怪物重用
            const tx = t.x + tu.ai.off[0], ty = t.y + tu.ai.off[1];
            for (let y = Math.floor(ty - 0.5); y <= Math.floor(ty + 0.5 - 1e-6); y++) for (let x = Math.floor(tx - 0.5); x <= Math.floor(tx + 0.5 - 1e-6); x++) {
              const i = y * S + x, c = this.tiles[i];
              if (x > 0 && y > 0 && x < S - 1 && y < S - 1 && (c === '#' || c === 'O')) { this.wallHp.delete(i); this._setTile(i, '.'); this.events.push(['brick', x + 0.5, y + 0.5]); }
            }
          }
        }
        for (const o of players) {
          if (a.hitSet && a.hitSet.has(o.id)) continue;
          if (Math.abs(o.x - t.x) < half + 0.5 && Math.abs(o.y - t.y) < half + 0.5) {
            (a.hitSet = a.hitSet || new Set()).add(o.id);
            this._damage(o, t, o.x, o.y, 'shot', t.pveDmg);
          }
        }
        if (!a.dash) { a.hitSet = null; a.next = this.tick + 3 * T; }
        return;
      }
      if (a.prep) { if (--a.prep === 0) { a.dash = 55; a.charging = false; } return; }
      if (!a.next || this.tick >= a.next) {
        const target = players[Math.floor(Math.random() * players.length)];
        a.dashA = angleTo(t, target);
        const [ux, uy] = vec(a.dashA);
        a.prep = 40; a.charging = true;
        this._pveHazard({ kind: 'line', x: t.x, y: t.y, x2: t.x + ux * 11, y2: t.y + uy * 11, w: t.size, fireAt: this.tick + 40, endAt: this.tick + 42, dmg: 0 });
      }
    }
  };

  // ---------- 毒霧女王 ----------
  P._boss_queen = function (t) {
    const a = t.ai, p = this.pve;
    a.real = true;
    if (this._pveBossPhase(t, [0.6, 0.25]) && a.phase === 3) {
      // 全場毒霧＋3 個繞中心移動的安全島
      const c = this.center + 0.5;
      const islands = [0, 120, 240].map(deg => ({ deg, x: c, y: c, r: 2.4 }));
      this._pveHazard({ kind: 'map', x: c, y: c, islands, fireAt: this.tick + 2 * T, endAt: this.tick + 9999 * T, dps: 8, owner: t.id,
        move(h) { for (const i of h.islands) { i.deg = (i.deg + 0.35) % 360; const r = i.deg * Math.PI / 180; i.x = c + Math.cos(r) * 5; i.y = c + Math.sin(r) * 5; } if (this.tick % 10 === 0) this.pve.hazardsChanged = true; } });
    }
    this._pveFly(t, a);
    const players = this._pvePlayers();
    if (!players.length) return;
    // 放射狀彈幕
    if (this.tick % 100 === 50) {
      const n = a.phase >= 2 ? 12 : 8;
      for (let i = 0; i < n; i++) this._pveBullet(t, t.x, t.y, i * 360 / n + (this.tick % 360), 4.5, t.pveDmg);
    }
    // 毒霧：玩家腳下 1.3 秒後生成，持續 8 秒
    const poisonEvery = a.phase >= 3 ? 150 : 90;
    if (this.tick % poisonEvery === 0) {
      for (const o of players.slice(0, 3)) {
        this._pveHazard({ kind: 'poison', x: o.x, y: o.y, r: 1.4, fireAt: this.tick + 40, endAt: this.tick + 40 + 8 * T, dps: 14, owner: t.id });
      }
    }
    // 分身
    if (a.phase >= 2 && this.tick - (a.cloneAt || 0) > 12 * T) {
      a.cloneAt = this.tick;
      for (let i = 0; i < 3; i++) {
        const cl = this._pveSpawn('qclone', t.x + (i - 1) * 1.5, t.y, { noElite: true, shield: 0, noCollide: true });
        if (cl) { cl.reserved = true; cl.ai.parent = t.id; cl.stats.speed = 2.6; cl.flying = true; }
      }
      // 本體換位，讓玩家重新找真身
      const c = this.center + 0.5;
      t.x = c + (Math.random() * 2 - 1) * 5; t.y = c + (Math.random() * 2 - 1) * 5;
      this.events.push(['portal', t.x, t.y]);
    }
  };

  // ---------- 雷霆列車 ----------
  P._boss_train = function (t) {
    const a = t.ai, p = this.pve, track = p.track, L = track.length;
    const at = pos => { const k = ((pos % L) + L) % L, i = Math.floor(k), f = k - i, A = track[i], B = track[(i + 1) % L]; return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f]; };
    const before = a.pos;
    a.pos += t.stats.speed / T * (1 + 0.15 * p.laps);
    [t.x, t.y] = at(a.pos);
    const ahead = at(a.pos + 0.5); t.angle = angleTo(t, { x: ahead[0], y: ahead[1] });
    // 繞完一圈：撞擊核心
    if (Math.floor(a.pos / L) > Math.floor(before / L)) {
      p.laps++; p.stateChanged = true;
      const core = p.core && this.tankById.get(p.core);
      this.objEvents.push(['lap', p.laps]);
      if (core && core.alive) {
        this.events.push(['baseBoom', core.x, core.y]);
        if (p.laps >= 4) this._damage(core, t, core.x, core.y, 'blast', 1e9);
        else { core.hp = Math.max(1, core.hp - Math.ceil(core.maxHp / 4)); }
      }
    }
    // 車廂跟著走；經過轉角丟炸彈
    for (const id of a.cars || []) {
      const car = this.tankById.get(id);
      if (!car || !car.alive) continue;
      const cp = a.pos - car.ai.idx * 1.4, prev = car.ai.lastPos ?? cp;
      [car.x, car.y] = at(cp);
      const nxt = at(cp + 0.5); car.angle = angleTo(car, { x: nxt[0], y: nxt[1] });
      for (const corner of p.trackCorners) {
        if (Math.hypot(car.x - corner[0], car.y - corner[1]) < 0.4 && !(car.ai.bombAt > this.tick - T)) {
          car.ai.bombAt = this.tick;
          this._pveHazard({ kind: 'circle', x: corner[0], y: corner[1], r: 1.4, fireAt: this.tick + 36, endAt: this.tick + 38, dmg: t.pveDmg, owner: t.id, breakWalls: true });
        }
      }
      car.ai.lastPos = cp;
    }
    // 碰撞：在軌道上被撞到
    for (const o of this._pvePlayers()) {
      if ((o.trainHitAt || 0) > this.tick - T) continue;
      const parts = [t, ...(a.cars || []).map(id => this.tankById.get(id)).filter(c => c && c.alive)];
      if (parts.some(c => Math.abs(c.x - o.x) < 0.95 && Math.abs(c.y - o.y) < 0.95)) {
        o.trainHitAt = this.tick;
        this._damage(o, t, o.x, o.y, 'shot', 30);
      }
    }
    // 車頭砲：射最近的玩家
    if (this.tick % 70 === 0) {
      const target = this._pveTarget(t);
      if (target && dist(t, target) < 10) this._pveBullet(t, t.x, t.y, angleTo(t, target), 6, Math.round(t.pveDmg * 0.6));
    }
  };

  // ---------- 機械巨像 ----------
  P._boss_colossus = function (t) {
    const a = t.ai, p = this.pve, c = this.center + 0.5;
    const changed = this._pveBossPhase(t, [0.7, 0.4]);
    if (changed && a.phase === 2) {
      // 地圖崩塌：安全區 30 秒內縮到中央 13×13
      this.zone = { start: this.playTick, end: this.playTick + 30 * T, minHalf: 6.5, full: this.size / 2, dynamic: true };
      p.zoneWasDynamic = true;
      p.stateChanged = true;
    }
    if (changed && a.phase === 3) a.cycle = this.tick;
    let open = false;
    if (a.phase === 3) {
      open = (this.tick - a.cycle) % (30 * T) < 15 * T;
      const was = t.dmgTaken;
      t.dmgTaken = open ? 1.5 : 0;
      if (was !== t.dmgTaken) { p.stateChanged = true; this.objEvents.push(['coreOpen', open ? 1 : 0]); }
    } else t.dmgTaken = 0.3;
    if (open) return;   // 核心開放時不攻擊
    const players = this._pvePlayers();
    if (!players.length) return;
    const every = a.phase === 3 ? 70 : a.phase === 2 ? 110 : 140;
    if (this.tick % every === 0) {
      const target = players[Math.floor(Math.random() * players.length)];
      const ang = angleTo(t, target), [ux, uy] = vec(ang);
      const x0 = t.x + ux * t.size / 2, y0 = t.y + uy * t.size / 2;
      this._pveHazard({ kind: 'line', x: x0, y: y0, x2: x0 + ux * 30, y2: y0 + uy * 30, w: 0.9, fireAt: this.tick + 40, endAt: this.tick + 46, dmg: t.pveDmg, owner: t.id,
        onFire(h) { this._pveLaser(t, h, ux, uy); } });
    }
    // 砲台：每 20 秒補到 3 座
    if (this.tick - (a.turretAt || a.start) > 20 * T) {
      a.turretAt = this.tick;
      const alive = this._pveAlive(o => o.ai && o.ai.parent === t.id && o.kind === 'turret').length;
      const spots = [[-4, -4], [4, -4], [4, 4], [-4, 4]];
      for (let i = alive; i < 3; i++) {
        const [dx, dy] = spots[i];
        const f = this._pveFreeCellNear(c + dx, c + dy);
        const tu = this._pveSpawn('turret', f.x, f.y, { noElite: true, ai: { parent: t.id } });
        if (tu) tu.summoned = true;
      }
    }
    if (a.phase >= 2 && this.tick - (a.eliteAt || a.start) > 15 * T) {
      a.eliteAt = this.tick;
      for (const k of ['shield', 'crawler']) { const sp = this._pveSpawnPoint(); const e = this._pveSpawn(k, sp.x, sp.y, { affixes: ['tough'] }); if (e) e.summoned = true; }
    }
  };

  // 雷射：從巨像往外打，碰到鋼牆停下、磚牆被打掉並停下、重裝坦克擋下（只受 30%）
  P._pveLaser = function (boss, h, ux, uy) {
    const S = this.size, hit = new Set();
    this.events.push(['laser', h.x, h.y]);
    for (let d = 0; d < 30; d += 0.25) {
      const x = h.x + ux * d, y = h.y + uy * d;
      if (x < 0 || y < 0 || x >= S || y >= S) break;
      const c = this.tiles[Math.floor(y) * S + Math.floor(x)];
      if (c === '@' || c === 'B') { this.events.push(['spark', x, y]); h.x2 = x; h.y2 = y; break; }
      if (c === '#') { this._breakTile(Math.floor(x), Math.floor(y)); this.events.push(['brick', x, y]); h.x2 = x; h.y2 = y; break; }
      let stop = false;
      for (const o of this._pvePlayers()) {
        if (hit.has(o.id) || Math.abs(o.x - x) > 0.42 + h.w / 2 || Math.abs(o.y - y) > 0.42 + h.w / 2) continue;
        hit.add(o.id);
        if (o.cls === 'heavy') { this._damage(o, boss, o.x, o.y, 'blast', Math.round(h.dmg * 0.3)); stop = true; }
        else this._damage(o, boss, o.x, o.y, 'blast', h.dmg);
      }
      if (stop) { h.x2 = x; h.y2 = y; break; }
    }
    this.pve.hazardsChanged = true;
  };

  P._pveBossDeath = function (t) {
    const p = this.pve;
    this.events.push(['baseBoom', t.x, t.y]);
    this.objEvents.push(['bossDown', t.kind]);
    // 附屬單位一起消失、Boss 的預警區清掉
    for (const o of this.tanks) {
      if (o.monster && o.alive && o.ai && o.ai.parent === t.id) { o.selfDestruct = true; this._damage(o, null, o.x, o.y, 'self', 1e9); }
    }
    for (const o of this.tanks) if (o.ai && o.ai.parent === t.id) o.reserved = false;
    p.hazards = p.hazards.filter(h => h.owner !== t.id);
    p.hazardsChanged = true;
    if (t.kind === 'colossus' && this.zone && this.zone.dynamic) this.zone = null;
    p.bossId = null;
    p.stateChanged = true;
    const L = p.level;
    if (L.objective === 'boss' || L.objective === 'train') this._pveWin();
  };
};
