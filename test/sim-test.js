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
