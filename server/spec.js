'use strict';

const C = require('./constants');

const classLines = Object.entries(C.CLASSES).map(([k, c]) =>
  `  ${k.padEnd(7)} ${c.name}  移速 ${c.speed}  冷卻 ${c.cooldown}  彈速 ${c.bulletSpeed}  同時子彈 ${c.maxBullets}  每命耐久 ${c.hp}${c.blast ? '  爆炸子彈' : ''}`
).join('\n');
const B = C.BOT_CLASS;

// 給玩家（和他們的 AI 助手）看的電腦代碼規格。只寫必要的事實，策略留給玩家自己設計。
module.exports = `# 坦克對戰：電腦隊友代碼規格

用 JavaScript 定義一個函式 think(view, memory)。遊戲每秒呼叫它 ${C.TICK_RATE} 次（每個 tick 一次），回傳你的電腦坦克在這個 tick 的動作。

## 回傳格式
{ move: 角度 | 方向 | null, fire: true | false, skill: true | false }
角度 = 0～360 的數字（度）：0 = 上、90 = 右、180 = 下、270 = 左，順時針，可以有小數（無段落，任何角度都可以）
方向 = "up" | "down" | "left" | "right" | "upleft" | "upright" | "downleft" | "downright"（等於 0、180、270、90、315、45、225、135 度）
- move：往該角度移動，車身和砲管也會轉向該角度；null 表示停住（保持原本的角度）。被擋住時只會轉向。
- 離正上下左右 ${require('../public/physics').SNAP} 度以內時，移動會當作直走並自動靠向格子中心（方便鑽 1 格寬的通道），但砲管仍朝實際角度。
- fire：true 表示朝砲管角度開火。冷卻中或自己的子彈數已達上限時會被忽略。
- skill：true 表示使用職業技能（me.skill 是你的技能，null 表示沒有）。冷卻中會被忽略。
  電腦坦克預設 cls 是 "bot"、沒有技能；房主打開「電腦也有職業」時（rules.botClasses 為 true），電腦會有玩家選的職業和那個職業的技能。

## 執行環境
- 標準 JavaScript，可以用 Math、JSON、Array、Map 等內建物件。沒有 DOM、網路、檔案、require/import、setTimeout。
- 最上層的程式在每局開始時執行一次，可以放輔助函式和初始化。
- memory 是一個空物件，整局都會保留，每局開始時清空。
- 每局開始有 ${C.COUNTDOWN_SECONDS} 秒倒數，倒數期間不會呼叫 think；倒數結束後 tick 從 1 開始。
- console.log(...) 的輸出會在賽後顯示。
- 除錯繪圖（只有你自己看得到，可以在設定裡關掉）：debug.line(x1, y1, x2, y2, 顏色)、debug.circle(x, y, 半徑, 顏色)、debug.text(x, y, 文字, 顏色)、debug.path([{x, y}, ...], 顏色)。座標單位是格，顏色是 CSS 顏色字串（例如 "#ff0" 或 "red"）。每個 tick 最多 60 個，畫的東西只會顯示到下一個 tick。
- 每次 think 必須在 ${C.BOT_CALL_TIMEOUT_MS} 毫秒內回傳。超時、拋出錯誤或回傳格式錯誤時，該 tick 不動。
- 代碼上限 ${C.BOT_CODE_MAX_BYTES / 1024}KB，記憶體上限 ${C.BOT_MEMORY_MB}MB。

## 座標
- x 向右、y 向下，單位是「格」。第 c 欄第 r 列的格子範圍是 x∈[c,c+1)、y∈[r,r+1)，中心是 (c+0.5, r+0.5)。
- 坦克座標是坦克中心。所有坦克都是邊長 ${C.TANK_SIZE} 格的正方形。
- 斜向移動時，速度向量正規化（每軸速度為移速的 1/√2），撞牆時會沿著牆滑動。
- 直向或橫向移動時，另一軸每 tick 會自動往所在格子的中心靠近（最多和移動距離一樣多），所以可以順利鑽進 1 格寬的通道。
- 子彈從砲管角度與車身方框邊緣的交點射出。

## view
{
  tick,                // 從 1 開始
  ticksLeft,           // 本局剩餘 tick，沒有時間限制時為 null
  me:      { ...坦克, cooldown, canFire, skill, skillCd, skillReady, charged },   // cooldown：還要幾個 tick 才能再開火；skill：技能名稱；skillCd：技能還要幾個 tick 才能再用
  smokes:  [ { x, y, r, ticksLeft } ],   // 場上的煙霧；煙霧裡的敵人不會出現在 enemies
  mines:   [ { x, y, armed, mine } ],    // 我方的地雷（敵人的地雷看不到）
  allies:  [ 坦克 ],   // 同隊、還活著的其他坦克（包含你的玩家）
  enemies: [ 坦克 ],   // 所有還活著的敵方坦克
  bullets: [ { x, y, angle, dir, vx, vy, speed, ally, blast, pierce, freeze, confuse, bounces } ],   // vx、vy：每秒移動幾格   // 場上所有子彈；speed 單位是格/秒；ally 表示是不是我方的；bounces 是剩餘反彈次數
  bases:   [ { x, y, ally, alive } ],    // 基地中心座標；非基地模式時是空陣列
  objective: { type, ... },             // 遊戲目標，見下方「遊戲目標」
  items:   [ { x, y, type, ticksLeft } ],  // 場上的道具（格子中心座標）；沒開道具時是空陣列
  map:     { width, height, tiles },     // tiles[r][c] 是第 r 列第 c 欄的地形字元
  rules:   { tickRate, tankSize, blastRadius, mode, baseMode, fog, breakableWalls, codeOnly, classes, botClasses, ricochet, bulletBounces, items }
}
坦克 = { id, x, y, dir, isBot, owner, cls, lives, hp, shield, carrying, buffs }
- angle：精確角度（度，0 = 上，順時針）；dir：最接近的八方向名稱（給簡單的代碼用）
- owner：這台坦克所屬玩家的 id。你的玩家是 allies 裡 isBot === false 且 owner === me.owner 的那台（他死掉等重生時不會出現在 allies）。
- cls：職業，"bot" 表示沒有職業的電腦坦克，其他見下方職業表（開了「電腦也有職業」時電腦也會是這些職業）。各職業的數值也在 rules.classes[cls] 裡。
- hp：這條命還能挨幾發；shield：剩餘無敵的 tick 數。
- buffs：道具效果 { speed, rapid, spread, bounce, swift, cloak, phase, radar, frozen, confused, blastShots, pierceShots, freezeShots, confuseShots }。
  前面幾個是剩餘 tick 數（0 = 沒有），…Shots 是還剩幾發。frozen > 0 時不能動也不能射；confused > 0 時移動方向會被顛倒。
- 隱形（cloak）中的敵人不會出現在 enemies 裡。
- 電腦沒有視野限制：草叢和迷霧只會擋住人類玩家的畫面。

## 職業技能（玩家坦克；開了「電腦也有職業」時電腦也有）
${Object.entries(C.SKILLS).map(([cls, s]) => `- ${C.CLASSES[cls].name}（${cls}）：${s.key}「${s.name}」，冷卻 ${s.cd} 秒。${s.desc}`).join('\n')}

## 地形
.  空地
#  磚牆：擋坦克和子彈，被子彈打中就消失（rules.breakableWalls 為 false 時打不破）。
   基地周圍的磚牆是加固的，要打 ${C.BASE_WALL_HP} 下才會破；剩餘耐久在 map.wallHp：[{ x, y, hp }]（只列出加固的牆）。
   開局後前 ${C.BASE_WALL_SHIELD_TICKS / C.TICK_RATE} 秒加固的牆完全打不壞（剩餘 tick 數在 rules.baseWallShieldLeft）。
@  鋼牆：擋坦克和子彈，打不壞
~  水：擋坦克，子彈可以飛過
*  草叢：坦克和子彈都可以通過
B  基地：擋坦克和子彈，被敵方子彈打中就會毀掉
地圖外圍不能通過。

## 職業（速度：格/秒，冷卻：tick）
  bot     電腦（沒有職業時）  移速 ${B.speed}  冷卻 ${B.cooldown}  彈速 ${B.bulletSpeed}  同時子彈 ${B.maxBullets}  每命耐久 ${B.hp}
${classLines}
爆炸子彈：命中坦克、牆或被抵消時爆炸，炸毀周圍 3×3 的磚牆（牆可破時），並對坦克中心距離爆炸中心 ${C.BLAST_RADIUS} 格以內（直線距離）的敵方坦克造成傷害。
子彈命中判定：子彈中心進入坦克方框（邊長 ${C.TANK_SIZE}）外擴 ${C.HIT_MARGIN} 格的範圍內就算命中。

## 遊戲目標（view.objective）
- { type: "survival" }：生存。打到剩最後一隊。
- { type: "koth", x, y, radius, myScore, bestEnemyScore, target, holder }：佔點。地圖中央以 (x, y) 為中心、兩軸各 ±radius 的區域，只有你們隊在裡面時每 tick 加 1 分，先到 target 分獲勝。holder 是 "me" | "enemy" | "contested" | null。
- { type: "ctf", flags: [ { x, y, homeX, homeY, ally, atHome, carrier } ], myCaptures, bestEnemyCaptures, target }：搶旗。碰到敵方的旗子就會撿起來（me.carrying 變成 true）；帶著它碰到「在家」的己方旗子就得 1 分，先到 target 分獲勝。帶旗的坦克被打掉時旗子會掉在原地，碰到自己掉落的旗子會把它送回家，掉落 ${C.FLAG_RETURN_TICKS / C.TICK_RATE} 秒沒人碰也會自己回家。
- { type: "escort", attacking, cart: { x, y }, radius, progress, state, path: [{ x, y }] }：護送。進攻方（attacking 為 true）要把礦車推到路線終點：礦車 radius 格內只有進攻方時會沿著 path 前進（人越多越快），只有防守方時會慢慢後退，兩邊都有時停住。progress 是 0～1 的進度。時間到之前推到終點進攻方贏，否則防守方贏。每局交換攻守。
- { type: "pve", wave, waves, monstersLeft }：打怪。所有玩家同一隊，怪物（cls 為 "monster"）會一波波出現，撐過 ${C.PVE_WAVES} 波就獲勝。每撐過一波，玩家坦克回 1 條命。
- 佔點、搶旗和護送模式所有坦克都會無限重生（電腦 ${C.BOT_RESPAWN_DELAY / C.TICK_RATE} 秒後重生）；生存和打怪模式照一般的命數規則。

## 子彈反彈（rules.ricochet 為 true 時）
- 子彈撞到鋼牆、地圖邊界，或打不破的磚牆時會反彈，每顆最多反彈 ${C.BULLET_BOUNCES} 次，用完後再撞牆就消失。
- 撞到正面時方向反轉；斜向子彈撞到牆面時，只翻轉撞到的那一軸（像撞球一樣）。
- 打得破的磚牆、基地照樣會擋下子彈（磚牆照樣被打掉）。爆炸子彈不會反彈，撞牆直接爆炸。

## 場地道具（rules.items 為 true 時）
- 開局 ${C.ITEM_FIRST_DELAY / C.TICK_RATE} 秒後出現第一個，之後每 ${C.ITEM_INTERVAL / C.TICK_RATE} 秒在隨機空地刷新一個，場上最多 ${C.ITEM_MAX} 個，${C.ITEM_LIFETIME / C.TICK_RATE} 秒沒人撿就消失。
- 坦克中心距離道具中心兩軸都小於 ${C.ITEM_PICKUP_RANGE} 格就會撿到。玩家和電腦都能撿。items[].type 是下面的英文名稱。
${C.ITEM_TYPES.map(t => `- ${t.key}（${t.name}）：${t.desc}`).join('\n')}
- 散彈的額外兩發不佔「同時子彈」數量。冰凍彈和混亂彈命中時不扣命，也不會爆炸。

## 規則
- 沒有友軍傷害：我方子彈會穿過我方坦克。但所有坦克之間都有碰撞，彼此會擋住。
- 敵我雙方的子彈相撞會互相抵消。
- 每被敵方子彈打中一次 hp 減 1，hp 歸零就失去一條命。玩家坦克有 ${C.PLAYER_LIVES} 條命，死後 ${C.RESPAWN_DELAY / C.TICK_RATE} 秒在出生點重生，重生後有 ${C.SHIELD_TICKS / C.TICK_RATE} 秒無敵。電腦坦克只有 ${C.BOT_LIVES} 條命。
- 一隊只要還有坦克活著，或玩家還有命可以重生，就算存活。基地模式下，基地被毀整隊立刻出局。
- 最後存活的隊伍獲勝。時間到時，剩餘總命數最多的隊伍獲勝；命數相同時比擊殺數。
- mode："ffa" 大亂鬥（每位玩家和他的電腦一隊）、"faction" 陣營戰（紅藍兩隊）、"team" 組隊（玩家自由分隊）。
- rules.codeOnly 為 true 時是純代碼對戰：沒有玩家坦克，每位玩家只有一台電腦坦克。
`;
