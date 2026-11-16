'use strict';

// 隨機地圖產生器。
// 地形：. 空地  # 磚牆  @ 鋼牆  ~ 水  * 草叢  B 基地

function anchorPositions(count, size) {
  const c = (size - 1) / 2;
  const lo = 3, hi = size - 4;
  if (count === 2) return [{ x: c, y: lo }, { x: c, y: hi }];
  if (count === 4) return [{ x: lo, y: lo }, { x: hi, y: lo }, { x: hi, y: hi }, { x: lo, y: hi }];
  const R = c - 3;
  const out = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const x = Math.min(hi, Math.max(lo, Math.round(c + R * Math.cos(a))));
    const y = Math.min(hi, Math.max(lo, Math.round(c + R * Math.sin(a))));
    out.push({ x, y });
  }
  return out;
}

function orbit(x, y, size, symmetry) {
  const m = size - 1;
  if (symmetry === 2) return [[x, y], [m - x, m - y]];
  if (symmetry === 4) return [[x, y], [m - y, x], [m - x, m - y], [y, m - x]];
  return [[x, y]];
}

function randomTerrain(size) {
  const g = Array.from({ length: size }, () => Array(size).fill('.'));
  const structures = Math.round(size * size * 0.105);
  for (let i = 0; i < structures; i++) {
    const r = Math.random();
    const t = r < 0.55 ? '#' : r < 0.67 ? '@' : r < 0.8 ? '~' : '*';
    const w = 1 + Math.floor(Math.random() * 3);
    const h = 1 + Math.floor(Math.random() * 3);
    const x0 = Math.floor(Math.random() * size);
    const y0 = Math.floor(Math.random() * size);
    for (let y = y0; y < Math.min(size, y0 + h); y++)
      for (let x = x0; x < Math.min(size, x0 + w); x++) g[y][x] = t;
  }
  return g;
}

function generateMap({ anchors: anchorCount, spawnsPerAnchor, size, baseMode, breakableWalls = true }) {
  const symmetry = anchorCount === 2 ? 2 : anchorCount === 4 ? 4 : 1;
  const anchors = anchorPositions(anchorCount, size);
  const center = (size - 1) / 2;

  for (let attempt = 0; attempt < 60; attempt++) {
    const raw = randomTerrain(size);
    const g = Array.from({ length: size }, () => Array(size).fill('.'));
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        // 對稱：同一軌道上的格子取同一個代表值，讓各隊地形公平
        const reps = orbit(x, y, size, symmetry);
        let best = reps[0];
        for (const p of reps) if (p[1] * size + p[0] < best[1] * size + best[0]) best = p;
        g[y][x] = raw[best[1]][best[0]];
      }

    // 出生區淨空
    for (const a of anchors)
      for (let y = a.y - 3; y <= a.y + 3; y++)
        for (let x = a.x - 3; x <= a.x + 3; x++)
          if (y >= 0 && y < size && x >= 0 && x < size) g[y][x] = '.';

    // 基地與磚牆圍欄
    if (baseMode) {
      for (const a of anchors) {
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            // 牆壁打不破時，只在四個角放磚牆，留出上下左右的缺口，基地才打得到
            if (!breakableWalls && (dx === 0 || dy === 0)) continue;
            g[a.y + dy][a.x + dx] = '#';
          }
        g[a.y][a.x] = 'B';
        // 基地上下左右與四個斜角距離 3 格放鋼牆：擋住遠距離直線／斜線狙擊，敵人得靠近才打得到基地
        for (const [dx, dy] of [[0, -3], [0, 3], [-3, 0], [3, 0], [-3, -3], [3, -3], [-3, 3], [3, 3]]) {
          const x = a.x + dx, y = a.y + dy;
          if (x >= 0 && y >= 0 && x < size && y < size) g[y][x] = '@';
        }
      }
    }

    // 出生點：距離基地 2 格的一圈，靠近地圖中央的優先
    const spawns = anchors.map((a, i) => {
      const ring = [];
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) ring.push({ x: a.x + dx, y: a.y + dy });
      ring.sort((p, q) => Math.hypot(p.x - center, p.y - center) - Math.hypot(q.x - center, q.y - center));
      return ring.slice(0, Math.max(2, spawnsPerAnchor[i] || 2));
    });

    if (attempt === 59) {
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) if (g[y][x] === '~' || g[y][x] === '@' || (!breakableWalls && g[y][x] === '#')) g[y][x] = '.';
    }

    // 連通性：確認所有出生點互相到得了（磚牆打得破時視為可通過）
    const open = breakableWalls ? '.*#' : '.*';
    const passable = (x, y) => x >= 0 && y >= 0 && x < size && y < size && open.includes(g[y][x]);
    const seen = new Uint8Array(size * size);
    const q = [[spawns[0][0].x, spawns[0][0].y]];
    seen[spawns[0][0].y * size + spawns[0][0].x] = 1;
    while (q.length) {
      const [x, y] = q.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (passable(nx, ny) && !seen[ny * size + nx]) { seen[ny * size + nx] = 1; q.push([nx, ny]); }
      }
    }
    const ok = spawns.every(list => list.every(p => seen[p.y * size + p.x]));
    if (!ok) continue;

    return {
      size,
      tiles: g.map(row => row.join('')).join('').split(''),
      anchors,
      spawns,
    };
  }
  throw new Error('map generation failed');
}

module.exports = { generateMap };
