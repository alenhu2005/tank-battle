'use strict';

// 遊戲的所有數值都集中在這裡，方便之後調整平衡。
const TICK_RATE = 30;

// 全體速度倍率：想讓遊戲整體快一點或慢一點，改這兩個數字就好
const MOVE_SCALE = 0.75;     // 坦克移動速度
const BULLET_SCALE = 0.75;   // 子彈速度
const FIRE_SCALE = 1.25;     // 開火冷卻（越大射越慢）

const C = module.exports = {
  TICK_RATE,
  TANK_SPEED: 4,            // 格/秒
  BULLET_SPEED: 8,          // 格/秒（各職業以 CLASSES 為準）
  TANK_SIZE: 0.84,          // 坦克邊長（格）
  FIRE_COOLDOWN: 24,        // tick（電腦 0.8 秒；玩家依職業見 CLASSES，約快一倍）
  MAX_BULLETS_PER_TANK: 1,
  PLAYER_LIVES: 3,
  BOT_LIVES: 1,
  RESPAWN_DELAY: 5 * TICK_RATE,       // 玩家重生時間：剛好看完死亡重播
  BOT_RESPAWN_DELAY: 6 * TICK_RATE,
  DASH_SPEED: 2.5,           // 突擊技能「衝刺」的速度倍率   // 佔點、搶旗模式電腦的重生時間
  SHIELD_TICKS: 2 * TICK_RATE,
  FOG_RADIUS: 5.5,          // 迷霧模式下玩家的視野半徑（格）
  END_DELAY: Math.round(1.5 * TICK_RATE), // 分出勝負後再播一下爆炸

  BOT_CALL_TIMEOUT_MS: 30,  // 每次 think() 上限
  BOT_INIT_TIMEOUT_MS: 1000,// 程式最上層初始化上限
  BOT_MEMORY_MB: 32,
  BOT_CODE_MAX_BYTES: 100 * 1024,
  BOT_LOG_LINES: 80,

  MAX_PLAYERS: 6,
  // 進階規則（房主可調）的預設值與範圍
  ADV_DEFAULTS: { playerLives: 3, botLives: 1, speed: 1, bullet: 1, fire: 1, respawn: 5, itemSec: 10, playerHp: 100, botHp: 100 },
  ADV_RANGES: {
    playerLives: [0, 9], botLives: [0, 9],          // 0 = 無限重生
    speed: [0.5, 1.5], bullet: [0.5, 1.5], fire: [0.5, 2],
    respawn: [1, 15], itemSec: [4, 30],
    playerHp: [25, 500], botHp: [25, 500],          // 血量系統：標準坦克的血量（各職業再乘上倍率）
  },
  NAME_MAX: 12,

  // 八個方向（移動與射擊）。斜向的向量在使用時會正規化成長度 1
  DIRS: ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright'],
  DIR_VEC: {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1],
  },
  ALIGN_RATE: 1.0,
  SPREAD_ANGLE: 25,
  MAX_LAG_TICKS: 6,          // 延遲補償最多倒帶幾個 tick（0.2 秒）
  BASE_WALL_HP: 5,          // 基地周圍的磚牆要打幾下才會破
  BASE_WALL_SHIELD_TICKS: 30 * TICK_RATE,   // 開局後多久內基地圍牆打不壞         // 散彈：左右各偏幾度          // 直向/橫向移動時，另一軸靠向格子中心的速度（相對於移動速度）

  // 人類玩家的五種職業（電腦隊友固定用 bot 規格）。速度單位：格/秒；冷卻單位：tick
  CLASSES: {
    assault: { name: '突擊', speed: 4.0, cooldown: 10, bulletSpeed: 8, maxBullets: 3, hp: 1, vision: 5.5,
      desc: '連射型：射最快，場上可同時有 3 顆子彈' },
    heavy:   { name: '重裝', speed: 2.8, cooldown: 14, bulletSpeed: 7, maxBullets: 2, hp: 2, vision: 5.5,
      desc: '每條命要被打 2 下，可同時 2 顆子彈，但又慢又笨重' },
    scout:   { name: '偵察', speed: 5.6, cooldown: 12, bulletSpeed: 8, maxBullets: 2, hp: 1, vision: 8, grassSight: true,
      desc: '移動最快，可同時 2 顆子彈；迷霧模式視野最大，看得穿草叢' },
    sniper:  { name: '狙擊', speed: 3.6, cooldown: 16, bulletSpeed: 14, maxBullets: 1, hp: 1, vision: 7,
      desc: '子彈速度最快（快將近一倍），迷霧模式視野較大' },
    demo:    { name: '爆破', speed: 3.8, cooldown: 14, bulletSpeed: 8, maxBullets: 1, hp: 1, vision: 5.5, blast: true,
      desc: '子彈命中或被抵消時爆炸：炸毀 3×3 磚牆，並波及周圍 1 格的敵人' },
    engineer: { name: '工兵', speed: 3.6, cooldown: 16, bulletSpeed: 9, maxBullets: 1, hp: 1, vision: 5.5,
      desc: '防守型：可以蓋磚牆，在自家基地旁還能修補基地圍牆' },
    nurse:   { name: '護士', speed: 3.8, cooldown: 14, bulletSpeed: 8, maxBullets: 2, hp: 1, vision: 6,
      desc: '支援型：火力弱，但可以治療身邊的隊友' },
  },
  MONSTER_CLASS: { name: '怪物', speed: 3.4, cooldown: 30, bulletSpeed: 7, maxBullets: 1, hp: 1, vision: 0 },

  // 遊戲目標（模式）
  OBJECTIVES: ['survival', 'koth', 'ctf', 'pve', 'escort'],
  CART_SPEED: 0.6,           // 護送：礦車每秒前進幾格（每多一台進攻坦克再快 25%）
  CART_BACK_SPEED: 0.12,      // 只有防守方在旁邊時，礦車每秒往回退幾格
  CART_RADIUS: 2,            // 礦車周圍多遠算「在旁邊」
  ESCORT_DEFAULT_TIME: 180,  // 護送模式沒設時間時的預設時間（秒）
  KOTH_RADIUS: 1.5,                 // 佔點區域：中心 ±1.5 格（3×3）
  KOTH_TARGET_TICKS: 45 * TICK_RATE,
  CTF_CAPTURES: 3,
  FLAG_RETURN_TICKS: 20 * TICK_RATE,
  PVE_WAVES: 5,
  PVE_MAX_MONSTERS: 12,
  BOT_CLASS: { name: '電腦', speed: 4.0, cooldown: 24, bulletSpeed: 8, maxBullets: 1, hp: 1, vision: 0 },
  // 血量系統（房間設定，預設開啟）：每條命有血量，子彈依射手職業扣血
  //   maxHp = 房主設定的血量（玩家／電腦分開，預設 100）× hpFactor；damage 是每發子彈扣的血
  HP: {
    hpFactor: { assault: 1, heavy: 1.4, scout: 0.9, sniper: 0.9, demo: 1.1, engineer: 1.35, nurse: 1, bot: 1, monster: 0.6 },
    damage:   { assault: 25, heavy: 32, scout: 30, sniper: 45, demo: 38, engineer: 40, nurse: 24, bot: 35, monster: 25 },
    // 各職業在血量系統下的特色（說明文字給大廳和規格用）
    traits: {
      assault:  '連擊：1 秒內連續打中同一個敵人，每發多 5 傷害（最多多 15）',
      heavy:    '血量 1.4 倍，爆炸和地雷的傷害減半',
      scout:    '血量略少，但沒受傷 3 秒就會自己回血（房主沒開自動回血也會；開了的話回血速度是別人的 2 倍）',
      sniper:   '距離越遠傷害越高：3 格內 45，10 格以上 80（蓄力射擊再 ×1.5）',
      demo:     '直接命中 38，爆炸波及周圍敵人 23',
      engineer: '血量 1.35 倍；每次成功使用築牆技能回復自己 20% 血量',
      nurse:    '傷害最低（24）；身邊 3 格內的隊友（含自己）就算在交戰中也會持續回血（每秒 4%）',
    },
    comboBonus: 5, comboMax: 3,            // 突擊連擊
    sniperNear: 45, sniperFar: 80,          // 狙擊：3 格內／10 格以上的傷害
    scoutRegenDelay: 3, scoutRegenMult: 2,
    engineerHeal: 0.2,
    nurseAura: 3, nurseAuraPerSec: 0.04,
    healSkill: 0.4,                         // 護士技能：回最大血量的 4 成
    chargedMult: 1.5,        // 狙擊蓄力射擊的傷害倍率
    splash: 0.6,             // 爆炸波及（不是直接命中）的傷害倍率
    mine: 50,                // 地雷傷害
    regenDelay: 5,           // 幾秒沒受傷後開始回血
    regenPerSec: 0.06,       // 每秒回最大血量的幾成
    medkit: 0.5,             // 醫療包：回最大血量的一半
    armor: 0.5,              // 裝甲：加最大血量一半的額外血量（最多到 1.5 倍）
    armorCap: 1.5,
  },
  BLAST_RADIUS: 1.1,        // 爆炸傷害：坦克中心與爆炸中心的直線距離
  HIT_MARGIN: 0.03,         // 子彈命中判定比坦克外框多出的距離（越小越不會「沒碰到就死」）
  COUNTDOWN_SECONDS: 5,
  BULLET_BOUNCES: 2,        // 子彈反彈模式：每顆子彈最多反彈幾次

  // 場地道具
  // icon 盡量一眼看得出功能；label 是地圖上道具下方的兩個字；weight 越大越常出現
  ITEM_TYPES: [
    { key: 'shield',   icon: '🛡️', name: '護盾',     label: '護盾', weight: 3, desc: '4 秒內無敵' },
    { key: 'speed',    icon: '👟', name: '加速',     label: '加速', weight: 3, desc: '8 秒內移動速度 ×1.4' },
    { key: 'rapid',    icon: '🔥', name: '火力全開', label: '連射', weight: 3, desc: '8 秒內開火冷卻減半，同時子彈 +1' },
    { key: 'life',     icon: '❤️', name: '加命',     label: '加命', weight: 2, desc: '玩家坦克 +1 條命（最多 3 條）；電腦撿到改給護盾' },
    { key: 'blast',    icon: '💣', name: '爆裂彈',   label: '爆裂', weight: 2, desc: '接下來 3 發子彈會爆炸，波及周圍敵人' },
    { key: 'pierce',   icon: '🗡️', name: '穿甲彈',   label: '穿甲', weight: 2, desc: '接下來 5 發子彈撞到敵方子彈不會被抵消' },
    { key: 'spread',   icon: '🔱', name: '散彈',     label: '散彈', weight: 2, desc: '8 秒內每次開火射出 3 發（扇形）' },
    { key: 'bounce',   icon: '🏀', name: '彈跳彈',   label: '彈跳', weight: 2, desc: '8 秒內子彈撞牆會反彈，最多 3 次' },
    { key: 'swift',    icon: '💨', name: '疾風彈',   label: '快彈', weight: 2, desc: '8 秒內子彈速度 ×1.6' },
    { key: 'armor',    icon: '🪖', name: '裝甲',     label: '裝甲', weight: 2, desc: '這條命可以多挨 1 發（血量系統：多一半的額外血量）' },
    { key: 'medkit',   icon: '🩹', name: '醫療包',   label: '補血', weight: 3, desc: '立刻回復一半血量（只在血量系統出現）', hpOnly: true },
    { key: 'cloak',    icon: '👻', name: '隱形',     label: '隱形', weight: 2, desc: '6 秒內敵人（包括敵方電腦）看不到你' },
    { key: 'phase',    icon: '🌀', name: '穿牆',     label: '穿牆', weight: 2, desc: '5 秒內可以穿過磚牆和水' },
    { key: 'freeze',   icon: '❄️', name: '冰凍彈',   label: '冰凍', weight: 2, desc: '接下來 3 發命中敵人時，把他凍住 2 秒（不扣命）' },
    { key: 'confuse',  icon: '😵', name: '混亂彈',   label: '混亂', weight: 2, desc: '接下來 3 發命中敵人時，讓他方向顛倒 3 秒（不扣命）' },
    { key: 'emp',      icon: '⚡', name: '電磁脈衝', label: '電磁', weight: 2, desc: '身邊 6 格內的敵人立刻凍住 1.5 秒' },
    { key: 'timestop', icon: '⏸️', name: '時間暫停', label: '暫停', weight: 1, desc: '全場敵人立刻凍住 1.5 秒' },
    { key: 'revive',   icon: '🤖', name: '復活電腦', label: '復活', weight: 1, desc: '你的電腦隊友如果陣亡就復活它；還活著就給它護盾' },
    { key: 'fortify',  icon: '🏰', name: '基地加固', label: '加固', weight: 2, desc: '把你們基地周圍的磚牆補回來（沒有基地時改給護盾）' },
    { key: 'quake',    icon: '⛏️', name: '拆牆',     label: '拆牆', weight: 2, desc: '炸掉你身邊 2 格內的所有磚牆' },
    { key: 'home',     icon: '🏠', name: '回城',     label: '回城', weight: 2, desc: '瞬間傳送回自己的出生點，並有 1 秒無敵' },
    { key: 'radar',    icon: '👁️', name: '全視',     label: '全視', weight: 2, desc: '10 秒內看得到全場（無視迷霧、看穿草叢）' },
    { key: 'swap',     icon: '🔄', name: '換位',     label: '換位', weight: 1, desc: '和離你最近的敵人互換位置' },
  ],
  ITEM_FIRST_DELAY: 6 * TICK_RATE,
  ITEM_INTERVAL: 10 * TICK_RATE,
  ITEM_MAX: 4,
  ITEM_LIFETIME: 20 * TICK_RATE,
  ITEM_PICKUP_RANGE: 0.6,
  ITEM_SHIELD_TICKS: 4 * TICK_RATE,
  BUFF_TICKS: 8 * TICK_RATE,
  SPEED_BUFF: 1.4,
  BLAST_SHOTS: 3,
  PIERCE_SHOTS: 5,
  STATUS_SHOTS: 3,                 // 冰凍彈、混亂彈的發數
  SWIFT_BULLET: 1.6,
  CLOAK_TICKS: 6 * TICK_RATE,
  PHASE_TICKS: 5 * TICK_RATE,
  RADAR_TICKS: 10 * TICK_RATE,
  FREEZE_HIT_TICKS: 2 * TICK_RATE,
  CONFUSE_TICKS: 3 * TICK_RATE,
  EMP_TICKS: Math.round(1.5 * TICK_RATE),
  EMP_RADIUS: 6,
  BOUNCE_BUFF: 3,

  // 大亂鬥時各隊的顏色；陣營戰固定紅藍
  FFA_COLORS: ['#f2c94c', '#3ddc84', '#4aa8ff', '#ff6b6b', '#c084fc', '#ff9f43'],
  TEAM_COUNT: 6,
  FACTION_COLORS: { red: '#ff6b6b', blue: '#4aa8ff' },
};

// 職業主動技能（cd：冷卻秒數）
const SKILLS = {
  assault:  { key: 'dash',   name: '衝刺',     icon: '⏩', cd: 6,  desc: '0.5 秒內移動速度 ×2.5' },
  heavy:    { key: 'wall',   name: '護盾牆',   icon: '🧱', cd: 12, desc: '在正前方立起 3 格鋼牆，5 秒後消失' },
  scout:    { key: 'smoke',  name: '煙霧',     icon: '🌫️', cd: 12, desc: '放出 5 秒的煙霧，裡面的坦克敵人看不到（玩家和電腦都看不到）' },
  sniper:   { key: 'charge', name: '蓄力射擊', icon: '🎯', cd: 8,  desc: '下一發（5 秒內）速度 ×1.8、撞到敵方子彈不會被抵消、會穿過第一台坦克' },
  demo:     { key: 'mine',   name: '地雷',     icon: '🧨', cd: 7,  desc: '在腳下放地雷（只有自己隊看得到），1 秒後啟動，敵人碰到就爆炸；最多 3 個' },
  engineer: { key: 'build',  name: '築牆',     icon: '🔧', cd: 5,  desc: '在正前方蓋一塊磚牆；在自家基地旁使用時改成修補並加固基地圍牆' },
  nurse:    { key: 'heal',   name: '治療',     icon: '💉', cd: 10, desc: '治療自己和 3 格內的隊友：回 40% 血量（沒開血量系統時改成補滿耐久並給 1.5 秒護盾）' },
};
for (const k in SKILLS) C.CLASSES[k].skill = SKILLS[k];
C.SKILLS = SKILLS;
for (const [k, c] of [...Object.entries(C.CLASSES), ['bot', C.BOT_CLASS]]) {   // 血量系統的數值也放進職業表（大廳顯示用）
  c.hpFactor = C.HP.hpFactor[k]; c.damage = C.HP.damage[k]; c.hpTrait = C.HP.traits[k] || null;
}

// 套用全體速度倍率（職業、電腦、怪物都一樣，彼此的相對差異不變）
const scale = (v, k) => Math.round(v * k * 100) / 100;
for (const c of [...Object.values(C.CLASSES), C.BOT_CLASS, C.MONSTER_CLASS]) {
  c.speed = scale(c.speed, MOVE_SCALE);
  c.bulletSpeed = scale(c.bulletSpeed, BULLET_SCALE);
  c.cooldown = Math.round(c.cooldown * FIRE_SCALE);
}
C.FIRE_COOLDOWN = Math.round(C.FIRE_COOLDOWN * FIRE_SCALE);
C.FIRE_SCALE = FIRE_SCALE;
C.TANK_SPEED = scale(C.TANK_SPEED, MOVE_SCALE);
C.BULLET_SPEED = scale(C.BULLET_SPEED, BULLET_SCALE);
C.MOVE_SCALE = MOVE_SCALE;
C.BULLET_SCALE = BULLET_SCALE;
