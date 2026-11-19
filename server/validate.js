'use strict';

// 送出代碼前的檢查：用「真的遊戲引擎」跑幾場短的測試對戰，
// 確認代碼能載入、think() 回傳格式正確、不會出錯或逾時。

const { Round } = require('./game');
const DEFAULT_BOT = require('./defaultBot');

const SCENARIOS = [
  { mode: 'ffa', baseMode: true, fog: false, opponents: 2, ticks: 240, items: true, ricochet: true },
  { mode: 'team', baseMode: false, fog: true, opponents: 1, ticks: 90 },
  { mode: 'ffa', baseMode: true, fog: false, opponents: 2, ticks: 60, hard: true, codeOnly: true },
  { mode: 'ffa', pve: '2-1', opponents: 0, ticks: 200 },   // 打怪：核心、怪物、view.objective 的 pve 欄位
];

function validateCode(code) {
  const result = { ok: false, errors: [], warnings: [], logs: [], stats: null };
  let timeouts = 0;
  // 偶爾超時多半是伺服器忙碌（例如雲端主機剛開機），不算代碼寫錯；超過這個次數才判定失敗
  const TIMEOUT_TOLERANCE = SCENARIOS.length;   // 平均每場測試容許 1 次
  let calls = 0, totalMs = 0, maxMs = 0;

  for (const sc of SCENARIOS) {
    const sides = [{ key: 'me', name: '測試', color: '#fff', members: [{ playerId: 'me', name: '測試', code, aiPilot: false, cls: 'assault' }] }];
    if (sc.mode !== 'ffa') sides[0].members.push({ playerId: 'mate', name: '隊友', code: DEFAULT_BOT, aiPilot: true });
    for (let i = 0; i < sc.opponents; i++)
      sides.push({ key: 'op' + i, name: '對手' + i, color: '#888', members: [{ playerId: 'op' + i, name: '對手' + i, code: DEFAULT_BOT, aiPilot: true }] });

    let round;
    try {
      if (sc.pve) sides[0].key = 'players';
      round = sc.pve ? new Round({ mode: 'ffa', objective: 'pve', pve: { mode: 'campaign', level: sc.pve, difficulty: 'normal' }, items: true, timeLimit: 0, sides, size: 25 }) : new Round({ mode: sc.mode, baseMode: sc.baseMode, fog: sc.fog, breakableWalls: !sc.hard, codeOnly: !!sc.codeOnly, hpSystem: !!sc.items, specialTerrain: !!sc.items, zone: !!sc.items, items: !!sc.items, ricochet: !!sc.ricochet, timeLimit: 0, sides, size: 21 });
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
        const realErrors = rep.errorCount - rep.timeoutCount;
        timeouts += rep.timeoutCount;
        if (realErrors > 0 || timeouts > TIMEOUT_TOLERANCE) {
          result.errors.push(...rep.errors);
          result.errors.push(`（測試中共發生 ${rep.errorCount} 次錯誤）`);
          return result;
        }
      }
    } finally {
      round.dispose();
    }
  }
  if (timeouts > 0) result.warnings.push(`測試中 ${timeouts} 次超過時間上限，該 tick 不會動作。若經常發生，請優化運算量。`);
  result.ok = true;
  result.stats = { calls, avgMs: calls ? +(totalMs / calls).toFixed(3) : 0, maxMs: +maxMs.toFixed(2) };
  result.logs = result.logs.slice(-15);
  return result;
}

module.exports = { validateCode };
