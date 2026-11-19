'use strict';

// 怪物 AI（伺服器原生，不經過代碼沙盒）
//   路徑：每 15 tick 從所有玩家方單位做一次多源 BFS（流場），怪物往距離較小的格子走
//   兩種流場：可以射穿磚牆的（有砲的怪物）、只走空地的（沒砲的怪物）；守核心關另有一組以核心為目標

const C = require('../constants');
const D = require('./data');

const T = C.TICK_RATE;
const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const angleTo = (a, b) => (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

module.exports = function install(Round) {
  const P = Round.prototype;

  // ---------- 流場 ----------
  P._pveFlow = function (sources, throughBrick) {
    const S = this.size, N = S * S, d = new Int32Array(N).fill(1e9);
    const buckets = [[]];
    for (const s of sources) {
      const i = Math.floor(s.y) * S + Math.floor(s.x);
      if (i >= 0 && i < N && d[i] > 0) { d[i] = 0; buckets[0].push(i); }
    }
    for (let k = 0; k < buckets.length && k < 2000; k++) {
      const list = buckets[k]; if (!list) continue;
      for (const i of list) {
        if (d[i] !== k) continue;
        const x = i % S, y = (i - x) / S;
        for (const [dx, dy] of DIR4) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const j = ny * S + nx, c = this.tiles[j];
          let cost;
          if (c === '.' || c === '*' || c === 'H' || c === 'P') cost = 1;
          else if (c === '#' && throughBrick) cost = 4;
          else continue;
          const nd = k + cost;
          if (nd < d[j]) { d[j] = nd; (buckets[nd] = buckets[nd] || []).push(j); }
        }
      }
    }
    return d;
  };

  P._pveUpdateFlows = function () {
    const p = this.pve;
    if (this.tick - p.flowAt < 15) return;
    p.flowAt = this.tick;
    const targets = this.tanks.filter(t => t.alive && t.side === 'players' && !t.structure);
    const core = p.core && this.tankById.get(p.core);
    const npc = p.npcId && this.tankById.get(p.npcId);
    const all = targets.concat(core && core.alive ? [core] : []).concat(npc && npc.alive && !targets.includes(npc) ? [npc] : []);
    p.flowShoot = this._pveFlow(all, true);
    p.flowWalk = this._pveFlow(all, false);
    if (core && core.alive) { p.coreShoot = this._pveFlow([core], true); p.coreWalk = this._pveFlow([core], false); }
  };

  // 沿流場的下一步：回傳 { angle, brick }（brick = 下一格是磚牆）
  P._pveFlowStep = function (t, field, away) {
    const S = this.size, x = Math.floor(t.x), y = Math.floor(t.y), here = field[y * S + x];
    let best = null, bv = here;
    for (const [dx, dy] of DIR4) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
      const v = field[ny * S + nx];
      if (v >= 1e9) continue;
      if (away ? v > bv : v < bv) { bv = v; best = [nx, ny]; }
    }
    if (!best) {
      // 已在目標格：往格子中心靠
      if (Math.abs(t.x - x - 0.5) + Math.abs(t.y - y - 0.5) > 0.15) return { angle: angleTo(t, { x: x + 0.5, y: y + 0.5 }), brick: false };
      return null;
    }
    // 轉彎前先對齊目前格子的中心，避免卡牆角
    const [nx, ny] = best, horizontal = nx !== x;
    const off = horizontal ? Math.abs(t.y - (y + 0.5)) : Math.abs(t.x - (x + 0.5));
    const aim = off > 0.12
      ? (horizontal ? { x: t.x + (nx - x) * 0.3, y: y + 0.5 } : { x: x + 0.5, y: t.y + (ny - y) * 0.3 })
      : { x: nx + 0.5, y: ny + 0.5 };
    return { angle: angleTo(t, aim), brick: this.tiles[ny * S + nx] === '#' };
  };

  // 單一目標的一步（救援對象用）：每 30 tick 重算
  P._pveStepToward = function (t, goal) {
    const key = `${t.id}`;
    this._stepCache = this._stepCache || {};
    let c = this._stepCache[key];
    if (!c || this.tick - c.at > 30) c = this._stepCache[key] = { at: this.tick, field: this._pveFlow([goal], false) };
    const s = this._pveFlowStep(t, c.field, false);
    return s ? s.angle : null;
  };

  // 視線：子彈打得過去嗎（磚、鋼、基地、油桶會擋）
  P._pveLos = function (a, b) {
    const S = this.size, d = dist(a, b), n = Math.ceil(d / 0.25);
    for (let i = 1; i < n; i++) {
      const x = a.x + (b.x - a.x) * i / n, y = a.y + (b.y - a.y) * i / n;
      const c = this.tiles[Math.floor(y) * S + Math.floor(x)];
      if (c === '#' || c === '@' || c === 'B' || c === 'O') return false;
    }
    return true;
  };

  // 目標選擇：最近的玩家方單位；嘲諷的重裝優先；守核心關部分怪物只打核心
  P._pveTarget = function (t) {
    const p = this.pve;
    const units = this.tanks.filter(o => o.alive && o.side === 'players' && !(o.cloak > 0));
    if (!units.length) return null;
    if (t.ai.goCore && p.core) { const core = this.tankById.get(p.core); if (core && core.alive) return core; }
    const taunt = units.find(o => o.mods && o.mods.taunt && dist(o, t) < 7);
    if (taunt) return taunt;
    let best = null, bd = 1e9;
    for (const o of units) {
      if (o.structure && o.kind === 'core' && !t.ai.goCore) continue;
      const d = dist(o, t);
      if (d < bd) { bd = d; best = o; }
    }
    return best || units[0];
  };

  P._pveAim = function (t, target) {
    // 輕微提前量：困難以上更準
    const hard = this.pve.diff.hp >= 1.5;
    const spread = hard ? 4 : 9;
    let a = angleTo(t, target);
    if (target.input && typeof target.input.move === 'number' && target.stats && target.stats.speed) {
      const lead = dist(t, target) / Math.max(3, t.stats.bulletSpeed) * target.stats.speed * (hard ? 0.8 : 0.5);
      const r = target.input.move * Math.PI / 180;
      a = angleTo(t, { x: target.x + Math.sin(r) * lead, y: target.y - Math.cos(r) * lead });
    }
    return (a + (Math.random() * 2 - 1) * spread + 360) % 360;
  };

  // ---------- 每 tick ----------
  P._pveThink = function () {
    const p = this.pve;
    if (!p) return;
    this._pveUpdateFlows();
    for (const t of this.tanks) {
      if (!t.monster || !t.alive) continue;
      t.input = { move: null, fire: false };
      if (t.ai.stunned > 0) { t.ai.stunned--; continue; }
      if (t.boss) { this._pveBossThink(t); continue; }
      if (t.part) { this._pvePartThink(t); continue; }
      const fn = this['_ai_' + t.kind] || this._ai_crawler;
      fn.call(this, t);
      // 卡住偵測：想走卻 1 秒沒動 → 隨機換方向一下
      if (t.input.move !== null && t.stats.speed > 0) {
        if (t.ai.lx !== undefined && Math.abs(t.ai.lx - t.x) + Math.abs(t.ai.ly - t.y) < 0.01) t.ai.still = (t.ai.still || 0) + 1; else t.ai.still = 0;
        t.ai.lx = t.x; t.ai.ly = t.y;
        if (t.ai.still > 30) { t.ai.wander = this.tick + 20; t.ai.wanderA = Math.floor(Math.random() * 4) * 90; t.ai.still = 0; }
        if (t.ai.wander > this.tick) t.input.move = t.ai.wanderA;
      }
    }
  };

  // 通用：有砲的怪物——追上去、有射線就停下來射
  P._pveGunner = function (t, opts = {}) {
    const p = this.pve;
    const target = this._pveTarget(t);
    if (!target) return;
    if (t.ai.goCore === undefined) t.ai.goCore = !!p.core && Math.random() < 0.45;
    const d = dist(t, target), los = d <= (D.MONSTERS[t.kind].range || 7) && this._pveLos(t, target);
    if (los) {
      t.angle = this._pveAim(t, target);
      t.input.fire = t.cooldown === 0;
      if (opts.keepAway && d < opts.keepAway) {
        const s = this._pveFlowStep(t, t.ai.goCore && p.coreWalk ? p.coreWalk : p.flowWalk, true);
        if (s) t.input.move = s.angle;
      }
      return target;
    }
    const field = t.ai.goCore && p.coreShoot ? p.coreShoot : p.flowShoot;
    const s = this._pveFlowStep(t, field, false);
    if (!s) return target;
    if (s.brick) { t.angle = s.angle; t.input.fire = t.cooldown === 0; }
    else t.input.move = s.angle;
    return target;
  };

  P._ai_crawler = function (t) { this._pveGunner(t); };

  // 衝鋒者：蓄力 1 秒 → 直線衝撞；撞牆暈眩
  P._ai_charger = function (t) {
    const a = t.ai, p = this.pve;
    if (a.dash) {
      a.dash--;
      const before = [t.x, t.y];
      if (a.baseSpeed === undefined) a.baseSpeed = t.stats.speed;
      t.stats.speed = 8.5;
      this._move(t, a.dashA);
      t.stats.speed = a.baseSpeed;
      for (const o of this.tanks) {
        if (!o.alive || o.side !== 'players' || (a.hitSet && a.hitSet.has(o.id))) continue;
        if (Math.abs(o.x - t.x) < ((o.size || C.TANK_SIZE) + t.size) / 2 + 0.12 && Math.abs(o.y - t.y) < ((o.size || C.TANK_SIZE) + t.size) / 2 + 0.12) {
          (a.hitSet = a.hitSet || new Set()).add(o.id);
          this._damage(o, t, o.x, o.y, 'shot', t.pveDmg);
          this._pveThorns(o, t);
        }
      }
      if (Math.abs(before[0] - t.x) + Math.abs(before[1] - t.y) < 0.02) { a.dash = 0; a.stunned = 2 * T; this.events.push(['wallHit', t.x, t.y]); }
      if (!a.dash) { a.charging = false; a.cd = this.tick + 2 * T; a.hitSet = null; }
      return;
    }
    if (a.prep) {
      a.prep--;
      if (!a.prep) { a.dash = 22; a.charging = false; }
      return;
    }
    const target = this._pveTarget(t);
    if (!target) return;
    if (dist(t, target) < 6 && this._pveLos(t, target) && !(a.cd > this.tick)) {
      a.dashA = angleTo(t, target); t.angle = a.dashA;
      a.prep = T; a.charging = true;
      const r = a.dashA * Math.PI / 180;
      this._pveHazard({ kind: 'line', x: t.x, y: t.y, x2: t.x + Math.sin(r) * 7, y2: t.y - Math.cos(r) * 7, w: t.size, fireAt: this.tick + T, endAt: this.tick + T + 2, dmg: 0 });
      return;
    }
    if (a.goCore === undefined) a.goCore = !!p.core && Math.random() < 0.45;
    const s = this._pveFlowStep(t, a.goCore && p.coreWalk ? p.coreWalk : p.flowWalk, false);
    if (s) t.input.move = s.angle;
  };

  // 砲台：不動，間歇三連發
  P._ai_turret = function (t) {
    const target = this._pveTarget(t);
    if (!target) return;
    if (dist(t, target) > D.MONSTERS.turret.range || !this._pveLos(t, target)) return;
    t.angle = this._pveAim(t, target);
    const a = t.ai;
    if (!a.next || this.tick >= a.next) { a.burstUntil = this.tick + 22; a.next = this.tick + t.stats.cooldown; }
    t.stats.cooldown = Math.min(t.stats.cooldown, 70);
    if (this.tick < a.burstUntil && t.cooldown === 0) { this._fire(t); t.cooldown = 7; }
  };

  // 狙擊蟲：保持距離；紅線預警 1 秒後射出高速彈
  P._ai_sniper = function (t) {
    const a = t.ai;
    if (a.aimUntil > this.tick) return;         // 瞄準中：不動
    const target = this._pveTarget(t);
    if (!target) return;
    const d = dist(t, target);
    if (d <= D.MONSTERS.sniper.range && this._pveLos(t, target) && t.cooldown === 0) {
      const ang = this._pveAim(t, target), r = ang * Math.PI / 180;
      t.angle = ang;
      a.aimUntil = this.tick + T;
      const born = a.born;
      const len = Math.min(16, d + 4);
      this._pveHazard({ kind: 'line', x: t.x, y: t.y, x2: t.x + Math.sin(r) * len, y2: t.y - Math.cos(r) * len, w: 0.25, fireAt: this.tick + T, endAt: this.tick + T + 2, owner: t.id,
        onFire() { if (t.alive && t.kind === 'sniper' && t.ai.born === born) { t.angle = ang; t.cooldown = 0; this._fire(t); } } });   // 欄位可能已被別的怪物重用
      return;
    }
    this._pveGunner(t, { keepAway: D.MONSTERS.sniper.keepAway });
    t.input.fire = false;
  };

  // 自爆蟲：貼身 0.8 秒後爆炸
  P._ai_bomber = function (t) {
    const a = t.ai, p = this.pve;
    if (a.fuse) {
      if (--a.fuse <= 0) this._pveExplode(t, 1.6, t.pveDmg);
      return;
    }
    const target = this._pveTarget(t);
    if (!target) return;
    if (dist(t, target) < 1.3 + (target.size || C.TANK_SIZE) / 2) { a.fuse = 24; return; }
    if (a.goCore === undefined) a.goCore = !!p.core && Math.random() < 0.6;
    const s = this._pveFlowStep(t, a.goCore && p.coreShoot ? p.coreShoot : p.flowShoot, false);
    if (!s) return;
    if (s.brick) { a.fuse = 20; return; }              // 前面是磚牆：直接炸開
    t.input.move = s.angle;
  };

  P._pveExplode = function (t, r, dmg) {
    this.events.push(['blast', t.x, t.y]);
    this.events.push(['boom', t.x, t.y]);
    if (this.breakableWalls) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this._breakTile(Math.floor(t.x) + dx, Math.floor(t.y) + dy);
    for (const o of this.tanks) {
      if (!o.alive || o.side !== 'players') continue;
      if (Math.hypot(o.x - t.x, o.y - t.y) <= r + ((o.size || C.TANK_SIZE) - C.TANK_SIZE) / 2) this._damage(o, t, t.x, t.y, 'blast', dmg);
    }
    t.selfDestruct = true;
    this._damage(t, null, t.x, t.y, 'self', 1e9, true);
  };

  // 護盾兵：擋在隊友前面，正面朝向玩家
  P._ai_shield = function (t) {
    const target = this._pveTarget(t);
    if (!target) return;
    const allies = this._pveAlive(o => o !== t && o.kind !== 'shield' && !o.part && !o.boss && !o.structureM);
    let guard = null, gd = 1e9;
    for (const o of allies) { const d = dist(o, t); if (d < gd) { gd = d; guard = o; } }
    if (guard && gd < 8) {
      const dx = target.x - guard.x, dy = target.y - guard.y, n = Math.hypot(dx, dy) || 1;
      const spot = { x: guard.x + dx / n * 1.3, y: guard.y + dy / n * 1.3 };
      if (dist(t, spot) > 0.5) { t.input.move = angleTo(t, spot); return; }
      t.angle = this._pveAim(t, target);
      t.input.fire = t.cooldown === 0 && this._pveLos(t, target) && dist(t, target) < 7;
      return;
    }
    this._pveGunner(t);
  };

  // 治療者：遠離玩家，持續治療附近怪物
  P._ai_healer = function (t) {
    const p = this.pve, target = this._pveTarget(t);
    const near = target && dist(t, target) < D.MONSTERS.healer.keepAway;
    if (near) { const s = this._pveFlowStep(t, p.flowWalk, true); if (s) t.input.move = s.angle; }
    else {
      const flock = this._pveAlive(o => o !== t && !o.structureM);
      if (flock.length) {
        const cx = flock.reduce((a, o) => a + o.x, 0) / flock.length, cy = flock.reduce((a, o) => a + o.y, 0) / flock.length;
        if (Math.hypot(cx - t.x, cy - t.y) > 2) t.input.move = angleTo(t, { x: cx, y: cy });
      }
    }
    if (this.tick % 15 === 0) {
      let healed = false;
      for (const o of this._pveAlive(o => !o.structureM)) {
        if (o.hp >= o.maxHp || Math.hypot(o.x - t.x, o.y - t.y) > 3.5) continue;
        o.hp = Math.min(o.maxHp, o.hp + Math.max(1, Math.round(o.maxHp * (o.boss ? 0.004 : 0.04))));
        healed = true;
      }
      if (healed && this.tick % 45 === 0) this.events.push(['heal', t.x, t.y]);
    }
  };

  // 召喚師：遠離玩家，每 6 秒召喚 2 隻爬蟲
  P._ai_summoner = function (t) {
    const p = this.pve, target = this._pveTarget(t);
    if (target && dist(t, target) < D.MONSTERS.summoner.keepAway) { const s = this._pveFlowStep(t, p.flowWalk, true); if (s) t.input.move = s.angle; }
    const a = t.ai;
    if (!a.next) a.next = this.tick + 2 * T;
    if (this.tick >= a.next) {
      a.next = this.tick + 6 * T;
      const kids = this._pveAlive(o => o.ai && o.ai.parent === t.id).length;
      for (let i = 0; i < 2 && kids + i < 4; i++) {
        const c = this._pveSpawn('crawler', t.x + (i ? 0.6 : -0.6), t.y + 0.6, { noElite: true, hpMult: 0.7, ai: { parent: t.id } });
        if (c) { c.summoned = true; this.events.push(['skill', c.x, c.y]); }
      }
    }
  };

  // 潛伏者：隱形接近，開火時現身 3 秒
  P._ai_lurker = function (t) {
    const a = t.ai;
    t.cloak = this.tick < (a.revealUntil || 0) ? 0 : 5;
    const target = this._pveGunner(t);
    if (t.input.fire && t.cooldown === 0) a.revealUntil = this.tick + 3 * T;
    if (target && dist(t, target) > 4) t.input.fire = false;
  };

  // 工程兵：每 8 秒在前方蓋磚牆；修補據點
  P._ai_builder = function (t) {
    const target = this._pveGunner(t);
    const a = t.ai;
    if (!a.next) a.next = this.tick + 4 * T;
    if (this.tick >= a.next) {
      a.next = this.tick + 8 * T;
      for (const id of this.pve.bunkers) {
        const b = this.tankById.get(id);
        if (b.alive && dist(b, t) < 3.5 && b.hp < b.maxHp) { b.hp = Math.min(b.maxHp, b.hp + 60); this.events.push(['heal', b.x, b.y]); }
      }
      if (target && dist(t, target) < 8) {
        const r = angleTo(t, target) * Math.PI / 180;
        const cx = Math.floor(t.x + Math.sin(r) * 1.4), cy = Math.floor(t.y - Math.cos(r) * 1.4);
        if (this._cellFree(cx, cy)) { this._setTile(cy * this.size + cx, '#'); this.events.push(['skill', cx + 0.5, cy + 0.5]); }
      }
    }
  };

  // 據點：不動，每 10 秒派出一隻爬蟲
  P._ai_bunker = function (t) {
    const a = t.ai;
    if (!a.next) a.next = this.tick + 5 * T;
    if (this.tick < a.next) return;
    a.next = this.tick + 10 * T;
    if (this._pveAlive(o => o.ai && o.ai.parent === t.id).length >= 3) return;
    const c = this._pveSpawn('crawler', t.x, t.y + 1.3, { ai: { parent: t.id } });
    if (c) c.summoned = true;
  };

  // 反應裝甲：近身攻擊者受到反傷
  P._pveThorns = function (victim, attacker) {
    if (victim.mods && victim.mods.thorns && attacker && attacker.alive) this._damage(attacker, victim, attacker.x, attacker.y, 'blast', victim.mods.thorns);
  };
};
