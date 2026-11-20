'use strict';

// 打怪（PvE）：戰役 9 關、無盡、每週挑戰。
//   流程：準備 → 波次預告 → 出怪 → 清完 → 強化卡三選一（＋零件商店）→ 下一波 …
//   目標：清完所有波、摧毀據點、擊敗 Boss、守護核心、護送、啟動發電機、擊毀列車

const C = require('../constants');
const Physics = require('../../public/physics');
const D = require('./data');
const installAI = require('./ai');
const installBosses = require('./bosses');

const T = C.TICK_RATE;
const DRAFT_TICKS = 8 * T;
const PREVIEW_TICKS = 3 * T;
const POOL = 44;
const KIND_IDX = Object.fromEntries(D.MONSTER_KINDS.map((k, i) => [k, i]));
const AFFIX_KEYS = Object.keys(D.AFFIXES);

function weekId(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

// 每週挑戰的內容：由週次決定（全服相同）
function weeklySpec(week = weekId()) {
  const h = hash(week);
  const levels = ['1-1', '1-2', '2-1', '2-2', '3-1'];
  const mods = Object.keys(D.WEEKLY_MODS);
  const a = h % mods.length, b = (a + 1 + (Math.floor(h / 7) % (mods.length - 1))) % mods.length;
  return { week, level: levels[Math.floor(h / 31) % levels.length], mods: [mods[a], mods[b]] };
}

module.exports = function install(Round) {
  const P = Round.prototype;
  installAI(Round);
  installBosses(Round);

  // ---------- 建立 ----------
  // 在地圖與坦克建好之後呼叫（取代舊版的打怪）
  P._initPve = function (opts) {
    const po = opts.pve || {};
    const mode = ['campaign', 'endless', 'weekly'].includes(po.mode) ? po.mode : 'campaign';
    const weekly = mode === 'weekly' ? weeklySpec() : null;
    const levelKey = mode === 'weekly' ? weekly.level : mode === 'endless' ? 'endless' : (D.LEVELS[po.level] ? po.level : '1-1');
    const level = mode === 'endless'
      ? { chapter: 0, name: '無盡', story: '怪物無窮無盡，撐得越久越好。', objective: 'endless', style: 'arena', par: 0, waves: [] }
      : D.LEVELS[levelKey];
    const diffKey = mode === 'weekly' ? 'normal' : (D.DIFFICULTY[po.difficulty] ? po.difficulty : 'normal');
    const humans = new Set(this.tanks.filter(t => t.side === 'players' && !t.isBot).map(t => t.owner)).size
      || new Set(this.tanks.filter(t => t.side === 'players').map(t => t.owner)).size || 1;
    this.pve = {
      mode, levelKey, level, diffKey, diff: D.DIFFICULTY[diffKey], mods: weekly ? weekly.mods : (level.mods || []), week: weekly ? weekly.week : null,
      humans, units: Math.max(1, this.tanks.filter(t => t.side === 'players').length),
      wave: 0, phase: 'prep', timer: 2 * T, queue: [], parts: 0, hazards: [], nextHazard: 1, hazardsChanged: true,
      kills: 0, bossKind: null, bossId: null, stateChanged: true, preview: null, startTick: this.tick,
      core: null, npcId: null, exit: null, gens: null, genIdx: 0, track: null, laps: 0, bunkers: [],
      result: null, flowAt: -999,
    };
    // 人數縮放：以我方坦克總數（玩家＋電腦）計算；4 台 = 1 倍
    this.pve.scale = 0.4 + 0.15 * this.pve.units;
    if (this.pve.mods.includes('darkness')) { this.fog = true; this.closeCam = true; }
    this._pveShapeMap();
    this._createMonsterPool(this.sideByKey.get('monsters'));
    this._pveInitObjective();
  };

  // 地圖整形：Boss 場地、軌道、核心、出口
  P._pveShapeMap = function () {
    const S = this.size, c = Math.floor(this.center), L = this.pve.level;
    const set = (x, y, ch) => { if (x > 0 && y > 0 && x < S - 1 && y < S - 1) this.tiles[y * S + x] = ch; };
    const clear = (x0, y0, x1, y1) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (this.tiles[y * S + x] !== 'B') set(x, y, '.'); };
    if (L.style === 'arena' || L.objective === 'endless') {
      clear(c - 5, c - 5, c + 5, c + 5);
      for (const [dx, dy] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) set(c + dx, c + dy, '@');   // 四根掩體柱
    }
    if (L.objective === 'core' || L.objective === 'train') clear(c - 2, c - 2, c + 2, c + 2);
    if (L.style === 'track') {
      // 軌道：距離邊界 3 格的一圈
      const a = 3, b = S - 4, path = [];
      for (let x = a; x <= b; x++) path.push([x, a]);
      for (let y = a + 1; y <= b; y++) path.push([b, y]);
      for (let x = b - 1; x >= a; x--) path.push([x, b]);
      for (let y = b - 1; y > a; y--) path.push([a, y]);
      for (const [x, y] of path) set(x, y, '.');
      this.pve.track = path.map(([x, y]) => [x + 0.5, y + 0.5]);
      this.pve.trackCorners = [[a, a], [b, a], [b, b], [a, b]].map(([x, y]) => [x + 0.5, y + 0.5]);
    }
    // 打怪不需要基地
    for (const s of this.sides) if (s.base) { this.tiles[s.base.y * S + s.base.x] = '.'; s.base = null; }
  };

  P._pveInitObjective = function () {
    const p = this.pve, L = p.level, S = this.size, c = this.center + 0.5;
    const players = this.sideByKey.get('players');
    if (L.objective === 'core' || L.objective === 'train') {
      const core = this._pveStructure('core', c, c, players, Math.round(1500 * p.scale));
      p.core = core.id;
    }
    if (L.objective === 'rescue') {
      // 友軍在一角、撤離點在對角
      const st = this._pveFreeCellNear(2, 2);
      const npc = this._pveStructure('npc', st.x, st.y, players, 420);
      npc.structure = false; npc.npc = true; npc.stats = { ...npc.stats, speed: 0.9 };
      p.npcId = npc.id;
      p.exit = this._pveFreeCellNear(S - 3, S - 3);
    }
    if (L.objective === 'generators') {
      const q = Math.round(S / 4);
      p.gens = [[q, q], [S - 1 - q, q], [S - 1 - q, S - 1 - q], [q, S - 1 - q]].map(([x, y]) => {
        const f = this._pveFreeCellNear(x, y);
        return { x: f.x, y: f.y, progress: 0, done: false };
      });
    }
  };

  // 玩家方的固定單位（核心、救援對象）
  P._pveStructure = function (kind, x, y, side, hp) {
    const t = {
      id: this.nextTankId++, side: side.key, owner: kind, ownerName: kind === 'core' ? '核心' : kind === 'sturret' ? '砲台' : '友軍', isBot: true, cls: kind, kind,
      stats: { speed: 0, cooldown: 999, bulletSpeed: 0, maxBullets: 0, hp: 1, vision: 0 }, structure: true,
      lives: 1, maxLives: 1, hp, maxHp: hp, alive: true, x, y, dir: 'up', angle: 0, size: kind === 'core' ? 1.6 : 0.84,
      respawnTimer: 0, shield: 0, cooldown: 0, input: { move: null, fire: false },
      kills: 0, deaths: 0, baseKills: 0, shots: 0, hits: 0, dodges: 0, itemsPicked: 0, captures: 0, sandbox: null,
    };
    this.tanks.push(t);
    this.tankById.set(t.id, t);
    return t;
  };

  P._pveFreeCellNear = function (x, y) {
    const S = this.size;
    for (let r = 0; r < S; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
      if (cx < 1 || cy < 1 || cx >= S - 1 || cy >= S - 1) continue;
      if (this.tiles[cy * S + cx] === '.' && !(this.tankById && this._tankAt(cx + 0.5, cy + 0.5, null))) return { x: cx + 0.5, y: cy + 0.5 };
    }
    return { x: this.center + 0.5, y: this.center + 0.5 };
  };

  // 怪物池：預先建立，出場時才指定種類（客戶端的 meta 在開局時就固定）
  P._createMonsterPool = function (side) {
    for (let i = 0; i < POOL; i++) {
      const t = {
        id: this.nextTankId++, side: side.key, owner: 'monster', ownerName: '怪物', isBot: true,
        cls: 'monster', kind: 'crawler', stats: this.statsFor('monster'), lives: 0, hp: 1, maxHp: 100, maxLives: 1,
        alive: false, x: 0, y: 0, dir: 'down', angle: 180, spawn: side.spawns[i % side.spawns.length],
        respawnTimer: 0, shield: 0, cooldown: 0, input: { move: null, fire: false },
        kills: 0, deaths: 0, baseKills: 0, shots: 0, hits: 0, dodges: 0, itemsPicked: 0, captures: 0, sandbox: null, monster: true,
      };
      this.tanks.push(t);
      if (this.tankById) this.tankById.set(t.id, t);
    }
  };

  // ---------- 出怪 ----------
  P._pveSpawn = function (kind, x, y, extra = {}) {
    const t = this.tanks.find(o => o.monster && !o.alive && !o.reserved);
    if (!t) return null;
    const def = D.MONSTERS[kind] || D.BOSSES[kind];
    const p = this.pve, diff = p.diff;
    // 召喚、分裂出來的小怪可能落在牆裡或地圖外：改放到最近的空地
    if (!extra.noCollide && !def.flying && (def.size || C.TANK_SIZE) < 1.5) {
      const S = this.size, sz = def.size || C.TANK_SIZE;
      if (x < 1 || y < 1 || x > S - 1 || y > S - 1 || Physics.tileBlocked(this, x, y, false, sz) || this._tankAt(x, y, { size: sz })) {
        const f = this._pveFreeCellNear(Math.max(1, Math.min(S - 2, x)), Math.max(1, Math.min(S - 2, y)));
        x = f.x; y = f.y;
      }
    }
    const waveGrow = p.mode === 'endless' ? 1 + 0.07 * Math.max(0, p.wave - 1) : 1 + 0.04 * Math.max(0, p.wave - 1);
    const bossScale = D.BOSSES[kind] ? (0.4 + 0.15 * p.units) * (extra.bossMult || 1) : 1;
    for (const k of Round.TIMERS) t[k] = 0;
    for (const k of Round.SHOTS) t[k] = 0;
    Object.assign(t, {
      kind, cls: 'monster', alive: true, lives: 0, x, y, angle: 180, dir: 'down', cooldown: 0, shield: extra.shield ?? 15,
      size: def.size || C.TANK_SIZE, noCollide: !!extra.noCollide, frontShield: def.shield || 0, invuln: !!def.invuln,
      dmgTaken: 1, elite: [], ai: { born: this.tick, ...(extra.ai || {}) }, skillCd: 0, dashTicks: 0, charged: 0, hurtBy: null,
      flying: !!def.flying, boss: !!D.BOSSES[kind], part: !!def.part, structureM: !!def.structure,
      input: { move: null, fire: false }, slowTicks: 0, markedUntil: 0, summoned: false, selfDestruct: false, reserved: false,
    });
    t.stats = { speed: def.speed || 0, cooldown: def.cooldown || 999, bulletSpeed: (def.bulletSpeed || 6) * diff.bulletSpeed, maxBullets: def.maxBullets || 0, hp: 1, vision: 0, skill: null };
    let hpMult = diff.hp * waveGrow * bossScale * (extra.hpMult || 1) * (p.level.hpMult && !D.BOSSES[kind] ? p.level.hpMult : 1);
    // 精英詞綴
    const affixes = extra.affixes || [];
    if (!extra.noElite && !t.boss && !t.part && !t.structureM) {
      const chance = p.mods.includes('elite') ? 1 : diff.elite;
      if (Math.random() < chance) {
        affixes.push(AFFIX_KEYS[Math.floor(Math.random() * AFFIX_KEYS.length)]);
        if (diff.extraAffix) { const b = AFFIX_KEYS[Math.floor(Math.random() * AFFIX_KEYS.length)]; if (!affixes.includes(b)) affixes.push(b); }
      }
    }
    t.elite = affixes;
    if (affixes.includes('tough')) hpMult *= 2;
    if (affixes.includes('frenzy')) { t.stats.cooldown = Math.max(8, Math.round(t.stats.cooldown / 2)); t.stats.speed *= 1.2; }
    if (p.mods.includes('swift')) t.stats.speed *= 1.3;
    t.maxHp = Math.max(1, Math.round(def.hp * hpMult));
    if (kind === 'qclone' || kind === 'tcar') t.maxHp = 1;
    t.hp = t.maxHp;
    t.pveDmg = Math.round((def.dmg || 0) * diff.dmg * (p.mods.includes('glass') ? 2 : 1));
    this.events.push(['spawn', x, y]);
    return t;
  };

  // 怪物出生點：地圖邊緣、離玩家夠遠的空地
  P._pveSpawnPoint = function () {
    const S = this.size;
    const players = this.tanks.filter(t => t.alive && t.side === 'players');
    for (let tries = 0; tries < 80; tries++) {
      const edge = Math.floor(Math.random() * 4), k = 1 + Math.floor(Math.random() * (S - 2));
      const [x, y] = edge === 0 ? [k, 1] : edge === 1 ? [S - 2, k] : edge === 2 ? [k, S - 2] : [1, k];
      if (this.tiles[y * S + x] !== '.') continue;
      if (players.some(t => Math.hypot(t.x - x - 0.5, t.y - y - 0.5) < 7)) continue;
      if (this._tankAt(x + 0.5, y + 0.5, null)) continue;
      return { x: x + 0.5, y: y + 0.5 };
    }
    const m = this.sideByKey.get('monsters');
    const sp = m.spawns[Math.floor(Math.random() * m.spawns.length)];
    return { x: sp.x + 0.5, y: sp.y + 0.5 };
  };

  // 這一波的怪物清單（含人數、無盡波數縮放）
  P._pveWaveList = function (n) {
    const p = this.pve, L = p.level;
    let comp;
    if (p.mode === 'endless') comp = this._pveEndlessComp(n);
    else {
      const base = L.waves[(n - 1) % L.waves.length];
      const loop = Math.floor((n - 1) / L.waves.length);
      comp = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v * (1 + 0.3 * loop))]));
    }
    const list = [];
    for (const [k, v] of Object.entries(comp)) {
      const cnt = Math.max(1, Math.round(v * p.scale));
      for (let i = 0; i < cnt; i++) list.push(k);
    }
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    return list.slice(0, POOL - 8);
  };

  P._pveEndlessComp = function (n) {
    const pool = ['crawler', 'charger', 'bomber', 'turret', 'sniper', 'shield', 'healer', 'lurker', 'summoner', 'builder'];
    const unlocked = pool.slice(0, Math.min(pool.length, 2 + Math.floor(n / 2)));
    const cost = { crawler: 1, charger: 2, bomber: 1.5, turret: 2, sniper: 2, shield: 2.5, healer: 3, lurker: 2, summoner: 4, builder: 3 };
    let budget = 5 + n * 2.2;
    const comp = {};
    while (budget > 0.9) {
      const k = unlocked[Math.floor(Math.random() * unlocked.length)];
      if (cost[k] > budget) { budget -= 0.5; continue; }
      comp[k] = (comp[k] || 0) + 1; budget -= cost[k];
    }
    return comp;
  };

  P._pveAlive = function (filter) { return this.tanks.filter(t => t.monster && t.alive && (!filter || filter(t))); };

  // ---------- 每 tick ----------
  P._updatePve = function () {
    const p = this.pve;
    if (!p || p.result) return;
    this._pveObjectiveTick();
    this._pveHazardsTick();
    this._pveModsTick();
    if (p.result) return;

    // 出怪佇列：錯開出場
    if (p.queue.length && this.tick % 10 === 0) {
      const kind = p.queue.shift();
      const sp = this._pveSpawnPoint();
      this._pveSpawn(kind, sp.x, sp.y);
    }
    const waveMonsters = this._pveAlive(t => !t.structureM && !t.part && !t.boss);
    const bossAlive = p.bossId && this.tankById.get(p.bossId).alive;
    switch (p.phase) {
      case 'prep':
        if (--p.timer <= 0) this._pvePreview(p.wave + 1);
        break;
      case 'preview':
        if (--p.timer <= 0) this._pveStartWave();
        break;
      case 'fight':
        if (!p.queue.length && !waveMonsters.length && !bossAlive) this._pveWaveCleared();
        break;
      case 'draft':
        if (--p.timer <= 0) this._pveEndDraft();
        break;
    }
  };

  P._pveTotalWaves = function () {
    const p = this.pve, L = p.level;
    if (p.mode === 'endless' || L.loopWaves) return Infinity;
    return L.waves.length + (L.objective === 'boss' ? 1 : 0);
  };

  P._pvePreview = function (n) {
    const p = this.pve;
    p.phase = 'preview'; p.timer = PREVIEW_TICKS;
    const bossWave = this._pveIsBossWave(n);
    p.nextList = bossWave && p.level.objective === 'boss' || bossWave && p.mode === 'endless' ? [] : this._pveWaveList(n);
    const counts = {};
    for (const k of p.nextList) counts[k] = (counts[k] || 0) + 1;
    p.preview = { wave: n, counts, boss: bossWave || null };
    p.stateChanged = true;
    this.objEvents.push(['wavePreview', n, counts, bossWave || null]);
  };

  // Boss 關：第 1 波是小怪，清完之後 Boss 登場；無盡模式每 5 波一隻 Boss
  P._pveIsBossWave = function (n) {
    const p = this.pve, L = p.level;
    if (p.mode === 'endless') return n % 5 === 0 ? (Math.floor(n / 5) % 2 ? 'fortress' : 'queen') : null;
    if (L.objective === 'boss' && n === L.waves.length + 1) return L.boss;
    if (L.objective === 'train' && n === 1) return 'train';
    return null;
  };

  P._pveStartWave = function () {
    const p = this.pve;
    p.wave++;
    p.phase = 'fight';
    p.stateChanged = true;
    const boss = p.preview && p.preview.boss;
    if (boss) this._pveSpawnBoss(boss, p.mode === 'endless' ? Math.pow(1.25, Math.floor(p.wave / 5) - 1) : (p.level.bossScale || 1));
    p.queue.push(...p.nextList);
    // 撐過一波：玩家回 1 條命（簡單、普通）
    if (p.wave > 1 && p.diff.regainLife) {
      for (const t of this.tanks) if (t.side === 'players' && !t.isBot && !t.structure && !t.unlimited && t.lives > 0 && t.lives < (t.maxLives || 1)) t.lives++;
    }
    // 重生護盾卡
    for (const t of this.tanks) if (t.alive && t.mods && t.mods.waveShield) t.shield = Math.max(t.shield, t.mods.waveShield * T);
    for (const t of this.tanks) if (t.mods) t.cheatUsed = false;
    this.events.push(['waveStart', this.center, this.center]);
    this.objEvents.push(['wave', p.wave, boss ? 1 : p.nextList.length, boss || null]);
  };

  P._pveWaveCleared = function () {
    const p = this.pve, L = p.level;
    if (L.objective === 'waves' && p.wave >= this._pveTotalWaves()) return this._pveWin();
    // Boss 關：小怪清完後下一波就是 Boss（不抽卡，直接預告）
    if (this._pveIsBossWave(p.wave + 1) && L.objective === 'boss') return this._pveStartDraft();
    this._pveStartDraft();
  };

  // ---------- 強化卡與商店 ----------
  P._pveDraftTanks = function () {
    return this.tanks.filter(t => t.side === 'players' && !t.structure && !t.npc && (t.alive || t.lives > 0));
  };

  P._pveRollCards = function (t) {
    const owned = new Set(t.cards || []);
    const pool = D.CARDS.filter(c => (!c.cls || c.cls === t.cls) && !(c.rarity === 3 && owned.has(c.key)));
    const out = [];
    for (let i = 0; i < 3 && pool.length; i++) {
      const r = Math.random(), want = r < 0.1 ? 3 : r < 0.4 ? 2 : 1;
      let cands = pool.filter(c => c.rarity === want && !out.includes(c.key));
      if (!cands.length) cands = pool.filter(c => !out.includes(c.key));
      if (!cands.length) break;
      out.push(cands[Math.floor(Math.random() * cands.length)].key);
    }
    return out;
  };

  P._pveStartDraft = function () {
    const p = this.pve;
    p.phase = 'draft'; p.timer = DRAFT_TICKS; p.stateChanged = true;
    for (const t of this._pveDraftTanks()) { t.draft = this._pveRollCards(t); t.draftPicked = false; }
  };

  P._pveEndDraft = function () {
    for (const t of this._pveDraftTanks()) {
      if (t.draft && !t.draftPicked) this._pveApplyCard(t, t.draft[Math.floor(Math.random() * t.draft.length)]);
      t.draft = null;
    }
    this._pvePreview(this.pve.wave + 1);
  };

  P._pveApplyCard = function (t, key) {
    const card = D.CARDS.find(c => c.key === key);
    if (!card || t.draftPicked) return false;
    t.draftPicked = true;
    (t.cards = t.cards || []).push(key);
    const m = t.mods = t.mods || {};
    for (const [k, v] of Object.entries(card.mods)) m[k] = (m[k] || 0) + v;
    this._pveRecalc(t);
    this.events.push(['skill', t.x, t.y]);
    return true;
  };

  // 依強化重新計算數值
  P._pveRecalc = function (t) {
    const m = t.mods || {}, base = this.statsFor(t.cls, this._role(t));
    t.stats = Object.assign({}, base, {
      speed: base.speed * (1 + (m.speed || 0)),
      cooldown: Math.max(3, Math.round(base.cooldown * Math.max(0.3, 1 + (m.fire || 0)))),
      bulletSpeed: base.bulletSpeed * (1 + (m.bullet || 0)),
      maxBullets: base.maxBullets + (m.bullets || 0),
    });
    const baseHp = this._maxHpFor(t.cls, t.isBot);
    const newMax = Math.round(baseHp * (1 + (m.hp || 0)));
    if (newMax > t.maxHp) t.hp += newMax - t.maxHp;
    t.maxHp = newMax;
  };

  // 玩家選卡（room 轉來）
  P.pvePick = function (playerId, i) {
    const p = this.pve;
    if (!p || p.phase !== 'draft') return;
    const t = this.tanks.find(o => o.owner === playerId && !o.isBot && o.side === 'players');
    if (!t || !t.draft || t.draftPicked || !Number.isInteger(i) || !t.draft[i]) return;
    this._pveApplyCard(t, t.draft[i]);
  };

  // 商店（room 轉來，或電腦代碼回傳 buy）
  P.pveShop = function (playerIdOrTank, item) {
    const p = this.pve;
    if (!p || p.phase !== 'draft' || !D.SHOP[item]) return false;
    const t = typeof playerIdOrTank === 'object' ? playerIdOrTank : this.tanks.find(o => o.owner === playerIdOrTank && !o.isBot && o.side === 'players');
    if (!t) return false;
    const cost = D.SHOP[item].cost;
    if (p.parts < cost) return false;
    if (item === 'life') { if (t.unlimited) return false; t.lives++; t.maxLives = Math.max(t.maxLives || 1, t.lives); }
    else if (item === 'repair') { const core = p.core && this.tankById.get(p.core); if (!core || !core.alive || core.hp >= core.maxHp) return false; core.hp = Math.min(core.maxHp, core.hp + Math.round(core.maxHp * 0.25)); }
    else if (item === 'reroll') { if (!t.draft || t.draftPicked) return false; t.draft = this._pveRollCards(t); }
    else if (item === 'revive') {
      const dead = this.tanks.find(o => o.side === 'players' && !o.structure && !o.npc && !o.alive && o.lives <= 0);
      if (!dead) return false;
      dead.lives = 1; dead.respawnTimer = 0;
    }
    p.parts -= cost; p.stateChanged = true;
    this.events.push(['pickup', t.x, t.y]);
    return true;
  };

  // 電腦代碼在抽卡階段回傳的 pick／buy
  P._pveBotDraft = function (t, action) {
    if (!this.pve || this.pve.phase !== 'draft' || !action) return;
    if (typeof action.buy === 'string') this.pveShop(t, action.buy);
    if (Number.isInteger(action.pick) && t.draft && !t.draftPicked && t.draft[action.pick]) this._pveApplyCard(t, t.draft[action.pick]);
  };

  // ---------- 持續效果（強化卡） ----------
  P._pveModsTick = function () {
    for (const t of this.tanks) {
      if (!t.alive) continue;
      if (t.slowTicks > 0) t.slowTicks--;
      const m = t.mods;
      if (!m) continue;
      if (m.regen && t.hp < t.maxHp) {
        t.modRegen = (t.modRegen || 0) + t.maxHp * m.regen / T * (this.pve.mods.includes('noheal') ? 0.5 : 1);
        if (t.modRegen >= 1) { const n = Math.floor(t.modRegen); t.modRegen -= n; t.hp = Math.min(t.maxHp, t.hp + n); }
      }
    }
  };

  // ---------- 預警區（Boss 招式、狙擊紅線、轟炸） ----------
  // h = { kind: 'line'|'circle'|'poison'|'map', x, y, x2, y2, r, w, fireAt, endAt, dmg, dps, owner, islands }
  P._pveHazard = function (h) {
    h.id = this.pve.nextHazard++;
    this.pve.hazards.push(h);
    this.pve.hazardsChanged = true;
    return h;
  };

  P._pveInHazard = function (h, x, y, pad = 0.35) {
    if (h.kind === 'circle' || h.kind === 'poison') return Math.hypot(x - h.x, y - h.y) <= h.r + pad;
    if (h.kind === 'line') {
      const dx = h.x2 - h.x, dy = h.y2 - h.y, L2 = dx * dx + dy * dy || 1;
      const k = Math.max(0, Math.min(1, ((x - h.x) * dx + (y - h.y) * dy) / L2));
      return Math.hypot(x - (h.x + dx * k), y - (h.y + dy * k)) <= (h.w || 0.5) / 2 + pad;
    }
    if (h.kind === 'map') return !(h.islands || []).some(i => Math.hypot(x - i.x, y - i.y) <= i.r);
    return false;
  };

  P._pveHazardsTick = function () {
    const p = this.pve;
    const before = p.hazards.length;
    for (const h of p.hazards) {
      if (h.move) h.move.call(this, h);
      if (h.fireAt === this.tick && h.onFire) h.onFire.call(this, h);
      else if (h.fireAt === this.tick && h.dmg) {
        this.events.push([h.kind === 'line' ? 'laser' : 'blast', h.x, h.y]);
        for (const t of this.tanks) {
          if (!t.alive || t.side !== 'players') continue;
          if (this._pveInHazard(h, t.x, t.y)) this._damage(t, h.owner ? this.tankById.get(h.owner) : null, t.x, t.y, 'blast', h.dmg);
        }
        if (h.breakWalls && this.breakableWalls) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this._breakTile(Math.floor(h.x) + dx, Math.floor(h.y) + dy);
      }
      // 持續傷害（毒霧）：每 0.5 秒
      if (h.dps && this.tick >= h.fireAt && this.tick % 15 === 0) {
        const dps = h.dps * (this.pve.mods.includes('glass') ? 2 : 1);
        for (const t of this.tanks) {
          if (!t.alive || t.side !== 'players' || t.structure) continue;
          if (this._pveInHazard(h, t.x, t.y, 0)) this._damage(t, null, t.x, t.y, 'zone', Math.max(1, Math.round(dps / 2)));
        }
      }
    }
    p.hazards = p.hazards.filter(h => this.tick < h.endAt);
    if (p.hazards.length !== before) p.hazardsChanged = true;
  };

  // ---------- 目標 ----------
  P._pveObjectiveTick = function () {
    const p = this.pve, L = p.level;
    if (L.objective === 'core') {
      if (this.playTick >= L.holdSeconds * T + 3 * T) return this._pveWin();
    }
    if (L.objective === 'destroy' && p.wave >= 1 && !p.bunkers.length) {
      // 第一波開始時放據點
      const m = this.sideByKey.get('monsters').anchor;
      const S = this.size;
      const spots = [[m.x, m.y], [Math.max(3, m.x - 7), Math.min(S - 4, m.y)], [Math.min(S - 4, m.x + 7), m.y]];
      for (const [x, y] of spots.slice(0, L.bunkers || 3)) {
        const f = this._pveFreeCellNear(x, y);
        // 據點佔 1.6 格：把周圍 3×3 清空，不要卡在牆裡
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const cx = Math.floor(f.x) + dx, cy = Math.floor(f.y) + dy, i = cy * S + cx;
          if (cx > 0 && cy > 0 && cx < S - 1 && cy < S - 1 && this.tiles[i] !== '.' && this.tiles[i] !== 'B') { this.wallHp.delete(i); this._setTile(i, '.'); }
        }
        const b = this._pveSpawn('bunker', f.x, f.y, { noElite: true, shield: 0 });
        if (b) { b.reserved = true; p.bunkers.push(b.id); }
      }
      p.stateChanged = true;
    }
    if (L.objective === 'destroy' && p.bunkers.length && p.bunkers.every(id => !this.tankById.get(id).alive)) return this._pveWin();
    if (L.objective === 'rescue') {
      const npc = this.tankById.get(p.npcId);
      if (!npc.alive) return this._pveLose('npc');
      if (Math.hypot(npc.x - p.exit.x, npc.y - p.exit.y) < 1.2) return this._pveWin();
      this._pveNpcMove(npc);
    }
    if (L.objective === 'generators' && p.wave >= 1) {
      const g = p.gens[p.genIdx];
      const on = this.tanks.some(t => t.alive && t.side === 'players' && !t.structure && Math.hypot(t.x - g.x, t.y - g.y) < 1.3);
      if (on) { g.progress = Math.min(1, g.progress + 1 / (10 * T)); if (this.tick % 15 === 0) p.stateChanged = true; }
      if (on && !g.defended) { g.defended = true; for (let i = 0; i < Math.round(3 * p.scale); i++) p.queue.push(['lurker', 'crawler', 'builder'][i % 3]); }
      if (g.progress >= 1 && !g.done) {
        g.done = true; p.genIdx++; p.stateChanged = true;
        this.events.push(['capture', g.x, g.y]);
        this.objEvents.push(['gen', p.genIdx]);
        if (p.genIdx >= p.gens.length) return this._pveWin();
        // 每啟動一座，額外派出一批怪物
        for (let i = 0; i < Math.round(2 * p.scale); i++) p.queue.push(Math.random() < 0.5 ? 'lurker' : 'crawler');
      }
    }
    if ((L.objective === 'core' || L.objective === 'train') && p.core && !this.tankById.get(p.core).alive) return this._pveLose('core');
  };

  // 救援對象：有玩家在 4 格內時沿路往出口走
  P._pveNpcMove = function (npc) {
    const escorted = this.tanks.some(t => t.alive && t.side === 'players' && !t.structure && !t.npc && Math.hypot(t.x - npc.x, t.y - npc.y) < 4);
    const blocked = this._pveAlive(m => !m.part && Math.hypot(m.x - npc.x, m.y - npc.y) < 3).length > 0;   // 有怪物擋路就停下
    npc.escorted = escorted && !blocked;
    if (!npc.escorted) return;
    const dir = this._pveStepToward(npc, this.pve.exit);
    if (dir !== null) this._move(npc, dir);
  };

  // ---------- 勝負 ----------
  P._pveWin = function () { if (!this.pve.result) this.pve.result = { win: true }; };
  P._pveLose = function (why) { if (!this.pve.result) this.pve.result = { win: false, why }; };

  P._pveEnd = function () {
    const p = this.pve;
    const players = this.sideByKey.get('players');
    if (!p.result && (players.eliminated || this._sideStrength(players) === 0)) p.result = { win: false, why: 'wiped' };
    if (!p.result && this.timeLimitTicks && this.playTick >= this.timeLimitTicks) p.result = p.mode === 'endless' ? { win: true, why: 'time' } : { win: false, why: 'time' };
    if (!p.result) return false;
    players.eliminated = !p.result.win && p.mode !== 'endless';
    const reason = p.mode === 'endless' ? 'pveEndless' : p.result.win ? 'pveWin' : ({ core: 'pveCore', npc: 'pveNpc', time: 'pveTime' }[p.result.why] || 'pveLose');
    return { winner: p.result.win || p.mode === 'endless' ? players : null, reason };
  };

  // 賽後摘要（星級在客戶端依這些資料計算）
  P._pveSummary = function () {
    const p = this.pve;
    const humanDeaths = this.tanks.filter(t => t.side === 'players' && !t.isBot && !t.structure).reduce((a, t) => a + t.deaths, 0);
    return {
      mode: p.mode, level: p.levelKey, levelName: p.level.name, difficulty: p.diffKey, cleared: !!(p.result && p.result.win),
      wave: p.wave, seconds: Math.round(this.playTick / T), par: p.level.par || 0, humanDeaths, kills: p.kills,
      week: p.week, weeklyMods: p.mods, parts: p.parts,
      cards: Object.fromEntries(this.tanks.filter(t => t.cards && t.cards.length).map(t => [t.id, t.cards])),
      bossKind: p.bossKind,
    };
  };

  // 怪物或玩家方單位死亡
  P._pveOnDeath = function (t, shooter) {
    const p = this.pve;
    if (!p) return;
    if (t.monster) {
      p.kills++;
      if (!t.part && !t.summoned || t.boss) {
        const gain = t.boss ? 25 : t.structureM ? 8 : 1 + Math.floor(Math.random() * 2) + (shooter && shooter.mods && shooter.mods.parts || 0);
        p.parts += gain; p.stateChanged = true;
      }
      if (shooter && shooter.mods && shooter.mods.leech) shooter.hp = Math.min(shooter.maxHp, shooter.hp + Math.round(shooter.maxHp * shooter.mods.leech));
      if (t.elite.includes('split') && t.kind !== 'crawler') {
        for (let i = 0; i < 2; i++) { const c = this._pveSpawn('crawler', t.x + (i ? 0.5 : -0.5), t.y, { noElite: true, hpMult: 0.6 }); if (c) c.summoned = false; }
      }
      if (t.elite.includes('contagion')) for (const o of this._pveAlive()) if (Math.hypot(o.x - t.x, o.y - t.y) < 4) o.speedBuff = Math.max(o.speedBuff || 0, 4 * T);
      if (p.mods.includes('explode') && !t.part) {
        this.events.push(['blast', t.x, t.y]);
        for (const o of this.tanks) if (o.alive && o.side === 'players' && Math.hypot(o.x - t.x, o.y - t.y) < 1.4) this._damage(o, null, t.x, t.y, 'blast', 20);
      }
      if (t.boss) this._pveBossDeath(t);
      t.reserved = !!t.structureM;   // 據點的欄位保留（目標判定用 id 追蹤），其他怪物的欄位可以重用
    }
  };

  // ---------- 給電腦代碼 ----------
  P._pveView = function (me) {
    const p = this.pve;
    const core = p.core && this.tankById.get(p.core), npc = p.npcId && this.tankById.get(p.npcId);
    const boss = p.bossId && this.tankById.get(p.bossId);
    const card = k => { const c = D.CARDS.find(x => x.key === k); return { key: c.key, name: c.name, rarity: c.rarity, mods: c.mods }; };
    return {
      type: 'pve', mode: p.mode, level: p.levelKey, objective: p.level.objective, difficulty: p.diffKey,
      wave: p.wave, waves: this._pveTotalWaves() === Infinity ? null : this._pveTotalWaves(), phase: p.phase,
      monstersLeft: this._pveAlive(t => !t.part && !t.structureM).length + p.queue.length,
      parts: p.parts, shop: Object.fromEntries(Object.entries(D.SHOP).map(([k, v]) => [k, v.cost])),
      draft: me.draft && !me.draftPicked ? me.draft.map(card) : null,
      draftTicksLeft: p.phase === 'draft' ? p.timer : 0,
      myCards: (me.cards || []).slice(),
      core: core ? { x: core.x, y: core.y, hp: core.hp, maxHp: core.maxHp } : null,
      npc: npc ? { x: npc.x, y: npc.y, hp: npc.hp, maxHp: npc.maxHp, alive: npc.alive } : null,
      exit: p.exit, generators: p.gens ? p.gens.map((g, i) => ({ x: g.x, y: g.y, progress: g.progress, done: g.done, active: i === p.genIdx })) : null,
      bunkers: p.bunkers.map(id => this.tankById.get(id)).filter(b => b.alive).map(b => ({ x: b.x, y: b.y, hp: b.hp, maxHp: b.maxHp })),
      track: p.track, laps: p.laps,
      boss: boss && boss.alive ? { kind: boss.kind, x: boss.x, y: boss.y, hp: boss.hp, maxHp: boss.maxHp, phase: boss.ai.phase || 1, vulnerable: boss.dmgTaken > 0 } : null,
      hazards: p.hazards.map(h => ({ kind: h.kind, x: h.x, y: h.y, x2: h.x2, y2: h.y2, r: h.r, w: h.w, firesIn: Math.max(0, h.fireAt - this.tick), endsIn: h.endAt - this.tick, dmg: h.dmg || 0, dps: h.dps || 0, islands: h.islands })),
    };
  };

  // ---------- 快照 ----------
  P._pveSnapshot = function (snap, viewer) {
    const p = this.pve;
    if (p.hazardsChanged || this.tick % 30 === 1) {
      snap.H = p.hazards.map(h => ({ i: h.id, k: h.kind, x: r2(h.x), y: r2(h.y), x2: r2(h.x2), y2: r2(h.y2), r: r2(h.r), w: r2(h.w), f: h.fireAt, e: h.endAt, isl: h.islands ? h.islands.map(i => [r2(i.x), r2(i.y), r2(i.r)]) : undefined }));
    }
    if (p.stateChanged || this.tick % 15 === 1) snap.V = this._pveState();
    if (viewer && p.phase === 'draft') {
      const t = this.tanks.find(o => o.owner === viewer && !o.isBot && o.side === 'players');
      if (t && t.draft) snap.D = { cards: t.draft, picked: !!t.draftPicked, left: p.timer };
    }
  };
  const r2 = v => v === undefined ? undefined : Math.round(v * 100) / 100;

  P._pveState = function () {
    const p = this.pve;
    const boss = p.bossId && this.tankById.get(p.bossId);
    const core = p.core && this.tankById.get(p.core), npc = p.npcId && this.tankById.get(p.npcId);
    return {
      ph: p.phase, w: p.wave, tw: this._pveTotalWaves() === Infinity ? 0 : this._pveTotalWaves(), t: p.timer, parts: p.parts,
      left: this._pveAlive(t => !t.part && !t.structureM).length + p.queue.length,
      pv: p.phase === 'preview' ? p.preview : null,
      boss: boss && boss.alive ? { id: boss.id, k: boss.kind, hp: boss.hp, max: boss.maxHp, ph: boss.ai.phase || 1, vul: boss.dmgTaken } : null,
      core: core ? { hp: core.hp, max: core.maxHp } : null,
      npc: npc ? { hp: npc.hp, max: npc.maxHp, esc: !!npc.escorted } : null,
      gens: p.gens ? p.gens.map(g => [r2(g.progress), g.done ? 1 : 0]) : null, gi: p.genIdx,
      bunkers: p.bunkers.length ? p.bunkers.filter(id => this.tankById.get(id).alive).length : null,
      laps: p.track ? p.laps : null,
      zone: this.zone && this.zone.dynamic ? this.zone : (this.pve.zoneWasDynamic ? null : undefined),
    };
  };

  // 開局資訊（客戶端用來畫地圖上的物件與說明）
  P._pveMeta = function () {
    const p = this.pve;
    return {
      mode: p.mode, level: p.levelKey, name: p.level.name, story: p.level.story, chapter: p.level.chapter, objective: p.level.objective,
      difficulty: p.diffKey, diffName: p.diff.name, weeklyMods: p.mods, week: p.week, holdSeconds: p.level.holdSeconds || 0,
      exit: p.exit, gens: p.gens ? p.gens.map(g => ({ x: g.x, y: g.y })) : null, track: p.track,
      kinds: D.MONSTER_KINDS, monsters: Object.fromEntries(Object.entries({ ...D.MONSTERS, ...D.BOSSES }).map(([k, v]) => [k, { name: v.name, icon: v.icon, desc: v.desc, counter: v.counter }])),
      affixes: D.AFFIXES, cards: D.CARDS, shop: D.SHOP,
    };
  };

  // 怪物在快照中的額外欄位：種類、最大血量、詞綴、狀態、大小
  P._pveTankExtra = function (t) {
    const flags = (t.ai && t.ai.charging ? 1 : 0) | (t.frontShield ? 2 : 0) | (t.dmgTaken === 0 || t.invuln ? 4 : 0)
      | (t.ai && t.ai.real ? 8 : 0) | (t.dmgTaken > 1 ? 16 : 0) | (t.cloak > 0 ? 32 : 0) | (t.ai && t.ai.stunned > 0 ? 64 : 0) | (t.ai && t.ai.fuse ? 128 : 0);
    let em = 0; for (const a of t.elite || []) em |= 1 << AFFIX_KEYS.indexOf(a);
    return [KIND_IDX[t.kind] ?? 0, t.maxHp, em, flags, Math.round((t.size || C.TANK_SIZE) * 100)];
  };

  P._pveKindIdx = KIND_IDX;

  // ---------- 戰鬥修正 ----------
  // 傷害倍率：Boss 護甲、強化卡（暴擊、處決、屠龍、標記、裝甲）、每週詞綴
  P._pveDamageMods = function (t, shooter, dmg, cause) {
    let d = dmg * (t.dmgTaken ?? 1);
    const m = shooter && shooter.mods;
    if (m && t.monster) {
      if (m.crit && Math.random() < m.crit) { d *= 2; this.events.push(['spark', t.x, t.y]); }
      if (m.execute && t.hp / t.maxHp < 0.25) d *= 1 + m.execute;
      if (m.bossDmg && (t.boss || t.part)) d *= 1 + m.bossDmg;
    }
    if (t.monster && t.markedUntil > this.tick) d *= 1 + (t.markVal || 0);
    if (t.monster && shooter && !shooter.monster && this.pve.mods.includes('glass')) d *= 2;
    if (t.mods && t.mods.armor) d *= 1 - Math.min(0.6, t.mods.armor);
    return Math.max(1, Math.round(d));
  };

  // 子彈打到怪物前：無敵車廂、正面護盾、反射詞綴
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  P._pveBlockBullet = function (b, t) {
    if (t.invuln) { b.dead = true; this.events.push(['spark', b.x, b.y]); return true; }
    if (t.frontShield) {
      const incoming = (Math.atan2(-b.vx, b.vy) * 180 / Math.PI + 360) % 360;   // 從坦克看子彈來的方向
      if (angDiff(incoming, t.angle) < t.frontShield) {
        b.dead = true;
        if (b.blast) this._blast(b, b.x, b.y, null); else this.events.push(['spark', b.x, b.y]);
        return true;
      }
    }
    if (t.elite && t.elite.includes('reflect') && Math.random() < 0.2) {
      b.vx = -b.vx; b.vy = -b.vy; b.angle = (b.angle + 180) % 360; b.dir = Physics.dirOf(b.angle);
      b.side = t.side; b.owner = t.id; b.dmg = t.pveDmg; b.pierceTanks = 0; b.homing = false; b.snipe = 0;
      b.x += b.vx * 0.3; b.y += b.vy * 0.3;
      this.events.push(['spark', b.x, b.y]);
      return true;
    }
    return false;
  };

  // 命中後：標記、連鎖閃電
  P._pveOnHit = function (shooter, t, b) {
    const m = shooter.mods;
    if (!t.monster) return;
    if (m.mark) { t.markedUntil = this.tick + 4 * T; t.markVal = m.mark; }
    if (m.chain) {
      let best = null, bd = 2.5;
      for (const o of this.tanks) {
        if (!o.alive || !o.monster || o === t) continue;
        const d = Math.hypot(o.x - t.x, o.y - t.y);
        if (d < bd) { bd = d; best = o; }
      }
      if (best) { this.events.push(['spark', best.x, best.y]); this._damage(best, shooter, best.x, best.y, 'chain', Math.round((b.dmg || 10) * m.chain)); }
    }
  };

  // 導引彈：每 tick 朝前方 60 度內最近的敵人轉最多 4 度
  P._pveHome = function (b) {
    let best = null, bd = 4;
    for (const o of this.tanks) {
      if (!o.alive || o.side === b.side) continue;
      const d = Math.hypot(o.x - b.x, o.y - b.y);
      if (d >= bd) continue;
      const a = (Math.atan2(o.x - b.x, -(o.y - b.y)) * 180 / Math.PI + 360) % 360;
      if (angDiff(a, b.angle) > 60) continue;
      bd = d; best = a;
    }
    if (best === null) return;
    const diff = ((best - b.angle + 540) % 360) - 180;
    const turn = typeof b.homing === 'number' ? b.homing : 4;   // 工兵導引釘轉得比較慢
    b.angle = (b.angle + Math.max(-turn, Math.min(turn, diff)) + 360) % 360;
    [b.vx, b.vy] = Physics.vec(b.angle);
    b.dir = Physics.dirOf(b.angle);
  };
};

module.exports.weeklySpec = weeklySpec;
module.exports.weekId = weekId;
