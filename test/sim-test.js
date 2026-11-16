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

// 子彈反彈、道具、強制結束
{
  const { Round } = require('../server/game');
  const C = require('../server/constants');
  const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: 'function think(){return null}' }] }));
  const r = new Round({ mode: 'ffa', baseMode: false, timeLimit: 0, sides, size: 21, ricochet: true, items: true });
  const S = r.size;
  r.tiles.fill('.');
  r.tiles[5 * S + 10] = '@';
  const t = r.tanks[0];
  r.tanks.filter(o => o !== t).forEach((o, i) => { o.x = 18.5; o.y = 18.5 - i * 2; });
  // 正面打鋼牆：反彈回來
  t.x = 10.5; t.y = 9.5; t.dir = 'up'; t.cooldown = 0;
  r.setInput('p0', { fire: true }); r.step(); r.setInput('p0', { fire: false });
  let b = r.bullets.find(b => b.owner === t.id);
  for (let i = 0; i < 20 && b.dir === 'up'; i++) r.step();
  assert.strictEqual(b.dir, 'down', 'cardinal bounce'); assert.strictEqual(b.bounces, 1);
  // 斜打下方邊界：只翻 y
  r.bullets = [];
  t.x = 5.5; t.y = 18.5; t.dir = 'downright'; t.cooldown = 0;
  r.setInput('p0', { fire: true }); r.step(); r.setInput('p0', { fire: false });
  b = r.bullets.find(b => b.owner === t.id);
  for (let i = 0; i < 20 && b.dir === 'downright'; i++) r.step();
  assert.strictEqual(b.dir, 'upright', 'diagonal bounce flips one axis');
  // 道具：出現、撿到、生效
  r.bullets = [];
  r.items = [{ id: 99, x: 3.5, y: 3.5, type: C.ITEM_TYPES.findIndex(x => x.key === 'rapid'), until: r.playTick + 100 }];
  t.x = 3.5; t.y = 4.5; r.setInput('p0', { move: 'up' });
  for (let i = 0; i < 5; i++) r.step();
  assert(t.rapidBuff > 0 && r.items.length === 0, 'picked up rapid');
  r.setInput('p0', { move: null });
  for (let i = 0; i < 6 * 30; i++) r.step();
  assert(r.items.length >= 1, 'items respawn over time');
  // 強制結束
  r.forceEnd();
  for (let i = 0; i < 3 && !r.over; i++) r.step();
  assert(r.over && r.result.reason === 'forced' && r.result.winner === null, 'force end');
  console.log('ricochet + items + forceEnd OK');
  r.dispose();
}

// 22 種道具逐一測試，加上 30 局隨機對戰（道具全開）不當機
{
  const { Round } = require('../server/game');
  const C = require('../server/constants');
  const idx = k => C.ITEM_TYPES.findIndex(t => t.key === k);
  const mk = (extra = {}) => {
    const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: 'function think(){return null}' }] }));
    const r = new Round({ mode: 'ffa', baseMode: true, timeLimit: 0, sides, size: 21, items: true, ...extra });
    for (const t of r.tanks) t.shield = 0;
    return r;
  };
  const r = mk();
  const me = r.tanks[0], myBot = r.tanks[1], foe = r.tanks[2];
  const give = k => r._applyItem(me, idx(k));
  give('shield'); assert(me.shield >= C.ITEM_SHIELD_TICKS);
  give('speed'); assert(me.speedBuff > 0);
  give('rapid'); assert(me.rapidBuff > 0 && r._maxBullets(me) === me.stats.maxBullets + 1);
  me.lives = 1; give('life'); assert.strictEqual(me.lives, 2);
  give('blast'); assert.strictEqual(me.blastShots, C.BLAST_SHOTS);
  give('pierce'); assert.strictEqual(me.pierceShots, C.PIERCE_SHOTS);
  give('armor'); assert.strictEqual(me.hp, me.stats.hp + 1);
  give('cloak'); assert(me.cloak > 0);
  assert(!JSON.parse(r._viewFor(foe)).enemies.some(e => e.id === me.id), 'cloaked hidden from enemy bot');
  assert(!r.snapshotFor('p1').T.some(a => a[0] === me.id), 'cloaked hidden from enemy player');
  assert(r.snapshotFor('p0').T.some(a => a[0] === me.id), 'cloaked visible to self');
  give('radar'); assert(me.radar > 0);
  give('phase'); assert(me.phase > 0);
  // 散彈：一次 3 發
  r.bullets = []; me.cooldown = 0; give('spread'); me.blastShots = 0; me.pierceShots = 0; r._fire(me);
  assert.strictEqual(r.bullets.filter(b => b.owner === me.id).length, 3, 'spread fires 3');
  // 冰凍彈：命中不扣命，凍住
  r.bullets = []; give('freeze'); me.cooldown = 0; me.spreadBuff = 0; r._fire(me);
  const fb = r.bullets.find(b => b.owner === me.id); assert(fb.freeze);
  foe.x = fb.x; foe.y = fb.y; foe.shield = 0; const lives0 = foe.lives;
  r._bulletHitTank(fb); assert(foe.frozen > 0 && foe.lives === lives0, 'freeze hit');
  // 混亂彈
  me.freezeShots = 0; give('confuse'); r.bullets = []; me.cooldown = 0; r._fire(me);
  const cb = r.bullets.find(b => b.owner === me.id); foe.x = cb.x; foe.y = cb.y; r._bulletHitTank(cb); assert(foe.confused > 0);
  // 被凍住不能動
  const fx = foe.x; r.setInput('p1', { move: 'left' }); foe.frozen = 10; r.startTicks = 0; r.step(); assert.strictEqual(foe.x, fx, 'frozen cannot move');
  foe.frozen = 0; foe.confused = 0;
  // 電磁脈衝、時間暫停
  foe.x = me.x + 2; foe.y = me.y; foe.shield = 0; give('emp'); assert(foe.frozen > 0); foe.frozen = 0;
  foe.x = me.x + 15; give('timestop'); assert(foe.frozen > 0); foe.frozen = 0;
  // 復活電腦
  myBot.alive = false; myBot.lives = 0; give('revive'); assert.strictEqual(myBot.lives, 1); r.step(); assert(myBot.alive, 'bot revived');
  // 基地加固
  const side = r.sides[0]; const ring = (side.base.y - 1) * r.size + side.base.x;
  r.tiles[ring] = '.'; me.x = 1.5; me.y = 1.5; give('fortify'); assert.strictEqual(r.tiles[ring], '#', 'base wall rebuilt');
  // 拆牆
  const cx = 10, cy = 10; r.tiles[(cy + 1) * r.size + cx] = '#'; me.x = cx + 0.5; me.y = cy + 0.5; give('quake'); assert.strictEqual(r.tiles[(cy + 1) * r.size + cx], '.');
  // 回城
  me.x = 10.5; me.y = 10.5; give('home'); assert(Math.abs(me.x - 10.5) + Math.abs(me.y - 10.5) > 2, 'went home');
  // 換位
  r.tanks[3].alive = false; me.x = 4.5; me.y = 15.5; foe.x = 16.5; foe.y = 15.5; foe.alive = true; give('swap'); assert(me.x === 16.5 && foe.x === 4.5, 'swapped');
  // 彈跳、疾風
  r.bullets = []; me.cooldown = 0; me.spreadBuff = 0; me.confuseShots = 0; give('bounce'); give('swift'); r._fire(me);
  const bb = r.bullets.find(b => b.owner === me.id); assert(bb.bounces === C.BOUNCE_BUFF && bb.speed > me.stats.bulletSpeed);
  r.dispose();
  // 穿牆後卡在牆裡也能出來
  const r2 = mk(); const t2 = r2.tanks[0]; r2.startTicks = 0;
  r2.tiles.fill('.'); for (let y = 0; y < r2.size; y++) r2.tiles[y * r2.size + 8] = '#';
  r2.tanks.filter(o => o !== t2).forEach((o, i) => { o.x = 18.5; o.y = 1.5 + i * 2; });
  t2.x = 6.5; t2.y = 10.5; t2.phase = 10; r2.setInput('p0', { move: 'right' });
  for (let i = 0; i < 12; i++) r2.step();
  assert(t2.phase === 0 && t2.x > 8, 'passed through brick');
  for (let i = 0; i < 20; i++) r2.step();
  assert(t2.x > 9.4, 'not stuck inside wall');
  r2.dispose();
  // 隨機 30 局：道具全開＋反彈
  const D = require('../server/defaultBot');
  for (let k = 0; k < 30; k++) {
    const sides = [0, 1, 2].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: D, aiPilot: true, cls: Object.keys(C.CLASSES)[(i + k) % 5] }] }));
    const rr = new Round({ mode: 'ffa', baseMode: k % 2 === 0, fog: k % 3 === 0, timeLimit: 90, sides, items: true, ricochet: k % 2 === 1, breakableWalls: k % 4 !== 0 });
    let picked = 0;
    while (!rr.over) { rr.step(); picked += rr.pickups.length; rr.snapshotFor('p0'); }
    const reps = Object.values(rr.botReports()).flatMap(x => [x.bot, x.pilot]).filter(Boolean);
    assert(reps.every(x => x.errorCount === 0), JSON.stringify(reps.map(x => x.errors)));
    rr.dispose();
  }
  console.log('22 items + 30 random item rounds OK');
}

// 地圖風格、自訂地圖（連不通時自動挖路）、房主關閉道具
{
  const { Round } = require('../server/game');
  const C = require('../server/constants');
  const mkSides = () => [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: 'function think(){return null}' }] }));
  for (const mapStyle of ['random', 'open', 'forest', 'fortress', 'river', 'maze']) {
    const r = new Round({ mode: 'ffa', baseMode: true, timeLimit: 0, sides: mkSides(), mapStyle }); r.dispose();
  }
  // 中間一整排鋼牆：一定連不通，要自動挖出通道
  const size = 21, rows = [];
  for (let y = 0; y < size; y++) rows.push(y === 10 ? '@'.repeat(size) : '.'.repeat(size));
  const r = new Round({ mode: 'ffa', baseMode: true, timeLimit: 0, sides: mkSides(), customMap: { size, tiles: rows.join('') } });
  assert(r.tiles.slice(10 * size, 11 * size).includes('.'), 'custom map got a carved path');
  r.dispose();
  // 只開放護盾
  const only = C.ITEM_TYPES.filter(t => t.key !== 'shield').map(t => t.key);
  const r2 = new Round({ mode: 'ffa', baseMode: false, timeLimit: 0, sides: mkSides(), items: true, disabledItems: only });
  for (let i = 0; i < 40; i++) r2._spawnItem();
  assert(r2.items.length > 0 && r2.items.every(it => C.ITEM_TYPES[it.type].key === 'shield'), 'only enabled items spawn');
  r2.dispose();
  console.log('map styles + custom map + item picker OK');
}

// 新模式：佔點、搶旗、打怪 — 全部用內建 AI 跑完整一局，確認會用模式自己的方式分出勝負
{
  const { Round } = require('../server/game');
  const D = require('../server/defaultBot');
  const C = require('../server/constants');
  const run = (objective, n, extra = {}) => {
    const sides = Array.from({ length: n }, (_, i) => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: D, aiPilot: true, cls: 'assault' }] }));
    const r = new Round({ mode: 'ffa', baseMode: true, timeLimit: 300, sides, objective, ...extra });
    let objEvents = 0;
    while (!r.over) { r.step(); objEvents += r.objEvents.length; const s = r.snapshotFor('p0'); if (s.O && objective !== 'survival') assert.strictEqual(s.O.type, objective); }
    const res = r.result; r.dispose();
    return { reason: res.reason, ticks: res.ticks, objEvents, score: res.objScore, wave: res.pveWave };
  };
  const reasons = { koth: [], ctf: [], pve: [] };
  let captures = 0;
  for (let k = 0; k < 4; k++) {
    reasons.koth.push(run('koth', 2 + (k % 2)).reason);
    const c = run('ctf', 2);
    reasons.ctf.push(c.reason);
    captures += Object.values(c.score || {}).reduce((a, b) => a + b, 0);
    // 打怪：一隊玩家（2 個 AI 玩家）
    const sides = [{ key: 'players', name: '玩家隊', color: '#3ddc84', members: [0, 1].map(i => ({ playerId: 'p' + i, name: 'P' + i, code: D, aiPilot: true, cls: 'heavy' })) }];
    const r = new Round({ mode: 'ffa', baseMode: k % 2 === 0, timeLimit: 0, sides, objective: 'pve' });
    let maxWave = 0; while (!r.over) { r.step(); maxWave = Math.max(maxWave, r.pveWave); }
    reasons.pve.push(r.result.reason + '@wave' + maxWave);
    r.dispose();
  }
  console.log('objective results:', JSON.stringify(reasons));
  assert(reasons.koth.some(x => x === 'koth'), 'koth wins by holding the hill');
  assert(captures > 0 && reasons.ctf.every(x => x === 'ctf' || x === 'time'), 'ctf: flags get captured, games end by captures or time');
  assert(reasons.pve.every(x => /^pve(Win|Lose)@wave[1-5]$/.test(x)), 'pve ends by waves');
  console.log('objectives OK');
}

// 除錯繪圖 API
{
  const { BotSandbox } = require('../server/botRunner');
  const sb = new BotSandbox('function think(v){ debug.line(1,2,3,4,"red"); debug.circle(v.me.x, v.me.y, 2); debug.text(5,5,"目標"); debug.path([{x:1,y:1},{x:2,y:2}], "#0f0"); return {move:"up", fire:true}; }', 't');
  const act = sb.think(JSON.stringify({ me: { x: 3, y: 4 } }), 1);
  assert.deepStrictEqual(act, { move: 'up', fire: true });
  assert.strictEqual(sb.debugOps.length, 4);
  assert.deepStrictEqual(sb.debugOps[0], ['l', 1, 2, 3, 4, 'red']);
  const sb2 = new BotSandbox('function think(){ return {move:"left"}; }', 't2');
  sb2.think('{}', 1); assert.strictEqual(sb2.debugOps, null);
  sb.dispose(); sb2.dispose();
  const { validateCode } = require('../server/validate');
  assert(validateCode('function think(v){ for (var i=0;i<200;i++) debug.circle(i,i,1); return null; }').ok, 'debug spam is capped, not an error');
  console.log('debug draw OK');
}
