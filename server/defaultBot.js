'use strict';

// 內建電腦（白痴版）：沒交代碼的玩家與內建電腦隊伍使用。
// 故意做得很笨，讓玩家自己寫的代碼有發揮空間：
//   不會尋路（常常卡牆）、反應慢、方向抖、大概對準就亂開槍、完全不會閃子彈、偶爾發呆。
module.exports = `// 白痴電腦：慢慢晃向目標，看到敵人大概對準就開槍
function think(view, memory) {
  var me = view.me;
  memory.t = (memory.t || 0) + 1;

  // 要去哪：佔點區、旗子、礦車；不然就是最近的敵人或敵方基地
  var goal = pickGoal(view);

  // 腦袋很慢：每 0.7 秒才重新決定一次方向，而且方向會偏 ±30 度
  if (memory.t % 20 === 1 || memory.dir === undefined) {
    memory.pause = Math.random() < 0.2;                       // 偶爾發呆
    memory.dir = goal ? angleTo(me, goal) + (Math.random() * 60 - 30) : Math.random() * 360;
    var closest = null, range = 7;
    view.enemies.forEach(function (e) {
      var d = Math.hypot(e.x - me.x, e.y - me.y);
      if (d < range) { closest = e; range = d; }
    });
    memory.aim = closest ? angleTo(me, closest) + (Math.random() * 40 - 20) : null;
  }

  // 卡住太久就隨便換個方向
  if (memory.lx === me.x && memory.ly === me.y) memory.still = (memory.still || 0) + 1; else memory.still = 0;
  memory.lx = me.x; memory.ly = me.y;
  if (memory.still > 25) { memory.dir = Math.random() * 360; memory.still = 0; }

  return {
    move: memory.pause ? null : (memory.dir + 360) % 360,
    aim: memory.aim,
    fire: (memory.aim !== null || memory.still > 10) && Math.random() < 0.6,
    skill: !!me.skillReady && Math.random() < 0.01,           // 偶爾亂用技能
  };
}

function pickGoal(view) {
  var me = view.me, o = view.objective || {};
  if (o.type === 'koth') return { x: o.x, y: o.y };
  if (o.type === 'escort') return o.cart;
  if (o.type === 'ctf') {
    var home = null, enemyFlag = null;
    o.flags.forEach(function (f) { if (f.ally) home = f; else if (!f.carrier) enemyFlag = f; });
    if (me.carrying && home) return { x: home.homeX, y: home.homeY };
    if (enemyFlag) return enemyFlag;
  }
  var best = null, bd = 1e9;
  view.enemies.concat((view.bases || []).filter(function (b) { return !b.ally && b.alive; })).forEach(function (t) {
    var d = Math.hypot(t.x - me.x, t.y - me.y);
    if (d < bd) { bd = d; best = t; }
  });
  return best;
}

function angleTo(a, b) { return (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI + 360) % 360; }
`;
