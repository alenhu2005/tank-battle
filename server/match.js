'use strict';

// 擂台對戰：兩份代碼打兩場（交換出生位置），純代碼 1 對 1。
// 每場有時間上限（真實時間），太慢的代碼不會卡住伺服器。
const { Round } = require('./game');

const WALL_BUDGET_MS = 12000;

function runMatch(codeA, codeB) {
  const out = { games: 0, wins: 0, losses: 0, draws: 0 };
  for (let g = 0; g < 2; g++) {
    const sides = [['A', codeA], ['B', codeB]].map(([key, code]) => ({ key, name: key, color: '#fff', members: [{ playerId: key, name: key, code }] }));
    if (g === 1) sides.reverse();
    const r = new Round({ mode: 'ffa', codeOnly: true, baseMode: g === 0, items: true, timeLimit: 90, sides });
    const t0 = Date.now();
    try {
      while (!r.over && Date.now() - t0 < WALL_BUDGET_MS) r.step();
      const w = r.over && r.result ? r.result.winner : null;
      out.games++;
      if (w === 'A') out.wins++; else if (w === 'B') out.losses++; else out.draws++;
    } finally { r.dispose(); }
  }
  return out;
}

module.exports = { runMatch };
