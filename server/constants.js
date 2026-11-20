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
      desc: '高射速，同時 3 發' },
    heavy:   { name: '重裝', speed: 2.8, cooldown: 14, bulletSpeed: 7, maxBullets: 2, hp: 2, vision: 5.5,
      desc: '高耐久，同時 2 發，移動緩慢' },
    scout:   { name: '偵察', speed: 5.6, cooldown: 12, bulletSpeed: 8, maxBullets: 2, hp: 1, vision: 8, grassSight: true,
      desc: '移速最快，同時 2 發；視野最大，可看穿草叢' },
    sniper:  { name: '狙擊', speed: 3.6, cooldown: 16, bulletSpeed: 14, maxBullets: 1, hp: 1, vision: 7,
      desc: '彈速最快，視野較大' },
    demo:    { name: '爆破', speed: 3.8, cooldown: 14, bulletSpeed: 8, maxBullets: 1, hp: 1, vision: 5.5, blast: true,
      desc: '爆炸彈：摧毀 3×3 磚牆並波及周圍敵人' },
    engineer: { name: '工兵', speed: 3.6, cooldown: 16, bulletSpeed: 9, maxBullets: 1, hp: 1, vision: 5.5,
      desc: '防守型：建造磚牆、修補基地圍牆' },
    nurse:   { name: '護士', speed: 3.8, cooldown: 14, bulletSpeed: 8, maxBullets: 2, hp: 1, vision: 6,
      desc: '支援型：治療周圍隊友，火力較弱' },
  },
  MONSTER_CLASS: { name: '怪物', speed: 3.4, cooldown: 30, bulletSpeed: 7, maxBullets: 1, hp: 1, vision: 0 },

  // 遊戲目標（模式）
  OBJECTIVES: ['survival', 'koth', 'ctf', 'pve', 'escort', 'siege', 'mkoth', 'crystals', 'soccer', 'gungame', 'tag'],
  TWO_TEAM_OBJECTIVES: ['escort', 'siege', 'soccer'],      // 只能兩隊
  RESPAWN_OBJECTIVES: ['koth', 'ctf', 'escort', 'siege', 'mkoth', 'crystals', 'soccer', 'gungame', 'tag'],   // 無限重生
  MODE_DEFAULT_SECONDS: 180,  // 新模式沒設時間時的時限（秒）
  MKOTH_MOVE_SECONDS: 30,     // 移動佔點：每幾秒換位置
  SIEGE: { coreHp: 3000, coreHits: 45, turretHp: 500, turretHits: 6, turretCooldown: 40, turretBulletSpeed: 6.5, turretRange: 10, defaultSeconds: 240 },
  CRYSTALS: { everySeconds: 2.5, maxOnMap: 10, carryMax: 10, homeRadius: 1.5, target: 20 },
  SOCCER: { push: 3.5, shot: 0.35, maxSpeed: 9, friction: 0.97, target: 3 },
  TAG_SPEED: 1.15,            // 鬼的移動速度倍率
  CART_SPEED: 0.6,           // 護送：礦車每秒前進幾格（每多一台進攻坦克再快 25%）
  CART_BACK_SPEED: 0.3,       // 只有防守方在旁邊時，礦車每秒往回退幾格（每多一台防守坦克再快 25%）
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
      assault:  '連擊：1 秒內連續命中同一目標，每發 +5（上限 +15）',
      heavy:    '爆炸與地雷傷害減半',
      scout:    '3 秒未受傷即自動回血（不受自動回血設定限制；開啟時速度 2 倍）',
      sniper:   '距離越遠傷害越高：45（3 格內）～80（10 格以上），蓄力 ×1.5',
      demo:     '直擊 38，波及 23',
      engineer: '築牆成功時回復 20% 血量',
      nurse:    '光環：3 格內隊友（含自身）持續回血，每秒 4%',
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
  // 玩家與電腦的職業分開：玩家坦克明顯較強；電腦的狙擊太強，額外削弱
  PLAYER_EDGE: { hp: 1.3, damage: 1.15, cooldown: 0.9 },
  BOT_CLASS_EDGE: { sniper: { damage: 0.6, bulletSpeed: 0.8, cooldown: 1.2 } },
  // 玩家職業套件：只有玩家坦克有（電腦坦克維持原本的職業）
  //   desc 被動專長、bullet 專屬子彈、skill 強化版技能（取代原本的技能）
  PLAYER_PERKS: {
    assault: { name: '腎上腺素', icon: '💢', desc: '擊殺後 3 秒開火冷卻 ×0.6',
      bullet: { name: '雙管', desc: '一次射出兩發平行子彈（算一發的額度），每發傷害 ×0.55，同一組打中只算一次連擊（經典模式：打中同一台只算一發）' },
      skill: { key: 'ram', name: '突擊衝撞', icon: '⏩', cd: 6, desc: '0.6 秒內移速 ×2.5，撞到的敵人受到 30 傷害並被擊退（經典模式：扣 1 點耐久）' } },
    heavy: { name: '前裝甲', icon: '🛡️', desc: '車頭正面 ±50° 飛來的子彈，每 4 秒可完全擋下一發',
      bullet: { name: '重砲彈', desc: '大口徑砲彈：傷害 ×1.2，命中時把目標擊退 0.6 格' },
      skill: { key: 'bigwall', name: '堡壘牆', icon: '🧱', cd: 12, desc: '前方生成 5 格鋼牆，持續 7 秒' } },
    scout: { name: '打帶跑', icon: '💨', desc: '子彈命中敵人後加速 1.5 秒',
      bullet: { name: '跳彈', desc: '子彈碰到牆（含磚牆）會反彈，最多 2 次' },
      skill: { key: 'ghost', name: '幻影煙霧', icon: '🌫️', cd: 12, desc: '施放煙霧 5 秒，並隱形 2 秒' } },
    sniper: { name: '屏息', icon: '🎯', desc: '靜止 0.6 秒後，下一發彈速 ×1.4、傷害 ×1.25（經典模式改為多貫穿 1 台）',
      bullet: { name: '穿甲彈', desc: '每發都能貫穿 1 台坦克' },
      skill: { key: 'mark', name: '標記射擊', icon: '🔴', cd: 8, desc: '5 秒內下一發蓄力（彈速 ×1.8、不被抵消、再貫穿 1 台），命中的敵人被標記 5 秒，受到的所有傷害 +25%' } },
    demo: { name: '高爆', icon: '💥', desc: '爆炸範圍 ×1.35，炸牆範圍擴大成十字 5 格',
      bullet: { name: '集束彈', desc: '爆炸後向四個斜角噴出破片（短距離，傷害 ×0.4）' },
      skill: { key: 'minefield', name: '雷區', icon: '🧨', cd: 8, desc: '一次在周圍放 3 顆地雷，0.5 秒後啟動；最多 6 顆' } },
    engineer: { name: '修復', icon: '🧱', desc: '3 格內受損的加固牆（基地圍牆、城牆）每 2 秒修復 1 點',
      bullet: { name: '導引釘', desc: '子彈會緩慢轉向前方 4 格內的敵人' },
      skill: { key: 'turret', name: '部署砲塔', icon: '🗼', cd: 18, desc: '在前方部署自動砲塔 6 秒，射擊 6 格內看得到的敵人（每發 14 傷害）；在自家基地旁使用時改為修補並加固圍牆' } },
    nurse: { name: '大範圍光環', icon: '✚', desc: '治療光環範圍 +1 格',
      bullet: { name: '治療彈', desc: '子彈穿過隊友時治療 8% 血量（經典模式回 1 點耐久）' },
      skill: { key: 'sanctuary', name: '聖域', icon: '💉', cd: 10, desc: '治療自身與 3 格內隊友 40% 血量，並給 1.5 秒護盾' } },
  },
  PERK: { frenzyTicks: 90, frenzyCd: 0.6, plateTicks: 120, plateArc: 50, scoutRush: 45, steadyTicks: 18, steadySpeed: 1.4, steadyDmg: 1.25, demoBlast: 1.35, engRepairTicks: 60, nurseHeal: 0.08,
    twinDmg: 0.55, shellDmg: 1.2, twinGap: 0.17, shellSpeed: 1, knockback: 0.6, scoutBounces: 2, shardDmg: 0.4, shardTicks: 7, markTicks: 150, markDmg: 1.25,
    ramDmg: 30, ramTicks: 18, turretTicks: 180, turretRange: 6, turretHp: 50, turretHits: 1, turretDmg: 14, turretCooldown: 36, homingTurn: 2 },

  // 規格版本：每次規格有新東西就 +1，並在 CHANGELOG 最前面加一行（玩家拿舊代碼給 AI 改時，AI 才知道要補什麼）
  SPEC_VERSION: 7,
  CHANGELOG: [
    [7, '新遊戲目標：攻城戰 siege、移動佔點（koth 的 moving）、晶礦收集 crystals、坦克足球 soccer、職業輪換 gungame、鬼抓人 tag'],
    [6, '全向砲塔：回傳 aim 可獨立瞄準，view 坦克的 aim 提供砲塔角度'],
    [5, '打怪模式改版：view.objective 的 pve 欄位（波次、Boss、預警區 hazards、核心、發電機等）、抽卡回傳 pick／buy、怪物的 kind／elite／size'],
    [4, '新地形 O 油桶、H 補血站、P 傳送門；縮圈 view.zone；坦克多了 maxHp'],
    [3, '血量系統（rules.hpSystem、hp／maxHp、各職業傷害）、自動回血 rules.regen、護士職業與 heal 技能、電腦也能有職業（rules.botClasses）'],
    [2, '職業技能 skill、工兵職業、護送模式、進階規則（命數、速度倍率）'],
    [1, '無段落移動（move 可以是任意角度）'],
  ],

  // 特殊地形與縮圈
  BARREL_RADIUS: 1.6,        // 油桶爆炸範圍（格，直線距離）
  BARREL_DMG: 60,            // 油桶爆炸傷害（經典模式一律算 1 下）
  HEAL_PAD_PER_SEC: 0.1,     // 補血站：每秒回最大血量的 1 成
  PORTAL_CD: 2 * TICK_RATE,  // 傳送後多久不能再傳送
  ZONE: { start: 0.4, end: 0.85, minHalf: 2.5, dmgPerSec: 0.08, classicSeconds: 4, defaultSeconds: 180 },
  BLAST_RADIUS: 1.1,        // 爆炸傷害：坦克中心與爆炸中心的直線距離
  HIT_MARGIN: 0.03,         // 子彈命中判定比坦克外框多出的距離（越小越不會「沒碰到就死」）
  COUNTDOWN_SECONDS: 5,
  BULLET_BOUNCES: 2,        // 子彈反彈模式：每顆子彈最多反彈幾次

  // 場地道具
  // icon 盡量一眼看得出功能；label 是地圖上道具下方的兩個字；weight 越大越常出現
  ITEM_TYPES: [
    { key: 'shield',   icon: '🛡️', name: '護盾',     label: '護盾', weight: 3, desc: '4 秒內無敵' },
    { key: 'speed',    icon: '👟', name: '加速',     label: '加速', weight: 3, desc: '8 秒內移動速度 ×1.4' },
    { key: 'rapid',    icon: '🔥', name: '火力全開', label: '連射', weight: 3, desc: '8 秒內冷卻減半、同時子彈 +1' },
    { key: 'life',     icon: '❤️', name: '加命',     label: '加命', weight: 2, desc: '玩家 +1 命（上限內）；電腦改為護盾' },
    { key: 'blast',    icon: '💣', name: '爆裂彈',   label: '爆裂', weight: 2, desc: '接下來 3 發為爆炸彈' },
    { key: 'pierce',   icon: '🗡️', name: '穿甲彈',   label: '穿甲', weight: 2, desc: '接下來 5 發不會被敵彈抵消' },
    { key: 'spread',   icon: '🔱', name: '散彈',     label: '散彈', weight: 2, desc: '8 秒內每次射出 3 發扇形彈' },
    { key: 'bounce',   icon: '🏀', name: '彈跳彈',   label: '彈跳', weight: 2, desc: '8 秒內子彈可反彈 3 次' },
    { key: 'swift',    icon: '💨', name: '疾風彈',   label: '快彈', weight: 2, desc: '8 秒內子彈速度 ×1.6' },
    { key: 'armor',    icon: '🪖', name: '裝甲',     label: '裝甲', weight: 2, desc: '耐久 +1（血量系統：額外 50% 血量）' },
    { key: 'medkit',   icon: '🩹', name: '醫療包',   label: '補血', weight: 3, desc: '回復 50% 血量（限血量系統）', hpOnly: true },
    { key: 'cloak',    icon: '👻', name: '隱形',     label: '隱形', weight: 2, desc: '6 秒內對敵方隱形' },
    { key: 'phase',    icon: '🌀', name: '穿牆',     label: '穿牆', weight: 2, desc: '5 秒內可穿越磚牆與水' },
    { key: 'freeze',   icon: '❄️', name: '冰凍彈',   label: '冰凍', weight: 2, desc: '接下來 3 發命中時凍結目標 2 秒（無傷害）' },
    { key: 'confuse',  icon: '😵', name: '混亂彈',   label: '混亂', weight: 2, desc: '接下來 3 發命中時使目標方向顛倒 3 秒（無傷害）' },
    { key: 'emp',      icon: '⚡', name: '電磁脈衝', label: '電磁', weight: 2, desc: '凍結 6 格內敵人 1.5 秒' },
    { key: 'timestop', icon: '⏸️', name: '時間暫停', label: '暫停', weight: 1, desc: '凍結全場敵人 1.5 秒' },
    { key: 'revive',   icon: '🤖', name: '復活電腦', label: '復活', weight: 1, desc: '復活己方電腦；存活時改為護盾' },
    { key: 'fortify',  icon: '🏰', name: '基地加固', label: '加固', weight: 2, desc: '修復基地圍牆（無基地時改為護盾）' },
    { key: 'quake',    icon: '⛏️', name: '拆牆',     label: '拆牆', weight: 2, desc: '摧毀 2 格內所有磚牆' },
    { key: 'home',     icon: '🏠', name: '回城',     label: '回城', weight: 2, desc: '傳送回出生點，無敵 1 秒' },
    { key: 'radar',    icon: '👁️', name: '全視',     label: '全視', weight: 2, desc: '10 秒內全圖視野（無視迷霧、草叢）' },
    { key: 'swap',     icon: '🔄', name: '換位',     label: '換位', weight: 1, desc: '與最近的敵人互換位置' },
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
  heavy:    { key: 'wall',   name: '護盾牆',   icon: '🧱', cd: 12, desc: '前方生成 3 格鋼牆，持續 5 秒' },
  scout:    { key: 'smoke',  name: '煙霧',     icon: '🌫️', cd: 12, desc: '施放煙霧 5 秒，霧中坦克對敵方隱形' },
  sniper:   { key: 'charge', name: '蓄力射擊', icon: '🎯', cd: 8,  desc: '5 秒內下一發：彈速 ×1.8、不被抵消、貫穿一台坦克' },
  demo:     { key: 'mine',   name: '地雷',     icon: '🧨', cd: 7,  desc: '放置地雷（僅己方可見），1 秒後啟動；最多 3 個' },
  engineer: { key: 'build',  name: '築牆',     icon: '🔧', cd: 5,  desc: '前方建造磚牆；於自家基地旁使用時修補並加固圍牆' },
  nurse:    { key: 'heal',   name: '治療',     icon: '💉', cd: 10, desc: '治療自身與 3 格內隊友 40% 血量（經典模式：補滿耐久＋1.5 秒護盾）' },
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
