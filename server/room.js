'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const REPLAYS_KEPT = 5;   // 每個房間保留最近幾局的重播
const C = require('./constants');
const { Round } = require('./game');
const { validateAsync } = require('./validateWorker');
const DEFAULT_BOT = require('./defaultBot');
const SAMPLES = require('./samples');

const DISCONNECT_GRACE_MS = 20000;          // 房主斷線多久後轉移房主
const LOBBY_REMOVE_MS = 10 * 60 * 1000;     // 大廳裡斷線多久後移出房間（手機切到背景會自動斷線）
const EMPTY_ROOM_MS = 15 * 60 * 1000;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, C.NAME_MAX);
  return n || '玩家';
}

class Room {
  // kind: 'normal' | 'practice'（代碼練習場）| 'tutorial'（新手教學）
  constructor(code, onClose, kind = 'normal') {
    this.code = code;
    this.kind = kind;
    this.speed = 1;   // 練習場可以快轉
    this.onClose = onClose;
    this.players = [];
    this.hostId = null;
    this.settings = { mode: 'ffa', baseMode: true, fog: false, hardWalls: false, codeOnly: false, items: true, ricochet: false, rounds: 3, timeLimit: 180,
      mapStyle: 'random', customMap: null, disabledItems: [], objective: 'survival',
      adv: Object.assign({}, C.ADV_DEFAULTS) };
    this.state = 'lobby'; // lobby | playing | intermission | finished
    this.roundNo = 0;
    this.round = null;
    this.lastResult = null;
    this.timer = null;
    this.aiCounter = 0;
    this.emptySince = null;
    this.housekeeping = setInterval(() => this._housekeep(), 5000);
    this.replays = new Map();   // roundNo -> gzip 壓縮過的整局重播
    this.recording = null;
  }

  // ---------- 玩家 ----------

  humans() { return this.players.filter(p => !p.isAI); }
  get(id) { return this.players.find(p => p.id === id); }

  canJoin() {
    if (this.kind !== 'normal') return '這是單人練習房，不能加入';
    if (this.state === 'playing') return '遊戲進行中，請等這一局結束再加入';
    if (this.players.length >= C.MAX_PLAYERS) return `房間已滿（最多 ${C.MAX_PLAYERS} 人）`;
    return null;
  }

  _uniqueName(name) {
    let n = cleanName(name), i = 2;
    const base = n;
    while (this.players.some(p => p.name === n)) n = `${base.slice(0, C.NAME_MAX - 2)}${i++}`;
    return n;
  }

  addHuman(name, ws) {
    const p = {
      id: crypto.randomBytes(4).toString('hex'),
      token: crypto.randomBytes(12).toString('hex'),
      name: this._uniqueName(name),
      isAI: false, ws, connected: true, disconnectedAt: 0,
      code: null, codeInfo: null,
      faction: this._suggestFaction(), team: this._suggestTeam(), cls: 'assault', ready: false,
      wins: 0, kills: 0,
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this.emptySince = null;
    return p;
  }

  addAI(code = DEFAULT_BOT, name) {
    this.aiCounter++;
    const p = {
      id: 'ai' + this.aiCounter + crypto.randomBytes(2).toString('hex'),
      name: this._uniqueName(name || '電腦' + this.aiCounter),
      isAI: true, connected: true, code, codeInfo: { ok: true },
      faction: this._suggestFaction(), team: this._suggestTeam(), ready: true, wins: 0, kills: 0,
      cls: Object.keys(C.CLASSES)[Math.floor(Math.random() * Object.keys(C.CLASSES).length)],
    };
    this.players.push(p);
    return p;
  }

  _suggestFaction() {
    const red = this.players.filter(p => p.faction === 'red').length;
    const blue = this.players.filter(p => p.faction === 'blue').length;
    return red <= blue ? 'red' : 'blue';
  }

  _suggestTeam() {
    for (let n = 1; n <= C.TEAM_COUNT; n++) if (!this.players.some(p => p.team === n)) return n;
    return 1;
  }

  resume(p, ws) {
    if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch { /* ignore */ } }
    p.ws = ws; p.connected = true; p.disconnectedAt = 0;
    this.emptySince = null;
    this.sendRoom();
    if (p.code) send(ws, { t: 'myCode', code: p.code });
    if (this.state === 'playing' && this.round) {
      send(ws, this._roundStartMsg(p));
    } else if (this.lastResult && (this.state === 'intermission' || this.state === 'finished')) {
      send(ws, this._roundEndMsg(p));
    }
  }

  disconnect(p, ws) {
    if (p.ws !== ws) return;
    p.ws = null; p.connected = false; p.disconnectedAt = Date.now();
    if (this.round) this.round.setInput(p.id, { move: null, fire: false });
    this.sendRoom();
  }

  remove(p) {
    this.players = this.players.filter(x => x !== p);
    if (p.ws) send(p.ws, { t: 'kicked' });
    if (!this.humans().length) return this.close();   // 沒有人了就關房，不浪費伺服器
    if (this.hostId === p.id) this._reassignHost();
    this.sendRoom();
  }

  _reassignHost() {
    const next = this.humans().find(p => p.connected) || this.humans()[0];
    this.hostId = next ? next.id : null;
  }

  _housekeep() {
    const now = Date.now();
    for (const p of this.humans()) {
      if (p.connected || now - p.disconnectedAt < DISCONNECT_GRACE_MS) continue;
      if (this.state === 'lobby' && now - p.disconnectedAt > LOBBY_REMOVE_MS) { this.remove(p); continue; }
      if (this.hostId === p.id) { this._reassignHost(); this.sendRoom(); }
    }
    const anyone = this.humans().some(p => p.connected);
    if (anyone) this.emptySince = null;
    else if (!this.emptySince) this.emptySince = now;
    else if (now - this.emptySince > (this.kind === 'normal' ? EMPTY_ROOM_MS : 3 * 60 * 1000)) this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.housekeeping);
    clearTimeout(this.timer);
    if (this.round) this.round.dispose();
    this.round = null;
    this.onClose(this);
  }

  // ---------- 訊息 ----------

  async handle(p, msg) {
    const isHost = p.id === this.hostId;
    switch (msg.t) {
      case 'i': // 操作輸入
        if (this.round) {
          // a：角度（度，0 = 上，順時針，-1 = 不動）；舊版用 m：八方向編號
          const move = typeof msg.a === 'number' ? (msg.a >= 0 ? msg.a : null) : (C.DIRS[msg.m] || null);
          this.round.setInput(p.id, { move, fire: !!msg.f, skill: !!msg.k, seq: Number.isInteger(msg.s) ? msg.s : undefined, view: Number(msg.v) });
        }
        return;
      case 'ping':     // 連線延遲測量：原封不動回傳
        return send(p.ws, { t: 'pong', c: msg.c });
      case 'settings': {
        if (!isHost || this.state !== 'lobby') return;
        const s = this.settings;
        if (['ffa', 'faction', 'team'].includes(msg.mode)) s.mode = msg.mode;
        if (typeof msg.baseMode === 'boolean') s.baseMode = msg.baseMode;
        if (typeof msg.fog === 'boolean') s.fog = msg.fog;
        if (typeof msg.hardWalls === 'boolean') s.hardWalls = msg.hardWalls;
        if (typeof msg.codeOnly === 'boolean') s.codeOnly = msg.codeOnly;
        if (typeof msg.items === 'boolean') s.items = msg.items;
        if (typeof msg.ricochet === 'boolean') s.ricochet = msg.ricochet;
        if (['random', 'open', 'forest', 'fortress', 'river', 'maze', 'custom'].includes(msg.mapStyle)) s.mapStyle = msg.mapStyle;
        if (C.OBJECTIVES.includes(msg.objective)) s.objective = msg.objective;
        if (msg.adv && typeof msg.adv === 'object') {
          for (const [k, [lo, hi]] of Object.entries(C.ADV_RANGES)) {
            const v = Number(msg.adv[k]);
            if (Number.isFinite(v)) s.adv[k] = Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
          }
        }
        if (msg.advReset) s.adv = Object.assign({}, C.ADV_DEFAULTS);
        if (msg.customMap !== undefined) {
          const cm = msg.customMap;
          const ok = cm && Number.isInteger(cm.size) && cm.size >= 15 && cm.size <= 35 && typeof cm.tiles === 'string'
            && cm.tiles.length === cm.size * cm.size && /^[.#@~*]+$/.test(cm.tiles);
          if (ok) { s.customMap = { size: cm.size, tiles: cm.tiles }; s.mapStyle = 'custom'; }
        }
        if (Array.isArray(msg.disabledItems)) {
          const keys = new Set(C.ITEM_TYPES.map(t => t.key));
          s.disabledItems = msg.disabledItems.filter(k => keys.has(k));
        }
        if (Number.isInteger(msg.rounds)) s.rounds = Math.min(15, Math.max(1, msg.rounds));
        if (Number.isInteger(msg.timeLimit)) s.timeLimit = [0, 120, 180, 300, 480].includes(msg.timeLimit) ? msg.timeLimit : s.timeLimit;
        return this.sendRoom();
      }
      case 'addAI':
        if (!isHost || this.state === 'playing' || this.players.length >= C.MAX_PLAYERS) return;
        this.addAI();
        return this.sendRoom();
      case 'kick': {
        const target = this.get(msg.id);
        if (!isHost || !target || target === p || this.state === 'playing') return;
        return this.remove(target);
      }
      case 'faction': {
        const target = msg.id ? this.get(msg.id) : p;
        if (!target || (target !== p && !isHost) || this.state === 'playing') return;
        if (msg.faction === 'red' || msg.faction === 'blue') target.faction = msg.faction;
        return this.sendRoom();
      }
      case 'team': {
        const target = msg.id ? this.get(msg.id) : p;
        if (!target || (target !== p && !isHost) || this.state === 'playing') return;
        if (Number.isInteger(msg.team) && msg.team >= 1 && msg.team <= C.TEAM_COUNT) target.team = msg.team;
        return this.sendRoom();
      }
      case 'cls': {
        if (this.state === 'playing') return;
        const target = msg.id ? this.get(msg.id) : p;
        if (!target || (target !== p && !(isHost && target.isAI))) return;
        if (C.CLASSES[msg.cls]) target.cls = msg.cls;
        return this.sendRoom();
      }
      case 'handicap': {   // 讓分：房主幫某位玩家加減命數
        const target = this.get(msg.id);
        if (!isHost || !target || target.isAI || this.state === 'playing') return;
        if (Number.isInteger(msg.v)) target.handicap = Math.max(-2, Math.min(2, msg.v));
        return this.sendRoom();
      }
      case 'ready':
        p.ready = !!msg.ready;
        return this.sendRoom();
      case 'code': {
        if (this.state === 'playing') return send(p.ws, { t: 'codeResult', ok: false, errors: ['遊戲進行中不能換代碼，請在局間調整'] });
        const code = msg.sample && SAMPLES[msg.sample] ? SAMPLES[msg.sample].code : String(msg.code || '');
        if (msg.useDefault) {
          p.code = null; p.codeInfo = null;
          send(p.ws, { t: 'codeResult', ok: true, usingDefault: true, errors: [], logs: [] });
          return this.sendRoom();
        }
        send(p.ws, { t: 'codeChecking' });
        const res = await validateAsync(code);
        if (!this.players.includes(p)) return;
        if (res.ok) { p.code = code; p.codeInfo = { ok: true, stats: res.stats, at: Date.now() }; }
        send(p.ws, { t: 'codeResult', ...res });
        return this.sendRoom();
      }
      case 'start':
        if (!isHost) return;
        if (this.state === 'lobby' || this.state === 'intermission') return this.startRound();
        return;
      case 'speed':      // 練習場快轉
        if (!isHost || this.kind !== 'practice') return;
        if ([1, 2, 4].includes(msg.v)) this.speed = msg.v;
        return this.sendRoom();
      case 'forceEnd':   // 房主強制結束這一局（算平手）
        if (!isHost || this.state !== 'playing' || !this.round) return;
        this.round.forceEnd();
        return;
      case 'endMatch':
        if (!isHost || this.state === 'playing') return;
        this.state = 'finished';
        return this.sendRoom();
      case 'toLobby':
        if (!isHost || this.state === 'playing') return;
        this.state = 'lobby';
        this.roundNo = 0;
        this.lastResult = null;
        for (const x of this.players) { x.wins = 0; x.kills = 0; x.ready = x.isAI; }
        return this.sendRoom();
      case 'leave':
        return this.remove(p);
    }
  }

  // ---------- 比賽流程 ----------

  _buildSides() {
    const s = this.settings;
    if (s.objective === 'pve') {
      return [{ key: 'players', name: '玩家隊', color: '#3ddc84', members: this.players.map(p => this._member(p)) }];
    }
    if (s.mode === 'faction') {
      return ['red', 'blue'].map(key => ({
        key, name: key === 'red' ? '紅軍' : '藍軍', color: C.FACTION_COLORS[key],
        members: this.players.filter(p => p.faction === key).map(p => this._member(p)),
      }));
    }
    if (s.mode === 'team') {
      const out = [];
      for (let n = 1; n <= C.TEAM_COUNT; n++) {
        const members = this.players.filter(p => p.team === n);
        if (members.length) out.push({ key: 't' + n, name: `第${n}隊`, color: C.FFA_COLORS[n - 1], members: members.map(p => this._member(p)) });
      }
      return out;
    }
    return this.players.map((p, i) => ({
      key: p.id, name: p.name, color: C.FFA_COLORS[i % C.FFA_COLORS.length], members: [this._member(p)],
    }));
  }

  _member(p) {
    // 新手教學時，玩家的電腦先待著不動，免得搶走練習目標
    const code = this.kind === 'tutorial' && !p.isAI ? 'function think() { return null; }' : (p.code || DEFAULT_BOT);
    return { playerId: p.id, name: p.name, code, cls: p.cls, aiPilot: p.isAI, handicap: p.handicap || 0 };
  }

  startError() {
    const sides = this._buildSides();
    if (this.settings.objective === 'pve') return null;
    if (this.settings.objective === 'escort' && sides.length !== 2) return '護送模式需要剛好兩隊（陣營戰最方便，或組隊分成兩隊）';
    if (this.settings.mode === 'faction') {
      if (sides.some(s => s.members.length === 0)) return '陣營戰需要紅藍兩邊都有人（可以加入電腦隊伍）';
    } else if (this.settings.mode === 'team') {
      if (sides.length < 2) return '組隊模式至少要有兩個不同的隊伍';
    } else if (sides.length < 2) return '至少要兩隊才能開始（可以加入電腦隊伍來練習）';
    return null;
  }

  startRound() {
    const err = this.startError();
    if (err) { const host = this.get(this.hostId); if (host) send(host.ws, { t: 'toast', msg: err }); return; }
    const s = this.settings;
    if (this.state === 'lobby') { this.roundNo = 0; for (const p of this.players) { p.wins = 0; p.kills = 0; } }
    this.roundNo++;
    this.round = new Round({
      mode: s.mode, baseMode: s.baseMode, fog: s.fog, breakableWalls: !s.hardWalls, codeOnly: s.codeOnly, items: s.items, ricochet: s.ricochet,
      rules: s.adv, objective: s.objective, attackerIndex: (this.roundNo - 1) % 2,   // 護送：每局交換攻守
      mapStyle: s.mapStyle, customMap: s.mapStyle === 'custom' ? s.customMap : null, disabledItems: s.disabledItems,
      timeLimit: s.timeLimit, sides: this._buildSides(), countdown: this.kind === 'tutorial' ? 3 : C.COUNTDOWN_SECONDS,
      itemFirstDelay: this.kind === 'tutorial' ? 2 : undefined, itemInterval: this.kind === 'tutorial' ? 4 : undefined,
    });
    this.state = 'playing';
    // 錄下整局（全視角）供賽後重播
    this.recording = this.kind === 'tutorial' ? null : { meta: JSON.stringify(this.round.meta()), frames: [] };
    for (const p of this.players) p.ready = p.isAI;
    this.sendRoom();
    for (const p of this.humans()) send(p.ws, this._roundStartMsg(p));
    this._scheduleLoop();
  }

  _roundStartMsg(p) {
    const t = this.round.playerTank(p.id);
    return { t: 'roundStart', roundNo: this.roundNo, rounds: this.settings.rounds, meta: this.round.meta(), myTank: t ? t.id : null };
  }

  _scheduleLoop() {
    const interval = 1000 / C.TICK_RATE;
    let next = Date.now();
    const loop = () => {
      if (!this.round) return;
      const now = Date.now();
      // 落後太多時不追趕，避免一次跑很多 tick
      let steps = 0;
      while (next <= now && steps < 3) {
        for (let k = 0; k < this.speed; k++) { this._tick(); if (!this.round) return; }
        next += interval; steps++;
      }
      if (next < now - 200) next = now;
      this.timer = setTimeout(loop, Math.max(0, next - Date.now()));
    };
    loop();
  }

  _tick() {
    const r = this.round;
    r.step();
    const full = JSON.stringify(r.snapshotFor(null));
    if (this.recording && this.recording.frames.length < 30 * 60 * 10) this.recording.frames.push(full);
    const perPlayer = r.needsPerPlayerSnapshots();
    for (const p of this.humans()) {
      if (!p.ws) continue;
      send(p.ws, perPlayer ? r.snapshotFor(p.id) : full);
      // 電腦代碼用 debug.* 畫的東西，只送給代碼的主人
      for (const t of r.tanks) {
        if (t.owner === p.id && t.sandbox && t.sandbox.debugOps && t.alive) send(p.ws, { t: 'dbg', k: r.tick, id: t.id, ops: t.sandbox.debugOps });
      }
    }
    if (r.over) this._endRound();
  }

  _endRound() {
    const r = this.round;
    this.round = null;
    clearTimeout(this.timer);
    this._saveReplay();
    const res = r.result;
    const sideWinner = res.winner;
    const winners = [];
    for (const p of this.players) {
      const mode = this.settings.mode;
      const inWinner = this.settings.objective === 'pve' ? sideWinner === 'players'
        : mode === 'faction' ? p.faction === sideWinner : mode === 'team' ? 't' + p.team === sideWinner : p.id === sideWinner;
      if (sideWinner && inWinner) { p.wins++; winners.push(p.name); }
      p.kills += res.tanks.filter(t => t.owner === p.id).reduce((a, t) => a + t.kills, 0);
    }
    const sideInfo = r.sides.map(s => ({ key: s.key, name: s.name, color: s.color }));
    this.lastResult = {
      roundNo: this.roundNo, winner: sideWinner, winners, reason: res.reason,
      seconds: Math.round(res.ticks / C.TICK_RATE), sides: sideInfo, tanks: res.tanks,
      reports: r.botReports(),
    };
    r.dispose();
    this.state = this.roundNo >= this.settings.rounds ? 'finished' : 'intermission';
    this.sendRoom();
    for (const p of this.humans()) send(p.ws, this._roundEndMsg(p));
  }

  _saveReplay() {
    const rec = this.recording;
    this.recording = null;
    if (!rec || !rec.frames.length) return;
    const json = `{"v":1,"room":"${this.code}","round":${this.roundNo},"meta":${rec.meta},"frames":[${rec.frames.join(',')}]}`;
    const gz = zlib.gzipSync(json, { level: 6 });
    this.replays.set(this.roundNo, gz);
    while (this.replays.size > REPLAYS_KEPT) this.replays.delete(this.replays.keys().next().value);
  }

  _roundEndMsg(p) {
    const { reports, ...rest } = this.lastResult;
    // 每個人只看得到自己電腦的錯誤與 log
    return { t: 'roundEnd', ...rest, myReport: reports[p.id] || null, replay: this.replays.has(this.lastResult.roundNo) ? `${this.code}-${this.lastResult.roundNo}` : null };
  }

  // ---------- 房間狀態 ----------

  sendRoom() {
    for (const p of this.humans()) {
      if (!p.ws) continue;
      send(p.ws, {
        t: 'room',
        code: this.code, you: p.id, hostId: this.hostId, state: this.state, kind: this.kind, speed: this.speed,
        settings: this.settings, roundNo: this.roundNo, maxPlayers: C.MAX_PLAYERS, teamCount: C.TEAM_COUNT,
        startError: this.state === 'lobby' || this.state === 'intermission' ? this.startError() : null,
        players: this.players.map(x => ({
          id: x.id, name: x.name, isAI: x.isAI, connected: x.connected, faction: x.faction, team: x.team, cls: x.cls, handicap: x.handicap || 0,
          ready: x.ready, wins: x.wins, kills: x.kills,
          customCode: !!x.code && !x.isAI,
        })),
        myCode: { custom: !!p.code, info: p.codeInfo },
      });
    }
  }
}

module.exports = { Room, send };
