// 伺服器與手機共用的移動物理。伺服器用它來模擬；手機用它來「預測」自己的坦克，
// 讓按下搖桿時坦克馬上動，不用等網路來回。兩邊用同一份程式，結果才會一致。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TankPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DIRS = ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright'];
  var DIR_VEC = {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1],
  };
  var UNIT = {};
  DIRS.forEach(function (d) { var v = DIR_VEC[d], n = Math.hypot(v[0], v[1]); UNIT[d] = [v[0] / n, v[1] / n]; });
  var OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left', upleft: 'downright', downright: 'upleft', upright: 'downleft', downleft: 'upright' };
  var TANK_SOLID = { '#': 1, '@': 1, '~': 1, B: 1 };
  var PHASE_SOLID = { '@': 1, B: 1 };

  // world = { size, tiles: 陣列或字串, tankSize, alignRate }
  // t = { x, y, dir, phase }（phase > 0 表示穿牆中）；others = 其他「活著」的坦克 [{x,y}]
  function tileBlocked(world, x, y, phase) {
    var half = world.tankSize / 2, solid = phase ? PHASE_SOLID : TANK_SOLID;
    var x0 = Math.floor(x - half + 1e-6), x1 = Math.floor(x + half - 1e-6);
    var y0 = Math.floor(y - half + 1e-6), y1 = Math.floor(y + half - 1e-6);
    if (x0 < 0 || y0 < 0 || x1 >= world.size || y1 >= world.size) return true;
    for (var ty = y0; ty <= y1; ty++)
      for (var tx = x0; tx <= x1; tx++)
        if (solid[world.tiles[ty * world.size + tx]]) return true;
    return false;
  }

  function blocked(world, t, x, y, others) {
    var phase = t.phase > 0, S = world.tankSize - 1e-6;
    // 穿牆結束時如果還卡在牆裡，允許移動直到出來
    if (tileBlocked(world, x, y, phase) && !tileBlocked(world, t.x, t.y, phase)) return true;
    // 已經重疊的坦克（例如剛重生）允許彼此分開，不允許新的重疊
    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      if (Math.abs(o.x - x) >= S || Math.abs(o.y - y) >= S) continue;
      var overlapOld = Math.abs(o.x - t.x) < S && Math.abs(o.y - t.y) < S;
      if (!overlapOld) return true;
      if (Math.abs(o.x - x) + Math.abs(o.y - y) < Math.abs(o.x - t.x) + Math.abs(o.y - t.y)) return true;
    }
    return false;
  }

  function moveAxis(world, t, mx, my, others) {
    if (!mx && !my) return;
    var parts = 8;
    for (var i = 0; i < parts; i++) {
      var nx = t.x + mx / parts, ny = t.y + my / parts;
      if (blocked(world, t, nx, ny, others)) break;
      t.x = nx; t.y = ny;
    }
  }

  function align(world, t, axis, maxStep, others) {
    var c = t[axis], d = Math.floor(c) + 0.5 - c;
    if (Math.abs(d) < 1e-4) return;
    var mv = Math.sign(d) * Math.min(Math.abs(d), maxStep);
    var fs = [1, 0.5, 0.25];
    for (var i = 0; i < fs.length; i++) {
      var nx = axis === 'x' ? t.x + mv * fs[i] : t.x, ny = axis === 'y' ? t.y + mv * fs[i] : t.y;
      if (!blocked(world, t, nx, ny, others)) { t.x = nx; t.y = ny; return; }
    }
  }

  // 往 dir 移動一個 tick；step = 這個 tick 的移動距離（格）
  function move(world, t, dir, step, others) {
    var u = UNIT[dir];
    t.dir = dir;
    moveAxis(world, t, u[0] * step, 0, others);          // 兩軸分開：斜走撞牆會沿牆滑動
    moveAxis(world, t, 0, u[1] * step, others);
    if (u[0] === 0) align(world, t, 'x', step * world.alignRate, others);  // 直走時自動靠向格子中心
    if (u[1] === 0) align(world, t, 'y', step * world.alignRate, others);
    t.x = Math.round(t.x * 1e4) / 1e4;
    t.y = Math.round(t.y * 1e4) / 1e4;
  }

  // 瞄準輔助線：從 (x, y) 往 dir 追蹤子彈路徑（會算反彈），回傳折線的點
  function traceShot(world, x, y, dir, bounces, maxLen, breakable) {
    var pts = [[x, y]], len = 0, step = 0.05;
    var v = DIR_VEC[dir].slice(), u = UNIT[dir].slice();
    function stops(px, py) {
      var tx = Math.floor(px), ty = Math.floor(py);
      if (tx < 0 || ty < 0 || tx >= world.size || ty >= world.size) return 'edge';
      var c = world.tiles[ty * world.size + tx];
      if (c === '@') return 'steel';
      if (c === '#') return breakable ? 'brick' : 'steel';
      if (c === 'B') return 'base';
      return null;
    }
    while (len < maxLen) {
      var px = x, py = y;
      x += u[0] * step; y += u[1] * step; len += step;
      var hit = stops(x, y);
      if (!hit) continue;
      if ((hit === 'steel' || hit === 'edge') && bounces > 0) {
        var xHit = !!stops(x, py), yHit = !!stops(px, y);
        if (v[0] && v[1]) {
          if (xHit && !yHit) v[0] = -v[0];
          else if (yHit && !xHit) v[1] = -v[1];
          else { v[0] = -v[0]; v[1] = -v[1]; }
        } else { v[0] = -v[0]; v[1] = -v[1]; }
        x = px; y = py;
        var n = Math.hypot(v[0], v[1]); u = [v[0] / n, v[1] / n];
        bounces--;
        pts.push([x, y]);
        continue;
      }
      pts.push([x, y]);
      return pts;
    }
    pts.push([x, y]);
    return pts;
  }

  return {
    DIRS: DIRS, DIR_VEC: DIR_VEC, UNIT: UNIT, OPPOSITE: OPPOSITE,
    tileBlocked: tileBlocked, blocked: blocked, move: move, traceShot: traceShot,
  };
});
