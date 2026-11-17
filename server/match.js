'use strict';

// 擂台對戰：兩份代碼打兩場（交換出生位置），純代碼 1 對 1。
// 每場有時間上限（真實時間），太慢的代碼不會卡住伺服器。
const { Round } = require('./game');
const zlib = require('zlib');

const WALL_BUDGET_MS = 12000;

// 回傳勝負，並附上兩場的重播（gzip 壓縮的 JSON）
function runMatch(codeA, codeB, nameA = 'A', nameB = 'B') {
  const out = { games: 0, wins: 0, losses: 0, draws: 0, replays: [] };
  const COLORS = { A: '#f2c94c', B: '#4aa8ff' };
  for (let g = 0; g < 2; g++) {
    const sides = [['A', codeA, nameA], ['B', codeB, nameB]].map(([key, code, name]) => ({ key, name, color: COLORS[key], members: [{ playerId: key, name, code }] }));
    if (g === 1) sides.reverse();
    const r = new Round({ mode: 'ffa', codeOnly: true, baseMode: g === 0, items: true, timeLimit: 90, sides });
    const t0 = Date.now();
    const frames = [];
    let w = null;
    try {
      while (!r.over && Date.now() - t0 < WALL_BUDGET_MS) { r.step(); frames.push(JSON.stringify(r.snapshotFor(null))); }
      w = r.over && r.result ? r.result.winner : null;
      out.games++;
      if (w === 'A') out.wins++; else if (w === 'B') out.losses++; else out.draws++;
      const json = `{"v":1,"title":${JSON.stringify(`${nameA} vs ${nameB}・第 ${g + 1} 場`)},"result":${JSON.stringify(w === 'A' ? 'win' : w === 'B' ? 'loss' : 'draw')},"meta":${JSON.stringify(r.meta())},"frames":[${frames.join(',')}]}`;
      out.replays.push(zlib.gzipSync(json, { level: 7 }));
    } finally { r.dispose(); }
  }
  return out;
}

module.exports = { runMatch };
