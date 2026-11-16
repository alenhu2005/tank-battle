'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const C = require('./constants');
const { Room, send } = require('./room');
const SPEC = require('./spec');
const DEFAULT_BOT = require('./defaultBot');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const rooms = new Map();
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

wss.on('connection', (ws) => {
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
        room = new Room(code, (r) => rooms.delete(r.code));
        rooms.set(code, room);
        player = room.addHuman(msg.name, ws);
      } else if (msg.t === 'join') {
        const r = rooms.get(String(msg.code || '').trim());
        if (!r) return send(ws, { t: 'error', msg: '找不到這個房號' });
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
