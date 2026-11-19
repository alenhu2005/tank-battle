'use strict';

// 幾種不同打法的範例電腦代碼。玩家可以直接選用，或把它當作範本複製給 AI 修改。
// 每份都是完整、可以單獨執行的代碼（共用的輔助函式會接在後面）。

const CLASSIC = require('./bots/classic');

const HELPERS = `
// ---- 共用輔助函式 ----
var AIM = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1] };
var STEP4 = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function tileAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return '@';
  return map.tiles[y][x];
}

// 和目標在同一直線／斜線、中間沒有擋住 → 回傳要面向的方向
function lineTo(me, t, view) {
  var dx = t.x - me.x, dy = t.y - me.y, dir = null;
  if (Math.abs(dx) < 0.4) dir = dy < 0 ? 'up' : 'down';
  else if (Math.abs(dy) < 0.4) dir = dx < 0 ? 'left' : 'right';
  else if (Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.35) dir = (dy < 0 ? 'up' : 'down') + (dx < 0 ? 'left' : 'right');
  if (!dir) return null;
  var v = AIM[dir], x = Math.floor(me.x), y = Math.floor(me.y), tx = Math.floor(t.x), ty = Math.floor(t.y);
  for (var n = 0; n < 40; n++) {
    x += v[0]; y += v[1];
    if (x === tx && y === ty) return dir;
    var c = tileAt(view.map, x, y);
    if (c === '@' || c === 'B' || c === 'O' || (c === '#' && !view.rules.breakableWalls)) return null;
  }
  return null;
}

// BFS：回傳往 goals（[{x,y}]）中最近一個的下一步方向；cost(c) 回傳通過該格的額外代價（Infinity = 不能走）
function stepToward(me, goals, view, cost) {
  var map = view.map, W = map.width, H = map.height;
  var sx = Math.floor(me.x), sy = Math.floor(me.y), start = sy * W + sx;
  var goal = {};
  goals.forEach(function (g) { goal[Math.floor(g.y) * W + Math.floor(g.x)] = 1; });
  if (goal[start]) return null;
  var dist = {}, first = {}, buckets = [[start]];
  dist[start] = 0;
  for (var d = 0; d < buckets.length && d < 400; d++) {
    var list = buckets[d]; if (!list) continue;
    for (var i = 0; i < list.length; i++) {
      var cur = list[i];
      if (dist[cur] !== d) continue;
      if (goal[cur]) return first[cur];
      var cx = cur % W, cy = (cur - cx) / W;
      for (var k in STEP4) {
        var nx = cx + STEP4[k][0], ny = cy + STEP4[k][1];
        var c = tileAt(map, nx, ny);
        var extra = cost ? cost(c) : (c === '.' || c === '*' || c === 'H' || c === 'P' ? 0 : c === '#' && view.rules.breakableWalls ? 3 : Infinity);
        if (extra === Infinity) continue;
        var id = ny * W + nx, nd = d + 1 + extra;
        if (dist[id] !== undefined && dist[id] <= nd) continue;
        dist[id] = nd; first[id] = cur === start ? k : first[cur];
        (buckets[nd] = buckets[nd] || []).push(id);
      }
    }
  }
  return null;
}

// 走路，前面是磚牆就順便打掉
function walk(me, dir, view) {
  if (!dir) return { move: null, fire: false };
  var v = STEP4[dir], c = tileAt(view.map, Math.floor(me.x) + v[0], Math.floor(me.y) + v[1]);
  return { move: dir, fire: c === '#' && view.rules.breakableWalls && me.dir === dir };
}

// 對任何一個目標有射線就開火（必要時先轉向）
function shootAny(me, list, view) {
  for (var i = 0; i < list.length; i++) {
    var d = lineTo(me, list[i], view);
    if (d) return { move: d === me.dir ? null : d, fire: d === me.dir };
  }
  return null;
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function hpRatio(t) { return t.maxHp ? t.hp / t.maxHp : 1; }

// 職業技能（沒有技能時 me.skill 是 null）：什麼時候按
function wantSkill(view, act) {
  var me = view.me;
  if (!me.skillReady) return false;
  var near = view.enemies.filter(function (e) { return dist(e, me) < 6; });
  switch (me.skill) {
    case 'heal':   // 護士：自己或 3 格內的隊友血不夠就治療
      return hpRatio(me) < 0.6 || view.allies.some(function (a) { return dist(a, me) <= 3 && hpRatio(a) < 0.6; });
    case 'charge': return !!act.fire && view.enemies.length > 0;          // 狙擊：要開火時順便蓄力
    case 'mine':   return near.length > 0;                                   // 爆破：敵人在附近就埋雷
    case 'smoke':  return hpRatio(me) < 0.5 && near.length > 0;              // 偵察：快不行時放煙霧
    case 'dash':   // 突擊：有子彈快打到自己就衝刺閃開
      return view.bullets.some(function (b) { return !b.ally && dist(b, me) < 2.5 && (b.vx * (me.x - b.x) + b.vy * (me.y - b.y)) > 0; });
    default: return false;
  }
}

// 外層：先決定移動和開火，再決定要不要用技能
function think(view, memory) {
  var act = decide(view, memory) || { move: null, fire: false };
  act.skill = wantSkill(view, act);
  return act;
}

function myPlayer(view) {
  for (var i = 0; i < view.allies.length; i++) { var a = view.allies[i]; if (!a.isBot && a.owner === view.me.owner) return a; }
  return null;
}
`;

const GUARD = `// 守門員：守在自己基地（沒有基地就守在自己的玩家）旁邊，敵人靠近才出手
function decide(view, memory) {
  var me = view.me;
  var home = null;
  (view.bases || []).forEach(function (b) { if (b.ally && b.alive) home = b; });
  if (!home) home = myPlayer(view) || memory.home || { x: me.x, y: me.y };
  memory.home = { x: home.x, y: home.y };

  // 靠近守護點 7 格內的敵人
  var threats = view.enemies.filter(function (e) { return dist(e, home) < 7; })
    .sort(function (a, b) { return dist(a, home) - dist(b, home); });
  var shot = shootAny(me, threats.length ? threats : view.enemies.filter(function (e) { return dist(e, me) < 6; }), view);
  if (shot) return shot;
  if (threats.length) return walk(me, stepToward(me, [threats[0]], view), view);

  // 沒事時待在守護點 2～3 格內
  if (dist(me, home) > 3) return walk(me, stepToward(me, [home], view), view);
  return { move: null, fire: false };
}
` + HELPERS;

const ASSASSIN = `// 刺客：專挑敵方玩家（不是電腦），優先打命少、血少的；走路偏好草叢隱藏行蹤
function decide(view, memory) {
  var me = view.me;
  var prey = view.enemies.filter(function (e) { return !e.isBot; });
  if (!prey.length) prey = view.enemies.slice();
  if (!prey.length) return { move: null, fire: false };
  prey.sort(function (a, b) { return (a.lives - b.lives) || (hpRatio(a) - hpRatio(b)) || (dist(a, me) - dist(b, me)); });

  var shot = shootAny(me, prey, view);
  if (shot && !(prey[0].shield > 10)) return shot;
  var bodyguard = shootAny(me, view.enemies.filter(function (e) { return dist(e, me) < 3; }), view);   // 太近的先處理
  if (bodyguard) return bodyguard;

  // 草叢代價比較低 → 盡量走草叢接近
  var dir = stepToward(me, [prey[0]], view, function (c) {
    if (c === '*') return 0;
    if (c === '.' || c === 'H' || c === 'P') return 1;
    if (c === '#' && view.rules.breakableWalls) return 4;
    return Infinity;
  });
  return walk(me, dir, view);
}
` + HELPERS;

const BODYGUARD = `// 保鑣：緊跟自己的玩家，看到朝玩家飛去的子彈就擋在前面或把它打掉
function decide(view, memory) {
  var me = view.me, boss = myPlayer(view);
  if (!boss) {   // 玩家不在（重生中或純代碼對戰）：就近打敵人
    var s0 = shootAny(me, view.enemies, view);
    if (s0) return s0;
    return view.enemies.length ? walk(me, stepToward(me, [view.enemies[0]], view), view) : { move: null, fire: false };
  }

  // 1. 有敵方子彈朝老闆飛來：朝它開火抵消
  for (var i = 0; i < view.bullets.length; i++) {
    var b = view.bullets[i];
    if (b.ally) continue;
    var v = AIM[b.dir], n = Math.hypot(v[0], v[1]);
    var tx = boss.x - b.x, ty = boss.y - b.y;
    var along = (tx * v[0] + ty * v[1]) / n;
    if (along <= 0 || along > 7) continue;
    var off = Math.abs(tx * v[1] - ty * v[0]) / n;
    if (off > 0.6) continue;
    var d = lineTo(me, b, view);
    if (d && me.canFire) return { move: d === me.dir ? null : d, fire: d === me.dir };
  }

  // 2. 威脅老闆最近的敵人
  var foes = view.enemies.slice().sort(function (a, b) { return dist(a, boss) - dist(b, boss); });
  var shot = shootAny(me, foes.filter(function (e) { return dist(e, boss) < 8; }), view);
  if (shot) return shot;

  // 3. 跟在老闆旁邊 1.5～3 格
  if (dist(me, boss) > 3) return walk(me, stepToward(me, [boss], view), view);
  if (dist(me, boss) < 1.2) {
    var away = me.x < boss.x ? 'left' : 'right';
    return { move: away, fire: false };
  }
  return { move: null, fire: false };
}
` + HELPERS;

const C = require('./constants');
const tag = code => `// spec v${C.SPEC_VERSION}\n` + code;
module.exports = {
  standard:  { name: '標準',   desc: '會尋路，找最近的敵人或敵方基地，對齊就開火，打掉擋路的磚牆', code: tag(CLASSIC) },
  guard:     { name: '守門員', desc: '守在基地或你旁邊，敵人靠近才出手；會用職業技能', code: tag(GUARD) },
  assassin:  { name: '刺客',   desc: '專挑敵方玩家、先打命少血少的，走草叢接近；會用職業技能', code: tag(ASSASSIN) },
  bodyguard: { name: '保鑣',   desc: '緊跟著你，把朝你飛來的子彈打掉；會用職業技能（護士會幫你補血）', code: tag(BODYGUARD) },
};
