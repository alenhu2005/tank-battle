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
{ move: 方向 | null, fire: true | false }
方向 = "up" | "down" | "left" | "right" | "upleft" | "upright" | "downleft" | "downright"（八個方向）
- move：往該方向移動，車身和砲管也會轉向該方向；null 表示停住（保持原本的方向）。被擋住時只會轉向。
- fire：true 表示朝車身方向開火（八個方向都可以）。冷卻中或自己的子彈數已達上限時會被忽略。

## 執行環境
- 標準 JavaScript，可以用 Math、JSON、Array、Map 等內建物件。沒有 DOM、網路、檔案、require/import、setTimeout。
- 最上層的程式在每局開始時執行一次，可以放輔助函式和初始化。
- memory 是一個空物件，整局都會保留，每局開始時清空。
- 每局開始有 ${C.COUNTDOWN_SECONDS} 秒倒數，倒數期間不會呼叫 think；倒數結束後 tick 從 1 開始。
- console.log(...) 的輸出會在賽後顯示。
- 每次 think 必須在 ${C.BOT_CALL_TIMEOUT_MS} 毫秒內回傳。超時、拋出錯誤或回傳格式錯誤時，該 tick 不動。
- 代碼上限 ${C.BOT_CODE_MAX_BYTES / 1024}KB，記憶體上限 ${C.BOT_MEMORY_MB}MB。

## 座標
- x 向右、y 向下，單位是「格」。第 c 欄第 r 列的格子範圍是 x∈[c,c+1)、y∈[r,r+1)，中心是 (c+0.5, r+0.5)。
- 坦克座標是坦克中心。所有坦克都是邊長 ${C.TANK_SIZE} 格的正方形。
- 斜向移動時，速度向量正規化（每軸速度為移速的 1/√2），撞牆時會沿著牆滑動。
- 直向或橫向移動時，另一軸每 tick 會自動往所在格子的中心靠近（最多和移動距離一樣多），所以可以順利鑽進 1 格寬的通道。
- 子彈從車身方向的邊緣（斜向時是車身角落）射出；斜向子彈的速度向量同樣正規化。

## view
{
  tick,                // 從 1 開始
  ticksLeft,           // 本局剩餘 tick，沒有時間限制時為 null
  me:      { ...坦克, cooldown, canFire },   // cooldown：還要幾個 tick 才能再開火
  allies:  [ 坦克 ],   // 同隊、還活著的其他坦克（包含你的玩家）
  enemies: [ 坦克 ],   // 所有還活著的敵方坦克
  bullets: [ { x, y, dir, speed, ally, blast } ],   // 場上所有子彈；speed 單位是格/秒；ally 表示是不是我方的
  bases:   [ { x, y, ally, alive } ],    // 基地中心座標；非基地模式時是空陣列
  map:     { width, height, tiles },     // tiles[r][c] 是第 r 列第 c 欄的地形字元
  rules:   { tickRate, tankSize, blastRadius, mode, baseMode, fog, breakableWalls, codeOnly, classes }
}
坦克 = { id, x, y, dir, isBot, owner, cls, lives, hp, shield }
- dir：八個方向之一
- owner：這台坦克所屬玩家的 id。你的玩家是 allies 裡 isBot === false 且 owner === me.owner 的那台（他死掉等重生時不會出現在 allies）。
- cls：職業，"bot" 表示電腦坦克，其他見下方職業表。各職業的數值也在 rules.classes[cls] 裡。
- hp：這條命還能挨幾發；shield：剩餘無敵的 tick 數。
- 電腦沒有視野限制：草叢和迷霧只會擋住人類玩家的畫面。

## 地形
.  空地
#  磚牆：擋坦克和子彈，被子彈打中就消失（rules.breakableWalls 為 false 時打不破）
@  鋼牆：擋坦克和子彈，打不壞
~  水：擋坦克，子彈可以飛過
*  草叢：坦克和子彈都可以通過
B  基地：擋坦克和子彈，被敵方子彈打中就會毀掉
地圖外圍不能通過。

## 職業（速度：格/秒，冷卻：tick）
  bot     電腦  移速 ${B.speed}  冷卻 ${B.cooldown}  彈速 ${B.bulletSpeed}  同時子彈 ${B.maxBullets}  每命耐久 ${B.hp}
${classLines}
爆炸子彈：命中坦克、牆或被抵消時爆炸，炸毀周圍 3×3 的磚牆（牆可破時），並對坦克中心距離爆炸中心 ${C.BLAST_RADIUS} 格以內（直線距離）的敵方坦克造成傷害。
子彈命中判定：子彈中心進入坦克方框（邊長 ${C.TANK_SIZE}）外擴 ${C.HIT_MARGIN} 格的範圍內就算命中。

## 規則
- 沒有友軍傷害：我方子彈會穿過我方坦克。但所有坦克之間都有碰撞，彼此會擋住。
- 敵我雙方的子彈相撞會互相抵消。
- 每被敵方子彈打中一次 hp 減 1，hp 歸零就失去一條命。玩家坦克有 ${C.PLAYER_LIVES} 條命，死後 ${C.RESPAWN_DELAY / C.TICK_RATE} 秒在出生點重生，重生後有 ${C.SHIELD_TICKS / C.TICK_RATE} 秒無敵。電腦坦克只有 ${C.BOT_LIVES} 條命。
- 一隊只要還有坦克活著，或玩家還有命可以重生，就算存活。基地模式下，基地被毀整隊立刻出局。
- 最後存活的隊伍獲勝。時間到時，剩餘總命數最多的隊伍獲勝；命數相同時比擊殺數。
- mode："ffa" 大亂鬥（每位玩家和他的電腦一隊）、"faction" 陣營戰（紅藍兩隊）、"team" 組隊（玩家自由分隊）。
- rules.codeOnly 為 true 時是純代碼對戰：沒有玩家坦克，每位玩家只有一台電腦坦克。
`;
