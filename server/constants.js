'use strict';

// 遊戲的所有數值都集中在這裡，方便之後調整平衡。
const TICK_RATE = 30;

module.exports = {
  TICK_RATE,
  TANK_SPEED: 4,            // 格/秒
  BULLET_SPEED: 8,          // 格/秒（各職業以 CLASSES 為準）
  TANK_SIZE: 0.84,          // 坦克邊長（格）
  FIRE_COOLDOWN: 24,        // tick（電腦 0.8 秒；玩家依職業見 CLASSES，約快一倍）
  MAX_BULLETS_PER_TANK: 1,
  PLAYER_LIVES: 3,
  BOT_LIVES: 1,
  RESPAWN_DELAY: 2 * TICK_RATE,
  SHIELD_TICKS: 2 * TICK_RATE,
  FOG_RADIUS: 5.5,          // 迷霧模式下玩家的視野半徑（格）
  END_DELAY: Math.round(1.5 * TICK_RATE), // 分出勝負後再播一下爆炸

  BOT_CALL_TIMEOUT_MS: 30,  // 每次 think() 上限
  BOT_INIT_TIMEOUT_MS: 1000,// 程式最上層初始化上限
  BOT_MEMORY_MB: 32,
  BOT_CODE_MAX_BYTES: 100 * 1024,
  BOT_LOG_LINES: 80,

  MAX_PLAYERS: 6,
  NAME_MAX: 12,

  // 八個方向（移動與射擊）。斜向的向量在使用時會正規化成長度 1
  DIRS: ['up', 'down', 'left', 'right', 'upleft', 'upright', 'downleft', 'downright'],
  DIR_VEC: {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1],
  },
  ALIGN_RATE: 1.0,          // 直向/橫向移動時，另一軸靠向格子中心的速度（相對於移動速度）

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
  },
  BOT_CLASS: { name: '電腦', speed: 4.0, cooldown: 24, bulletSpeed: 8, maxBullets: 1, hp: 1, vision: 0 },
  BLAST_RADIUS: 1.1,        // 爆炸傷害：坦克中心與爆炸中心的直線距離
  HIT_MARGIN: 0.03,         // 子彈命中判定比坦克外框多出的距離（越小越不會「沒碰到就死」）
  COUNTDOWN_SECONDS: 5,

  // 大亂鬥時各隊的顏色；陣營戰固定紅藍
  FFA_COLORS: ['#f2c94c', '#3ddc84', '#4aa8ff', '#ff6b6b', '#c084fc', '#ff9f43'],
  TEAM_COUNT: 6,
  FACTION_COLORS: { red: '#ff6b6b', blue: '#4aa8ff' },
};
