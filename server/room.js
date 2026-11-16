'use strict';

const crypto = require('crypto');
const C = require('./constants');
const { Round } = require('./game');
const { validateAsync } = require('./validateWorker');
const DEFAULT_BOT = require('./defaultBot');

const DISCONNECT_GRACE_MS = 20000;
const EMPTY_ROOM_MS = 5 * 60 * 1000;

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, C.NAME_MAX);
  return n || '玩家';
}

class Room {
  constructor(code, onClose) {
    this.code = code;
    this.onClose = onClose;
    this.players = [];
    this.hostId = null;
    this.settings = { mode: 'ffa', baseMode: true, fog: false, hardWalls: false, codeOnly: false, rounds: 3, timeLimit: 180 };
    this.state = 'lobby'; // lobby | playing | intermission | finished
    this.roundNo = 0;
    this.round = null;
    this.lastResult = null;
    this.timer = null;
    this.aiCounter = 0;
    this.emptySince = null;
    this.housekeeping = setInterval(() => this._housekeep(), 5000);
  }

  // ---------- 玩家 ----------

  humans() { return this.players.filter(p => !p.isAI); }
  get(id) { return this.players.find(p => p.id === id); }

  canJoin() {
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

  addAI() {
    this.aiCounter++;
    const p = {
      id: 'ai' + this.aiCounter + crypto.randomBytes(2).toString('hex'),
      name: this._uniqueName('電腦' + this.aiCounter),
      isAI: true, connected: true, code: DEFAULT_BOT, codeInfo: { ok: true },
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
      if (this.state === 'lobby') { this.remove(p); continue; }
      if (this.hostId === p.id) { this._reassignHost(); this.sendRoom(); }
    }
    const anyone = this.humans().some(p => p.connected);
    if (anyone) this.emptySince = null;
    else if (!this.emptySince) this.emptySince = now;
    else if (now - this.emptySince > EMPTY_ROOM_MS) this.close();
  }

  close() {
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
        if (this.round) this.round.setInput(p.id, { move: C.DIRS[msg.m] || null, fire: !!msg.f });
        return;
      case 'settings': {
        if (!isHost || this.state !== 'lobby') return;
        const s = this.settings;
        if (['ffa', 'faction', 'team'].includes(msg.mode)) s.mode = msg.mode;
        if (typeof msg.baseMode === 'boolean') s.baseMode = msg.baseMode;
        if (typeof msg.fog === 'boolean') s.fog = msg.fog;
        if (typeof msg.hardWalls === 'boolean') s.hardWalls = msg.hardWalls;
        if (typeof msg.codeOnly === 'boolean') s.codeOnly = msg.codeOnly;
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
      case 'ready':
        p.ready = !!msg.ready;
        return this.sendRoom();
      case 'code': {
        if (this.state === 'playing') return send(p.ws, { t: 'codeResult', ok: false, errors: ['遊戲進行中不能換代碼，請在局間調整'] });
        const code = String(msg.code || '');
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
    return { playerId: p.id, name: p.name, code: p.code || DEFAULT_BOT, cls: p.cls, aiPilot: p.isAI };
  }

  startError() {
    const sides = this._buildSides();
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
      mode: s.mode, baseMode: s.baseMode, fog: s.fog, breakableWalls: !s.hardWalls, codeOnly: s.codeOnly,
      timeLimit: s.timeLimit, sides: this._buildSides(),
    });
    this.state = 'playing';
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
      while (next <= now && steps < 3) { this._tick(); next += interval; steps++; if (!this.round) return; }
      if (next < now - 200) next = now;
      this.timer = setTimeout(loop, Math.max(0, next - Date.now()));
    };
    loop();
  }

  _tick() {
    const r = this.round;
    r.step();
    let shared = null;
    for (const p of this.humans()) {
      if (!p.ws) continue;
      if (r.fog && !r.codeOnly) send(p.ws, r.snapshotFor(p.id));
      else send(p.ws, shared || (shared = JSON.stringify(r.snapshotFor(null))));
    }
    if (r.over) this._endRound();
  }

  _endRound() {
    const r = this.round;
    this.round = null;
    clearTimeout(this.timer);
    const res = r.result;
    const sideWinner = res.winner;
    const winners = [];
    for (const p of this.players) {
      const mode = this.settings.mode;
      const inWinner = mode === 'faction' ? p.faction === sideWinner : mode === 'team' ? 't' + p.team === sideWinner : p.id === sideWinner;
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

  _roundEndMsg(p) {
    const { reports, ...rest } = this.lastResult;
    // 每個人只看得到自己電腦的錯誤與 log
    return { t: 'roundEnd', ...rest, myReport: reports[p.id] || null };
  }

  // ---------- 房間狀態 ----------

  sendRoom() {
    for (const p of this.humans()) {
      if (!p.ws) continue;
      send(p.ws, {
        t: 'room',
        code: this.code, you: p.id, hostId: this.hostId, state: this.state,
        settings: this.settings, roundNo: this.roundNo, maxPlayers: C.MAX_PLAYERS, teamCount: C.TEAM_COUNT,
        startError: this.state === 'lobby' || this.state === 'intermission' ? this.startError() : null,
        players: this.players.map(x => ({
          id: x.id, name: x.name, isAI: x.isAI, connected: x.connected, faction: x.faction, team: x.team, cls: x.cls,
          ready: x.ready, wins: x.wins, kills: x.kills,
          customCode: !!x.code && !x.isAI,
        })),
        myCode: { custom: !!p.code, info: p.codeInfo },
      });
    }
  }
}

module.exports = { Room, send };
