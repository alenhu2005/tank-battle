'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const C = require('./constants');
const { Room, send } = require('./room');
const SPEC = require('./spec');
const DEFAULT_BOT = require('./defaultBot');
const SAMPLES = require('./samples');
// 新手教學的練習靶：慢慢左右移動，不會開火
const TARGET_BOT = 'function think(v, m) { m.t = (m.t || 0) + 1; var d = Math.floor(m.t / 50) % 2 ? "left" : "right"; return { move: m.t % 70 < 35 ? d : null, fire: false }; }';

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const league = require('./league');
const rooms = new Map();

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(data));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('資料太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const CLIENT_INFO = {
  classes: C.CLASSES, botClass: C.BOT_CLASS, colors: C.FFA_COLORS, factionColors: C.FACTION_COLORS,
  teamCount: C.TEAM_COUNT, tickRate: C.TICK_RATE, itemTypes: C.ITEM_TYPES,
};

function newRoomCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  throw new Error('no room codes left');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/spec.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(SPEC);
  }
  // 整局重播：/replay/房號/第幾局（gzip 壓縮的 JSON）
  const rm = url.pathname.match(/^\/replay\/(\d{4})\/(\d+)$/);
  if (rm) {
    const r = rooms.get(rm[1]);
    const gz = r && r.replays.get(Number(rm[2]));
    if (!gz) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('重播已失效（房間已關閉）'); }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' };
    if (url.searchParams.get('download')) headers['Content-Disposition'] = `attachment; filename="tank-replay-${rm[1]}-${rm[2]}.json"`;
    res.writeHead(200, headers);
    return res.end(gz);
  }
  // 代碼擂台 API
  if (url.pathname === '/api/league' && req.method === 'GET') {
    league.standings(url.searchParams.get('key') || '').then(data => json(res, 200, data)).catch(e => json(res, 500, { error: e.message }));
    return;
  }
  const lr = url.pathname.match(/^\/api\/league\/replay\/([A-Za-z0-9_-]+)$/);
  if (lr) {
    league.replay(lr[1]).then(gz => {
      if (!gz) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到這場重播'); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Cache-Control': 'private, max-age=3600' });
      res.end(gz);
    }).catch(e => json(res, 500, { error: e.message }));
    return;
  }
  if (url.pathname === '/api/league/submit' && req.method === 'POST') {
    readBody(req, 300 * 1024).then(body => league.submit(JSON.parse(body)))
      .then(data => json(res, 200, data))
      .catch(e => json(res, 400, { ok: false, error: e.message }));
    return;
  }
  if (url.pathname === '/samples.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(Object.entries(SAMPLES).map(([key, s]) => ({ key, name: s.name, desc: s.desc, code: s.code }))));
  }
  if (url.pathname === '/default-bot.js') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(DEFAULT_BOT);
  }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

// 測試用：模擬網路延遲（只有設定環境變數 LAG_MS 時才會啟用）
const LAG_MS = Number(process.env.LAG_MS) || 0;

wss.on('connection', (ws) => {
  if (LAG_MS) {
    const rawSend = ws.send.bind(ws);
    ws.send = (data) => setTimeout(() => { if (ws.readyState === 1) rawSend(data); }, LAG_MS);
    const rawOn = ws.on.bind(ws);
    ws.on = (ev, fn) => rawOn(ev, ev === 'message' ? (d) => setTimeout(() => fn(d), LAG_MS) : fn);
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let room = null, player = null;
  let msgCount = 0, msgWindow = Date.now();

  ws.on('message', (data) => {
    // 簡單的流量限制
    const now = Date.now();
    if (now - msgWindow > 1000) { msgWindow = now; msgCount = 0; }
    if (++msgCount > 120) return;

    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (!player) {
      if (msg.t === 'create') {
        const code = newRoomCode();
        const kind = msg.kind === 'practice' || msg.kind === 'tutorial' ? msg.kind : 'normal';
        room = new Room(code, (r) => rooms.delete(r.code), kind);
        rooms.set(code, room);
        player = room.addHuman(msg.name, ws);
        if (kind === 'practice') {
          // 代碼練習場：純代碼對戰，兩隊內建 AI 當對手，可以快轉
          Object.assign(room.settings, { mode: 'ffa', codeOnly: true, items: true, rounds: 15, timeLimit: 180 });
          room.addAI(); room.addAI();
        } else if (kind === 'tutorial') {
          // 新手教學：一隊不會開火的練習靶
          Object.assign(room.settings, { mode: 'ffa', baseMode: false, codeOnly: false, items: true, ricochet: false, fog: false, rounds: 1, timeLimit: 0, hpSystem: true, terrain: true, zone: false, closeCam: false });
          room.addAI(TARGET_BOT, '練習靶');
        }
      } else if (msg.t === 'join') {
        const r = rooms.get(String(msg.code || '').trim());
        if (!r) return send(ws, { t: 'error', msg: '找不到此房號' });
        const err = r.canJoin();
        if (err) return send(ws, { t: 'error', msg: err });
        room = r;
        player = room.addHuman(msg.name, ws);
      } else if (msg.t === 'resume') {
        const r = rooms.get(String(msg.code || ''));
        const p = r && r.get(msg.id);
        if (!p || p.token !== msg.token) return send(ws, { t: 'resumeFailed', roomExists: !!r });
        room = r; player = p;
        send(ws, { t: 'joined', code: room.code, id: player.id, token: player.token, name: player.name, ...CLIENT_INFO });
        room.resume(player, ws);
        return;
      } else return;
      send(ws, { t: 'joined', code: room.code, id: player.id, token: player.token, name: player.name, ...CLIENT_INFO });
      room.sendRoom();
      if (room.kind === 'tutorial') room.startRound();   // 教學直接開始
      return;
    }
    if (!room.players.includes(player)) return;
    room.handle(player, msg).catch(e => console.error('handle error', e));
  });

  ws.on('close', () => { if (room && player && room.players.includes(player)) room.disconnect(player, ws); });
});

// 心跳：偵測斷線，也讓雲端主機知道連線還活著
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 15000);

server.listen(PORT, () => console.log(`坦克對戰伺服器啟動：http://localhost:${PORT}  (tick ${C.TICK_RATE}Hz)`));
