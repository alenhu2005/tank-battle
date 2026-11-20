'use strict';

// 打怪（PvE）資料：怪物、Boss、精英詞綴、強化卡、關卡、每週詞綴。
// 速度單位：格/秒；冷卻：tick；血量以「玩家標準坦克 100」為基準，難度與人數會再縮放。

// ---------- 怪物 ----------
// size：碰撞與命中方框邊長（格）；dmg：子彈或技能傷害；range：會開火的距離
const MONSTERS = {
  crawler:  { name: '爬蟲',   icon: '🐛', hp: 45,  speed: 2.2, cooldown: 50,  bulletSpeed: 5,  maxBullets: 1, dmg: 14, range: 7,  size: 0.84,
    desc: '基本雜兵，直衝最近的玩家。', counter: '集中火力即可。' },
  charger:  { name: '衝鋒者', icon: '🦏', hp: 80,  speed: 2.3, cooldown: 0,   bulletSpeed: 0,  maxBullets: 0, dmg: 35, range: 6,  size: 0.9,
    desc: '鎖定後蓄力 1 秒直線衝撞；撞牆會暈眩 2 秒。', counter: '看到蓄力就側閃，引它撞牆。' },
  turret:   { name: '砲台',   icon: '🗼', hp: 130, speed: 0,   cooldown: 70,  bulletSpeed: 6,  maxBullets: 3, dmg: 12, range: 9,  size: 0.9, shield: 50,
    desc: '固定不動，三連發；正面有護盾。', counter: '繞到側面或背後攻擊。' },
  sniper:   { name: '狙擊蟲', icon: '🎯', hp: 55,  speed: 1.8, cooldown: 110, bulletSpeed: 13, maxBullets: 1, dmg: 38, range: 14, size: 0.84, keepAway: 7,
    desc: '保持距離，地面出現紅線 1 秒後射出高速彈。', counter: '看到紅線立刻離開。' },
  bomber:   { name: '自爆蟲', icon: '💥', hp: 28,  speed: 3.9, cooldown: 0,   bulletSpeed: 0,  maxBullets: 0, dmg: 45, range: 1.3, size: 0.75,
    desc: '高速接近，貼身 0.8 秒後爆炸，波及周圍並炸毀磚牆。', counter: '在遠距離擊殺。' },
  shield:   { name: '護盾兵', icon: '🛡️', hp: 120, speed: 1.8, cooldown: 60,  bulletSpeed: 5,  maxBullets: 1, dmg: 14, range: 7,  size: 0.95, shield: 60,
    desc: '正面盾牌擋子彈，會擋在其他怪物前面。', counter: '繞後，或用爆炸傷害。' },
  healer:   { name: '治療者', icon: '💚', hp: 60,  speed: 2.2, cooldown: 0,   bulletSpeed: 0,  maxBullets: 0, dmg: 0,  range: 0,  size: 0.84, keepAway: 6,
    desc: '遠離玩家，持續治療 3.5 格內的怪物。', counter: '優先擊殺。' },
  summoner: { name: '召喚師', icon: '🔮', hp: 85,  speed: 1.6, cooldown: 0,   bulletSpeed: 0,  maxBullets: 0, dmg: 0,  range: 0,  size: 0.9, keepAway: 6,
    desc: '每 6 秒召喚 2 隻爬蟲。', counter: '優先擊殺。' },
  lurker:   { name: '潛伏者', icon: '👤', hp: 50,  speed: 3.0, cooldown: 30,  bulletSpeed: 7,  maxBullets: 1, dmg: 26, range: 4,  size: 0.84,
    desc: '隱形接近，只看得到殘影；開火時現身 3 秒。', counter: '偵察可看穿；範圍傷害。' },
  builder:  { name: '工程兵', icon: '🔧', hp: 75,  speed: 2.0, cooldown: 70,  bulletSpeed: 5,  maxBullets: 1, dmg: 14, range: 7,  size: 0.9,
    desc: '每 8 秒在前方蓋磚牆封路，並修補己方據點。', counter: '優先擊殺，拆除封路的牆。' },
  // 關卡物件（不算一般怪物）
  bunker:   { name: '據點',   icon: '🏯', hp: 1300, speed: 0, cooldown: 0, bulletSpeed: 0, maxBullets: 0, dmg: 0, range: 0, size: 1.6, structure: true,
    desc: '每 10 秒派出一隻爬蟲。', counter: '擊毀所有據點。' },
  fturret:  { name: '堡壘砲塔', icon: '🔩', hp: 380, speed: 0, cooldown: 55, bulletSpeed: 6, maxBullets: 4, dmg: 14, range: 12, size: 1.0, part: true,
    desc: '鋼鐵堡壘的砲塔，可以個別擊毀。', counter: '先拆掉一側，製造安全區。' },
  qclone:   { name: '女王分身', icon: '🪞', hp: 1, speed: 2.6, cooldown: 60, bulletSpeed: 5, maxBullets: 1, dmg: 10, range: 9, size: 1.6, part: true,
    desc: '一擊即碎；真身有影子。', counter: '找出有影子的真身。' },
  tcar:     { name: '車廂',   icon: '🚃', hp: 1, speed: 0, cooldown: 0, bulletSpeed: 0, maxBullets: 0, dmg: 0, range: 0, size: 1.1, part: true, invuln: true,
    desc: '無敵，擋住子彈；經過路口會丟炸彈。', counter: '攻擊車頭。' },
};

// ---------- Boss ----------
const BOSSES = {
  fortress: { name: '鋼鐵堡壘', icon: '🏰', hp: 4200, size: 2.8, speed: 1.3, dmg: 40, chapter: 1,
    desc: '四座砲塔齊射；60% 開始旋轉掃射並召喚爬蟲；25% 開始衝撞。', counter: '先拆一側砲塔，衝撞前看預警線閃開。' },
  queen:    { name: '毒霧女王', icon: '🦋', hp: 3200, size: 1.6, speed: 2.4, dmg: 12, chapter: 2, flying: true,
    desc: '飛行，不受牆阻擋。放毒霧；60% 分身；25% 全場毒霧只剩移動的安全島。', counter: '分身一擊即碎，真身有影子；護士維持血量。' },
  train:    { name: '雷霆列車', icon: '🚂', hp: 1600, size: 1.3, speed: 2.0, dmg: 35, chapter: 3,
    desc: '沿軌道繞行，只有車頭會受傷；經過路口丟炸彈。每繞一圈撞擊核心一次。', counter: '在軌道旁埋伏車頭，4 圈內擊毀。' },
  colossus: { name: '機械巨像', icon: '🗿', hp: 5000, size: 4.6, speed: 0, dmg: 45, chapter: 3,
    desc: '雷射掃射並生成砲台；70% 地圖崩塌；40% 起核心每 15 秒開放一次。', counter: '重裝與磚牆可擋雷射；核心開放時全力輸出。' },
};

// ---------- 精英詞綴 ----------
const AFFIXES = {
  frenzy:  { name: '狂暴', color: '#ff5a4f', desc: '射速 ×2、移速 ×1.2' },
  tough:   { name: '堅韌', color: '#c9a227', desc: '血量 ×2' },
  split:   { name: '分裂', color: '#7ee0ff', desc: '死亡時分裂成 2 隻爬蟲' },
  frost:   { name: '寒冰', color: '#9fdcff', desc: '子彈命中時緩速 1.5 秒' },
  reflect: { name: '反射', color: '#e0e0ff', desc: '被擊中時 20% 機率反彈子彈' },
  contagion: { name: '傳染', color: '#9be15d', desc: '死亡時周圍怪物加速 4 秒' },
};

// ---------- 強化卡 ----------
// mods：數值類直接累加；hooks 由引擎在對應時機檢查
const CARDS = [
  // 普通
  { key: 'fire1',   rarity: 1, icon: '🔥', name: '快速裝填', desc: '開火冷卻 -15%', mods: { fire: -0.15 } },
  { key: 'hp1',     rarity: 1, icon: '❤️', name: '強化裝甲', desc: '最大血量 +20%', mods: { hp: 0.2 } },
  { key: 'spd1',    rarity: 1, icon: '👟', name: '引擎改裝', desc: '移速 +10%', mods: { speed: 0.1 } },
  { key: 'bs1',     rarity: 1, icon: '💨', name: '高壓砲管', desc: '彈速 +20%', mods: { bullet: 0.2 } },
  { key: 'dmg1',    rarity: 1, icon: '⚔️', name: '強化彈頭', desc: '傷害 +15%', mods: { dmg: 0.15 } },
  { key: 'mag1',    rarity: 1, icon: '📦', name: '擴充彈匣', desc: '同時子彈 +1', mods: { bullets: 1 } },
  { key: 'regen1',  rarity: 1, icon: '🩹', name: '自動修復', desc: '每秒回復 1.5% 血量', mods: { regen: 0.015 } },
  { key: 'parts1',  rarity: 1, icon: '⚙️', name: '回收專家', desc: '擊殺多掉 1 個零件', mods: { parts: 1 } },
  { key: 'armor1',  rarity: 1, icon: '🪖', name: '複合裝甲', desc: '受到傷害 -10%', mods: { armor: 0.1 } },
  { key: 'shield1', rarity: 1, icon: '🛡️', name: '重生護盾', desc: '每波開始時護盾 4 秒', mods: { waveShield: 4 } },
  // 稀有
  { key: 'pierce',  rarity: 2, icon: '🗡️', name: '穿甲彈', desc: '子彈可貫穿 1 隻怪物', mods: { pierce: 1 } },
  { key: 'leech',   rarity: 2, icon: '🧛', name: '吸血', desc: '擊殺回復 10% 血量', mods: { leech: 0.1 } },
  { key: 'cdr',     rarity: 2, icon: '⏱️', name: '技能精通', desc: '技能冷卻 -30%', mods: { skillCd: -0.3 } },
  { key: 'bounce',  rarity: 2, icon: '🏀', name: '跳彈', desc: '子彈可反彈 1 次', mods: { bounce: 1 } },
  { key: 'spread',  rarity: 2, icon: '🔱', name: '雙管', desc: '每次開火多射 1 發（偏 12 度）', mods: { extraShot: 1 } },
  { key: 'crit',    rarity: 2, icon: '💢', name: '弱點打擊', desc: '15% 機率造成 2 倍傷害', mods: { crit: 0.15 } },
  { key: 'thorns',  rarity: 2, icon: '🌵', name: '反應裝甲', desc: '被近身怪物攻擊時反彈 30 傷害', mods: { thorns: 30 } },
  { key: 'execute', rarity: 2, icon: '🪓', name: '處決', desc: '對血量低於 25% 的目標傷害 +50%', mods: { execute: 0.5 } },
  { key: 'boss1',   rarity: 2, icon: '👑', name: '屠龍者', desc: '對 Boss 傷害 +25%', mods: { bossDmg: 0.25 } },
  // 傳說
  { key: 'blast5',  rarity: 3, icon: '💣', name: '爆裂連發', desc: '每第 5 發是爆炸彈', mods: { blastEvery: 5 } },
  { key: 'cheat',   rarity: 3, icon: '✨', name: '不屈', desc: '受到致命傷時改為留 1 血（每波一次）', mods: { cheat: 1 } },
  { key: 'teamsh',  rarity: 3, icon: '🔰', name: '戰術掩護', desc: '使用技能時全隊護盾 2 秒', mods: { teamShield: 2 } },
  { key: 'homing',  rarity: 3, icon: '🧲', name: '導引彈', desc: '子彈微幅追蹤最近的怪物', mods: { homing: 1 } },
  { key: 'chain',   rarity: 3, icon: '⚡', name: '連鎖閃電', desc: '命中時電擊 2.5 格內另一隻怪物（50% 傷害）', mods: { chain: 0.5 } },
  // 職業專屬
  { key: 'nurseR',  rarity: 2, cls: 'nurse',    icon: '💉', name: '野戰醫療', desc: '治療範圍 +50%、治療量 +30%', mods: { healRange: 0.5, healAmt: 0.3 } },
  { key: 'sniperC', rarity: 2, cls: 'sniper',   icon: '🎯', name: '快速蓄力', desc: '蓄力射擊冷卻減半', mods: { skillCd: -0.5 } },
  { key: 'engS',    rarity: 2, cls: 'engineer', icon: '🧱', name: '鋼構工法', desc: '築牆改為鋼牆（10 秒後變回磚牆）', mods: { steelWall: 1 } },
  { key: 'heavyT',  rarity: 2, cls: 'heavy',    icon: '🏋️', name: '嘲諷', desc: '附近怪物優先攻擊你；受到傷害 -20%', mods: { taunt: 1, armor: 0.2 } },
  { key: 'demoM',   rarity: 2, cls: 'demo',     icon: '🧨', name: '集束炸藥', desc: '爆炸範圍 +40%', mods: { blastR: 0.4 } },
  { key: 'scoutX',  rarity: 2, cls: 'scout',    icon: '👁️', name: '標記', desc: '命中的怪物 4 秒內受到傷害 +20%', mods: { mark: 0.2 } },
  { key: 'assaultD', rarity: 2, cls: 'assault', icon: '⏩', name: '突擊步伐', desc: '衝刺時無敵', mods: { dashShield: 1 } },
];

// ---------- 商店 ----------
const SHOP = {
  life:    { name: '補充 1 命', icon: '❤️', cost: 15 },
  repair:  { name: '修復核心 25%', icon: '🔧', cost: 10 },
  reroll:  { name: '重抽強化卡', icon: '🎲', cost: 5 },
  revive:  { name: '復活陣亡隊友', icon: '🤖', cost: 12 },
};

// ---------- 難度 ----------
const DIFFICULTY = {
  easy:   { name: '簡單', hp: 0.7, dmg: 0.7, elite: 0,    regainLife: true,  bulletSpeed: 1 },
  normal: { name: '普通', hp: 1,   dmg: 1,   elite: 0.1,  regainLife: true,  bulletSpeed: 1 },
  hard:   { name: '困難', hp: 1.5, dmg: 1.3, elite: 0.25, regainLife: false, bulletSpeed: 1 },
  hell:   { name: '煉獄', hp: 2,   dmg: 1.6, elite: 0.5,  regainLife: false, bulletSpeed: 1.2, extraAffix: true },
};

// ---------- 關卡 ----------
// 地圖：style 用既有的隨機地形；features 由 pve 模組放置（核心、據點、發電機、軌道、出口）
// waves：每波的怪物組成（人數縮放前，以 2 位玩家為基準）
const W = (o) => o;
const LEVELS = {
  '1-1': { chapter: 1, name: '初次接觸', story: '前哨站傳來求救訊號，不明機械正在逼近。', objective: 'waves', style: 'open', par: 240,
    waves: [W({ crawler: 4 }), W({ crawler: 5, charger: 1 }), W({ crawler: 6, charger: 2 }), W({ crawler: 6, charger: 3, bomber: 2 })] },
  '1-2': { chapter: 1, name: '砲台陣地', story: '敵方在高地建立了據點，摧毀它們。', objective: 'destroy', style: 'fortress', par: 300, bunkers: 3,
    waves: [W({ turret: 2, crawler: 3 }), W({ sniper: 2, crawler: 4 }), W({ turret: 2, sniper: 2, charger: 2 })], loopWaves: true },
  '1-3': { chapter: 1, name: '鋼鐵堡壘', story: '堡壘本體出現了。', objective: 'boss', boss: 'fortress', style: 'arena', par: 300,
    waves: [W({ crawler: 4, charger: 1 })] },
  '2-1': { chapter: 2, name: '守護核心', story: '保護能源核心，撐到增援抵達。', objective: 'core', style: 'forest', par: 180, holdSeconds: 180,
    waves: [W({ crawler: 6, bomber: 2 }), W({ crawler: 6, bomber: 3, charger: 2 }), W({ bomber: 4, shield: 2, crawler: 4 }), W({ bomber: 5, charger: 3, sniper: 2 }), W({ bomber: 6, shield: 3, crawler: 6 })], loopWaves: true },
  '2-2': { chapter: 2, name: '救援', story: '友軍坦克受困，護送它抵達撤離點。', objective: 'rescue', style: 'river', par: 240,
    waves: [W({ crawler: 5, shield: 1 }), W({ crawler: 5, healer: 1, shield: 2 }), W({ charger: 3, healer: 2, shield: 2 }), W({ sniper: 3, shield: 3, healer: 2 })], loopWaves: true },
  '2-3': { chapter: 2, name: '毒霧女王', story: '毒沼深處傳來翅膀拍動的聲音。', objective: 'boss', boss: 'queen', style: 'arena', par: 300,
    waves: [W({ crawler: 4, healer: 1 })] },
  '3-1': { chapter: 3, name: '斷電', story: '依序啟動 4 座發電機，恢復城市電力。', objective: 'generators', style: 'maze', par: 300,
    waves: [W({ lurker: 2, crawler: 4 }), W({ summoner: 1, lurker: 2, builder: 1 }), W({ summoner: 2, lurker: 3, shield: 2 }), W({ builder: 2, lurker: 3, sniper: 2, summoner: 1 })], loopWaves: true },
  '3-2': { chapter: 3, name: '雷霆列車', story: '失控的列車正衝向核心，4 圈內擊毀它。', objective: 'train', boss: 'train', style: 'track', par: 240,
    waves: [W({ crawler: 3, lurker: 1 })] },
  '3-3': { chapter: 3, name: '機械巨像', story: '一切的源頭。', objective: 'boss', boss: 'colossus', style: 'arena', par: 420,
    waves: [W({ crawler: 3, shield: 1 })] },
  // 第四、五章：沿用既有目標，加上關卡詞綴（mods）與強化倍率（hpMult 小怪血量、bossScale Boss 血量）
  '4-1': { chapter: 4, name: '夜襲', story: '停電的夜裡，潛伏者從四面八方摸過來。', objective: 'waves', style: 'forest', par: 300, mods: ['darkness'],
    waves: [W({ lurker: 3, crawler: 4 }), W({ lurker: 4, charger: 3 }), W({ lurker: 4, bomber: 3, healer: 1 }), W({ lurker: 5, charger: 3, summoner: 1 }), W({ lurker: 6, shield: 2, sniper: 2 })] },
  '4-2': { chapter: 4, name: '最後防線', story: '敵軍主力加速推進，守住核心 4 分鐘。', objective: 'core', style: 'fortress', par: 240, holdSeconds: 240, mods: ['swift'],
    waves: [W({ charger: 4, crawler: 4 }), W({ bomber: 5, charger: 3 }), W({ shield: 3, bomber: 4, healer: 1 }), W({ charger: 5, sniper: 3, builder: 1 }), W({ bomber: 6, shield: 3, summoner: 1 })], loopWaves: true },
  '4-3': { chapter: 4, name: '堡壘再臨', story: '強化過的堡壘捲土重來，身邊還帶著精英護衛。', objective: 'boss', boss: 'fortress', style: 'arena', par: 360, bossScale: 1.5, mods: ['elite'],
    waves: [W({ crawler: 4, shield: 1 }), W({ charger: 3, healer: 1, sniper: 1 })] },
  '5-1': { chapter: 5, name: '突圍', story: '友軍被困在迷宮深處，敵人倒下時會殉爆。', objective: 'rescue', style: 'maze', par: 300, mods: ['explode'],
    waves: [W({ crawler: 6, charger: 2 }), W({ crawler: 5, shield: 2, healer: 1 }), W({ charger: 4, bomber: 3, lurker: 2 }), W({ sniper: 3, shield: 3, summoner: 1 })], loopWaves: true, hpMult: 1.2 },
  '5-2': { chapter: 5, name: '過載', story: '發電機嚴重過載，敵軍裝甲也全面升級。', objective: 'generators', style: 'river', par: 330, hpMult: 1.35,
    waves: [W({ lurker: 3, builder: 1, crawler: 3 }), W({ summoner: 2, shield: 2, lurker: 2 }), W({ builder: 2, sniper: 3, healer: 2 }), W({ summoner: 2, lurker: 4, charger: 3 })], loopWaves: true },
  '5-3': { chapter: 5, name: '終焉', story: '巨像完成了最終形態。一擊定勝負。', objective: 'boss', boss: 'colossus', style: 'arena', par: 480, bossScale: 1.4, mods: ['glass'],
    waves: [W({ crawler: 4, shield: 2 }), W({ charger: 3, healer: 2, sniper: 2 })] },
};

// ---------- 每週挑戰詞綴 ----------
const WEEKLY_MODS = {
  explode: { name: '殉爆', desc: '怪物死亡時爆炸（20 傷害）' },
  swift:   { name: '迅捷', desc: '怪物移速 ×1.3' },
  elite:   { name: '菁英', desc: '所有怪物都有詞綴' },
  darkness:{ name: '黑暗', desc: '強制迷霧與近距離鏡頭' },
  glass:   { name: '玻璃砲', desc: '雙方傷害 ×2' },
  noheal:  { name: '斷補', desc: '治療效果減半' },
};

module.exports = { MONSTERS, BOSSES, AFFIXES, CARDS, SHOP, DIFFICULTY, LEVELS, WEEKLY_MODS,
  MONSTER_KINDS: [...Object.keys(MONSTERS), ...Object.keys(BOSSES)] };
