// 打怪模式的介面：大廳設定、HUD、波次預告、Boss 登場、強化卡與商店、結算（星級、成就）、圖鑑與紀錄、塗裝
(function () {
  'use strict';
  let api = null, data = null;
  const OBJ_NAMES = { waves: '撐過所有波次', destroy: '摧毀所有據點', boss: '擊敗 Boss', core: '守護核心', rescue: '護送友軍到撤離點', generators: '依序啟動 4 座發電機', train: '在 4 圈內擊毀列車', endless: '撐得越久越好' };
  const SKINS = {
    default: { name: '標準', req: null },
    camo:    { name: '迷彩', req: '通關第一章' },
    stripes: { name: '條紋', req: '通關第二章' },
    carbon:  { name: '碳纖', req: '通關第三章' },
    neon:    { name: '霓虹', req: '無盡模式 20 波' },
    gold:    { name: '黃金', req: '煉獄難度通關任一關' },
  };
  // 成就：check(summary, ctx) → true 表示達成
  const ACH = [
    ['first',     '初次通關', '通關任一關卡', (s) => s.cleared && s.mode === 'campaign'],
    ['ch1',       '前哨站解放', '通關 1-3', (s) => s.cleared && s.level === '1-3'],
    ['ch2',       '毒沼淨化', '通關 2-3', (s) => s.cleared && s.level === '2-3'],
    ['ch3',       '機械城終結', '通關 3-3', (s) => s.cleared && s.level === '3-3'],
    ['flawless',  '無傷', '玩家無人陣亡通關', (s) => s.cleared && s.humanDeaths === 0],
    ['speed',     '神速', '在標準時間 60% 內通關', (s) => s.cleared && s.par && s.seconds <= s.par * 0.6],
    ['hard',      '困難征服者', '困難難度通關', (s) => s.cleared && (s.difficulty === 'hard' || s.difficulty === 'hell')],
    ['hell',      '煉獄行者', '煉獄難度通關', (s) => s.cleared && s.difficulty === 'hell'],
    ['nurseonly', '白衣軍團', '全隊只用護士通關', (s, c) => s.cleared && c.classes.length && c.classes.every(k => k === 'nurse')],
    ['solo',      '孤狼', '單人通關', (s, c) => s.cleared && c.humans === 1],
    ['e10',       '持久戰', '無盡模式達到第 10 波', (s) => s.mode === 'endless' && s.wave >= 10],
    ['e20',       '鋼鐵意志', '無盡模式達到第 20 波', (s) => s.mode === 'endless' && s.wave >= 20],
    ['e30',       '傳說', '無盡模式達到第 30 波', (s) => s.mode === 'endless' && s.wave >= 30],
    ['weekly',    '每週挑戰者', '通關每週挑戰', (s) => s.cleared && s.mode === 'weekly'],
    ['hundred',   '百斬', '單場擊殺 100 隻怪物', (s) => s.kills >= 100],
    ['legend',    '傳說收藏家', '單場獲得 3 張傳說卡', (s, c) => c.legend >= 3],
    ['bFortress', '攻城者', '擊敗鋼鐵堡壘', (s) => s.cleared && s.bossKind === 'fortress' || (s.mode === 'endless' && s.wave >= 6)],
    ['bQueen',    '除蟲專家', '擊敗毒霧女王', (s) => s.cleared && s.bossKind === 'queen' || (s.mode === 'endless' && s.wave >= 11)],
    ['bTrain',    '脫軌', '擊毀雷霆列車', (s) => s.cleared && s.bossKind === 'train'],
    ['bColossus', '巨像殺手', '擊敗機械巨像', (s) => s.cleared && s.bossKind === 'colossus'],
  ];

  // ---------- 進度（存在手機裡） ----------
  function progress() {
    const p = api.store.get('pveProgress', null) || {};
    return Object.assign({ stars: {}, endless: 0, seen: {}, ach: {}, skin: 'default' }, p);
  }
  function saveProgress(p) { api.store.set('pveProgress', p); }
  function skinUnlocked(key, p = progress()) {
    const st = lv => Object.values(p.stars[lv] || {}).some(v => v > 0);
    return { default: true, camo: st('1-3'), stripes: st('2-3'), carbon: st('3-3'), neon: p.endless >= 20, gold: !!p.ach.hell }[key];
  }
  function bestStars(level, p = progress()) { return Math.max(0, ...Object.values(p.stars[level] || {})); }

  // ---------- 大廳 ----------
  function lobbyRows(s, host, seg) {
    if (!data) return '<div class="set-desc">載入關卡資料中…</div>';
    const dis = host ? '' : 'disabled';
    const p = progress();
    let html = `<div class="set-row"><span>打怪模式</span>${seg('pveMode', [['campaign', '戰役'], ['endless', '無盡'], ['weekly', '每週挑戰']], s.pveMode || 'campaign')}</div>`;
    if ((s.pveMode || 'campaign') === 'campaign') {
      const lv = data.levels[s.pveLevel] || data.levels['1-1'];
      html += `<div class="set-row"><span>關卡</span><select id="pveLevelSel" ${dis}>${Object.entries(data.levels).map(([k, v]) =>
        `<option value="${k}" ${k === s.pveLevel ? 'selected' : ''}>${k} ${v.name}${v.boss ? ' 👑' : ''}　${'★'.repeat(bestStars(k, p))}${'☆'.repeat(3 - bestStars(k, p))}</option>`).join('')}</select></div>
        <div class="set-desc pve-story">「${api.esc(lv.story)}」<br>目標：${OBJ_NAMES[lv.objective] || ''}・標準時間 ${Math.floor(lv.par / 60)}:${String(lv.par % 60).padStart(2, '0')}</div>`;
    } else if (s.pveMode === 'endless') {
      html += `<div class="set-desc">無盡波次，每 5 波一隻 Boss。個人最佳：第 ${p.endless} 波。</div>`;
    } else {
      const w = data.weekly;
      html += `<div class="set-desc">本週（${w.week}）：關卡 ${w.level} ${api.esc(data.levels[w.level].name)}・詞綴 ${w.mods.map(m => `<b>${api.esc(data.weeklyMods[m].name)}</b>（${api.esc(data.weeklyMods[m].desc)}）`).join('、')}・難度固定普通</div>`;
    }
    if ((s.pveMode || 'campaign') !== 'weekly') {
      html += `<div class="set-row"><span>難度</span>${seg('pveDiff', Object.entries(data.difficulty).map(([k, v]) => [k, v.name]), s.pveDiff || 'normal')}</div>
        <div class="set-desc">${{ easy: '怪物血量、傷害 ×0.7；每波回 1 命', normal: '每波回 1 命；10% 精英怪', hard: '血量 ×1.5、傷害 ×1.3；不回命；25% 精英怪', hell: '血量 ×2、傷害 ×1.6、彈速 ×1.2；不回命；50% 精英怪且詞綴加倍' }[s.pveDiff || 'normal']}</div>`;
    }
    html += '<div class="set-desc">打怪固定使用血量系統；每波結束可選強化卡、用零件購買補給。</div>';
    return html;
  }

  function skinRow() {
    const p = progress(), cur = p.skin || 'default';
    return Object.entries(SKINS).map(([k, v]) => {
      const ok = skinUnlocked(k, p);
      return `<button class="skin-chip ${k === cur ? 'sel' : ''} skin-${k}" data-skin="${k}" ${ok ? '' : 'disabled'} title="${ok ? v.name : '解鎖條件：' + v.req}">${ok ? v.name : '🔒 ' + v.name}</button>`;
    }).join('');
  }
  function chooseSkin(k) {
    if (!skinUnlocked(k)) return api.toast(`解鎖條件：${SKINS[k].req}`);
    const p = progress(); p.skin = k; saveProgress(p);
    api.send({ t: 'skin', skin: k });
  }

  // ---------- 對戰中 ----------
  let lastState = null, bannerTimer = null;
  function onRoundStart(meta) {
    lastState = null;
    const bb = api.$('#bossBar'); if (bb) bb.classList.remove('show');
    api.$('#draft').classList.remove('show');
    if (!meta.pve) return;
    const pv = meta.pve;
    banner(`<small>${pv.mode === 'endless' ? '無盡模式' : pv.mode === 'weekly' ? '每週挑戰' : `第 ${pv.chapter} 章・${pv.level}`}・${pv.diffName}</small><b>${api.esc(pv.name)}</b><span>${api.esc(pv.story)}</span>`, 3800);
  }

  function banner(html, ms = 2500) {
    const el = api.$('#pveBanner');
    el.innerHTML = html; el.classList.add('show');
    clearTimeout(bannerTimer); bannerTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function name(kind) { const m = data && (data.monsters[kind] || data.bosses[kind]); return m ? m.name : kind; }
  function icon(kind) { const m = data && (data.monsters[kind] || data.bosses[kind]); return m ? m.icon : '👾'; }

  // 物件事件：回傳 true 表示已處理
  function onObjEvent(e) {
    const [type, a, b, c] = e;
    const r = api.renderer;
    if (type === 'wavePreview') {
      const list = Object.entries(b || {}).map(([k, n]) => `<span class="pv-item">${icon(k)} ${api.esc(name(k))} ×${n}</span>`).join('');
      banner(`<small>即將來襲</small><b>第 ${a} 波</b>${c ? `<span class="pv-boss">${icon(c)} ${api.esc(name(c))}</span>` : ''}<div class="pv-list">${list}</div>`, 2800);
      markSeen(Object.keys(b || {}).concat(c ? [c] : []));
      return true;
    }
    if (type === 'wave') { window.Sfx.play('emp'); return true; }
    if (type === 'bossIntro') {
      r.focus = { x: b, y: c, t0: performance.now(), until: performance.now() + 1800 };
      banner(`<small>BOSS</small><b class="boss-name">${icon(a)} ${api.esc(name(a))}</b>`, 2200);
      window.Sfx.play('baseBoom'); api.buzz([80, 60, 120]);
      markSeen([a]);
      return true;
    }
    if (type === 'bossPhase') { banner(`<b>${api.esc(name(a))}・第 ${b} 階段</b>`, 1500); window.Sfx.play('timestop'); return true; }
    if (type === 'coreOpen') { if (a) banner('<b>核心開放！全力攻擊</b>', 1500); return true; }
    if (type === 'bossDown') { banner(`<b>${api.esc(name(a))} 擊破</b>`, 2500); window.Sfx.play('win'); return true; }
    if (type === 'gen') { banner(`<b>發電機 ${a} / 4 啟動</b>`, 1500); window.Sfx.play('kill'); return true; }
    if (type === 'lap') { banner(`<b>列車撞擊核心（第 ${a} 圈）</b>`, 1500); api.buzz([100]); return true; }
    return false;
  }

  function markSeen(kinds) {
    const p = progress(); let changed = false;
    for (const k of kinds) if (!p.seen[k]) { p.seen[k] = true; changed = true; }
    if (changed) saveProgress(p);
  }

  // HUD 目標文字（取代一般模式的目標列）
  function hud(r) {
    const v = r.pveState, pv = r.meta.pve;
    if (!v || !pv) return '';
    const parts = [];
    const phase = { prep: '準備', preview: '即將來襲', fight: '', draft: '強化' }[v.ph] || '';
    parts.push(`<span>${v.tw ? `第 ${v.w}/${v.tw} 波` : `第 ${v.w} 波`}${phase ? '・' + phase : ''}・剩 ${v.left}</span>`);
    parts.push(`<span>⚙️ ${v.parts}</span>`);
    if (v.core) parts.push(`<span>核心 ${bar(v.core.hp / v.core.max, '#4fd1ff')}</span>`);
    if (v.npc) parts.push(`<span>友軍 ${bar(v.npc.hp / v.npc.max, '#4fd1ff')}${v.npc.esc ? '' : '・需護送或清除附近怪物'}</span>`);
    if (v.gens) parts.push(`<span>⚡ ${v.gens.filter(g => g[1]).length}/4</span>`);
    if (v.bunkers !== null && v.bunkers !== undefined) parts.push(`<span>🏯 剩 ${v.bunkers}</span>`);
    if (v.laps !== null && v.laps !== undefined) parts.push(`<span>🚂 ${v.laps}/4 圈</span>`);
    if (pv.objective === 'core') {
      const left = Math.max(0, Math.ceil(pv.holdSeconds - r.playTick() / r.meta.tickRate + 3));
      parts.push(`<span>⏳ ${left}s</span>`);
    }
    // Boss 大血條
    const bb = api.$('#bossBar');
    if (v.boss) {
      bb.classList.add('show');
      bb.querySelector('.bb-name').textContent = `${icon(v.boss.k)} ${name(v.boss.k)}・第 ${v.boss.ph} 階段${v.boss.vul === 0 ? '・無敵' : v.boss.vul > 1 ? '・核心開放' : v.boss.vul < 1 ? '・裝甲' : ''}`;
      bb.querySelector('i').style.width = `${Math.max(0, v.boss.hp / v.boss.max * 100)}%`;
      bb.classList.toggle('open', v.boss.vul > 1);
    } else bb.classList.remove('show');
    lastState = v;
    return parts.join('');
  }
  function bar(f, color) { return `<i class="bar"><i style="width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%;background:${color}"></i></i>`; }

  // 強化卡與商店（每個畫面更新）
  let draftKey = '';
  function frame() {
    const r = api.renderer, el = api.$('#draft');
    const d = r.draft, v = r.pveState;
    if (!d || !v || v.ph !== 'draft') { if (el.classList.contains('show')) el.classList.remove('show'); draftKey = ''; return; }
    const key = d.cards.join(',') + (d.picked ? '!' : '') + '|' + v.parts;
    el.classList.add('show');
    el.querySelector('.dr-time').textContent = `${Math.ceil(d.left / 30)} 秒`;
    if (key === draftKey) return;
    draftKey = key;
    const cards = d.cards.map((k, i) => {
      const c = data && data.cards.find(x => x.key === k);
      if (!c) return '';
      return `<button class="card r${c.rarity}" data-pick="${i}" ${d.picked ? 'disabled' : ''}><span class="ci">${c.icon}</span><b>${api.esc(c.name)}</b><small>${api.esc(c.desc)}</small><em>${['', '普通', '稀有', '傳說'][c.rarity]}${c.cls ? '・職業' : ''}</em></button>`;
    }).join('');
    el.querySelector('.dr-cards').innerHTML = d.picked ? '<div class="dr-done">✓ 已選擇，等待其他人</div>' : cards;
    el.querySelector('.dr-shop').innerHTML = Object.entries(data ? data.shop : {}).map(([k, s]) =>
      `<button class="btn small" data-shop="${k}" ${v.parts < s.cost ? 'disabled' : ''}>${s.icon} ${api.esc(s.name)} <b>⚙️${s.cost}</b></button>`).join('');
    el.querySelector('.dr-parts').textContent = `⚙️ ${v.parts}`;
  }

  // ---------- 結算 ----------
  function resultHtml(r, meId) {
    const s = r.pve;
    if (!s || !data) return '';
    const myTanks = r.tanks.filter(t => t.owner === meId);
    const humans = new Set(r.tanks.filter(t => !t.isBot).map(t => t.owner)).size;
    const classes = r.tanks.filter(t => !t.isBot).map(t => t.cls);
    const legend = myTanks.reduce((a, t) => a + ((s.cards[t.id] || []).filter(k => (data.cards.find(c => c.key === k) || {}).rarity === 3).length), 0);
    // 星級
    let stars = 0;
    if (s.mode !== 'endless' && s.cleared) stars = 1 + (s.humanDeaths === 0 ? 1 : 0) + (s.par && s.seconds <= s.par ? 1 : 0);
    const p = progress();
    const newAch = [];
    if (!r._pveSaved) {
      r._pveSaved = true;
      if (s.mode === 'campaign' && stars) { p.stars[s.level] = p.stars[s.level] || {}; p.stars[s.level][s.difficulty] = Math.max(p.stars[s.level][s.difficulty] || 0, stars); }
      if (s.mode === 'endless') p.endless = Math.max(p.endless || 0, s.wave);
      for (const [k, n, , check] of ACH) if (!p.ach[k] && check(s, { humans, classes, legend })) { p.ach[k] = Date.now(); newAch.push(n); }
      saveProgress(p);
      r._newAch = newAch;
    }
    const cardIcons = myTanks.map(t => (s.cards[t.id] || []).map(k => { const c = data.cards.find(x => x.key === k); return c ? `<span class="ccard r${c.rarity}" title="${api.esc(c.name)}">${c.icon}</span>` : ''; }).join('')).join('');
    const mmss = x => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`;
    return `<div class="pve-result ${s.cleared ? 'win' : ''}">
      <div class="pr-title">${s.mode === 'endless' ? `無盡模式・第 ${s.wave} 波` : `${s.level} ${api.esc(s.levelName)}`}・${api.esc(data.difficulty[s.difficulty].name)}</div>
      ${s.mode !== 'endless' ? `<div class="pr-stars">${'★'.repeat(stars)}<span>${'☆'.repeat(3 - stars)}</span></div>
        <div class="pr-rules"><span class="${s.cleared ? 'ok' : ''}">★ 通關</span><span class="${s.cleared && s.humanDeaths === 0 ? 'ok' : ''}">★ 無人陣亡</span><span class="${s.cleared && s.seconds <= s.par ? 'ok' : ''}">★ ${mmss(s.par)} 內</span></div>` : `<div class="pr-stars">🏆 個人最佳：第 ${p.endless} 波</div>`}
      <div class="pr-stats"><span>時間 <b>${mmss(s.seconds)}</b></span><span>擊殺 <b>${s.kills}</b></span><span>零件 <b>${s.parts}</b></span></div>
      ${cardIcons ? `<div class="pr-cards">我的強化：${cardIcons}</div>` : ''}
      ${(r._newAch || []).length ? `<div class="pr-ach">🏅 新成就：${r._newAch.map(n => `<b>${api.esc(n)}</b>`).join('、')}</div>` : ''}
    </div>`;
  }

  // ---------- 圖鑑・紀錄 ----------
  async function openHub(tab = 'codex') {
    api.show('pveHub');
    if (!data) await load();
    renderHub(tab);
  }
  async function renderHub(tab) {
    const el = api.$('#pveHubBody');
    api.$$('#pveHub [data-hub]').forEach(b => b.classList.toggle('sel', b.dataset.hub === tab));
    const p = progress();
    if (tab === 'codex') {
      const all = [...Object.entries(data.monsters).filter(([, v]) => !v.part && !v.structure), ...Object.entries(data.bosses)];
      el.innerHTML = `<div class="codex">${all.map(([k, v]) => {
        const seen = p.seen[k];
        return `<div class="cx ${seen ? '' : 'locked'} ${data.bosses[k] ? 'boss' : ''}"><canvas width="96" height="96" data-kind="${k}"></canvas>
          <div><b>${seen ? `${v.icon} ${api.esc(v.name)}` : '？？？'}</b>${data.bosses[k] ? '<em>BOSS</em>' : ''}
          <p>${seen ? api.esc(v.desc) : '尚未遭遇'}</p>${seen ? `<p class="cx-counter">對策：${api.esc(v.counter)}</p>` : ''}</div></div>`;
      }).join('')}</div>
      <h4>精英詞綴</h4><div class="affixes">${Object.values(data.affixes).map(a => `<span style="border-color:${a.color}"><b style="color:${a.color}">${api.esc(a.name)}</b> ${api.esc(a.desc)}</span>`).join('')}</div>`;
      el.querySelectorAll('canvas[data-kind]').forEach(c => { if (p.seen[c.dataset.kind]) window.PveDraw.icon(c, c.dataset.kind); else c.classList.add('silhouette'); });
    } else if (tab === 'ach') {
      const n = ACH.filter(([k]) => p.ach[k]).length;
      el.innerHTML = `<div class="muted small-text">已達成 ${n} / ${ACH.length}</div><ul class="achs">${ACH.map(([k, name, desc]) =>
        `<li class="${p.ach[k] ? 'done' : ''}"><span>${p.ach[k] ? '🏅' : '🔒'}</span><div><b>${api.esc(name)}</b><small>${api.esc(desc)}</small></div></li>`).join('')}</ul>
        <h4>塗裝</h4><div class="skins">${Object.entries(SKINS).map(([k, v]) => `<span class="${skinUnlocked(k, p) ? 'done' : ''}">${skinUnlocked(k, p) ? '🎨' : '🔒'} ${api.esc(v.name)}${v.req ? `<small>${api.esc(v.req)}</small>` : ''}</span>`).join('')}</div>`;
    } else if (tab === 'progress') {
      el.innerHTML = `<table class="prog"><tr><th>關卡</th>${Object.values(data.difficulty).map(d => `<th class="num">${d.name}</th>`).join('')}</tr>${Object.entries(data.levels).map(([k, v]) =>
        `<tr><td>${k} ${api.esc(v.name)}</td>${Object.keys(data.difficulty).map(d => { const s = (p.stars[k] || {})[d] || 0; return `<td class="num stars">${'★'.repeat(s)}<span>${'☆'.repeat(3 - s)}</span></td>`; }).join('')}</tr>`).join('')}</table>
        <p class="muted small-text">無盡模式個人最佳：第 ${p.endless} 波</p>`;
    } else if (tab === 'board') {
      el.innerHTML = '<p class="muted">讀取中…</p>';
      try {
        const [e, w] = await Promise.all(['endless', 'weekly'].map(b => fetch('/api/pve/board?board=' + b).then(r => r.json())));
        const rows = (list, fmt) => list.entries.length ? `<table><tr><th>#</th><th>隊伍</th><th class="num">${fmt === 'wave' ? '波數' : '時間'}</th></tr>${list.entries.map(x =>
          `<tr><td>${x.rank}</td><td>${api.esc(x.team)}</td><td class="num">${fmt === 'wave' ? x.score : `${Math.floor(x.score / 60)}:${String(x.score % 60).padStart(2, '0')}`}</td></tr>`).join('')}</table>` : '<p class="muted small-text">本週尚無紀錄</p>';
        el.innerHTML = `<h4>無盡模式（${e.week}）</h4>${rows(e, 'wave')}
          <h4>每週挑戰：${w.weekly.level} ${api.esc(data.levels[w.weekly.level].name)}・${w.weekly.mods.map(m => api.esc(data.weeklyMods[m].name)).join('＋')}</h4>${rows(w, 'time')}
          <p class="muted small-text">多人房間的成績才會上榜；每週一重置。</p>`;
      } catch { el.innerHTML = '<p class="muted">讀取失敗</p>'; }
    }
  }

  async function load() {
    try { data = await fetch('/pve.json').then(r => r.json()); } catch { data = null; }
    return data;
  }

  function init(a) {
    api = a;
    load().then(() => { if (api.onData) api.onData(); });
    // 強化卡與商店
    api.$('#draft').addEventListener('click', e => {
      const c = e.target.closest('[data-pick]');
      if (c) { api.send({ t: 'pick', i: +c.dataset.pick }); api.buzz(20); window.Sfx.play('pickup'); return; }
      const s = e.target.closest('[data-shop]');
      if (s) { api.send({ t: 'shop', item: s.dataset.shop }); api.buzz(15); }
    });
    api.$('#pveHub').addEventListener('click', e => {
      const b = e.target.closest('[data-hub]');
      if (b) renderHub(b.dataset.hub);
    });
  }

  window.PveUI = { init, lobbyRows, skinRow, chooseSkin, onRoundStart, onObjEvent, hud, frame, resultHtml, openHub, progress, data: () => data, SKINS };
})();
