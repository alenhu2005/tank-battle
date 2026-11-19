'use strict';

// 隨機地圖產生器。
// 地形：. 空地  # 磚牆  @ 鋼牆  ~ 水  * 草叢  B 基地  O 油桶  H 補血站  P 傳送門

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

// 地圖風格：密度、各地形比例（磚 / 鋼 / 水 / 草）、區塊大小
const STYLES = {
  random:   { density: 0.105, mix: [0.55, 0.12, 0.13, 0.20], block: 3 },
  open:     { density: 0.05,  mix: [0.45, 0.30, 0.10, 0.15], block: 2 },
  forest:   { density: 0.13,  mix: [0.30, 0.08, 0.05, 0.57], block: 3 },
  fortress: { density: 0.09,  mix: [0.45, 0.45, 0.10, 0.00], block: 3, minBlock: 2 },
  river:    { density: 0.06,  mix: [0.60, 0.15, 0.00, 0.25], block: 2 },
  maze:     null,
};

function pickTile(mix) {
  const r = Math.random();
  return r < mix[0] ? '#' : r < mix[0] + mix[1] ? '@' : r < mix[0] + mix[1] + mix[2] ? '~' : '*';
}

// 迷宮：在奇數格之間挖通道，牆是磚牆，再隨機打通一些牆形成迴路
function mazeTerrain(size) {
  const g = Array.from({ length: size }, () => Array(size).fill('#'));
  const stack = [[1, 1]];
  g[1][1] = '.';
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const nb = [[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dy]) => [x + dx, y + dy, dx, dy])
      .filter(([nx, ny]) => nx > 0 && ny > 0 && nx < size - 1 && ny < size - 1 && g[ny][nx] === '#');
    if (!nb.length) { stack.pop(); continue; }
    const [nx, ny, dx, dy] = nb[Math.floor(Math.random() * nb.length)];
    g[y + dy / 2][x + dx / 2] = '.'; g[ny][nx] = '.';
    stack.push([nx, ny]);
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (g[y][x] !== '#') continue;
    const r = Math.random();
    if (r < 0.35) g[y][x] = '.';          // 打通，形成迴路
    else if (r < 0.42) g[y][x] = '@';
    else if (r < 0.47) g[y][x] = '*';
  }
  return g;
}

function randomTerrain(size, styleName) {
  if (styleName === 'maze') return mazeTerrain(size);
  const st = STYLES[styleName] || STYLES.random;
  const g = Array.from({ length: size }, () => Array(size).fill('.'));
  const structures = Math.round(size * size * st.density);
  for (let i = 0; i < structures; i++) {
    const t = pickTile(st.mix);
    const minB = st.minBlock || 1;
    const w = minB + Math.floor(Math.random() * (st.block - minB + 1));
    const h = minB + Math.floor(Math.random() * (st.block - minB + 1));
    const x0 = Math.floor(Math.random() * size);
    const y0 = Math.floor(Math.random() * size);
    for (let y = y0; y < Math.min(size, y0 + h); y++)
      for (let x = x0; x < Math.min(size, x0 + w); x++) g[y][x] = t;
  }
  if (styleName === 'river') {
    // 十字河道，每隔幾格留一座橋
    // 河道在正中央、橋的位置左右對稱，地圖對稱後才不會把橋堵住
    const c = (size - 1) / 2;
    for (let i = 0; i < size; i++) {
      const k = Math.abs(i - c) % 6;
      if (k === 2 || k === 3) continue;
      g[c][i] = '~'; g[i][c] = '~';
    }
  }
  return g;
}

// 自訂地圖連不通時，挖出 L 形通道把各出生點連起來
function carvePath(g, a, b) {
  const size = g.length;
  const open = (x, y) => { if (x >= 0 && y >= 0 && x < size && y < size && (g[y][x] === '@' || g[y][x] === '~')) g[y][x] = '.'; };
  for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) open(x, a.y);
  for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) open(b.x, y);
}

// 特殊地形：油桶、補血站、傳送門（對稱擺放，避開出生區和地圖正中央）
function placeSpecials(g, anchors, symmetry) {
  const size = g.length, m = size - 1, c = m / 2;
  const sym = Math.max(2, symmetry);
  const okCell = (x, y) => x > 0 && y > 0 && x < m && y < m && g[y][x] === '.'
    && anchors.every(a => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) > 4) && Math.max(Math.abs(x - c), Math.abs(y - c)) > 2;
  const place = (ch, groups) => {
    for (let n = 0, tries = 0; n < groups && tries < 200; tries++) {
      const x = 1 + Math.floor(Math.random() * (m - 1)), y = 1 + Math.floor(Math.random() * (m - 1));
      const cells = orbit(x, y, size, sym);
      if (!cells.every(([px, py]) => okCell(px, py))) continue;
      for (const [px, py] of cells) g[py][px] = ch;
      n++;
    }
  };
  place('O', Math.max(2, Math.round(size / 9)));
  place('H', 1);
  // 傳送門：彼此點對稱的一對（伺服器會把點對稱的兩個傳送門配成一對）；四隊地圖放兩對（旋轉 90 度），每隊都有一個在附近
  for (let tries = 0; tries < 200; tries++) {
    const x = 1 + Math.floor(Math.random() * (m - 1)), y = 1 + Math.floor(Math.random() * (m - 1));
    const cells = symmetry === 4 ? orbit(x, y, size, 4) : [[x, y], [m - x, m - y]];
    if (!cells.every(([px, py]) => okCell(px, py)) || Math.abs(x - (m - x)) + Math.abs(y - (m - y)) < size * 0.6) continue;
    if (symmetry === 4 && new Set(cells.map(([px, py]) => py * size + px)).size < 4) continue;
    for (const [px, py] of cells) g[py][px] = 'P';
    break;
  }
}

function generateMap({ anchors: anchorCount, spawnsPerAnchor, size, baseMode, breakableWalls = true, style = 'random', custom = null, specials = false }) {
  if (custom) size = custom.size;
  const symmetry = custom ? 1 : anchorCount === 2 ? 2 : anchorCount === 4 ? 4 : 1;
  const anchors = anchorPositions(anchorCount, size);
  const center = (size - 1) / 2;

  for (let attempt = 0; attempt < 60; attempt++) {
    const raw = custom
      ? Array.from({ length: size }, (_, y) => custom.tiles.slice(y * size, (y + 1) * size).split('').map(c => '.#@~*OHP'.includes(c) ? c : '.'))
      : randomTerrain(size, style);
    if (custom && attempt > 0) for (let i = 1; i < anchors.length; i++) carvePath(raw, anchors[0], anchors[i]);
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

    if (specials && !custom) placeSpecials(g, anchors, symmetry);

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
    const open = breakableWalls ? '.*#OHP' : '.*OHP';
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
