'use strict';

// 範例電腦代碼：沒交代碼的玩家和「內建電腦隊伍」都用這份。
// 也會顯示在編輯器裡當作起點。
module.exports = `// 範例電腦隊友：找最近的敵人或敵方基地，對齊就開火，路上有磚牆就打掉
var DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };          // 尋路用四方向
var AIM = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],               // 射擊可以八方向
  upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1] };

function think(view, memory) {
  var me = view.me, map = view.map;
  var targets = view.enemies.slice();
  (view.bases || []).forEach(function (b) { if (!b.ally && b.alive) targets.push(b); });
  if (targets.length === 0) return { move: null, fire: false };

  // 卡住偵測：太久沒移動就隨便換個方向走一下
  if (memory.lastX === me.x && memory.lastY === me.y) memory.still = (memory.still || 0) + 1;
  else memory.still = 0;
  memory.lastX = me.x; memory.lastY = me.y;
  if (memory.wander > 0) { memory.wander--; return { move: memory.wanderDir, fire: true }; }
  if (memory.still > 20) {
    var ds = Object.keys(DIRS);
    memory.wanderDir = ds[Math.floor(Math.random() * 4)];
    memory.wander = 12; memory.still = 0;
  }

  // 1. 和目標在同一直線或斜線上、中間沒有擋住 → 轉過去開火
  for (var i = 0; i < targets.length; i++) {
    var d = clearShot(me, targets[i], map, view.rules.breakableWalls);
    if (d) return { move: d === me.dir ? null : d, fire: d === me.dir };
  }

  // 2. 用 BFS 找往最近目標的下一步（磚牆打得破時當作可以通過）
  var dir = nextStep(me, targets, map, view.rules.breakableWalls);
  if (!dir) return { move: null, fire: true };
  var v = DIRS[dir];
  var nx = Math.floor(me.x) + v[0], ny = Math.floor(me.y) + v[1];
  var brickAhead = map.tiles[ny] && map.tiles[ny][nx] === '#';
  return { move: dir, fire: brickAhead && me.dir === dir };
}

function tileAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return '@';
  return map.tiles[y][x];
}

function clearShot(me, t, map, breakable) {
  var mx = Math.floor(me.x), my = Math.floor(me.y);
  var tx = Math.floor(t.x), ty = Math.floor(t.y);
  var dir = null, dx = t.x - me.x, dy = t.y - me.y;
  if (Math.abs(dx) < 0.4) dir = dy < 0 ? 'up' : 'down';
  else if (Math.abs(dy) < 0.4) dir = dx < 0 ? 'left' : 'right';
  else if (Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.35) dir = (dy < 0 ? 'up' : 'down') + (dx < 0 ? 'left' : 'right');
  if (!dir) return null;
  var v = AIM[dir], x = mx, y = my;
  for (var n = 0; n < 60; n++) {
    x += v[0]; y += v[1];
    if (x === tx && y === ty) return dir;
    var c = tileAt(map, x, y);
    if (c === '@' || c === 'B' || (c === '#' && !breakable)) return null;
  }
  return null;
}

function nextStep(me, targets, map, breakable) {
  var W = map.width, H = map.height;
  var sx = Math.floor(me.x), sy = Math.floor(me.y);
  var goal = {};
  targets.forEach(function (t) {
    var tx = Math.floor(t.x), ty = Math.floor(t.y);
    goal[ty * W + tx] = 1;
    for (var k in DIRS) goal[(ty + DIRS[k][1]) * W + (tx + DIRS[k][0])] = 1;
  });
  var first = new Array(W * H);
  var seen = new Uint8Array(W * H);
  var queue = [sy * W + sx];
  seen[sy * W + sx] = 1;
  for (var qi = 0; qi < queue.length; qi++) {
    var cur = queue[qi], cx = cur % W, cy = (cur - cx) / W;
    if (goal[cur] && cur !== queue[0]) return first[cur];
    for (var k in DIRS) {
      var nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
      var c = tileAt(map, nx, ny);
      if (c !== '.' && c !== '*' && !(c === '#' && breakable)) continue;
      var id = ny * W + nx;
      if (seen[id]) continue;
      seen[id] = 1;
      first[id] = cur === queue[0] ? k : first[cur];
      queue.push(id);
    }
  }
  return null;
}
`;
