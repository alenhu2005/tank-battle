'use strict';

// 接到各份範例後方，讓複製出去的代碼可獨立執行。
module.exports = `
function aimAt(from, target) {
  return (Math.atan2(target.x - from.x, from.y - target.y) * 180 / Math.PI + 360) % 360;
}

function tileAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return '@';
  return map.tiles[y][x];
}

// 依序檢查射線穿過的地格，略過起點與目標所在格（目標可能是基地）。
function clearAim(from, target, map) {
  var dx = target.x - from.x, dy = target.y - from.y;
  if (dx === 0 && dy === 0) return null;
  var x = Math.floor(from.x), y = Math.floor(from.y);
  var tx = Math.floor(target.x), ty = Math.floor(target.y);
  var sx = Math.sign(dx), sy = Math.sign(dy);
  var nextX = x === tx ? Infinity : (x + (sx > 0 ? 1 : 0) - from.x) / dx;
  var nextY = y === ty ? Infinity : (y + (sy > 0 ? 1 : 0) - from.y) / dy;
  while (x !== tx || y !== ty) {
    var crossX = nextX <= nextY, crossY = nextY <= nextX;
    if (crossX) { x += sx; nextX = x === tx ? Infinity : nextX + 1 / Math.abs(dx); }
    if (crossY) { y += sy; nextY = y === ty ? Infinity : nextY + 1 / Math.abs(dy); }
    if (x === tx && y === ty) break;
    if ('#@BO'.includes(tileAt(map, x, y))) return null;
  }
  return aimAt(from, target);
}
`;
