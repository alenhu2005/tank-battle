'use strict';

const C = require('./constants');

const classLines = Object.entries(C.CLASSES).map(([k, c]) =>
  `  ${k.padEnd(7)} ${c.name}  移速 ${c.speed}  冷卻 ${c.cooldown}  彈速 ${c.bulletSpeed}  同時子彈 ${c.maxBullets}  每命耐久 ${c.hp}${c.blast ? '  爆炸子彈' : ''}`
).join('\n');
const B = C.BOT_CLASS;

const { SPEC_VERSION, CHANGELOG } = C;
const PVE = require('./pve/data');

// 給玩家（和他們的 AI 助手）看的電腦代碼規格。只寫必要的事實，策略留給玩家自己設計。
const text = `# 坦克對戰：電腦隊友代碼規格（版本 v${SPEC_VERSION}）

請在代碼第一行寫上註解 // spec v${SPEC_VERSION}（遊戲會用它提醒玩家代碼是不是照舊版規格寫的）。

## 最近更新
${CHANGELOG.slice(0, 3).map(([v, s]) => `- v${v}：${s}`).join('\n')}

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
  zone:    { ... } | null,             // 縮圈的安全區，見下方「縮圈」
  rules:   { specVersion, tickRate, tankSize, blastRadius, mode, baseMode, fog, breakableWalls, codeOnly, hpSystem, regen, classes, botClasses, playerHp, botHp, playerLives, botLives, respawnTicks, baseWallShieldLeft, ricochet, bulletBounces, items }
}
坦克 = { id, x, y, angle, dir, isBot, owner, cls, lives, hp, maxHp, shield, carrying, buffs }
- angle：精確角度（度，0 = 上，順時針）；dir：最接近的八方向名稱（給簡單的代碼用）
- owner：這台坦克所屬玩家的 id。你的玩家是 allies 裡 isBot === false 且 owner === me.owner 的那台（他死掉等重生時不會出現在 allies）。
- cls：職業，"bot" 表示沒有職業的電腦坦克，其他見下方職業表（開了「電腦也有職業」時電腦也會是這些職業）。各職業的數值也在 rules.classes[cls] 裡。
- hp／maxHp：這條命目前和最多的血量（見「血量系統」；經典模式是還能挨幾發）；shield：剩餘無敵的 tick 數。
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
O  油桶：擋坦克和子彈。被子彈或爆炸打到就爆炸，對 ${C.BARREL_RADIUS} 格內（直線距離）射手的敵人造成 ${C.BARREL_DMG} 傷害（經典模式算 1 下），炸掉旁邊 3×3 的磚牆，並引爆相鄰的油桶。
H  補血站：可以通過。坦克中心站在上面時每秒回 ${C.HEAL_PAD_PER_SEC * 100}% 最大血量（經典模式：連續站 3 秒補滿耐久）。
P  傳送門：可以通過，成對出現（通常是彼此點對稱的位置）。坦克中心開到門中央 0.3 格內就傳送到另一個門的中央，之後 ${C.PORTAL_CD / C.TICK_RATE} 秒內不會再被傳送；目的地有坦克時不會傳送。子彈不會被傳送。
地圖外圍不能通過。房主可以關掉特殊地形（O、H、P 就不會出現）。

## 縮圈（view.zone，沒開時是 null）
{ x0, y0, x1, y1, finalX0, finalY0, finalX1, finalY1, startsIn, endsIn }
- 安全區是以地圖中心為中心的正方形，目前範圍是 x0～x1、y0～y1（座標和坦克相同）。
- 從 startsIn 個 tick 後開始縮，endsIn 個 tick 後縮到 final 範圍為止，中間線性縮小。
- 坦克中心在安全區外時持續受傷：血量系統每秒 ${C.ZONE.dmgPerSec * 100}% 最大血量；經典模式在圈外每待 ${C.ZONE.classicSeconds} 秒扣 1。
- 只在生存和佔點模式出現。

## 職業（速度：格/秒，冷卻：tick）
  bot     電腦（沒有職業時）  移速 ${B.speed}  冷卻 ${B.cooldown}  彈速 ${B.bulletSpeed}  同時子彈 ${B.maxBullets}  每命耐久 ${B.hp}
${classLines}
爆炸子彈：命中坦克、牆或被抵消時爆炸，炸毀周圍 3×3 的磚牆（牆可破時），並對坦克中心距離爆炸中心 ${C.BLAST_RADIUS} 格以內（直線距離）的敵方坦克造成傷害。

## 血量系統（rules.hpSystem 為 true 時）
- 每條命有血量 hp（上限 maxHp），被打中就扣血，扣到 0 才算死一次。maxHp = 房主設定的血量（rules.playerHp 或 rules.botHp，預設 100）× 職業倍率 rules.classes[cls].hpFactor。
- 每發子彈的傷害是射手職業的 rules.classes[cls].damage；各職業的特色在 rules.classes[cls].hpTrait。
${Object.entries(C.HP.traits).map(([k, t]) => `  ${k.padEnd(8)} 血量 ×${C.HP.hpFactor[k]}  傷害 ${C.HP.damage[k]}  ${t}`).join('\n')}
  bot      血量 ×${C.HP.hpFactor.bot}  傷害 ${C.HP.damage.bot}（沒有職業的電腦）
- 爆炸子彈波及（不是直接命中）的傷害是 ${C.HP.splash * 100}%；地雷 ${C.HP.mine}。
- 自動回血（rules.regen，預設關閉）：開啟時 ${C.HP.regenDelay} 秒沒受傷後每秒回 ${C.HP.regenPerSec * 100}% 的最大血量。關閉時只有偵察會自己回血，其他只能靠護士和醫療包。
- rules.hpSystem 為 false 時：hp 是這條命還能挨幾發（大多是 1，重裝 2），每發扣 1。
子彈命中判定：子彈中心進入坦克方框（邊長 ${C.TANK_SIZE}）外擴 ${C.HIT_MARGIN} 格的範圍內就算命中。

## 遊戲目標（view.objective）
- { type: "survival" }：生存。打到剩最後一隊。
- { type: "koth", x, y, radius, myScore, bestEnemyScore, target, holder }：佔點。地圖中央以 (x, y) 為中心、兩軸各 ±radius 的區域，只有你們隊在裡面時每 tick 加 1 分，先到 target 分獲勝。holder 是 "me" | "enemy" | "contested" | null。
- { type: "ctf", flags: [ { x, y, homeX, homeY, ally, atHome, carrier } ], myCaptures, bestEnemyCaptures, target }：搶旗。碰到敵方的旗子就會撿起來（me.carrying 變成 true）；帶著它碰到「在家」的己方旗子就得 1 分，先到 target 分獲勝。帶旗的坦克被打掉時旗子會掉在原地，碰到自己掉落的旗子會把它送回家，掉落 ${C.FLAG_RETURN_TICKS / C.TICK_RATE} 秒沒人碰也會自己回家。
- { type: "escort", attacking, cart: { x, y }, radius, progress, state, path: [{ x, y }] }：護送。進攻方（attacking 為 true）要把礦車推到路線終點：礦車 radius 格內只有進攻方時會沿著 path 前進（人越多越快），只有防守方時會慢慢後退，兩邊都有時停住。progress 是 0～1 的進度。時間到之前推到終點進攻方贏，否則防守方贏。每局交換攻守。
- { type: "pve", ... }：打怪。見下方「打怪模式」。
- 佔點、搶旗和護送模式所有坦克都會無限重生（電腦 ${C.BOT_RESPAWN_DELAY / C.TICK_RATE} 秒後重生）；生存和打怪模式照一般的命數規則。

## 打怪模式（view.objective.type 為 "pve"）
所有玩家同一隊對抗怪物（cls 為 "monster"），固定使用血量系統。
view.objective = {
  type: "pve", mode: "campaign" | "endless" | "weekly", level, objective, difficulty,
  wave, waves（無盡或循環關為 null）, phase: "prep" | "preview" | "fight" | "draft", monstersLeft,
  parts（全隊共用的零件）, shop: { life, repair, reroll, revive }（各項價格）,
  draft: [ { key, name, rarity, mods } ] | null（抽卡階段給你的 3 張卡；已選或不在抽卡時為 null）, draftTicksLeft, myCards: [ key ],
  core: { x, y, hp, maxHp } | null, npc: { x, y, hp, maxHp, alive } | null, exit: { x, y } | null,
  generators: [ { x, y, progress, done, active } ] | null, bunkers: [ { x, y, hp, maxHp } ], track: [ [x, y] ] | null, laps,
  boss: { kind, x, y, hp, maxHp, phase, vulnerable } | null,
  hazards: [ { kind: "line" | "circle" | "poison" | "map", x, y, x2, y2, r, w, firesIn, endsIn, dmg, dps, islands } ]
}
- objective：waves 撐過所有波、destroy 摧毀據點、boss 擊敗 Boss、core 守護核心到時間結束、rescue 護送 npc 到 exit（npc 附近 4 格內有我方坦克、且 3 格內沒有怪物時才會前進）、generators 依序站在發電機上 10 秒（開始啟動時會引來一批怪物）、train 在列車繞 4 圈前擊毀車頭、endless 無盡。
- hazards 是預警區：firesIn 個 tick 後在範圍內造成 dmg 傷害；dps > 0 表示持續傷害區（每秒 dps）。line 是寬 w 的線段（x,y → x2,y2），circle／poison 是半徑 r 的圓，map 是全圖、但 islands（[{ x, y, r }]）裡面安全。
- 抽卡：phase 為 "draft" 時，回傳 { pick: 0～2 } 選卡，{ buy: "life" | "repair" | "reroll" | "revive" } 用零件買東西（可以和 move、fire 一起回傳）。時間到沒選會隨機。
- enemies 裡的怪物多了 kind、elite（詞綴陣列）、size（方框邊長）、boss、invulnerable。大型單位的命中範圍以 size 為準。
- 怪物種類（kind）：${Object.entries(PVE.MONSTERS).map(([k, m]) => `${k} ${m.name}：${m.desc}`).join('；')}
- Boss：${Object.entries(PVE.BOSSES).map(([k, m]) => `${k} ${m.name}：${m.desc}`).join('；')}
- 精英詞綴（elite）：${Object.entries(PVE.AFFIXES).map(([k, a]) => `${k} ${a.name}（${a.desc}）`).join('、')}
- 強化卡 key：${PVE.CARDS.map(c => `${c.key}（${c.name}：${c.desc}${c.cls ? '，限' + c.cls : ''}）`).join('、')}

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
- 被打中就扣 hp（見「血量系統」），hp 歸零就失去一條命。命數由房主設定（預設玩家 ${C.PLAYER_LIVES} 條、電腦 ${C.BOT_LIVES} 條；rules.playerLives／botLives，0 = 無限），死後在出生點重生（預設 ${C.RESPAWN_DELAY / C.TICK_RATE} 秒），重生後有 ${C.SHIELD_TICKS / C.TICK_RATE} 秒無敵。
- 一隊只要還有坦克活著，或玩家還有命可以重生，就算存活。基地模式下，基地被毀整隊立刻出局。
- 最後存活的隊伍獲勝。時間到時，剩餘總命數最多的隊伍獲勝；命數相同時比擊殺數。
- mode："ffa" 大亂鬥（每位玩家和他的電腦一隊）、"faction" 陣營戰（紅藍兩隊）、"team" 組隊（玩家自由分隊）。
- rules.codeOnly 為 true 時是純代碼對戰：沒有玩家坦克，每位玩家只有一台電腦坦克。
`;

module.exports = text;
