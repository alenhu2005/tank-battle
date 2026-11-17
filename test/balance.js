'use strict';
// 平衡測試：五個職業各一隊（玩家坦克也用範例代碼開），隨機位置，統計勝率與擊殺
const { Round } = require('../server/game');
const DEFAULT_BOT = require('../server/bots/classic');
const C = require('../server/constants');
const CLS = Object.keys(C.CLASSES);
const N = +process.argv[2] || 60;
const stats = Object.fromEntries(CLS.map(c => [c, { wins: 0, kills: 0, deaths: 0, duelW: 0, duelN: 0 }]));
for (let r = 0; r < N; r++) {
  const order = CLS.slice().sort(() => Math.random() - 0.5);
  const sides = order.map((c, i) => ({ key: c, name: c, color: '#fff', members: [{ playerId: c, name: c, code: DEFAULT_BOT, aiPilot: true, cls: c }] }));
  const round = new Round({ mode: 'ffa', baseMode: r % 2 === 0, fog: false, timeLimit: 240, breakableWalls: r % 3 !== 0, sides });
  while (!round.over) round.step();
  if (round.result.winner) stats[round.result.winner].wins++;
  for (const t of round.result.tanks) if (!t.isBot) { stats[t.side].kills += t.kills; stats[t.side].deaths += t.deaths; }
  round.dispose();
}
// 1 對 1 決鬥（無基地、牆可破）
for (let i = 0; i < CLS.length; i++) for (let j = i + 1; j < CLS.length; j++) for (let k = 0; k < Math.max(4, N / 10); k++) {
  const a = CLS[i], b = CLS[j];
  const sides = [a, b].map(c => ({ key: c, name: c, color: '#fff', members: [{ playerId: c, name: c, code: DEFAULT_BOT, aiPilot: true, cls: c }] }));
  if (k % 2) sides.reverse();
  const round = new Round({ mode: 'ffa', baseMode: false, timeLimit: 180, sides });
  while (!round.over) round.step();
  stats[a].duelN++; stats[b].duelN++;
  if (round.result.winner) stats[round.result.winner].duelW++;
  round.dispose();
}
for (const c of CLS) {
  const s = stats[c];
  console.log(C.CLASSES[c].name.padEnd(3), `FFA勝 ${(s.wins / N * 100).toFixed(0).padStart(3)}%`, `K/D ${(s.kills / Math.max(1, s.deaths)).toFixed(2)}`, `1v1勝 ${(s.duelW / s.duelN * 100).toFixed(0)}%`);
}
