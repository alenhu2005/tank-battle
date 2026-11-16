'use strict';
const assert = require('assert');
const { validateCode } = require('../server/validate');
const { Round } = require('../server/game');
const DEFAULT_BOT = require('../server/defaultBot');
const CLS = Object.keys(require('../server/constants').CLASSES);

let t0 = Date.now();
let r = validateCode(DEFAULT_BOT);
console.log('default bot', r.ok, r.errors, r.stats, Date.now() - t0, 'ms');
assert(r.ok);

r = validateCode('function think(v,m){ return {move:"up", fire:true}');
console.log('syntax', r.ok, r.errors); assert(!r.ok);
r = validateCode('function think(v,m){ while(true){} }');
console.log('loop', r.ok, r.errors.slice(0,2)); assert(!r.ok);
r = validateCode('export default function think(v,m){ console.log("hi", v.me.x); return {move:"left",fire:1} }');
console.log('export default', r.ok, r.errors, r.logs.slice(0,1)); assert(r.ok);
r = validateCode('const think = (v) => ({ move: "north" })');
console.log('bad move', r.ok, r.errors.slice(0,1)); assert(!r.ok);
r = validateCode('function think(v){ return v.me.foo.bar }');
console.log('throw', r.ok, r.errors.slice(0,1)); assert(!r.ok);
r = validateCode('var a=[]; function think(v){ for(;;) a.push(new Array(1e6).fill(1)); }');
console.log('oom', r.ok, r.errors.slice(0,1)); assert(!r.ok);
r = validateCode('module.exports = { think(v,m){ return null } }');
console.log('module.exports', r.ok, r.errors); assert(r.ok);
r = validateCode('function think(v){ return process.exit() }');
console.log('no process', r.ok, r.errors.slice(0,1)); assert(!r.ok);

// 完整對戰：5 隊，基地模式，全部用範例代碼（玩家坦克也由代碼控制）
for (const opts of [{ mode: 'ffa', baseMode: true }, { mode: 'ffa', baseMode: false }, { mode: 'faction', baseMode: true }, { mode: 'ffa', baseMode: true, breakableWalls: false }, { mode: 'faction', baseMode: true, breakableWalls: false }, { mode: 'team', baseMode: true, codeOnly: true }]) {
  const sides = opts.mode !== 'faction'
    ? [0,1,2,3,4,5].map(i => ({ key: 's'+i, name: 'P'+i, color: '#fff', members: [{ playerId: 'p'+i, name: 'P'+i, code: DEFAULT_BOT, aiPilot: true, cls: CLS[i % 5] }] }))
    : ['red','blue'].map((k, si) => ({ key: k, name: k, color: '#fff', members: [0,1,2].map(i => ({ playerId: k+i, name: k+i, code: DEFAULT_BOT, aiPilot: true, cls: CLS[(i + si) % 5] })) }));
  const round = new Round({ ...opts, fog: true, timeLimit: 180, sides });
  t0 = process.hrtime.bigint();
  while (!round.over) { round.step(); round.snapshotFor('p0'); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(opts, 'size', round.size, 'winner', round.result.winner, round.result.reason, 'ticks', round.tick,
    'avg ms/tick', (ms / round.tick).toFixed(3), 'kills', round.result.tanks.map(t => t.kills).join(','));
  const reps = Object.values(round.botReports()).flatMap(x => [x.bot, x.pilot]).filter(Boolean);
  assert(reps.every(x => x.errorCount === 0), JSON.stringify(reps.map(x => x.errors)));
  round.dispose();
}
console.log('ALL OK');

// 倒數：前 5 秒不模擬、不呼叫電腦代碼
{
  const { Round } = require('../server/game');
  const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: DEFAULT_BOT, aiPilot: true }] }));
  const r = new Round({ mode: 'ffa', baseMode: true, timeLimit: 60, countdown: 5, sides });
  const before = r.tanks.map(t => [t.x, t.y]).join();
  let s;
  for (let i = 0; i < 150; i++) { r.step(); s = r.snapshotFor(null); }
  assert.strictEqual(r.tanks.map(t => [t.x, t.y]).join(), before, 'tanks moved during countdown');
  assert.strictEqual(s.c, 0);
  assert.strictEqual(r.tanks[1].sandbox.report().calls, 0);
  for (let i = 0; i < 60; i++) r.step();
  assert(r.tanks[1].sandbox.report().calls > 0);
  let kills = 0;
  while (!r.over) { r.step(); kills += r.kills.length; }
  assert(kills > 0, 'kill feed events emitted');
  console.log('countdown + kill feed OK, round ticks', r.result.ticks);
  r.dispose();
}

// 八方向移動：偏離中心也能鑽進 1 格寬通道；斜走撞牆會沿牆滑動；斜向子彈
{
  const { Round } = require('../server/game');
  const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: 'function think(){return null}' }] }));
  const r = new Round({ mode: 'ffa', baseMode: false, timeLimit: 0, sides, size: 21 });
  const S = r.size;
  r.tiles.fill('.');
  // 第 10 列只有第 10 欄是通道，其他是鋼牆
  for (let x = 0; x < S; x++) if (x !== 10) r.tiles[10 * S + x] = '@';
  const t = r.tanks[0];
  r.tanks.filter(o => o !== t).forEach((o, i) => { o.x = 18.5; o.y = 1.5 + i * 2; }); // 其他坦克移到角落，不擋路
  t.x = 10.2; t.y = 7.5; t.shield = 0;
  r.setInput('p0', { move: 'down' });
  for (let i = 0; i < 40; i++) r.step();
  assert(t.y > 11, 'tank should pass through the 1-wide gap, y=' + t.y);
  assert(Math.abs(t.x - 10.5) < 0.01, 'aligned to lane center');
  // 斜走沿牆滑動：往右下走，下方是牆
  t.x = 3.5; t.y = 9.4;
  r.setInput('p0', { move: 'downright' });
  for (let i = 0; i < 10; i++) r.step();
  assert(t.x > 4.2 && t.y < 9.6, 'slides along wall: ' + t.x + ',' + t.y);
  // 斜向子彈
  t.x = 5.5; t.y = 5.5; t.dir = 'upright'; t.cooldown = 0;
  r.setInput('p0', { move: null, fire: true });
  r.step();
  const b = r.bullets.find(b => b.owner === t.id);
  assert(b && b.x > 5.5 && b.y < 5.5 && Math.abs((b.x - 5.5) - (5.5 - b.y)) < 1e-6, 'diagonal bullet');
  console.log('8-direction movement OK');
  r.dispose();
}

// 偶爾一次超時：通過但有警告；一直超時：失敗
{
  const { validateCode } = require('../server/validate');
  const once = validateCode('function think(v,m){ if (v.tick === 5 && !m.done) { m.done = 1; var t = Date.now(); while (Date.now() - t < 60) {} } return null }');
  assert(once.ok && once.warnings.length === 1, 'single timeout tolerated: ' + JSON.stringify(once));
  const always = validateCode('function think(v){ var t = Date.now(); while (Date.now() - t < 60) {} return null }');
  assert(!always.ok, 'repeated timeouts fail');
  console.log('timeout tolerance OK');
}
