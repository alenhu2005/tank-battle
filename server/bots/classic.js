'use strict';

// 「標準」範例打法（以前的內建電腦）：會尋路、有射線就開火、打掉擋路的磚牆。
// 現在的內建電腦換成故意很笨的 defaultBot.js，這份留給玩家當範例、給擂台當對手、給測試用。
const AIM_HELPERS = require('./aim');

module.exports = `// 範例電腦隊友：找最近的敵人或敵方基地，有射線就開火，路上有磚牆就打掉
var DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };          // 尋路用四方向

function think(view, memory) {
  var me = view.me, map = view.map;
  var targets = view.enemies.slice();
  (view.bases || []).forEach(function (b) { if (!b.ally && b.alive) targets.push(b); });

  // 遊戲目標：佔點就往中央區域走、搶旗就去搶旗或帶旗回家
  var goals = objectiveGoals(view);
  if (targets.length === 0 && !goals) return { move: null, fire: false };

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

  // 1. 對可射擊的目標瞄準，仍可往遊戲目標移動
  var aim = null;
  for (var i = 0; i < targets.length; i++) {
    aim = clearAim(me, targets[i], map);
    if (aim !== null) break;
  }
  if (aim !== null && (!goals || goals.length === 0)) return { move: null, aim: aim, fire: true };

  // 2. 用 BFS 找往最近目標的下一步（磚牆打得破時當作可以通過）
  if (goals && goals.length === 0) return { move: null, fire: false };   // 已經站在佔點區裡
  var dir = nextStep(me, goals || targets, map, view.rules.breakableWalls);
  if (aim !== null) return { move: dir, aim: aim, fire: true };
  if (!dir) return { move: null, fire: true };
  var v = DIRS[dir];
  var nx = Math.floor(me.x) + v[0], ny = Math.floor(me.y) + v[1];
  var brickAhead = map.tiles[ny] && map.tiles[ny][nx] === '#';
  return { move: dir, aim: dir, fire: brickAhead };
}

function objectiveGoals(view) {
  var o = view.objective || {}, me = view.me;
  var nearEnemy = view.enemies.some(function (e) { return Math.abs(e.x - me.x) + Math.abs(e.y - me.y) < 6; });
  if (o.type === 'koth') {
    if (nearEnemy) return null;
    var inHill = Math.abs(me.x - o.x) <= o.radius && Math.abs(me.y - o.y) <= o.radius;
    return inHill ? [] : [{ x: o.x, y: o.y }];
  }
  if (o.type === 'escort') return [o.cart];   // 護送：進攻方推車、防守方擋車，都往礦車去
  if (o.type === 'ctf') {
    var mine = o.flags.filter(function (f) { return f.ally; })[0];
    if (me.carrying) return [{ x: mine.homeX, y: mine.homeY }];
    if (mine && !mine.atHome && !mine.carrier) return [{ x: mine.x, y: mine.y }];
    var free = o.flags.filter(function (f) { return !f.ally && !f.carrier; });
    return free.length ? free.map(function (f) { return { x: f.x, y: f.y }; }) : null;
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
      if (c !== '.' && c !== '*' && c !== 'H' && c !== 'P' && !(c === '#' && breakable)) continue;
      var id = ny * W + nx;
      if (seen[id]) continue;
      seen[id] = 1;
      first[id] = cur === queue[0] ? k : first[cur];
      queue.push(id);
    }
  }
  return null;
}
` + AIM_HELPERS;
