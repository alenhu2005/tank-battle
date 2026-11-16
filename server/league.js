'use strict';

// 代碼擂台：每週一季。玩家提交代碼後，馬上和本週其他參賽者（人不夠時用範例打法補）各打兩場，
// 用 Elo 分數排名。資料存在 Firestore（部署在 Cloud Run 時），本機開發時存在記憶體。

const crypto = require('crypto');
const SAMPLES = require('./samples');
const { validateAsync, matchAsync } = require('./validateWorker');

const START_RATING = 1000;
const K = 32;
const MAX_OPPONENTS = 6;
const SUBMIT_COOLDOWN_MS = 30 * 1000;

// ISO 週次，例如 2026-W47
function weekId(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ---------- 儲存 ----------

function memoryStore() {
  const docs = new Map();
  return {
    kind: 'memory',
    async list(week) { return [...docs.values()].filter(e => e.week === week); },
    async get(week, key) { return docs.get(`${week}_${key}`) || null; },
    async put(e) { docs.set(`${e.week}_${e.key}`, { ...e }); },
  };
}

function firestoreStore() {
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({ ignoreUndefinedProperties: true });
  const col = db.collection('league');
  return {
    kind: 'firestore',
    async list(week) { const snap = await col.where('week', '==', week).get(); return snap.docs.map(d => d.data()); },
    async get(week, key) { const d = await col.doc(`${week}_${key}`).get(); return d.exists ? d.data() : null; },
    async put(e) { await col.doc(`${e.week}_${e.key}`).set(e); },
  };
}

let store = null;
function getStore() {
  if (store) return store;
  const wantFirestore = process.env.LEAGUE_STORE === 'firestore' || (process.env.K_SERVICE && process.env.LEAGUE_STORE !== 'memory');
  if (wantFirestore) {
    try { store = firestoreStore(); console.log('代碼擂台：使用 Firestore'); }
    catch (e) { console.error('代碼擂台：Firestore 無法使用，改用記憶體', e.message); store = memoryStore(); }
  } else store = memoryStore();
  return store;
}

// Firestore 失敗時（例如還沒建立資料庫）自動改用記憶體，不讓整個功能壞掉
async function withStore(fn) {
  try { return await fn(getStore()); }
  catch (e) {
    if (getStore().kind === 'firestore') {
      console.error('代碼擂台：Firestore 錯誤，改用記憶體', e.message);
      store = memoryStore();
      return fn(store);
    }
    throw e;
  }
}

// ---------- Elo ----------

function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function eloDelta(rA, rB, scoreA) { return Math.round(K * (scoreA - expected(rA, rB))); }

function publicEntry(e, rank, myKey) {
  return { rank, name: e.name, rating: e.rating, wins: e.wins, losses: e.losses, draws: e.draws, games: e.games, me: e.key === myKey };
}

async function standings(myKey) {
  const week = weekId();
  return withStore(async (st) => {
    const list = (await st.list(week)).sort((a, b) => b.rating - a.rating || b.wins - a.wins);
    const entries = list.slice(0, 50).map((e, i) => publicEntry(e, i + 1, myKey));
    const myIdx = list.findIndex(e => e.key === myKey);
    return { week, storage: st.kind, total: list.length, entries, mine: myIdx >= 0 ? publicEntry(list[myIdx], myIdx + 1, myKey) : null };
  });
}

// 一次只處理一個提交（對戰很吃 CPU）
let queue = Promise.resolve();
const lastSubmit = new Map();

function submit({ key, name, code }) {
  const run = queue.then(() => doSubmit({ key, name, code }));
  queue = run.catch(() => {});
  return run;
}

async function doSubmit({ key, name, code }) {
  key = String(key || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
  name = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || '無名氏';
  code = String(code || '');
  if (key.length < 8) return { ok: false, error: '缺少玩家識別碼' };
  const now = Date.now();
  if (now - (lastSubmit.get(key) || 0) < SUBMIT_COOLDOWN_MS) return { ok: false, error: '提交太頻繁了，30 秒後再試' };
  lastSubmit.set(key, now);

  const v = await validateAsync(code);
  if (!v.ok) return { ok: false, error: '代碼測試沒通過', errors: v.errors };

  const week = weekId();
  return withStore(async (st) => {
    const all = await st.list(week);
    let me = all.find(e => e.key === key) || { week, key, rating: START_RATING, games: 0, wins: 0, losses: 0, draws: 0, createdAt: now };
    me = { ...me, name, code, codeHash: crypto.createHash('sha1').update(code).digest('hex').slice(0, 10), updatedAt: now };

    // 對手：本週其他參賽者隨機挑；人不夠就用範例打法補（範例的分數固定 1000，不會被存起來）
    const others = all.filter(e => e.key !== key).sort(() => Math.random() - 0.5).slice(0, MAX_OPPONENTS);
    const house = Object.entries(SAMPLES).map(([k, s]) => ({ key: 'house-' + k, name: `範例・${s.name}`, code: s.code, rating: START_RATING, house: true }));
    const opponents = others.length >= 3 ? others : others.concat(house.slice(0, 4 - others.length));

    const results = [];
    for (const op of opponents) {
      const r = await matchAsync(code, op.code);        // 兩場，交換位置
      const m = { games: r.games || 1, wins: r.wins || 0, losses: r.losses || 0, draws: r.games ? r.draws || 0 : 1 };
      const scoreA = (m.wins + m.draws * 0.5) / Math.max(1, m.games);
      const d = eloDelta(me.rating, op.rating, scoreA);
      me.rating += d;
      me.games += m.games; me.wins += m.wins; me.losses += m.losses; me.draws += m.draws;
      if (!op.house) {
        op.rating -= d;
        op.games += m.games; op.wins += m.losses; op.losses += m.wins; op.draws += m.draws;
        await st.put(op);
      }
      results.push({ opponent: op.name, wins: m.wins, losses: m.losses, draws: m.draws, delta: d });
    }
    await st.put(me);
    const board = await standings(key);
    return { ok: true, results, rating: me.rating, standings: board };
  });
}

module.exports = { submit, standings, weekId };
