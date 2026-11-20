'use strict';
const assert = require('assert');
const { validateCode } = require('../server/validate');
const { Round } = require('../server/game');
const DEFAULT_BOT = require('../server/defaultBot');
const CLASSIC = require('../server/bots/classic');
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
  const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: CLASSIC, aiPilot: true }] }));
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
  t.x = 5.5; t.y = 5.5; t.dir = 'upright'; t.angle = 45; t.cooldown = 0;
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
  t.x = 10.5; t.y = 9.5; t.dir = 'up'; t.angle = 0; t.cooldown = 0;
  r.setInput('p0', { fire: true }); r.step(); r.setInput('p0', { fire: false });
  let b = r.bullets.find(b => b.owner === t.id);
  for (let i = 0; i < 20 && b.dir === 'up'; i++) r.step();
  assert.strictEqual(b.dir, 'down', 'cardinal bounce'); assert.strictEqual(b.bounces, 1);
  // 斜打下方邊界：只翻 y
  r.bullets = [];
  t.x = 5.5; t.y = 18.5; t.dir = 'downright'; t.angle = 135; t.cooldown = 0;
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
  t2.x = 6.5; t2.y = 10.5; t2.phase = 18; r2.setInput('p0', { move: 'right' });
  for (let i = 0; i < 20; i++) r2.step();
  assert(t2.phase === 0 && t2.x > 8, 'passed through brick');
  for (let i = 0; i < 20; i++) r2.step();
  assert(t2.x > 9.4, 'not stuck inside wall');
  r2.dispose();
  // 隨機 30 局：道具全開＋反彈
  const D = require('../server/bots/classic');
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
  const D = require('../server/bots/classic');
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
    let maxWave = 0, guard = 0; while (!r.over && guard++ < 30 * 60 * 8) { r.step(); maxWave = Math.max(maxWave, r.pve.wave); }
    if (!r.over) { r.forceEnd(); r.step(); }
    reasons.pve.push(r.result.reason + '@wave' + maxWave);
    r.dispose();
  }
  console.log('objective results:', JSON.stringify(reasons));
  assert(reasons.koth.some(x => x === 'koth'), 'koth wins by holding the hill');
  assert(captures > 0 && reasons.ctf.every(x => x === 'ctf' || x === 'time' || x === 'timeDraw'), 'ctf: flags get captured, games end by captures or time');
  assert(reasons.pve.every(x => /^pve(Win|Lose|Time|Core|Npc)@wave\d+$/.test(x) || /^forced/.test(x)), 'pve ends');
  console.log('objectives OK');
}

// 除錯繪圖 API
{
  const { BotSandbox } = require('../server/botRunner');
  const sb = new BotSandbox('function think(v){ debug.line(1,2,3,4,"red"); debug.circle(v.me.x, v.me.y, 2); debug.text(5,5,"目標"); debug.path([{x:1,y:1},{x:2,y:2}], "#0f0"); return {move:"up", fire:true}; }', 't');
  const act = sb.think(JSON.stringify({ me: { x: 3, y: 4 } }), 1);
  assert.deepStrictEqual(act, { move: 'up', fire: true, skill: false });
  assert.strictEqual(sb.debugOps.length, 4);
  assert.deepStrictEqual(sb.debugOps[0], ['l', 1, 2, 3, 4, 'red']);
  const sb2 = new BotSandbox('function think(){ return {move:"left"}; }', 't2');
  sb2.think('{}', 1); assert.strictEqual(sb2.debugOps, null);
  sb.dispose(); sb2.dispose();
  const { validateCode } = require('../server/validate');
  assert(validateCode('function think(v){ for (var i=0;i<200;i++) debug.circle(i,i,1); return null; }').ok, 'debug spam is capped, not an error');
  console.log('debug draw OK');
}

// 無段落（任意角度）：移動、靠格子中心、射擊、反彈、電腦代碼回傳數字
{
  const { Round } = require('../server/game');
  const { validateCode } = require('../server/validate');
  const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: 'function think(){return null}' }] }));
  const r = new Round({ mode: 'ffa', baseMode: false, timeLimit: 0, sides, size: 21, ricochet: true });
  r.startTicks = 0;
  r.tiles.fill('.');
  const t = r.tanks[0];
  r.tanks.filter(o => o !== t).forEach((o, i) => { o.x = 19.5; o.y = 1.5 + i * 2; });
  // 30°：往右上，x 增加量 / y 減少量 ≈ tan(30°)
  t.x = 5.5; t.y = 15.5; t.shield = 0;
  r.setInput('p0', { move: 30 });
  for (let i = 0; i < 10; i++) r.step();
  const dx = t.x - 5.5, dy = 15.5 - t.y;
  assert(Math.abs(dx / dy - Math.tan(Math.PI / 6)) < 0.02, `moves at 30°: ${dx}/${dy}`);
  assert.strictEqual(Math.round(t.angle), 30); assert.strictEqual(t.dir, 'upright');
  // 離正上 8°：移動當作直走並靠中心，砲管照實際角度
  t.x = 10.2; t.y = 15.5;
  r.setInput('p0', { move: 8 });
  for (let i = 0; i < 10; i++) r.step();
  assert(Math.abs(t.x - 10.5) < 0.01 && Math.round(t.angle) === 8, 'near-cardinal snaps movement to lane');
  // 任意角度射擊
  r.setInput('p0', { move: null });
  t.x = 10.5; t.y = 10.5; t.angle = 200; t.cooldown = 0; r.bullets = [];
  r._fire(t);
  const b = r.bullets[0];
  assert(Math.abs(Math.atan2(b.vx, -b.vy) * 180 / Math.PI + 160) < 0.01, 'bullet at 200°');
  // 斜射撞右邊界：只翻 x
  r.bullets = []; t.x = 18.5; t.y = 10.5; t.angle = 60; t.cooldown = 0; r._fire(t);
  const bb = r.bullets[0];
  for (let i = 0; i < 30 && bb.vx > 0; i++) r.step();
  assert(bb.vx < 0 && bb.vy < 0 && Math.round(bb.angle) === 300, 'bounce off right wall: 60° -> 300°, got ' + bb.angle);
  r.dispose();
  // 電腦代碼回傳角度
  assert(validateCode('function think(v){ return { move: 137.5, fire: true }; }').ok, 'numeric move accepted');
  const bad = validateCode('function think(){ return { move: "northeast" }; }');
  assert(!bad.ok && /角度/.test(bad.errors[0]), 'helpful error mentions angles');
  console.log('analog control OK');
}

// 玩家與電腦都能邊移動邊朝其他角度射擊，沒有 aim 的舊輸入沿用車身角度
{
  const C = require('../server/constants');
  const sides = [
    { key: 'a', name: 'A', color: '#fff', members: [{ playerId: 'p', name: 'P', code: 'function think(){return {move:"left", aim:-137.5, fire:true}}' }] },
    { key: 'b', name: 'B', color: '#eee', members: [{ playerId: 'q', name: 'Q', code: 'function think(){return null}' }] },
  ];
  const r = new Round({ mode: 'ffa', sides, countdown: 0 });
  r.tiles.fill('.');
  const [player, bot] = r.tanks;
  r.tanks.forEach((t, i) => { t.x = 5.5 + i * 3; t.y = 10.5; });
  player.spreadBuff = 2;
  r.setInput('p', { move: 90, aim: 0, fire: true });
  r.step();
  assert(player.x > 5.5 && bot.x < 8.5);
  assert.strictEqual(player.angle, 90);
  assert.strictEqual(bot.angle, 270);
  assert.deepStrictEqual(r.bullets.filter(b => b.owner === player.id).map(b => b.angle), [0, 360 - C.SPREAD_ANGLE, C.SPREAD_ANGLE]);
  assert.strictEqual(r.bullets.find(b => b.owner === bot.id).angle, 222.5);
  assert.deepStrictEqual(r.snapshotFor(null).A, [[player.id, 0], [bot.id, 222.5]]);
  assert.strictEqual(JSON.parse(r._viewFor(bot)).me.aim, 222.5);
  r.bullets = [];
  player.cooldown = 0;
  r.setInput('p', { move: null, fire: true });
  r.step();
  assert.strictEqual(r.bullets.find(b => b.owner === player.id).angle, 90);
  assert(!r.snapshotFor(null).A.some(([id]) => id === player.id));
  r.dispose();

  assert(validateCode('function think(){return {aim:"up", fire:true}}').ok);
  const invalid = validateCode('function think(){return {aim:"north", fire:true}}');
  assert(!invalid.ok && invalid.errors.some(error => error.includes('aim')));
  console.log('independent turret aim OK');
}

// 延遲補償：敵人在子彈飛到前最後 6 tick 才閃開；玩家畫面落後 6 tick，畫面上確實打中了
{
  const { Round } = require('../server/game');
  const run = (lagged) => {
    const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: 'function think(){return null}' }] }));
    const r = new Round({ mode: 'ffa', baseMode: false, timeLimit: 0, sides, size: 21 });
    r.startTicks = 0; r.tiles.fill('.');
    const me = r.tanks[0], foe = r.tanks[2];
    r.tanks[1].x = 1.5; r.tanks[1].y = 19.5; r.tanks[3].x = 19.5; r.tanks[3].y = 19.5;
    me.x = 10.5; me.y = 15.5; me.angle = 0; me.shield = 0;
    foe.x = 10.5; foe.y = 9.5; foe.shield = 0;
    for (let i = 0; i < 3; i++) r.step();
    const view = () => r.tick - (lagged ? 6 : 0);
    r.setInput('p0', { move: null, fire: true, view: view() });
    r.step();
    r.setInput('p0', { move: null, fire: false, view: view() });
    const b = r.bullets.find(x => x.owner === me.id);
    const perTick = b.speed / 30;
    for (let i = 0; i < 60 && foe.alive; i++) {
      // 子彈還差 6 tick 就到的時候，敵人開始往右閃
      if (b && !b.dead && b.y - (foe.y + 0.45) <= perTick * 6) r.setInput('p1', { move: 'right' });
      r.step();
    }
    const hit = !foe.alive;
    r.dispose();
    return hit;
  };
  const withComp = run(true), without = run(false);
  console.log('lag compensation: hit with comp =', withComp, '| hit without =', without);
  assert(withComp && !without, 'lag compensation should register the on-screen hit');
  console.log('lag compensation OK');
}

// 職業技能：衝刺、護盾牆、煙霧、蓄力射擊、地雷、工兵築牆／修基地
{
  const { Round } = require('../server/game');
  const C = require('../server/constants');
  const mk = (cls, extra = {}) => {
    const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: 'function think(){return null}', cls: i === 0 ? cls : 'assault' }] }));
    const r = new Round({ mode: 'ffa', baseMode: true, timeLimit: 0, sides, size: 21, ...extra });
    r.startTicks = 0;
    for (let i = 0; i < r.tiles.length; i++) if (r.tiles[i] !== 'B' && !r.wallHp.has(i)) r.tiles[i] = '.';
    for (const t of r.tanks) t.shield = 0;
    const me = r.tanks[0], foe = r.tanks[2];
    r.tanks[1].x = 1.5; r.tanks[1].y = 10.5; r.tanks[3].x = 19.5; r.tanks[3].y = 10.5;
    return { r, me, foe };
  };
  // 衝刺：0.5 秒移動距離是平常的 2.5 倍
  { const { r, me } = mk('assault'); me.x = 5.5; me.y = 14.5; me.angle = 90;
    r.setInput('p0', { move: 90, skill: true }); r.step(); r.setInput('p0', { move: 90 });
    for (let i = 0; i < 9; i++) r.step();
    const normal = me.stats.speed / 30 * 10;
    assert(me.x - 5.5 > normal * 2, 'dash moves faster: ' + (me.x - 5.5) + ' vs ' + normal);
    assert(me.skillCd > 0, 'cooldown started'); r.dispose(); }
  // 護盾牆：前方 3 格變鋼牆，5 秒後恢復
  { const { r, me } = mk('heavy'); me.x = 10.5; me.y = 14.5; me.angle = 0;
    r.setInput('p0', { skill: true }); r.step(); r.setInput('p0', {});
    const row = () => [9, 10, 11].map(x => r.tiles[13 * r.size + x]).join('');
    assert.strictEqual(row(), '@@@', 'shield wall up');
    for (let i = 0; i < 5 * 30 + 2; i++) r.step();
    assert.strictEqual(row(), '...', 'shield wall gone'); r.dispose(); }
  // 煙霧：敵方電腦看不到煙霧裡的坦克
  { const { r, me, foe } = mk('scout'); me.x = 10.5; me.y = 14.5;
    r.setInput('p0', { skill: true }); r.step();
    assert(!JSON.parse(r._viewFor(r.tanks[3])).enemies.some(e => e.id === me.id), 'hidden in smoke');
    assert(!r.snapshotFor('p1').T.some(a => a[0] === me.id), 'hidden from enemy player'); r.dispose(); }
  // 蓄力射擊：穿過第一台坦克，打到後面那台
  { const { r, me, foe } = mk('sniper'); me.x = 5.5; me.y = 16.5; me.angle = 0;
    foe.x = 5.5; foe.y = 13.5; const back = r.tanks[3]; back.x = 5.5; back.y = 10.5; for (const y of [10, 11, 12, 13, 14, 15]) r.tiles[y * r.size + 5] = '.'; back.shield = 0; foe.lives = 9; back.lives = 9;
    r.setInput('p0', { skill: true }); r.step(); r.setInput('p0', { fire: true }); r.step(); r.setInput('p0', {});
    for (let i = 0; i < 40; i++) r.step();
    assert(foe.deaths === 1 && back.deaths === 1, `pierce hits both: ${foe.deaths} ${back.deaths}`); r.dispose(); }
  // 地雷：敵人踩到就爆炸
  { const { r, me, foe } = mk('demo'); me.x = 6.5; me.y = 14.5;
    r.setInput('p0', { skill: true }); r.step(); r.setInput('p0', {});
    assert.strictEqual(r.mines.length, 1);
    assert(!JSON.parse(r._viewFor(r.tanks[3])).mines.length, 'enemy cannot see mine');
    for (let i = 0; i < 35; i++) r.step();
    me.x = 2.5; foe.x = 6.5; foe.y = 14.5; foe.lives = 9; r.step();
    assert(foe.deaths === 1 && r.mines.length === 0, 'mine exploded'); r.dispose(); }
  // 工兵：前方蓋牆；在基地旁修牆
  { const { r, me } = mk('engineer'); me.x = 10.5; me.y = 14.5; me.angle = 0;
    r.setInput('p0', { skill: true }); r.step(); r.setInput('p0', {});
    assert.strictEqual(r.tiles[13 * r.size + 10], '#', 'built a brick');
    const base = r.sides[0].base, idx = (base.y + 1) * r.size + base.x;
    r.tiles[idx] = '.'; r.wallHp.delete(idx);
    me.skillCd = 0; me.x = base.x + 0.5 + 2; me.y = base.y + 2.5;
    r.setInput('p0', { skill: true }); r.step();
    assert(r.tiles[idx] === '#' && r.wallHp.get(idx) === C.BASE_WALL_HP, 'repaired base wall'); r.dispose(); }
  // 電腦代碼也能用技能
  { const { validateCode } = require('../server/validate');
    assert(validateCode('function think(v){ return { move: 45, fire: true, skill: v.me.skillReady }; }').ok); }
  console.log('class skills OK');
}

// 護送模式：內建 AI 對打，會用推到終點或守住分出勝負；路線要挖通
{
  const { Round } = require('../server/game');
  const D = require('../server/bots/classic');
  const out = [];
  for (let k = 0; k < 4; k++) {
    const sides = ['red', 'blue'].map((key, si) => ({ key, name: key, color: '#fff', members: [0, 1].map(i => ({ playerId: key + i, name: key + i, code: D, aiPilot: true, cls: 'assault' })) }));
    const r = new Round({ mode: 'faction', timeLimit: 120, sides, objective: 'escort', attackerIndex: k % 2 });
    const path = r.cart.path;
    assert(path.every(p => '.*'.includes(r.tiles[Math.floor(p[1]) * r.size + Math.floor(p[0])])), 'escort path is open');
    let maxI = r.cart.i;
    while (!r.over) { r.step(); maxI = Math.max(maxI, r.cart.i); }
    out.push(`${r.result.reason}(${Math.round((maxI - r.cart.start) / (r.cart.end - r.cart.start) * 100)}%)`);
    r.dispose();
  }
  console.log('escort results:', out.join(' '));
  assert(out.every(x => /^escort(Win|Defend)/.test(x)), 'escort ends by cart or time');
  assert(out.some(x => !x.endsWith('(0%)')), 'cart moved in at least one game');
  console.log('escort OK');
}

// 電腦職業：房間設定打開時電腦拿到選的職業和技能；關閉時是標準規格
{
  const { Round } = require('../server/game');
  const { Room } = require('../server/room');
  const code = 'function think(view){ return { move: null, fire: false, skill: view.me.skillReady }; }';
  const mk = (botCls, codeOnly) => {
    const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code, cls: 'heavy', botCls: i === 0 ? botCls : null }] }));
    return new Round({ mode: 'ffa', baseMode: false, timeLimit: 0, sides, size: 21, codeOnly });
  };
  { const r = mk('scout'); r.startTicks = 0;
    const bot = r.tanks.find(t => t.owner === 'p0' && t.isBot), other = r.tanks.find(t => t.owner === 'p1' && t.isBot);
    assert.strictEqual(bot.cls, 'scout'); assert.strictEqual(other.cls, 'bot');
    assert.strictEqual(bot.stats.speed, r.statsFor('scout').speed);
    assert.strictEqual(JSON.parse(r._viewFor(bot)).rules.botClasses, true);
    for (let i = 0; i < 3; i++) r.step();
    assert(bot.skillCd > 0 && r.smokes.length === 1, 'bot used smoke skill');
    assert(!(other.skillCd > 0), 'classless bot has no skill');
    r.dispose(); }
  { const r = mk(null); assert(r.tanks.filter(t => t.isBot).every(t => t.cls === 'bot'));
    assert.strictEqual(JSON.parse(r._viewFor(r.tanks[1])).rules.botClasses, false); r.dispose(); }
  { const r = mk('sniper', true); assert.strictEqual(r.tanks.length, 2); assert.strictEqual(r.tanks[0].cls, 'sniper'); r.dispose(); }
  // 房間：設定關閉時 botCls 不會傳進遊戲
  const room = new Room('9999', () => {});
  const ai = room.addAI();
  assert(ai.botCls, 'AI gets a random bot class');
  assert.strictEqual(room._member(ai).botCls, null);
  room.settings.botClasses = true;
  assert.strictEqual(room._member(ai).botCls, ai.botCls);
  room.close();
  console.log('bot classes OK');
}

// 血量系統：扣血、職業傷害、回血、醫療包、護士治療、狙擊距離加成、重裝爆炸減半、房主設定血量
{
  const { Round } = require('../server/game');
  const C = require('../server/constants');
  // 這段測的是血量機制本身：先關掉玩家／電腦的職業差異
  const savedEdge = { ...C.PLAYER_EDGE }, savedBotEdge = { ...C.BOT_CLASS_EDGE };
  Object.assign(C.PLAYER_EDGE, { hp: 1, damage: 1, cooldown: 1 }); for (const k in C.BOT_CLASS_EDGE) delete C.BOT_CLASS_EDGE[k];
  const idle = 'function think(){ return null; }';
  const mk = (cls0, cls1, extra = {}) => {
    const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: idle, cls: i ? cls1 : cls0 }] }));
    const r = new Round({ mode: 'ffa', baseMode: false, timeLimit: 0, sides, size: 21, hpSystem: true, ...extra });
    r.startTicks = 0;
    for (const t of r.tanks) t.shield = 0;
    return { r, a: r.tanks[0], b: r.tanks[2] };
  };
  { const { r, a, b } = mk('assault', 'heavy', { regen: true });
    assert.strictEqual(a.maxHp, 100); assert.strictEqual(b.maxHp, Math.round(100 * C.HP.hpFactor.heavy));
    assert.strictEqual(r.tanks[1].maxHp, 100, 'bot hp');
    r._damage(b, a, b.x, b.y, 'shot', 25);
    assert.strictEqual(b.hp, b.maxHp - 25); assert(b.alive);
    r._damage(b, a, b.x, b.y, 'shot', 25);   // 連擊 +5
    assert.strictEqual(b.hp, b.maxHp - 55, 'assault combo');
    r._damage(b, null, b.x, b.y, 'blast', 40);
    assert.strictEqual(b.hp, b.maxHp - 75, 'heavy halves blast');
    // 回血：5 秒沒受傷後開始
    const before = b.hp;
    for (let i = 0; i < C.HP.regenDelay * 30 - 5; i++) r._regen(), r.tick++;
    assert.strictEqual(b.hp, before, 'no regen before delay');
    for (let i = 0; i < 60; i++) r._regen(), r.tick++;
    assert(b.hp > before, 'regen after delay');
    // 醫療包
    b.hp = 10; r._applyItem(b, C.ITEM_TYPES.findIndex(t => t.key === 'medkit'));
    assert.strictEqual(b.hp, 10 + Math.round(b.maxHp * C.HP.medkit));
    // 打到 0 才死
    r._damage(a, b, a.x, a.y, 'shot', 99); assert(a.alive && a.hp === 1);
    r._damage(a, b, a.x, a.y, 'shot', 5); assert(!a.alive && a.lives === 2);
    r.dispose(); }
  // 護士：技能治療附近隊友，光環讓隊友交戰中也回血
  { const { r, a } = mk('nurse', 'assault');
    const bot = r.tanks[1]; bot.x = a.x + 1; bot.y = a.y; bot.hp = 20; a.hp = 50;
    assert(r._useSkill(a)); assert.strictEqual(bot.hp, 20 + Math.round(bot.maxHp * C.HP.healSkill)); assert.strictEqual(a.hp, 90);
    bot.hurtTick = r.tick; const h = bot.hp;
    for (let i = 0; i < 30; i++) { r._regen(); r.tick++; bot.hurtTick = r.tick; }
    assert(bot.hp > h, 'nurse aura heals during combat');
    r.dispose(); }
  // 自動回血預設關閉：一般職業不回血，偵察照樣回
  { const { r, a, b } = mk('heavy', 'scout');
    a.hp = 50; b.hp = 40;
    for (let i = 0; i < 10 * 30; i++) { r._regen(); r.tick++; }
    assert.strictEqual(a.hp, 50, 'no regen when off');
    assert(b.hp > 40, 'scout still regenerates');
    assert.strictEqual(JSON.parse(r._viewFor(a)).rules.regen, false);
    r.dispose(); }
  // 狙擊：越遠傷害越高
  { const { r, a } = mk('sniper', 'assault');
    const near = r._bulletDmg({ snipe: 1, dmg: 45, x: 5, y: 5, ox: 5, oy: 3 });
    const far = r._bulletDmg({ snipe: 1, dmg: 45, x: 5, y: 15, ox: 5, oy: 3 });
    assert.strictEqual(near, C.HP.sniperNear); assert.strictEqual(far, C.HP.sniperFar);
    r.dispose(); }
  // 房主設定血量
  { const { r, a } = mk('heavy', 'assault', { rules: { playerHp: 200, botHp: 50 } });
    assert.strictEqual(a.maxHp, Math.round(200 * C.HP.hpFactor.heavy)); assert.strictEqual(r.tanks[1].maxHp, 50);
    r.dispose(); }
  // 沒開血量系統：照舊一發一條命，醫療包不會出現
  { const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: idle, cls: 'assault' }] }));
    const r = new Round({ mode: 'ffa', baseMode: false, timeLimit: 0, sides, size: 21, items: true });
    const t = r.tanks[0]; t.shield = 0;
    assert.strictEqual(t.maxHp, 1);
    r._damage(t, null, t.x, t.y, 'shot', 25); assert(!t.alive);
    assert(!r.allowedItems.some(i => C.ITEM_TYPES[i].key === 'medkit'));
    r.dispose(); }
  // 整局跑得完（全職業、道具全開）
  { const D = require('../server/bots/classic');
    const sides = Object.keys(C.CLASSES).map(c => ({ key: c, name: c, color: '#fff', members: [{ playerId: c, name: c, code: D, aiPilot: true, cls: c, botCls: c }] }));
    const r = new Round({ mode: 'ffa', baseMode: true, timeLimit: 90, sides, hpSystem: true, items: true });
    while (!r.over) r.step();
    r.dispose(); }
  console.log('hp system OK');
  Object.assign(C.PLAYER_EDGE, savedEdge); Object.assign(C.BOT_CLASS_EDGE, savedBotEdge);
}

// 特殊地形（油桶、補血站、傳送門）、縮圈、助攻／傷害／治療統計、代碼相容性提醒
{
  const { Round } = require('../server/game');
  const C = require('../server/constants');
  const idle = 'function think(){ return null; }';
  const mk = (extra = {}) => {
    const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: idle, cls: 'assault' }] }));
    const r = new Round({ mode: 'ffa', baseMode: false, timeLimit: 100, sides, size: 21, hpSystem: true, ...extra });
    r.startTicks = 0;
    for (let i = 0; i < r.tiles.length; i++) r.tiles[i] = '.';
    for (const t of r.tanks) t.shield = 0;
    return r;
  };
  // 地圖產生：開了特殊地形才有，連通、傳送門成對
  for (let k = 0; k < 10; k++) {
    const sides = Array.from({ length: [2, 3, 4][k % 3] }, (_, i) => ({ key: 's' + i, name: 's', color: '#fff', members: [{ playerId: 'p' + i, name: 'p', code: idle, cls: 'assault' }] }));
    const r = new Round({ mode: 'ffa', baseMode: true, timeLimit: 60, sides, specialTerrain: true, mapStyle: ['random', 'maze', 'open', 'forest', 'river'][k % 5] });
    const portals = r.tiles.filter(c => c === 'P').length;
    assert(portals % 2 === 0 && r.portalPair.size === portals, 'portals paired');
    r.dispose();
    const r2 = new Round({ mode: 'ffa', baseMode: true, timeLimit: 60, sides });
    assert(!r2.tiles.some(c => 'OHP'.includes(c)), 'no specials when off');
    r2.dispose();
  }
  // 油桶：打到就爆炸，傷到射手的敵人、不傷隊友，炸掉旁邊磚牆、連鎖
  { const r = mk(); const [a, abot, b] = r.tanks; const S = r.size;
    r.tiles[10 * S + 10] = 'O'; r.tiles[10 * S + 11] = 'O'; r.tiles[11 * S + 10] = '#';
    b.x = 10.5; b.y = 9.3; abot.x = 9.4; abot.y = 10.5; a.x = 3.5; a.y = 3.5;
    r._explodeBarrel(10, 10, { owner: a.id, side: a.side });
    assert.strictEqual(r.tiles[10 * S + 10], '.'); assert.strictEqual(r.tiles[10 * S + 11], '.', 'chain');
    assert.strictEqual(r.tiles[11 * S + 10], '.', 'breaks bricks');
    assert(b.hp < b.maxHp, 'enemy hurt'); assert.strictEqual(abot.hp, abot.maxHp, 'ally safe');
    // 子彈打到油桶也會爆
    r.tiles[5 * S + 15] = 'O';
    r._bulletHitWorld({ x: 15.5, y: 5.5, side: a.side, owner: a.id, bounces: 0 });
    assert.strictEqual(r.tiles[5 * S + 15], '.', 'bullet detonates');
    r.dispose(); }
  // 補血站、傳送門
  { const r = mk(); const [a] = r.tanks; const S = r.size;
    r.tiles[5 * S + 5] = 'H'; a.x = 5.5; a.y = 5.5; a.hp = 20;
    for (let i = 0; i < 30; i++) r._updateTerrain();
    assert(a.hp >= 20 + Math.floor(a.maxHp * C.HEAL_PAD_PER_SEC) - 1, 'heal pad heals');
    r.tiles[3 * S + 3] = 'P'; r.tiles[17 * S + 17] = 'P'; r._initTerrain({});
    a.x = 3.5; a.y = 3.5; a.portalCd = 0;
    r._updateTerrain();
    assert.strictEqual(a.x, 17.5); assert.strictEqual(a.y, 17.5);
    r._updateTerrain(); assert.strictEqual(a.x, 17.5, 'cooldown prevents bouncing back');
    r.dispose(); }
  // 縮圈：只在生存／佔點；圈外扣血；view 有範圍
  { const r = mk({ zone: true }); const [a] = r.tanks;
    assert(r.zone, 'zone on');
    const z = r.zone; r.tick = r.startTicks + z.end + 1;
    assert(Math.abs(r._zoneHalf() - z.minHalf) < 1e-9);
    a.x = 1.5; a.y = 1.5; const hp = a.hp;
    for (let i = 0; i < 30; i++) r._updateTerrain();
    assert(a.hp < hp, 'zone damage');
    const v = JSON.parse(r._viewFor(a)).zone;
    assert(v && v.x1 - v.x0 === z.minHalf * 2, 'zone view');
    r.dispose();
    const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: idle, cls: 'assault' }] }));
    const r3 = new Round({ mode: 'ffa', timeLimit: 60, sides, zone: true, objective: 'ctf' });
    assert(!r3.zone, 'no zone in ctf'); r3.dispose(); }
  // 助攻：10 秒內打過的人算助攻
  { const r = mk(); const [a, abot, b] = r.tanks;
    r._damage(b, abot, b.x, b.y, 'shot', 30);
    r._damage(b, a, b.x, b.y, 'shot', 200);
    assert(!b.alive); assert.strictEqual(abot.assists, 1); assert.strictEqual(a.kills, 1);
    assert.strictEqual(abot.dmgDealt, 30); assert(a.dmgDealt === b.maxHp - 30);
    r.dispose(); }
  // 代碼相容性提醒
  { const hints = require('../server/codeHints');
    const keys = c => hints(c, { hpSystem: true, zone: true, terrain: true }).map(h => h.key).sort().join(',');
    assert.strictEqual(keys('// spec v2\nfunction think(view){ return null; }'), 'hp,skill,version,zone');
    assert.strictEqual(keys(`// spec v${C.SPEC_VERSION}\nfunction think(view){ var z = view.zone, h = view.me.hp; return { skill: true }; }`), '');
    assert(keys('function think(v){ var t = v.map.tiles; return null; }').includes('terrain'));
  }
  console.log('terrain + zone + stats + hints OK');
}


// 打怪改版：關卡、怪物、Boss、預警區、強化卡、商店、目標
{
  const { Round } = require('../server/game');
  const PD = require('../server/pve/data');
  const D = require('../server/bots/classic');
  const mk = (pve, extra = {}) => {
    const sides = [{ key: 'players', name: 'P', color: '#fff', members: [0, 1].map(i => ({ playerId: 'p' + i, name: 'p' + i, code: D, aiPilot: true, cls: ['heavy', 'nurse'][i] })) }];
    return new Round({ mode: 'ffa', objective: 'pve', timeLimit: 300, sides, pve, size: 25, ...extra });
  };
  // 每關都跑得完、會分出勝負
  for (const level of Object.keys(PD.LEVELS)) {
    const r = mk({ mode: 'campaign', level, difficulty: 'easy' });
    assert(r.hpSystem, 'pve forces hp system');
    while (!r.over) r.step();
    assert(/^pve(Win|Lose|Time|Core|Npc)$/.test(r.result.reason), level + ' ends: ' + r.result.reason);
    assert.strictEqual(r.result.pve.level, level);
    r.dispose();
  }
  // 無盡：第 5 波是 Boss
  { const r = mk({ mode: 'endless' });
    assert.strictEqual(r._pveIsBossWave(5), 'fortress'); assert.strictEqual(r._pveIsBossWave(10), 'queen'); assert.strictEqual(r._pveIsBossWave(4), null);
    r.dispose(); }
  // 每週挑戰：同一週內容固定
  { const W = require('../server/pve').weeklySpec;
    const a = W('2026-W40'), b = W('2026-W40');
    assert.deepStrictEqual(a, b); assert(PD.LEVELS[a.level] && a.mods.length === 2 && a.mods[0] !== a.mods[1]); }
  // 出怪：難度縮放、精英詞綴、Boss 與附屬單位
  { const r = mk({ mode: 'campaign', level: '1-1', difficulty: 'hard' });
    const m = r._pveSpawn('crawler', 5.5, 5.5, { noElite: true });
    assert.strictEqual(m.maxHp, Math.round(PD.MONSTERS.crawler.hp * 1.5));
    const e = r._pveSpawn('shield', 7.5, 5.5, { affixes: ['tough'] });
    assert.strictEqual(e.maxHp, Math.round(PD.MONSTERS.shield.hp * 1.5 * 2)); assert(e.frontShield > 0);
    // 正面護盾擋子彈、背後打得到
    e.angle = 0; e.shield = 0;
    const front = { vx: 0, vy: 1, x: e.x, y: e.y - 0.4, side: 'players', owner: r.tanks[0].id };
    assert(r._pveBlockBullet(front, e) && front.dead, 'front shield blocks');
    const back = { vx: 0, vy: -1, x: e.x, y: e.y + 0.4, side: 'players', owner: r.tanks[0].id };
    assert(!r._pveBlockBullet(back, e), 'back is open');
    r._pveSpawnBoss('fortress');
    const boss = r.tankById.get(r.pve.bossId);
    assert(boss.boss && boss.size > 2 && boss.ai.turrets.length === 4);
    boss.shield = 0;
    r._damage(boss, r.tanks[0], boss.x, boss.y, 'shot', 1e9);
    assert(!boss.alive && r.tanks.filter(t => t.monster && t.alive && t.kind === 'fturret').length === 0, 'turrets go with the boss');
    r.dispose(); }
  // 預警區：時間到才傷害，範圍外沒事
  { const r = mk({ mode: 'campaign', level: '1-1' });
    const me = r.tanks.find(t => !t.isBot && t.cls === 'nurse'), far = r.tanks.find(t => t.isBot && t.side === 'players');
    for (const t of [me, far]) t.shield = 0;
    far.x = me.x + 6; far.y = me.y;
    const hp = me.hp;
    r._pveHazard({ kind: 'circle', x: me.x, y: me.y, r: 1, fireAt: r.tick + 2, endAt: r.tick + 4, dmg: 30 });
    r.tick++; r._pveHazardsTick(); assert.strictEqual(me.hp, hp, 'not yet');
    r.tick++; r._pveHazardsTick(); assert.strictEqual(me.hp, hp - 30, 'fires'); assert.strictEqual(far.hp, far.maxHp);
    r.dispose(); }
  // 強化卡與商店
  { const r = mk({ mode: 'campaign', level: '1-1' });
    const me = r.tanks.find(t => !t.isBot && t.side === 'players');
    r.pve.phase = 'draft'; me.draft = ['hp1', 'fire1', 'pierce']; me.draftPicked = false;
    const maxHp = me.maxHp, cd = me.stats.cooldown;
    r.pvePick('p0', 0); assert.strictEqual(me.maxHp, Math.round(maxHp * 1.2)); assert(me.cards.includes('hp1'));
    r.pvePick('p0', 1); assert.strictEqual(me.stats.cooldown, cd, 'only one pick per draft');
    me.draftPicked = false; me.draft = ['fire1']; r.pvePick('p0', 0); assert(me.stats.cooldown < cd);
    r.pve.parts = 20; const lives = me.lives;
    assert(r.pveShop('p0', 'life')); assert.strictEqual(me.lives, lives + 1); assert.strictEqual(r.pve.parts, 5);
    assert(!r.pveShop('p0', 'life'), 'not enough parts');
    r.dispose(); }
  // 規格與範例
  { const spec = require('../server/spec');
    assert(spec.includes('## 打怪模式') && spec.includes('hazards'));
    const S = require('../server/samples'); assert(S.pve && S.pve.code.includes('hazards')); }
  console.log('pve overhaul OK');
}

// 搶旗：雙方互搶時，帶著敵旗回到自己的旗座照樣得分（不需要自己的旗子在家）
{
  const { Round } = require('../server/game');
  const idle = 'function think(){ return null; }';
  const sides = ['red', 'blue'].map(key => ({ key, name: key, color: '#fff', members: [{ playerId: key, name: key, code: idle, cls: 'assault' }] }));
  const r = new Round({ mode: 'faction', objective: 'ctf', timeLimit: 0, sides });
  r.startTicks = 0;
  const red = r.tanks.find(t => t.side === 'red' && !t.isBot), blue = r.tanks.find(t => t.side === 'blue' && !t.isBot);
  const fr = r.flags.find(f => f.side === 'red'), fb = r.flags.find(f => f.side === 'blue');
  // 互搶
  red.x = fb.x; red.y = fb.y; blue.x = fr.x; blue.y = fr.y;
  r._updateObjective();
  assert.strictEqual(red.carrying, 'blue'); assert.strictEqual(blue.carrying, 'red');
  assert(!fr.atHome && !fb.atHome, 'both flags away');
  // 紅方帶著藍旗回到自己的旗座：自己的旗子還在藍方手上也能得分
  red.x = fr.home.x; red.y = fr.home.y;
  r._updateObjective();
  assert.strictEqual(r.objScore.red, 1, 'scores at own stand while own flag is stolen');
  assert.strictEqual(red.carrying, null); assert(fb.atHome, 'enemy flag returns home');
  assert.strictEqual(blue.carrying, 'red', 'own flag still carried by enemy');
  r.dispose();
  console.log('ctf stand capture OK');
}

// 玩家與電腦的職業分開：玩家較強、電腦狙擊削弱
{
  const { Round } = require('../server/game');
  const C = require('../server/constants');
  const idle = 'function think(){ return null; }';
  const sides = [0, 1].map(i => ({ key: 's' + i, name: 'P' + i, color: '#fff', members: [{ playerId: 'p' + i, name: 'P' + i, code: idle, cls: 'sniper', botCls: 'sniper' }] }));
  const r = new Round({ mode: 'ffa', baseMode: false, timeLimit: 0, sides, hpSystem: true, botClasses: true });
  const player = r.tanks.find(t => !t.isBot), bot = r.tanks.find(t => t.isBot && t.cls === 'sniper');
  assert(player.maxHp > 100 * C.HP.hpFactor.sniper, 'player hp edge');
  assert(player.stats.cooldown < r.statsFor('sniper').cooldown, 'player fires faster');
  if (bot) {
    assert(bot.stats.bulletSpeed < player.stats.bulletSpeed, 'bot sniper bullet slower');
    assert(r._damageOf(bot) < r._damageOf(player), 'bot sniper weaker');
  }
  r.dispose();
  console.log('class edge OK');
}

// 新遊戲目標：攻城、移動佔點、晶礦、足球、職業輪換、鬼抓人
{
  const { Round } = require('../server/game');
  const C = require('../server/constants');
  const idle = 'function think(){ return null; }';
  const mk = (objective, extra = {}) => {
    const sides = ['red', 'blue'].map(key => ({ key, name: key, color: '#fff', members: [{ playerId: key, name: key, code: idle, cls: 'assault' }] }));
    const r = new Round({ mode: 'faction', objective, timeLimit: 0, sides, hpSystem: true, ...extra });
    r.startTicks = 0;
    for (const t of r.tanks) t.shield = 0;
    return { r, red: r.tanks.find(t => t.side === 'red' && !t.isBot && !t.structure), blue: r.tanks.find(t => t.side === 'blue' && !t.isBot && !t.structure) };
  };
  // 攻城：核心被打爆 → 進攻方贏；時間到 → 防守方贏；砲台會開火
  { const { r } = mk('siege');
    assert(r.timeLimitTicks > 0 && !r.baseMode);
    const core = r.tankById.get(r.siege.core);
    assert.strictEqual(core.side, r.siege.defender);
    assert.strictEqual(r.siege.turrets.length, 4);
    for (const t of r.tanks) if (t.alive && !t.structure) assert(!r._tileBlocked(t.x, t.y), 'no tank inside castle wall');
    const att = r.tanks.find(t => t.side === r.siege.attacker && !t.structure);
    const tu = r.tankById.get(r.siege.turrets[0]);
    att.x = tu.x + 2; att.y = tu.y; tu.cooldown = 0;
    const before = r.bullets.length;
    if (r._pveLos(tu, att)) { r._siegeTurrets(); assert(r.bullets.length > before, 'turret fires'); }
    r._damage(core, att, core.x, core.y, 'shot', 1e6);
    assert(!core.alive);
    const e = r._modeEnd();
    assert.strictEqual(e.reason, 'siegeWin'); assert.strictEqual(e.winner.key, r.siege.attacker);
    for (let i = 0; i < 200; i++) r.step();
    assert(!core.alive, 'core does not respawn');
    r.dispose(); }
  { const { r } = mk('siege', { timeLimit: 5 });
    while (!r.over) r.step();
    assert.strictEqual(r.result.reason, 'siegeHold'); r.dispose(); }
  // 移動佔點：時間到就換位置
  { const { r } = mk('mkoth');
    const h0 = { ...r.hill };
    r.hillMoveAt = r.playTick;
    r._mkothUpdate();
    assert(r.hill.x !== h0.x || r.hill.y !== h0.y, 'hill moved');
    assert(r.objectiveView(r.tanks[0]).moving);
    r.dispose(); }
  // 晶礦：撿起、帶回、陣亡掉落
  { const { r, red, blue } = mk('crystals');
    r.crystals.push({ id: 99, x: red.x, y: red.y, n: 3 });
    r._crystalsUpdate();
    assert.strictEqual(red.crystals, 3);
    r._damage(red, blue, red.x, red.y, 'shot', 1e6);
    assert.strictEqual(red.crystals, 0);
    assert(r.crystals.some(c => c.n === 3), 'dropped on death');
    blue.crystals = 4;
    const home = r.sideByKey.get('blue').anchor;
    blue.x = home.x + 0.5; blue.y = home.y + 0.5;
    r._crystalsUpdate();
    assert.strictEqual(r.objScore.blue, 4); assert.strictEqual(blue.crystals, 0);
    r.dispose(); }
  // 足球：子彈推球、進球得分
  { const { r, red } = mk('soccer');
    r.ball.frozen = 0;
    const bl = { x: r.ball.x, y: r.ball.y, vx: 1, vy: 0 };
    assert(r._ballHit(bl) && bl.dead && r.ball.vx > 0, 'bullet pushes ball');
    const g = r.goals.find(x => x.side === 'blue');
    Object.assign(r.ball, { x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2, vx: 0, vy: 0 });
    r._soccerUpdate();
    assert.strictEqual(r.objScore.red, 1, 'goal scored');
    assert(Math.abs(r.ball.x - r.center - 0.5) < 0.01, 'ball reset');
    for (let i = 0; i < 300; i++) r.step();
    assert(r.ball.x > 0.3 && r.ball.y > 0.3 && r.ball.x < r.size - 0.3 && r.ball.y < r.size - 0.3, 'ball stays in map');
    void red; r.dispose(); }
  // 職業輪換：擊殺升級換職業，最後一階擊殺獲勝
  { const { r, red, blue } = mk('gungame');
    assert.strictEqual(red.cls, 'assault');
    r._damage(blue, red, blue.x, blue.y, 'shot', 1e6);
    assert.strictEqual(red.ggLevel, 1); assert.strictEqual(red.cls, 'scout'); assert.strictEqual(red.hp, red.maxHp);
    red.ggLevel = 6; blue.alive = true; blue.hp = 1;
    r._damage(blue, red, blue.x, blue.y, 'shot', 1e6);
    assert.strictEqual(r._modeEnd().reason, 'gungame');
    r.dispose(); }
  // 鬼抓人：沒有傷害、碰到換鬼、時間到當鬼最短的隊伍贏
  { const { r, red, blue } = mk('tag', { timeLimit: 3 });
    r.itId = red.id;
    const hp = blue.hp;
    r._damage(blue, red, blue.x, blue.y, 'shot', 50);
    assert.strictEqual(blue.hp, hp, 'no damage in tag');
    assert.strictEqual(r.itId, blue.id, 'shot passes it');
    r._damage(red, blue, red.x, red.y, 'shot', 50);
    assert.strictEqual(r.itId, blue.id, 'no instant tag-back');
    red.x = blue.x + 0.5; red.y = blue.y;
    r.tick += 3 * C.TICK_RATE;
    r._tagUpdate();
    assert.strictEqual(r.itId, red.id, 'touch passes it');
    for (const t of r.tanks) t.itTicks = 0;
    r.tick = 0; r.itId = red.id;
    while (!r.over) r.step();
    assert.strictEqual(r.result.reason, 'tag'); assert.strictEqual(r.result.winner, 'blue');
    r.dispose(); }
  // 這些目標都要兩隊或無限重生
  for (const o of ['siege', 'soccer']) assert(C.TWO_TEAM_OBJECTIVES.includes(o));
  console.log('new objectives OK');
}

// 打怪：通關自動選下一關、一局結束、重玩；公開大廳摘要；進行中可加入
{
  const { Room } = require('../server/room');
  const room = new Room('7777', () => {}, 'normal');
  const host = room.addHuman('host', null);
  room.settings.objective = 'pve'; room.settings.pveLevel = '1-1';
  room.startRound();
  assert.strictEqual(room.state, 'playing');
  const sum = room.summary();
  assert.strictEqual(sum.objective, 'pve'); assert.strictEqual(sum.pve.level, '1-1'); assert.strictEqual(sum.humans, 1);
  assert(!room.canJoin(), 'can join while playing');
  // 直接讓這局通關
  room.round._pveWin();
  while (!room.round.over) room.round.step();
  room._tick();
  assert.strictEqual(room.state, 'finished');
  assert.strictEqual(room.lastResult.pveNext, '1-2');
  assert.strictEqual(room.settings.pveLevel, '1-2');
  room.handle(host, { t: 'pveReplay' });
  assert.strictEqual(room.settings.pveLevel, '1-1'); assert.strictEqual(room.state, 'playing');
  room.close();
  const D = require('../server/pve/data');
  assert(Object.keys(D.LEVELS).length >= 15, 'more campaign levels');
  console.log('pve progression OK');
}
