'use strict';

// 送出代碼前的檢查：用「真的遊戲引擎」跑幾場短的測試對戰，
// 確認代碼能載入、think() 回傳格式正確、不會出錯或逾時。

const { Round } = require('./game');
const DEFAULT_BOT = require('./defaultBot');

const SCENARIOS = [
  { mode: 'ffa', baseMode: true, fog: false, opponents: 2, ticks: 120 },
  { mode: 'team', baseMode: false, fog: true, opponents: 1, ticks: 90 },
  { mode: 'ffa', baseMode: true, fog: false, opponents: 2, ticks: 60, hard: true, codeOnly: true },
];

function validateCode(code) {
  const result = { ok: false, errors: [], logs: [], stats: null };
  let calls = 0, totalMs = 0, maxMs = 0;

  for (const sc of SCENARIOS) {
    const sides = [{ key: 'me', name: '測試', color: '#fff', members: [{ playerId: 'me', name: '測試', code, aiPilot: false, cls: 'assault' }] }];
    if (sc.mode !== 'ffa') sides[0].members.push({ playerId: 'mate', name: '隊友', code: DEFAULT_BOT, aiPilot: true });
    for (let i = 0; i < sc.opponents; i++)
      sides.push({ key: 'op' + i, name: '對手' + i, color: '#888', members: [{ playerId: 'op' + i, name: '對手' + i, code: DEFAULT_BOT, aiPilot: true }] });

    let round;
    try {
      round = new Round({ mode: sc.mode, baseMode: sc.baseMode, fog: sc.fog, breakableWalls: !sc.hard, codeOnly: !!sc.codeOnly, timeLimit: 0, sides, size: 21 });
    } catch (e) {
      result.errors.push('測試環境建立失敗：' + e.message);
      return result;
    }
    try {
      const mine = round.tanks.filter(t => t.owner === 'me' && t.sandbox);
      if (mine[0].sandbox.initError) {
        result.errors.push(mine[0].sandbox.initError);
        return result;
      }
      for (let i = 0; i < sc.ticks && !round.over; i++) round.step();
      for (const t of mine) {
        const rep = t.sandbox.report();
        calls += rep.calls; totalMs += rep.avgMs * rep.calls; maxMs = Math.max(maxMs, rep.maxMs);
        result.logs.push(...rep.logs.slice(-10));
        if (rep.errorCount > 0) {
          result.errors.push(...rep.errors);
          result.errors.push(`（測試中共發生 ${rep.errorCount} 次錯誤）`);
          return result;
        }
      }
    } finally {
      round.dispose();
    }
  }
  result.ok = true;
  result.stats = { calls, avgMs: calls ? +(totalMs / calls).toFixed(3) : 0, maxMs: +maxMs.toFixed(2) };
  result.logs = result.logs.slice(-15);
  return result;
}

module.exports = { validateCode };
