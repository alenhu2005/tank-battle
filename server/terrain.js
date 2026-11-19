'use strict';

// 特殊地形與縮圈：
//   O 油桶：被子彈或爆炸打到就爆炸，傷害周圍坦克（不傷射手的隊友），也會炸掉旁邊的磚牆、引爆旁邊的油桶
//   H 補血站：坦克中心站在上面就持續回血（經典模式：每 3 秒補滿耐久）
//   P 傳送門：成對出現，開到門中央就傳送到另一個門（每台坦克 2 秒冷卻）
//   縮圈：時間過了 40% 開始，安全區從整張地圖縮到中央 5×5，85% 時縮完；圈外持續扣血

const C = require('./constants');

module.exports = function install(Round) {
  const P = Round.prototype;

  P._initTerrain = function (opts) {
    const S = this.size, m = S - 1;
    // 傳送門配對：優先和點對稱位置的傳送門配，沒有就按順序兩兩一組
    const portals = [];
    for (let i = 0; i < this.tiles.length; i++) if (this.tiles[i] === 'P') portals.push({ x: i % S, y: Math.floor(i / S) });
    this.portalPair = new Map();
    const used = new Set();
    for (const p of portals) {
      const key = p.y * S + p.x;
      if (used.has(key)) continue;
      let q = portals.find(o => o.x === m - p.x && o.y === m - p.y && o !== p && !used.has(o.y * S + o.x));
      if (!q) q = portals.find(o => o !== p && !used.has(o.y * S + o.x));
      if (!q) continue;
      const k2 = q.y * S + q.x;
      used.add(key); used.add(k2);
      this.portalPair.set(key, q); this.portalPair.set(k2, p);
    }
    for (const p of portals) { const k = p.y * S + p.x; if (!this.portalPair.has(k)) this.tiles[k] = '.'; }   // 落單的傳送門（例如被護送路線挖掉另一個）
    // 縮圈：只在生存和佔點模式
    const Z = C.ZONE;
    this.zone = null;
    if (opts.zone && (this.objective === 'survival' || this.objective === 'koth')) {
      const T = this.timeLimitTicks || Z.defaultSeconds * C.TICK_RATE;
      this.zone = { start: Math.round(T * Z.start), end: Math.round(T * Z.end), minHalf: Z.minHalf, full: S / 2 };
    }
  };

  // 目前的安全區（以地圖中心為中心的正方形）
  P._zoneHalf = function (playTick = this.playTick) {
    const z = this.zone;
    if (!z) return Infinity;
    const k = Math.max(0, Math.min(1, (playTick - z.start) / (z.end - z.start)));
    return z.full - (z.full - z.minHalf) * k;
  };
  P._outsideZone = function (t) {
    if (!this.zone) return false;
    const h = this._zoneHalf(), c = this.size / 2;
    return Math.abs(t.x - c) > h || Math.abs(t.y - c) > h;
  };

  P._explodeBarrel = function (tx, ty, src) {
    const S = this.size, idx = ty * S + tx;
    if (this.tiles[idx] !== 'O') return;
    this.tiles[idx] = '.';
    this.tileChanges.push([idx, '.']);
    const x = tx + 0.5, y = ty + 0.5;
    this.events.push(['blast', x, y]);
    this.events.push(['boom', x, y]);
    const shooter = src && src.owner ? this.tankById.get(src.owner) : null;
    const side = src ? src.side : null;
    if (this.breakableWalls) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this._breakTile(tx + dx, ty + dy);
    for (const t of this.tanks) {
      if (!t.alive || (side && t.side === side)) continue;        // 沒有友軍傷害
      if (Math.hypot(t.x - x, t.y - y) <= C.BARREL_RADIUS) this._damage(t, shooter, x, y, 'barrel', C.BARREL_DMG);
    }
    // 連鎖：旁邊的油桶一起爆
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = tx + dx, ny = ty + dy;
      if (nx >= 0 && ny >= 0 && nx < S && ny < S && this.tiles[ny * S + nx] === 'O') this._explodeBarrel(nx, ny, src);
    }
  };

  P._updateTerrain = function () {
    const S = this.size;
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (t.portalCd > 0) t.portalCd--;
      const tx = Math.floor(t.x), ty = Math.floor(t.y), key = ty * S + tx, c = this.tiles[key];
      // 傳送門
      if (c === 'P' && !(t.portalCd > 0) && Math.abs(t.x - (tx + 0.5)) < 0.3 && Math.abs(t.y - (ty + 0.5)) < 0.3) {
        const dst = this.portalPair.get(key);
        if (dst && !this._tankAt(dst.x + 0.5, dst.y + 0.5, t)) {
          this.events.push(['portal', t.x, t.y]);
          t.x = dst.x + 0.5; t.y = dst.y + 0.5;
          t.portalCd = C.PORTAL_CD;
          this.events.push(['portal', t.x, t.y]);
        }
      }
      // 補血站
      if (c === 'H') {
        const max = t.maxHp || t.stats.hp;
        if (t.hp < max) {
          if (this.hpSystem) {
            t.padAcc = (t.padAcc || 0) + max * C.HEAL_PAD_PER_SEC / C.TICK_RATE;
            if (t.padAcc >= 1) { const n = Math.floor(t.padAcc); t.padAcc -= n; t.hp = Math.min(max, t.hp + n); }
          } else if ((t.padTicks = (t.padTicks || 0) + 1) >= 3 * C.TICK_RATE) { t.hp = max; t.padTicks = 0; this.events.push(['heal', t.x, t.y]); }
        }
      } else t.padTicks = 0;
      // 縮圈：圈外持續受傷
      if (this.zone && this._outsideZone(t)) {
        t.zoneTicks = (t.zoneTicks || 0) + 1;
        if (this.hpSystem) {
          if (t.zoneTicks % 15 === 0) this._damage(t, null, t.x, t.y, 'zone', Math.max(1, Math.round((t.maxHp || 100) * C.ZONE.dmgPerSec / 2)));
        } else if (t.zoneTicks % (C.ZONE.classicSeconds * C.TICK_RATE) === 0) this._damage(t, null, t.x, t.y, 'zone', 1);
      } else t.zoneTicks = 0;
    }
  };

  // 給電腦代碼：目前與最終的安全區
  P._terrainView = function () {
    if (!this.zone) return { zone: null };
    const c = this.size / 2, h = this._zoneHalf(), z = this.zone;
    const r = v => Math.round(v * 100) / 100;
    return {
      zone: {
        x0: r(c - h), y0: r(c - h), x1: r(c + h), y1: r(c + h),
        finalX0: r(c - z.minHalf), finalY0: r(c - z.minHalf), finalX1: r(c + z.minHalf), finalY1: r(c + z.minHalf),
        startsIn: Math.max(0, z.start - this.playTick), endsIn: Math.max(0, z.end - this.playTick),
      },
    };
  };
};
