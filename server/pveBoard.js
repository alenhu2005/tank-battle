'use strict';

// 打怪排行榜：無盡（最高波數）與每週挑戰（最快通關秒數），每週重置。
// 和代碼擂台一樣：Cloud Run 上存 Firestore，本機存記憶體。

const { weekId } = require('./pve');

let store = null;
function getStore() {
  if (store) return store;
  const wantFirestore = process.env.LEAGUE_STORE === 'firestore' || (process.env.K_SERVICE && process.env.LEAGUE_STORE !== 'memory');
  if (wantFirestore) {
    try {
      const { Firestore } = require('@google-cloud/firestore');
      const col = new Firestore({ ignoreUndefinedProperties: true }).collection('pve_board');
      store = {
        async list(board, week) { const s = await col.where('board', '==', board).where('week', '==', week).get(); return s.docs.map(d => d.data()); },
        async get(id) { const d = await col.doc(id).get(); return d.exists ? d.data() : null; },
        async put(e) { await col.doc(e.id).set(e); },
      };
      return store;
    } catch (e) { console.error('打怪排行榜：Firestore 無法使用，改用記憶體', e.message); }
  }
  const docs = new Map();
  store = {
    async list(board, week) { return [...docs.values()].filter(e => e.board === board && e.week === week); },
    async get(id) { return docs.get(id) || null; },
    async put(e) { docs.set(e.id, e); },
  };
  return store;
}

const better = (board, a, b) => board === 'endless' ? a.score > b.score || (a.score === b.score && a.seconds < b.seconds) : a.score < b.score;

// summary：Round 的 pve 摘要；names：參與的玩家暱稱
async function submit(summary, names) {
  if (!summary || !names.length) return null;
  const board = summary.mode === 'endless' ? 'endless' : summary.mode === 'weekly' ? 'weekly' : null;
  if (!board) return null;
  if (board === 'weekly' && !summary.cleared) return null;
  const week = summary.week || weekId();
  const team = names.slice().sort().join('・').slice(0, 80);
  const e = {
    id: `${board}_${week}_${team}`, board, week, team, players: names.length,
    score: board === 'endless' ? summary.wave : summary.seconds, seconds: summary.seconds,
    difficulty: summary.difficulty, at: Date.now(),
  };
  try {
    const s = getStore(), old = await s.get(e.id);
    if (!old || better(board, e, old)) await s.put(e);
    return e;
  } catch (err) { console.error('打怪排行榜寫入失敗', err.message); return null; }
}

async function top(board, n = 20) {
  const week = weekId();
  try {
    const list = await getStore().list(board, week);
    list.sort((a, b) => better(board, a, b) ? -1 : better(board, b, a) ? 1 : 0);
    return { board, week, entries: list.slice(0, n).map((e, i) => ({ rank: i + 1, team: e.team, score: e.score, seconds: e.seconds, players: e.players, difficulty: e.difficulty })) };
  } catch (err) { return { board, week, entries: [], error: err.message }; }
}

module.exports = { submit, top };
