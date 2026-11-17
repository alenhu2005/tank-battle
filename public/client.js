'use strict';

(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ---------- 個人設定（存在這支手機） ----------
  const PREF_DEFAULTS = { stickSize: 1, fireSize: 1, opacity: 1, lefty: false, aimLine: true, sound: true, volume: 0.7, vibrate: true, botDebug: true };
  const prefs = Object.assign({}, PREF_DEFAULTS, store.get('prefs', {}));
  function buzz(p) { if (prefs.vibrate && navigator.vibrate) navigator.vibrate(p); }
  function applyPrefs() {
    const root = document.documentElement.style;
    root.setProperty('--stick-scale', prefs.stickSize);
    root.setProperty('--fire-scale', prefs.fireSize);
    root.setProperty('--ctrl-opacity', prefs.opacity);
    document.body.classList.toggle('lefty', !!prefs.lefty);
    if (window.Sfx) { window.Sfx.setEnabled(prefs.sound); window.Sfx.setVolume(prefs.volume); }
    if (window.__tankRenderer) { window.__tankRenderer.showAim = prefs.aimLine; window.__tankRenderer.showBotDebug = prefs.botDebug; }
    document.querySelectorAll('[data-pref]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('sel', Number(b.dataset.v) === prefs[seg.dataset.pref])));
    document.querySelectorAll('[data-pref-toggle]').forEach(b => b.classList.toggle('on', !!prefs[b.dataset.prefToggle]));
    const op = document.getElementById('prefOpacity'), vol = document.getElementById('prefVolume');
    if (op) op.value = prefs.opacity;
    if (vol) vol.value = prefs.volume;
  }
  function savePrefs() { store.set('prefs', prefs); applyPrefs(); }

  // ---------- 手機：鎖定縮放、禁止選取與長按選單 ----------
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(e => document.addEventListener(e, ev => ev.preventDefault(), { passive: false }));
  document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('input, textarea, .selectable')) e.preventDefault();
  });
  document.addEventListener('selectstart', e => {
    if (!e.target.closest || !e.target.closest('input, textarea, .selectable')) e.preventDefault();
  });
  let lastTouchEnd = 0;
  document.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTouchEnd < 300 && !e.target.closest('input, textarea')) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  // ---------- 狀態 ----------
  let ws = null;
  let me = null;          // { id, token, code }
  let info = null;        // classes, colors...
  let room = null;
  let lastResult = null;
  let roundMeta = null;
  let reconnectTimer = null, reconnectDelay = 500;
  let intentionalClose = false;
  const renderer = new window.Renderer($('#canvas'));
  window.__tankRenderer = renderer;   // 除錯／自動測試用
  applyPrefs();
  document.querySelectorAll('.open-prefs').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); $('#prefs').classList.add('show'); }));
  $('#prefsClose').onclick = () => $('#prefs').classList.remove('show');
  document.querySelectorAll('[data-pref] button').forEach(b => b.onclick = () => { prefs[b.parentElement.dataset.pref] = Number(b.dataset.v); savePrefs(); });
  document.querySelectorAll('[data-pref-toggle]').forEach(b => b.onclick = () => { const k = b.dataset.prefToggle; prefs[k] = !prefs[k]; savePrefs(); if (k === 'sound' && prefs.sound) window.Sfx.play('beep'); });
  $('#prefOpacity').oninput = (e) => { prefs.opacity = Number(e.target.value); savePrefs(); };
  $('#prefVolume').oninput = (e) => { prefs.volume = Number(e.target.value); savePrefs(); };
  $('#prefVolume').onchange = () => window.Sfx.play('pickup');

  // 遊戲音效：依和自己坦克的距離決定音量
  renderer.onEvent = (type, x, y) => {
    const me = renderer.pred ? [renderer.pred.x, renderer.pred.y] : null;
    window.Sfx.playAt(type, x, y, me);
    if (type === 'brick') tutAdvance(3);
  };
  let specText = '';
  let defaultBot = '';

  // ---------- 小工具 ----------
  function show(id) {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    if (id === 'game') requestAnimationFrame(layoutGame);
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove(); return ok;
    }
  }
  const isHost = () => room && me && room.hostId === me.id;
  const myPlayer = () => room && room.players.find(p => p.id === me.id);

  fetch('/spec.txt').then(r => r.text()).then(t => { specText = t; }).catch(() => {});
  fetch('/default-bot.js').then(r => r.text()).then(t => { defaultBot = t; }).catch(() => {});
  let samples = [];
  fetch('/samples.json').then(r => r.json()).then(list => {
    samples = list;
    $('#sampleList').innerHTML = list.map(s => `<li><b>${esc(s.name)}</b><span>${esc(s.desc)}</span>
      <div class="row"><button class="btn small primary" data-use-sample="${s.key}">使用這個</button>
      <button class="btn small" data-copy-sample="${s.key}">當作範本複製給 AI</button></div></li>`).join('');
  }).catch(() => {});

  // ---------- 連線 ----------
  function connect(firstMsg) {
    clearTimeout(reconnectTimer);
    intentionalClose = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      reconnectDelay = 500;
      $('#connBanner').classList.remove('show');
      if (firstMsg) send(firstMsg);
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      if (intentionalClose) return;
      const saved = store.get('session', null);
      if (!saved) return;
      $('#connBanner').classList.add('show');
      reconnectTimer = setTimeout(() => connect({ t: 'resume', ...saved }), reconnectDelay);
      reconnectDelay = Math.min(5000, reconnectDelay * 1.6);
    };
  }

  function leaveRoom() {
    send({ t: 'leave' });
    store.del('session');
    intentionalClose = true;
    if (ws) ws.close();
    room = null; me = null; lastResult = null; roundMeta = null;
    document.body.classList.remove('is-host');
    show('home');
  }

  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        me = { id: m.id, token: m.token, code: m.code };
        info = { classes: m.classes, botClass: m.botClass, colors: m.colors, factionColors: m.factionColors, teamCount: m.teamCount, itemTypes: m.itemTypes || [] };
        store.set('session', { code: m.code, id: m.id, token: m.token, at: Date.now() });
        history.replaceState(null, '', '?room=' + m.code);
        break;
      case 'resumeFailed':
        store.del('session');
        $('#connBanner').classList.remove('show');
        intentionalClose = true; ws.close();
        show('home');
        toast(m.roomExists ? '你太久沒回來，已經被移出房間了' : '房間已經不存在了');
        break;
      case 'error':
        toast(m.msg);
        intentionalClose = true; ws.close();
        break;
      case 'toast': toast(m.msg); break;
      case 'kicked':
        store.del('session'); intentionalClose = true; ws.close();
        room = null; show('home'); toast('你已離開房間');
        break;
      case 'room': onRoom(m); break;
      case 'myCode':
        if (m.code) store.set('botCode', m.code);
        break;
      case 'roundStart': onRoundStart(m); break;
      case 's':
        renderer.applySnapshot(m, performance.now());
        reconcile();
        hudDirty = true;
        break;
      case 'roundEnd': onRoundEnd(m); break;
      case 'dbg': {
        const d = renderer.debugOps && performance.now() - renderer.debugOps.at < 400 ? renderer.debugOps : { byTank: {} };
        d.byTank[m.id] = m.ops; d.at = performance.now();
        renderer.debugOps = d;
        break;
      }
      case 'codeChecking':
        $('#codeStatus').innerHTML = '<span class="muted">測試中…（放進測試對戰實際跑一遍）</span>';
        $('#checkBtn').disabled = true;
        break;
      case 'codeResult': onCodeResult(m); break;
    }
  }

  // ---------- 首頁 ----------
  $('#nameInput').value = store.get('name', '');
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) $('#codeInput').value = urlRoom;

  function getName() {
    const n = $('#nameInput').value.trim();
    if (!n) { toast('先輸入暱稱'); $('#nameInput').focus(); return null; }
    store.set('name', n);
    return n;
  }
  $('#createBtn').onclick = () => { const name = getName(); if (name) connect({ t: 'create', name }); };
  const quickName = () => { const n = $('#nameInput').value.trim() || '新手'; store.set('name', n); return n; };
  $('#tutorialBtn').onclick = () => connect({ t: 'create', name: quickName(), kind: 'tutorial' });
  $('#practiceBtn').onclick = () => connect({ t: 'create', name: quickName(), kind: 'practice' });
  $('#joinBtn').onclick = () => {
    const name = getName(); if (!name) return;
    const code = $('#codeInput').value.trim();
    if (!/^\d{4}$/.test(code)) return toast('房號是 4 位數字');
    connect({ t: 'join', code, name });
  };
  $('#codeInput').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
  $('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });

  // 自動回到原本的房間（重新整理或切換 App 後）
  const saved = store.get('session', null);
  if (saved && Date.now() - saved.at < 6 * 3600 * 1000 && (!urlRoom || urlRoom === saved.code)) connect({ t: 'resume', ...saved });

  // ---------- 大廳 ----------
  const MODE_NAMES = { ffa: '大亂鬥', faction: '陣營戰', team: '組隊' };
  const TIME_OPTS = [[120, '2 分'], [180, '3 分'], [300, '5 分'], [480, '8 分'], [0, '不限']];

  function playerColor(p, idx) {
    if (!info) return '#888';
    const mode = room.settings.mode;
    if (mode === 'faction') return info.factionColors[p.faction];
    if (mode === 'team') return info.colors[(p.team - 1) % info.colors.length];
    return info.colors[idx % info.colors.length];
  }

  function onRoom(m) {
    room = m;
    document.body.classList.toggle('is-host', isHost());
    document.body.classList.toggle('room-practice', m.kind === 'practice');
    $('#speedBtn').textContent = (m.speed || 1) + '×';
    $('#roomCode').textContent = m.code;
    renderLobby();
    renderResultButtons();
    if ($('#editor').classList.contains('show')) renderCodeNow();
    if ($('#replayScreen').classList.contains('active')) return;   // 正在看重播：不要跳走
    if (m.state === 'lobby') {
      if (!$('#lobby').classList.contains('active')) show('lobby');
    } else if (m.state === 'intermission' || m.state === 'finished') {
      if (lastResult) { renderResult(); if (!$('#result').classList.contains('active')) show('result'); }
      else show('lobby');
    } else if (m.state === 'playing') {
      if (!$('#game').classList.contains('active') && !roundMeta) show('lobby');
    }
  }

  let itemGuideOpen = false;
  document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('item-guide')) itemGuideOpen = e.target.open; }, true);

  function renderLobby() {
    const s = room.settings;
    const host = isHost();
    $('#playerCount').textContent = `${room.players.length} / ${room.maxPlayers}`;
    $('#addAIBtn').disabled = room.players.length >= room.maxPlayers;
    $('#hostHint').textContent = host ? '你是房主' : '由房主設定';

    // 玩家列表
    $('#playerList').innerHTML = room.players.map((p, i) => {
      const mine = p.id === me.id;
      const canEdit = mine || host;
      let groupChip = '';
      if (s.mode === 'faction') groupChip = `<button class="icon-btn" data-act="faction" data-id="${p.id}" ${canEdit ? '' : 'disabled'} style="background:${info.factionColors[p.faction]};color:#000">${p.faction === 'red' ? '紅' : '藍'}</button>`;
      if (s.mode === 'team') groupChip = `<button class="icon-btn" data-act="team" data-id="${p.id}" ${canEdit ? '' : 'disabled'} style="background:${playerColor(p, i)};color:#000">${p.team}隊</button>`;
      const cls = !s.codeOnly && info.classes[p.cls] ? `<span class="tag" ${p.isAI && host ? `data-act="aicls" data-id="${p.id}"` : ''}>${info.classes[p.cls].name}</span>` : '';
      const tags = [
        p.id === room.hostId ? '<span class="tag host">房主</span>' : '',
        p.isAI ? '<span class="tag">電腦隊伍</span>' : (p.customCode ? '<span class="tag ok">自訂代碼</span>' : '<span class="tag">範例代碼</span>'),
        !p.connected ? '<span class="tag off">斷線</span>' : '',
        p.ready && !p.isAI ? '<span class="tag ok">已準備</span>' : '',
      ].join('');
      const kick = host && !mine ? `<button class="icon-btn" data-act="kick" data-id="${p.id}" aria-label="移除">✕</button>` : '';
      return `<li><span class="dot" style="background:${playerColor(p, i)}"></span>
        <span class="pname">${esc(p.name)}${mine ? '（你）' : ''}</span>${cls}${tags}${groupChip}${kick}</li>`;
    }).join('');

    // 設定
    const dis = host && room.state === 'lobby' ? '' : 'disabled';
    const seg = (key, opts, val) => `<div class="seg" ${dis ? 'style="opacity:.6;pointer-events:none"' : ''}>${opts.map(([v, label]) => `<button data-set="${key}" data-val="${v}" class="${v === val ? 'sel' : ''}">${label}</button>`).join('')}</div>`;
    const sw = (key, val) => `<button class="switch ${val ? 'on' : ''}" data-set="${key}" data-val="${!val}" ${dis} aria-label="${key}"></button>`;
    $('#settings').innerHTML = `
      <div class="set-row"><span>模式</span>${seg('mode', [['ffa', '大亂鬥'], ['faction', '陣營戰'], ['team', '組隊']], s.mode)}</div>
      <div class="set-desc">${{ ffa: '每位玩家和自己的電腦一隊，打到剩最後一隊', faction: '紅藍兩軍，在玩家列表點顏色換邊', team: '在玩家列表點「N隊」換隊，同號就是隊友' }[s.mode]}</div>
      <div class="set-row"><span>目標</span>${seg('objective', [['survival', '生存'], ['koth', '佔點'], ['ctf', '搶旗'], ['pve', '打怪']], s.objective || 'survival')}</div>
      <div class="set-desc">${{ survival: '打到剩最後一隊', koth: '佔住中央區域累積 45 秒的隊伍獲勝（可以無限重生）', ctf: '把敵方旗子帶回自家旗子旁 3 次獲勝（可以無限重生，沒有基地）', pve: '所有人同一隊，撐過 5 波怪物（不分隊伍）' }[s.objective || 'survival']}</div>
      <div class="set-row"><span>純代碼對戰</span>${sw('codeOnly', s.codeOnly)}</div>
      <div class="set-desc">玩家不下場，每人只派一台電腦坦克，大家一起看</div>
      <div class="set-row"><span>基地模式</span>${sw('baseMode', s.baseMode)}</div>
      <div class="set-desc">每隊有一座基地，被敵人打爆就整隊出局</div>
      <div class="set-row"><span>迷霧</span>${sw('fog', s.fog)}</div>
      <div class="set-desc">玩家只看得到自己周圍；電腦不受影響</div>
      <div class="set-row"><span>牆壁打不破</span>${sw('hardWalls', s.hardWalls)}</div>
      <div class="set-row"><span>場地道具</span>${sw('items', s.items)}</div>
      <details class="item-guide ${host ? 'host' : ''}" ${itemGuideOpen ? 'open' : ''}><summary>每 10 秒刷新一個道具，開放 ${info.itemTypes.length - (s.disabledItems || []).length} / ${info.itemTypes.length} 種（點開看說明${host ? '，點道具可以關掉' : ''}）</summary>
        <ul>${info.itemTypes.map(t => `<li data-item="${t.key}" class="${(s.disabledItems || []).includes(t.key) ? 'off' : ''}"><span class="ic">${t.icon}</span><div><b>${esc(t.name)}</b>${esc(t.desc)}</div></li>`).join('')}</ul></details>
      <div class="set-row"><span>子彈反彈</span>${sw('ricochet', s.ricochet)}</div>
      <div class="set-desc">子彈撞到鋼牆和邊界會反彈，最多 2 次</div>
      <div class="set-row"><span>地圖</span><div style="display:flex;gap:6px;align-items:center">
        ${s.mapStyle === 'custom' && host ? '<button class="btn small" id="editMapBtn">✏️ 編輯</button>' : ''}
        <select id="mapStyleSel" ${dis}>${[['random', '隨機'], ['maze', '迷宮'], ['open', '開闊'], ['river', '河流'], ['forest', '森林'], ['fortress', '堡壘'], ['custom', '自訂']].map(([v, l]) => `<option value="${v}" ${s.mapStyle === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="set-row"><span>局數</span><div class="stepper">
        <button data-set="rounds" data-val="${s.rounds - 1}" ${dis}>−</button><b>${s.rounds}</b><button data-set="rounds" data-val="${s.rounds + 1}" ${dis}>＋</button></div></div>
      <div class="set-row"><span>每局時間</span>${seg('timeLimit', TIME_OPTS, s.timeLimit)}</div>`;

    // 我的代碼
    const mc = room.myCode;
    $('#codeBadge').textContent = mc.custom ? '自訂' : '範例';
    $('#codeBadge').className = 'badge' + (mc.custom ? ' ok' : '');
    const mp = myPlayer();
    $('#readyBtn').textContent = mp && mp.ready ? '已準備 ✓' : '準備';
    $('#readyBtn').classList.toggle('on', !!(mp && mp.ready));
    $('#startBtn').disabled = !!room.startError;
    $('#startError').textContent = host ? (room.startError || '') : (room.state === 'lobby' ? '等待房主開始…' : '');

    renderClassPicker('#classPicker');
    renderClassPicker('#classPicker2');
  }

  // 職業選擇
  function renderClassPicker(sel) {
    const el = $(sel); if (!el || !info) return;
    const mp = myPlayer();
    if (room.settings.codeOnly) { el.innerHTML = '<p class="muted small-text">純代碼對戰不需要選職業。</p>'; return; }
    const all = Object.values(info.classes);
    const max = k => Math.max(...all.map(c => k(c)));
    const bars = (c) => {
      const stats = [
        ['移速', c.speed / max(x => x.speed)],
        ['射速', (1 / c.cooldown) / max(x => 1 / x.cooldown)],
        ['彈速', c.bulletSpeed / max(x => x.bulletSpeed)],
        ['耐久', c.hp / max(x => x.hp)],
      ];
      return stats.map(([n, v]) => `<div class="bar"><span>${n}</span><i style="--v:${Math.round(v * 100)}%"></i></div>`).join('');
    };
    el.innerHTML = Object.entries(info.classes).map(([k, c]) =>
      `<button class="cls-card ${mp && mp.cls === k ? 'sel' : ''}" data-cls="${k}">
        <b>${c.name}</b>${bars(c)}<small>${c.desc}</small></button>`).join('');
  }
  document.addEventListener('click', e => {
    const card = e.target.closest('.cls-card');
    if (card && room && room.state !== 'playing') send({ t: 'cls', cls: card.dataset.cls });
  });

  $('#playerList').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.dataset.id, p = room.players.find(x => x.id === id);
    if (!p) return;
    const target = id === me.id ? undefined : id;
    if (b.dataset.act === 'kick') send({ t: 'kick', id });
    if (b.dataset.act === 'faction') send({ t: 'faction', id: target, faction: p.faction === 'red' ? 'blue' : 'red' });
    if (b.dataset.act === 'team') send({ t: 'team', id: target, team: (p.team % info.teamCount) + 1 });
    if (b.dataset.act === 'aicls') {
      const keys = Object.keys(info.classes);
      send({ t: 'cls', id, cls: keys[(keys.indexOf(p.cls) + 1) % keys.length] });
    }
  });
  $('#settings').addEventListener('change', e => {
    if (e.target.id !== 'mapStyleSel' || !isHost()) return;
    const v = e.target.value;
    if (v === 'custom') return openMapEditor();
    send({ t: 'settings', mapStyle: v });
  });
  $('#settings').addEventListener('click', e => {
    if (e.target.closest('#editMapBtn')) return openMapEditor();
    const li = e.target.closest('.item-guide li[data-item]');
    if (li && isHost() && room.state === 'lobby') {
      const off = new Set(room.settings.disabledItems || []);
      if (off.has(li.dataset.item)) off.delete(li.dataset.item); else off.add(li.dataset.item);
      if (off.size >= info.itemTypes.length) return toast('至少要留一種道具（或直接關掉場地道具）');
      return send({ t: 'settings', disabledItems: [...off] });
    }
    const b = e.target.closest('[data-set]'); if (!b || !isHost()) return;
    const key = b.dataset.set; let val = b.dataset.val;
    if (val === 'true' || val === 'false') val = val === 'true';
    else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    send({ t: 'settings', [key]: val });
  });
  $('#addAIBtn').onclick = () => send({ t: 'addAI' });
  $('#leaveBtn').onclick = () => { if (confirm('確定要離開房間？')) leaveRoom(); };
  $('#shareBtn').onclick = async () => {
    const url = `${location.origin}/?room=${room.code}`;
    if (navigator.share) { try { await navigator.share({ title: '坦克對戰', text: `來玩坦克對戰！房號 ${room.code}`, url }); return; } catch { /* 取消 */ } }
    toast((await copyText(url)) ? '已複製邀請連結' : url);
  };
  const toggleReady = () => { const mp = myPlayer(); send({ t: 'ready', ready: !(mp && mp.ready) }); };
  $('#readyBtn').onclick = toggleReady;
  $('#readyBtn2').onclick = toggleReady;
  $('#startBtn').onclick = () => { send({ t: 'start' }); tryFullscreen(); };
  $('#nextBtn').onclick = () => { send({ t: 'start' }); tryFullscreen(); };
  $('#endMatchBtn').onclick = () => { if (confirm('提前結束整場比賽？')) send({ t: 'endMatch' }); };
  $('#toLobbyBtn').onclick = () => send({ t: 'toLobby' });

  // ---------- 地圖編輯器 ----------
  const MAP_COLORS = { '.': '#1b1f26', '#': '#a9552c', '@': '#9aa5af', '~': '#2a63b0', '*': '#3f9a44' };
  const ed = { size: 21, tiles: [], brush: '.', painting: false };
  function openMapEditor() {
    const saved = (room && room.settings.customMap) || store.get('customMap', null);
    if (saved) { ed.size = saved.size; ed.tiles = saved.tiles.split(''); }
    else { ed.size = 21; ed.tiles = Array(21 * 21).fill('.'); }
    $('#mapSize').value = String(ed.size);
    $('#mapEditor').classList.add('show');
    requestAnimationFrame(drawEditor);
  }
  function drawEditor() {
    const cv = $('#mapCanvas'), wrap = cv.parentElement;
    const px = Math.max(140, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth)));
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = cv.style.height = px + 'px';
    cv.width = cv.height = Math.round(px * dpr);
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = px / ed.size;
    for (let i = 0; i < ed.tiles.length; i++) {
      c.fillStyle = MAP_COLORS[ed.tiles[i]] || '#000';
      c.fillRect((i % ed.size) * t, Math.floor(i / ed.size) * t, t - 0.5, t - 0.5);
    }
    // 出生區大概位置（上下中央與四個角）
    c.strokeStyle = 'rgba(242,201,76,.55)'; c.setLineDash([3, 3]);
    const m = ed.size - 1, z = [[m / 2, 3], [m / 2, m - 3], [3, 3], [m - 3, 3], [3, m - 3], [m - 3, m - 3]];
    for (const [x, y] of z) c.strokeRect((x - 3) * t, (y - 3) * t, 7 * t, 7 * t);
    c.setLineDash([]);
  }
  function paintAt(e) {
    const cv = $('#mapCanvas'), r = cv.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * ed.size), y = Math.floor((e.clientY - r.top) / r.height * ed.size);
    if (x < 0 || y < 0 || x >= ed.size || y >= ed.size) return;
    const m = ed.size - 1, sym = $('#mapSym').value;
    const pts = [[x, y]];
    if (sym === 'h' || sym === '4') pts.push([m - x, y]);
    if (sym === 'v' || sym === '4') pts.push([x, m - y]);
    if (sym === '4') pts.push([m - x, m - y]);
    for (const [px, py] of pts) ed.tiles[py * ed.size + px] = ed.brush;
    drawEditor();
  }
  $('#mapCanvas').addEventListener('pointerdown', e => { e.preventDefault(); ed.painting = true; $('#mapCanvas').setPointerCapture(e.pointerId); paintAt(e); });
  $('#mapCanvas').addEventListener('pointermove', e => { if (ed.painting) paintAt(e); });
  $('#mapCanvas').addEventListener('pointerup', () => { ed.painting = false; });
  $('#mapPalette').addEventListener('click', e => {
    const b = e.target.closest('[data-tile]'); if (!b) return;
    ed.brush = b.dataset.tile;
    $$('#mapPalette button').forEach(x => x.classList.toggle('sel', x === b));
  });
  $('#mapSize').onchange = () => { ed.size = Number($('#mapSize').value); ed.tiles = Array(ed.size * ed.size).fill('.'); drawEditor(); };
  $('#mapClear').onclick = () => { ed.tiles.fill('.'); drawEditor(); };
  $('#mapRandom').onclick = () => {
    ed.tiles = ed.tiles.map(() => { const r = Math.random(); return r < 0.12 ? '#' : r < 0.16 ? '@' : r < 0.19 ? '~' : r < 0.24 ? '*' : '.'; });
    drawEditor();
  };
  $('#mapCancel').onclick = () => { $('#mapEditor').classList.remove('show'); renderLobby(); };
  $('#mapApply').onclick = () => {
    const customMap = { size: ed.size, tiles: ed.tiles.join('') };
    store.set('customMap', customMap);
    send({ t: 'settings', customMap });
    $('#mapEditor').classList.remove('show');
    toast('已使用自訂地圖');
  };
  window.addEventListener('resize', () => { if ($('#mapEditor').classList.contains('show')) drawEditor(); });

  // ---------- 電腦隊友代碼（介面不顯示原始碼） ----------
  function renderCodeNow() {
    const mc = room && room.myCode;
    const el = $('#codeNow');
    if (!mc || !mc.custom) { el.innerHTML = '目前使用：<b>內建 AI</b>（還沒交過自己的代碼）'; return; }
    const at = mc.info && mc.info.at ? new Date(mc.info.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';
    const lines = (store.get('botCode', '') || '').split('\n').length;
    el.innerHTML = `目前使用：<b>你的自訂代碼</b>${lines > 1 ? `（${lines} 行）` : ''}${at ? `・${at} 啟用` : ''}`;
  }
  function openEditor() {
    renderCodeNow();
    $('#editor').classList.add('show');
  }
  $('#codeBtn').onclick = openEditor;
  $('#codeBtn2').onclick = openEditor;
  $('#editorClose').onclick = () => $('#editor').classList.remove('show');

  $('#sampleList').addEventListener('click', async e => {
    const use = e.target.closest('[data-use-sample]');
    const cp = e.target.closest('[data-copy-sample]');
    if (use) {
      const s = samples.find(x => x.key === use.dataset.useSample);
      store.set('pendingCode', s.code);
      $('#codeStatus').innerHTML = `<span class="muted">已選「${esc(s.name)}」，測試中…</span>`;
      send({ t: 'code', sample: s.key });
    }
    if (cp) {
      const s = samples.find(x => x.key === cp.dataset.copySample);
      toast((await copyText(aiPrompt(s))) ? `已複製（以「${s.name}」為範本），貼給 AI 再說你想怎麼改` : '複製失敗');
    }
  });

  function aiPrompt(sample) {
    return `我在玩一款手機坦克對戰遊戲，需要你幫我寫「電腦隊友」的 JavaScript 代碼。
請完全依照下面的規格，寫出完整、可以直接執行的代碼（定義 think(view, memory)，可以加輔助函式）。
只輸出代碼，放在一個 \`\`\`javascript 區塊裡；不要用 import、require、setTimeout。

${specText}
## 參考：${sample ? `「${sample.name}」打法的範例（${sample.desc}）` : '遊戲內建的範例 AI'}（可以改進它，也可以完全重寫）
\`\`\`javascript
${sample ? sample.code : defaultBot}\`\`\`

## 我想要的隊友
`;
  }
  $('#copyPromptBtn').onclick = async () => {
    if (!specText) return toast('還在載入，請稍等一下再按');
    toast((await copyText(aiPrompt())) ? '已複製！貼給你的 AI，再補一句你想要的隊友' : '複製失敗，請再試一次');
  };

  // AI 回覆常常包在 ``` 裡，或前後有說明文字：自動取出代碼區塊
  function extractCode(t) {
    const blocks = [...String(t).matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)].map(m => m[1]);
    if (!blocks.length) return String(t);
    return blocks.find(b => /function\s+think|think\s*=|think\s*\(/.test(b)) || blocks.sort((a, b) => b.length - a.length)[0];
  }
  function submitCode(raw, source) {
    const code = extractCode(raw).trim();
    if (!code) return toast('沒有讀到代碼');
    if (new Blob([code]).size > 100 * 1024) return toast('代碼超過 100KB');
    if (!/think/.test(code)) {
      $('#codeStatus').innerHTML = '<span class="bad">❌ 這看起來不是電腦代碼（找不到 think）</span><div class="muted small-text">請確認複製的是 AI 給的整段代碼。</div>';
      return;
    }
    store.set('pendingCode', code);
    $('#codeStatus').innerHTML = `<span class="muted">已收到${source}，測試中…</span>`;
    send({ t: 'code', code });
  }
  $('#pasteBtn').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t || !t.trim()) return toast('剪貼簿是空的，先去 AI 那邊複製代碼');
      submitCode(t, '剪貼簿的代碼');
    } catch {
      $('#manualBox').classList.remove('hidden');
      toast('瀏覽器不讓讀剪貼簿，請在下方框框長按貼上');
      $('#codeArea').focus();
    }
  };
  $('#fileInput').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 300 * 1024) return toast('檔案太大了');
    const reader = new FileReader();
    reader.onload = () => submitCode(String(reader.result), `檔案「${f.name}」`);
    reader.onerror = () => toast('讀取檔案失敗');
    reader.readAsText(f);
  };
  $('#manualToggle').onclick = () => $('#manualBox').classList.toggle('hidden');
  $('#checkBtn').onclick = () => { submitCode($('#codeArea').value, '代碼'); };
  $('#useDefaultBtn').onclick = () => { if (confirm('改回內建 AI？')) send({ t: 'code', useDefault: true }); };

  function onCodeResult(m) {
    $('#checkBtn').disabled = false;
    const st = $('#codeStatus');
    if (m.usingDefault) { store.del('botCode'); st.innerHTML = '<span class="ok">已改回內建 AI</span>'; renderCodeNow(); return; }
    if (m.ok) {
      store.set('botCode', store.get('pendingCode', ''));
      $('#codeArea').value = '';
      $('#manualBox').classList.add('hidden');
      st.innerHTML = `<span class="ok">✅ 測試通過！下一局就會使用這份代碼</span>
        <div class="muted small-text">測試對戰中跑了 ${m.stats.calls} 次，平均 ${m.stats.avgMs}ms</div>
        ${m.warnings && m.warnings.length ? `<div class="small-text" style="color:var(--accent)">⚠️ ${esc(m.warnings.join(' '))}</div>` : ''}`;
      toast('代碼已啟用');
    } else {
      st.innerHTML = `<span class="bad">❌ 測試沒通過，先繼續用${room && room.myCode.custom ? '上一份能用的代碼' : '內建 AI'}</span>
        <div class="logbox err selectable">${esc(m.errors.join('\n'))}</div>
        <button class="btn small primary" id="copyErrBtn" style="margin-top:6px">📋 複製錯誤，貼回給 AI 修</button>`;
      $('#copyErrBtn').onclick = async () => toast((await copyText('你寫的坦克代碼在遊戲測試時出錯了，請修正後給我完整的新代碼。錯誤訊息：\n' + m.errors.join('\n'))) ? '已複製，貼給 AI 就好' : '複製失敗');
    }
    renderCodeNow();
  }

  // ---------- 遊戲 ----------
  let hudDirty = true;
  let wakeLock = null;
  let lastDeath = null;    // { killer, cause, at }

  const tankName = (id) => {
    const m = renderer.tankMeta && renderer.tankMeta.get(id);
    if (!m) return '？';
    if (m.cls === 'monster') return '怪物';
    return m.isBot ? `${m.name}的電腦` : m.name;
  };
  const tankColor = (id) => {
    const m = renderer.tankMeta && renderer.tankMeta.get(id);
    return m ? renderer.sideMeta.get(m.side).color : '#fff';
  };

  // 擊殺訊息
  renderer.onKill = (victim, killer, cause) => {
    const feed = $('#killFeed');
    const el = document.createElement('div');
    const icon = cause === 'blast' ? '💥' : cause === 'base' ? '🏳️' : '➜';
    const mine = renderer.myTank && (victim === renderer.myTank.id || killer === renderer.myTank.id);
    el.className = mine ? 'mine' : '';
    el.innerHTML = cause === 'base'
      ? `<span style="color:${tankColor(victim)}">${esc(tankName(victim))}</span> 基地被毀`
      : `<span style="color:${tankColor(killer)}">${esc(killer ? tankName(killer) : '？')}</span> ${icon} <span style="color:${tankColor(victim)}">${esc(tankName(victim))}</span>`;
    feed.prepend(el);
    while (feed.children.length > 4) feed.lastChild.remove();
    setTimeout(() => el.classList.add('fade'), 3500);
    setTimeout(() => el.remove(), 4000);
    if (renderer.myTank && killer === renderer.myTank.id && victim !== killer) { window.Sfx.play('kill'); tutAdvance(5); }
    if (renderer.myTank && victim === renderer.myTank.id) {
      lastDeath = { killer, cause, at: performance.now() };
      buzz([60, 40, 60]); window.Sfx.play('die');
      $('#replayCause').textContent = cause === 'blast' ? `被 ${tankName(killer)} 炸到` : `被 ${tankName(killer)} 擊中`;
    }
    hudDirty = true;
  };
  renderer.onBaseKill = (sideKey, shooter) => {
    const side = renderer.sideMeta.get(sideKey);
    const feed = $('#killFeed');
    const el = document.createElement('div');
    const mine = renderer.myTank && renderer.myTank.side === sideKey;
    el.className = mine ? 'mine' : '';
    el.innerHTML = `<span style="color:${tankColor(shooter)}">${esc(shooter ? tankName(shooter) : '？')}</span> 🏳️ 摧毀了 <span style="color:${side.color}">${esc(side.name)}</span> 的基地`;
    feed.prepend(el);
    while (feed.children.length > 4) feed.lastChild.remove();
    setTimeout(() => el.classList.add('fade'), 4500);
    setTimeout(() => el.remove(), 5000);
    if (mine) { lastDeath = { killer: shooter, cause: 'base', at: performance.now() }; buzz([100, 50, 100]); }
    hudDirty = true;
  };
  // 遊戲目標事件：搶旗、得分、新的一波怪物
  let waveTimer = null;
  renderer.onObjEvent = (e) => {
    const [type, a, b] = e;
    const feed = $('#killFeed');
    const el = document.createElement('div');
    if (type === 'wave') {
      const wb = $('#waveBanner'); wb.textContent = `第 ${a} 波：${b} 隻怪物`; wb.classList.add('show');
      clearTimeout(waveTimer); waveTimer = setTimeout(() => wb.classList.remove('show'), 1800);
      window.Sfx.play('emp');
      return;
    }
    const side = renderer.sideMeta.get(b);
    el.innerHTML = type === 'steal'
      ? `<span style="color:${tankColor(a)}">${esc(tankName(a))}</span> 🚩 搶走了 <span style="color:${side.color}">${esc(side.name)}</span> 的旗子`
      : `<span style="color:${tankColor(a)}">${esc(tankName(a))}</span> 🏁 得分！`;
    feed.prepend(el);
    while (feed.children.length > 4) feed.lastChild.remove();
    setTimeout(() => el.remove(), 4500);
    if (type === 'capture') window.Sfx.play('win');
    hudDirty = true;
  };

  // 練習場快轉
  $('#speedBtn').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const next = { 1: 2, 2: 4, 4: 1 }[(room && room.speed) || 1];
    send({ t: 'speed', v: next });
  });

  // ---------- 新手教學 ----------
  const TUT_STEPS = [
    '推動左下的搖桿移動坦克（往任何方向都可以）',
    '把搖桿往斜的方向推：推到哪個角度，坦克就朝那個角度走、朝那個角度射',
    '按住右下的「開火」射擊。虛線是子彈會飛的路線',
    '打掉一塊磚牆（橘色的牆打得破，灰色鋼牆打不破）',
    '地圖上發亮的小方塊是道具，開過去撿一個',
    '擊中那台不會還手的「練習靶」',
  ];
  const tut = { on: false, step: 0, start: null, diagTicks: 0 };
  function tutShow() {
    const el = $('#tutorial');
    el.classList.toggle('hidden', !tut.on);
    if (!tut.on) return;
    const done = tut.step >= TUT_STEPS.length;
    $('#tutStep').textContent = done ? '教學完成' : `第 ${tut.step + 1} / ${TUT_STEPS.length} 步`;
    $('#tutText').textContent = done
      ? '🎉 完成！有條紋的坦克是你的電腦隊友，它的行動由代碼決定。在大廳按「我的電腦代碼」，就能和你的 AI 一起設計它。'
      : TUT_STEPS[tut.step];
    $('#tutDone').classList.toggle('hidden', !done);
    $('#tutSkip').classList.toggle('hidden', done);
  }
  function tutAdvance(step) {
    if (!tut.on || tut.step !== step) return;
    tut.step++;
    window.Sfx.play('pickup');
    buzz(30);
    const el = $('#tutorial'); el.classList.remove('tut-ok'); void el.offsetWidth; el.classList.add('tut-ok');
    tutShow();
  }
  function tutTick() {
    if (!tut.on || !renderer.pred) return;
    if (!tut.start) tut.start = { x: renderer.pred.x, y: renderer.pred.y };
    if (tut.step === 0 && Math.hypot(renderer.pred.x - tut.start.x, renderer.pred.y - tut.start.y) > 1) tutAdvance(0);
    if (tut.step === 1) {
      const off = input.move >= 0 ? Math.abs(((input.move % 90) + 90) % 90 - 45) : 45;   // 離正上下左右多遠
      tut.diagTicks = input.move >= 0 && off < 30 ? tut.diagTicks + 1 : 0;
      if (tut.diagTicks > 3) tutAdvance(1);
    }
    if (tut.step === 2 && input.fire) tutAdvance(2);
  }
  setInterval(tutTick, 100);
  $('#tutSkip').onclick = () => leaveRoom();
  $('#tutDone').onclick = () => leaveRoom();

  // 房主強制結束
  let forceArmed = 0;
  $('#forceEndBtn').addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (Date.now() - forceArmed < 3000) { send({ t: 'forceEnd' }); forceArmed = 0; toast('已強制結束這一局'); return; }
    forceArmed = Date.now();
    toast('再按一次 ⏹ 強制結束這一局（算平手）');
  });

  // 撿到道具：飄字
  let bannerTimer = null;
  renderer.onPickup = (tankId, type) => {
    hudDirty = true;
    if (!renderer.myTank) return;
    const it = info.itemTypes[type];
    const mine = tankId === renderer.myTank.id;
    const myBot = renderer.tankMeta.get(tankId);
    const isMyBot = myBot && myBot.isBot && myBot.owner === renderer.myTank.owner;
    if (!mine && !isMyBot) return;
    if (mine) { buzz(25); window.Sfx.play('pickup'); tutAdvance(4); }
    const el = $('#pickupBanner');
    el.innerHTML = `<div class="ic">${it.icon}</div><div><b>${mine ? '' : '你的電腦撿到 '}${esc(it.name)}</b><span>${esc(it.desc)}</span></div>`;
    el.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), mine ? 2800 : 1800);
  };
  $('#replayBox').addEventListener('pointerdown', (e) => { e.stopPropagation(); renderer.closeReplay(); $('#replayBox').classList.remove('show'); });

  function onRoundStart(m) {
    roundMeta = m;
    lastResult = null;
    lastDeath = null;
    $('#editor').classList.remove('show');
    $('#killFeed').innerHTML = '';
    renderer.setRound(m.meta, m.myTank);
    pending = [];
    Object.assign(tut, { on: room && room.kind === 'tutorial', step: 0, start: null, diagTicks: 0 });
    tutShow();
    document.body.classList.toggle('spectator', !m.myTank);
    $('#game .controls').classList.toggle('hidden', !m.myTank);
    show('game');
    layoutGame();
    resetInput();
    requestWakeLock();
    hudDirty = true;
  }

  function onRoundEnd(m) {
    if (tut.on) { tut.step = TUT_STEPS.length; tutShow(); return; }
    const mySide = renderer.myTank ? renderer.myTank.side : null;
    if (mySide) window.Sfx.play(m.winner === mySide ? 'win' : 'lose');
    lastResult = m;
    roundMeta = null;
    resetInput();
    releaseWakeLock();
    $('#replayBox').classList.remove('show');
    $('#countdown').classList.remove('show');
    setTimeout(() => { renderResult(); show('result'); }, 600);
  }

  function layoutGame() {
    const portrait = window.innerHeight > window.innerWidth;
    const hasCtrl = !!(roundMeta && roundMeta.myTank);
    const ctrlH = portrait && hasCtrl ? Math.min(260, Math.max(190, window.innerHeight * 0.3)) : 0;
    document.documentElement.style.setProperty('--ctrl-h', ctrlH + 'px');
    const hudH = $('.hud').offsetHeight || 40;
    renderer.layout = { top: hudH, ctrlBottom: ctrlH };
    renderer.resize();
  }
  window.addEventListener('resize', () => { if ($('#game').classList.contains('active')) layoutGame(); });
  window.addEventListener('orientationchange', () => setTimeout(layoutGame, 200));

  let shownCount = null, goUntil = 0, lastHudAt = 0;
  function frame(now) {
    if ($('#game').classList.contains('active')) {
      renderer.draw(now);
      // 開局倒數
      const left = renderer.countdownLeft();
      const cd = $('#countdown');
      if (left !== null) {
        const n = Math.ceil(left);
        if (n !== shownCount) {
          shownCount = n;
          cd.textContent = n; cd.className = 'countdown';
          void cd.offsetWidth; cd.classList.add('show');
          if (n <= 3) buzz(15);
          window.Sfx.play('beep');
        }
      } else if (shownCount !== null) {
        shownCount = null; goUntil = now + 700;
        window.Sfx.play('go');
        cd.textContent = '開始！'; cd.className = 'countdown go';
        void cd.offsetWidth; cd.classList.add('show');
      } else if (goUntil && now > goUntil) { goUntil = 0; cd.classList.remove('show'); }
      // 死亡重播（子母畫面）
      const box = $('#replayBox');
      if (renderer.replayActive(now)) { box.classList.add('show'); renderer.drawReplay($('#replayCanvas'), now); }
      else if (box.classList.contains('show')) box.classList.remove('show');
      if (hudDirty || now - lastHudAt > 200) { updateHud(); hudDirty = false; lastHudAt = now; }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function updateHud() {
    const r = renderer;
    if (!r.meta) return;
    $('#hudRound').textContent = roundMeta ? `第 ${roundMeta.roundNo}/${roundMeta.rounds} 局` : '';
    const played = r.playTick();
    if (r.meta.timeLimitTicks) {
      const left = Math.max(0, Math.ceil((r.meta.timeLimitTicks - played) / r.meta.tickRate));
      $('#hudTimer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    } else $('#hudTimer').textContent = `${Math.floor(played / r.meta.tickRate)}s`;
    $('#hudSides').innerHTML = r.meta.sides.map(s => {
      const st = r.sideState.get(s.key);
      return `<span class="${st && st.out ? 'out' : ''}" style="background:${s.color}">${esc(s.name)}</span>`;
    }).join('');
    // 遊戲目標進度
    const o = r.obj;
    let objHtml = '';
    if (o && o.type === 'koth') {
      objHtml = o.s.map(([k, v]) => { const sm = r.sideMeta.get(k); return `<span><i class="bar"><i style="width:${Math.min(100, v / o.target * 100)}%;background:${sm.color}"></i></i> ${Math.floor(v / r.meta.tickRate)}s</span>`; }).join('');
    } else if (o && o.type === 'ctf') {
      objHtml = o.s.map(([k, v]) => { const sm = r.sideMeta.get(k); return `<span style="color:${sm.color}">🚩 ${v}/${o.target}</span>`; }).join('');
    } else if (o && o.type === 'pve') {
      objHtml = `<span>第 ${o.wave}/${o.waves} 波・剩 ${o.left} 隻</span>`;
    }
    if (r.meta.baseMode && r.wallShieldTicks && r.wallHp.size) {
      const left = Math.ceil((r.wallShieldTicks - Math.max(0, played)) / r.meta.tickRate);
      if (left > 0) objHtml += `<span>🛡️ 基地圍牆無敵 ${left}s</span>`;
    }
    $('#hudObj').innerHTML = objHtml;
    const spect = $('#spectate');
    if (r.myTank) {
      const mine = r.lives.get(r.myTank.id) || { lives: 0, alive: false };
      const botMeta = r.meta.tanks.find(t => t.owner === r.myTank.owner && t.isBot);
      const bot = botMeta ? r.lives.get(botMeta.id) : null;
      const buffs = r.myBuffs();
      const BUFF_ICONS = [[1, '👟'], [2, '🔥'], [4, '💣'], [8, '👻'], [16, '👁️'], [32, '❄️'], [64, '😵'], [128, '🌀'], [256, '🔱'], [512, '🏀'], [1024, '💨']];
      const buffIcons = BUFF_ICONS.filter(([bit]) => buffs & bit).map(([, ic]) => ic).join('');
      $('#hudLives').innerHTML = `${buffIcons ? `<span class="buffs">${buffIcons}</span>` : ''}${'♥'.repeat(mine.lives)}<span style="opacity:.3">${'♥'.repeat(Math.max(0, 3 - mine.lives))}</span> 電腦${bot && bot.alive ? '✓' : '✕'}`;
      const sideOut = (r.sideState.get(r.myTank.side) || {}).out;
      const why = !lastDeath ? '' : lastDeath.cause === 'base' ? '基地被摧毀' : lastDeath.cause === 'blast' ? `被 ${tankName(lastDeath.killer)} 的爆炸波及` : `被 ${tankName(lastDeath.killer)} 擊中`;
      if (sideOut) { spect.innerHTML = `${lastDeath && lastDeath.cause === 'base' ? '基地被摧毀，' : ''}你的隊伍已出局<br><small>觀戰中</small>`; spect.classList.add('show'); }
      else if (!mine.alive && mine.lives > 0) { spect.innerHTML = `${esc(why)}<br><small>重生中…</small>`; spect.classList.add('show'); }
      else if (!mine.alive && r.countdownLeft() === null) { spect.innerHTML = `${esc(why)}<br><small>沒有命了，看你的電腦表現吧</small>`; spect.classList.add('show'); }
      else spect.classList.remove('show');
    } else {
      $('#hudLives').textContent = '觀戰中';
      spect.classList.remove('show');
    }
  }

  // ---------- 操作：虛擬搖桿（八方向）、開火鍵、鍵盤 ----------
  // 方向編號與伺服器一致：0 上 1 下 2 左 3 右 4 左上 5 右上 6 左下 7 右下
  const input = { move: -1, fire: false };   // move：角度（度，0 = 上，順時針），-1 = 不動
  let sentInput = '', lastSendAt = 0, inputSeq = 0;
  let pending = [];   // 已送出、伺服器還沒確認的移動輸入（預測用）
  // 輸入改變時不立刻送，交給下面每秒 30 次的迴圈（同時做本機預測）
  function pushInput(force) { if (force) sentInput = ''; }

  const PHYS = window.TankPhysics;
  function predWorld() {
    return { size: renderer.size, tiles: renderer.liveTiles, tankSize: renderer.meta.tankSize, alignRate: renderer.meta.alignRate || 1 };
  }
  function predOthers(myId) {
    const out = [];
    for (const [id, t] of renderer.latest.tanks) if (id !== myId) out.push({ x: t.x, y: t.y });
    return out;
  }
  function myStep(me) {
    const cls = info.classes[renderer.myTank.cls];
    return (cls ? cls.speed : 4) * (me.buffs & 1 ? renderer.meta.speedBuff : 1) / renderer.meta.tickRate;
  }

  // 收到伺服器快照：以伺服器位置為準，重播還沒被確認的輸入
  function reconcile() {
    const r = renderer;
    if (!r.myTank || !r.latest) return;
    const me = r.latest.tanks.get(r.myTank.id);
    if (!me) { r.pred = null; pending = []; return; }
    pending = pending.filter(p => p.seq > me.ack);
    const p = { x: me.x, y: me.y, angle: me.dir, dir: PHYS.dirOf(me.dir), phase: me.buffs & 128 ? 1 : 0 };
    const world = predWorld(), others = predOthers(r.myTank.id);
    for (const inp of pending) PHYS.move(world, p, inp.dir, inp.step, others);
    if (!r.pred || Math.abs(r.pred.x - p.x) + Math.abs(r.pred.y - p.y) > 1.5) { r.predOff.x = 0; r.predOff.y = 0; }
    else { r.predOff.x += r.pred.x - p.x; r.predOff.y += r.pred.y - p.y; }
    r.pred = p;
  }

  setInterval(() => {
    if (!roundMeta || !renderer.latest) return;
    const r = renderer, now = performance.now();
    const key = Math.round(input.move) + ',' + (input.fire ? 1 : 0);
    const active = input.move >= 0 || input.fire;
    if (!active && key === sentInput && now - lastSendAt < 500) return;
    const seq = ++inputSeq;
    send({ t: 'i', a: input.move >= 0 ? Math.round(input.move * 10) / 10 : -1, f: input.fire ? 1 : 0, s: seq });
    sentInput = key; lastSendAt = now;
    // 本機預測：倒數中、凍住或沒活著時不動
    const me = r.myTank && r.latest.tanks.get(r.myTank.id);
    if (!me || !r.pred || r.latest.c > 0 || input.move < 0 || (me.buffs & 32)) return;
    let dir = Math.round(input.move * 10) / 10;
    if (me.buffs & 64) dir = PHYS.norm(dir + 180);   // 混亂：方向顛倒
    const step = myStep(me);
    r.pred.phase = me.buffs & 128 ? 1 : 0;
    PHYS.move(predWorld(), r.pred, dir, step, predOthers(r.myTank.id));
    pending.push({ seq, dir, step });
    if (pending.length > 90) pending.shift();
  }, 1000 / 30);
  function resetInput() {
    input.move = -1; input.fire = false; stick.id = null; fireId = null;
    $('#fireBtn').classList.remove('down');
    $('#stickKnob').style.transform = '';
    pushInput(true);
  }

  // 角度（0 = 右，逆時針）每 45° 一區
  const SECTOR_TO_DIR = [3, 5, 0, 4, 2, 6, 1, 7];
  const stick = { id: null, ox: 0, oy: 0 };
  const zone = $('#stickZone'), base = $('#stickBase'), knob = $('#stickKnob');
  zone.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (stick.id !== null) return;
    stick.id = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    const r = zone.getBoundingClientRect();
    stick.ox = e.clientX; stick.oy = e.clientY;
    base.style.left = (e.clientX - r.left) + 'px';
    base.style.top = (e.clientY - r.top) + 'px';
    updateStick(e);
  });
  zone.addEventListener('pointermove', e => { if (e.pointerId === stick.id) { e.preventDefault(); updateStick(e); } });
  const endStick = e => {
    if (e.pointerId !== stick.id) return;
    stick.id = null; knob.style.transform = ''; input.move = -1; pushInput();
    base.style.left = ''; base.style.top = '';
  };
  zone.addEventListener('pointerup', endStick);
  zone.addEventListener('pointercancel', endStick);
  function updateStick(e) {
    let dx = e.clientX - stick.ox, dy = e.clientY - stick.oy;
    const d = Math.hypot(dx, dy), maxR = 45;
    if (d > maxR) { dx = dx / d * maxR; dy = dy / d * maxR; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    // 無段落：推多少角度就是多少角度
    const mv = d > 12 ? PHYS.angleOfVec(dx, dy) : -1;
    if (input.move < 0 && mv >= 0) buzz(6);
    input.move = mv; pushInput();
  }

  let fireId = null;
  const fz = $('#fireZone'), fb = $('#fireBtn');
  fz.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (fireId !== null) return;
    fireId = e.pointerId; fz.setPointerCapture(e.pointerId);
    input.fire = true; fb.classList.add('down'); pushInput();
  });
  const endFire = e => { if (e.pointerId !== fireId) return; fireId = null; input.fire = false; fb.classList.remove('down'); pushInput(); };
  fz.addEventListener('pointerup', endFire);
  fz.addEventListener('pointercancel', endFire);

  const keys = new Set();
  const KEY_VEC = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
  const VEC_TO_DIR = { '0,-1': 0, '0,1': 1, '-1,0': 2, '1,0': 3, '-1,-1': 4, '1,-1': 5, '-1,1': 6, '1,1': 7 };
  function keyInput() {
    let x = 0, y = 0;
    for (const k of keys) if (KEY_VEC[k]) { x += KEY_VEC[k][0]; y += KEY_VEC[k][1]; }
    x = Math.sign(x); y = Math.sign(y);
    input.move = (x || y) ? PHYS.angleOfVec(x, y) : -1;
    input.fire = keys.has('Space') || keys.has('KeyJ');
    pushInput();
  }
  window.addEventListener('keydown', e => {
    if (!$('#game').classList.contains('active') || e.target.closest('input, textarea')) return;
    if (e.code in KEY_VEC || e.code === 'Space' || e.code === 'KeyJ') { e.preventDefault(); keys.add(e.code); keyInput(); }
  });
  window.addEventListener('keyup', e => { if (keys.delete(e.code)) keyInput(); });
  window.addEventListener('blur', () => { keys.clear(); if (roundMeta) resetInput(); });

  // 全螢幕與橫向鎖定（Android 有效；iPhone 請「加入主畫面」）
  function tryFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen) return;
    if (!matchMedia('(pointer: coarse)').matches) return;
    el.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
    }).catch(() => {});
  }
  $('#fsBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => {
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      }).catch(() => toast('這個瀏覽器不支援全螢幕，可以用「加入主畫面」'));
    } else toast('iPhone 請用 Safari 的「分享 → 加入主畫面」來全螢幕遊玩');
  };
  async function requestWakeLock() {
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
  }
  function releaseWakeLock() { try { if (wakeLock) wakeLock.release(); } catch { /* ignore */ } wakeLock = null; }

  // ---------- 省錢：網頁切到背景超過 2 分鐘就自動斷線，回來時自動連回 ----------
  const HIDDEN_DISCONNECT_MS = 2 * 60 * 1000;
  let hiddenTimer = null, pausedForHidden = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(() => {
        if (ws && ws.readyState <= 1 && store.get('session', null)) {
          pausedForHidden = true;
          intentionalClose = true;
          clearTimeout(reconnectTimer);
          ws.close();
        }
      }, HIDDEN_DISCONNECT_MS);
    } else {
      clearTimeout(hiddenTimer);
      if (pausedForHidden) {
        pausedForHidden = false;
        const saved = store.get('session', null);
        if (saved) { saved.at = Date.now(); store.set('session', saved); connect({ t: 'resume', ...saved }); }
      }
      if (roundMeta) requestWakeLock();
    }
  });

  // ---------- 代碼擂台 ----------
  function leagueKey() {
    let k = store.get('leagueKey', '');
    if (!k) { k = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => b.toString(16).padStart(2, '0')).join(''); store.set('leagueKey', k); }
    return k;
  }
  function leagueTable(data) {
    $('#leagueWeek').textContent = data.week || '';
    $('#leagueCount').textContent = data.total ? `${data.total} 人參賽` : '';
    if (!data.entries || !data.entries.length) { $('#leagueTable').innerHTML = '<p class="muted small-text">本週還沒有人參賽，搶頭香！</p>'; return; }
    const rows = data.entries.map(e => `<tr class="${e.me ? 'me' : ''}"><td>${e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : e.rank}</td><td>${esc(e.name)}${e.me ? '（你）' : ''}</td><td class="num">${e.rating}</td><td class="num">${e.wins}/${e.losses}/${e.draws}</td></tr>`).join('');
    const mine = data.mine && !data.entries.some(e => e.me) ? `<tr class="me"><td>${data.mine.rank}</td><td>${esc(data.mine.name)}（你）</td><td class="num">${data.mine.rating}</td><td class="num">${data.mine.wins}/${data.mine.losses}/${data.mine.draws}</td></tr>` : '';
    $('#leagueTable').innerHTML = `<table><tr><th>#</th><th>玩家</th><th class="num">分數</th><th class="num">勝/敗/和</th></tr>${rows}${mine}</table>`
      + (data.storage === 'memory' ? '<p class="muted small-text">（目前排行榜存在伺服器記憶體，伺服器重開時會清空）</p>' : '');
  }
  async function openLeague() {
    show('league');
    const opts = [];
    if (store.get('botCode', '')) opts.push(['mine', '我的自訂代碼']);
    for (const s of samples) opts.push(['sample:' + s.key, `範例・${s.name}`]);
    $('#leagueCodeSel').innerHTML = opts.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    $('#leagueResult').innerHTML = store.get('botCode', '') ? '' : '<span class="muted">你還沒有自訂代碼：可以先用範例參賽，或在房間裡交出自己的代碼後再來。</span>';
    try { leagueTable(await (await fetch('/api/league?key=' + leagueKey())).json()); }
    catch { $('#leagueTable').innerHTML = '<p class="muted">讀取排行榜失敗</p>'; }
  }
  $('#leagueBtn').onclick = openLeague;
  $('#leagueBack').onclick = () => show('home');
  $('#leagueSubmit').onclick = async () => {
    const sel = $('#leagueCodeSel').value;
    const code = sel === 'mine' ? store.get('botCode', '') : (samples.find(s => 'sample:' + s.key === sel) || {}).code;
    if (!code) return toast('沒有可以參賽的代碼');
    const btn = $('#leagueSubmit');
    btn.disabled = true; btn.textContent = '對戰中…（約 10～30 秒）';
    $('#leagueResult').innerHTML = '';
    try {
      const res = await (await fetch('/api/league/submit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: leagueKey(), name: $('#nameInput').value.trim() || store.get('name', '') || '無名氏', code }),
      })).json();
      if (!res.ok) {
        $('#leagueResult').innerHTML = `<span class="bad">❌ ${esc(res.error || '參賽失敗')}</span>${res.errors ? `<div class="logbox err selectable">${esc(res.errors.join('\n'))}</div>` : ''}`;
      } else {
        const total = res.results.reduce((a, r) => a + r.delta, 0);
        $('#leagueResult').innerHTML = `<span class="ok">✅ 打完了！分數 ${res.rating}（${total >= 0 ? '+' : ''}${total}）</span>
          <div class="league-res">${res.results.map(r => `<div><span>vs ${esc(r.opponent)}</span><span>${r.wins} 勝 ${r.losses} 敗 ${r.draws} 和 <b class="${r.delta >= 0 ? 'up' : 'down'}">${r.delta >= 0 ? '+' : ''}${r.delta}</b></span></div>`).join('')}</div>`;
        leagueTable(res.standings);
        window.Sfx.play(total >= 0 ? 'win' : 'lose');
      }
    } catch { $('#leagueResult').innerHTML = '<span class="bad">連線失敗，請再試一次</span>'; }
    btn.disabled = false; btn.textContent = '⚔️ 參賽';
  };

  // ---------- 整局重播 ----------
  const rp = { renderer: new window.Renderer($('#replayMain')), data: null, frames: [], next: 0, tick: 0, playing: true, speed: 1, lastNow: 0, id: null };
  function openReplay(data, id) {
    if (!data || !data.meta || !Array.isArray(data.frames) || !data.frames.length) return toast('重播檔格式不正確');
    rp.data = data; rp.frames = data.frames; rp.id = id || (data.room ? `${data.room}-${data.round}` : null);
    rp.playing = true; rp.speed = 1;
    $$('#rpSpeed button').forEach(b => b.classList.toggle('sel', b.dataset.v === '1'));
    $('#rpTitle').textContent = data.round ? `第 ${data.round} 局重播` : '整局重播';
    $('#rpShare').classList.toggle('hidden', !rp.id);
    show('replayScreen');
    rp.renderer.layout = { top: 54, ctrlBottom: 68 };
    rpSeek(rp.frames[0].k);
    rp.lastNow = 0;
  }
  // 跳到某個 tick：從頭快速套用到那一刻（不產生特效）
  function rpSeek(target) {
    const r = rp.renderer;
    r.setRound(rp.data.meta, null);
    r.silent = true;
    rp.next = 0;
    while (rp.next < rp.frames.length && rp.frames[rp.next].k <= target + 1) r.applySnapshot(rp.frames[rp.next++], performance.now());
    r.fixedTick = target;
    r._applyUpTo(target, performance.now());
    r.silent = false;
    rp.tick = target;
  }
  function rpFrame(now) {
    if (!$('#replayScreen').classList.contains('active') || !rp.data || !rp.renderer.meta) return;
    const r = rp.renderer, last = rp.frames[rp.frames.length - 1].k, first = rp.frames[0].k;
    const dt = rp.lastNow ? Math.min(100, now - rp.lastNow) : 0;
    rp.lastNow = now;
    if (rp.playing) {
      rp.tick = Math.min(last, rp.tick + dt / 1000 * 30 * rp.speed);
      if (rp.tick >= last) { rp.playing = false; $('#rpPlay').textContent = '▶️'; }
    }
    while (rp.next < rp.frames.length && rp.frames[rp.next].k <= rp.tick + 1) r.applySnapshot(rp.frames[rp.next++], now);
    r.fixedTick = rp.tick;
    r.draw(now);
    const fmt = t => { const s = Math.max(0, Math.floor(t / 30)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    $('#rpTime').textContent = `${fmt(rp.tick - first)} / ${fmt(last - first)}`;
    if (!rp.dragging) $('#rpSeek').value = Math.round((rp.tick - first) / Math.max(1, last - first) * 1000);
  }
  (function rpLoop(now) { rpFrame(now); requestAnimationFrame(rpLoop); })(0);
  window.addEventListener('resize', () => { if ($('#replayScreen').classList.contains('active')) rp.renderer.resize(); });
  $('#rpPlay').onclick = () => {
    const last = rp.frames[rp.frames.length - 1].k;
    if (!rp.playing && rp.tick >= last) rpSeek(rp.frames[0].k);
    rp.playing = !rp.playing;
    $('#rpPlay').textContent = rp.playing ? '⏸' : '▶️';
  };
  $('#rpSpeed').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    rp.speed = Number(b.dataset.v);
    $$('#rpSpeed button').forEach(x => x.classList.toggle('sel', x === b));
  });
  $('#rpSeek').addEventListener('input', e => {
    rp.dragging = true;
    const first = rp.frames[0].k, last = rp.frames[rp.frames.length - 1].k;
    rpSeek(first + (last - first) * Number(e.target.value) / 1000);
  });
  $('#rpSeek').addEventListener('change', () => { rp.dragging = false; });
  $('#rpClose').onclick = () => {
    rp.data = null;
    if (new URLSearchParams(location.search).get('replay')) history.replaceState(null, '', '/');
    show(room ? (lastResult ? 'result' : 'lobby') : 'home');
  };
  const replayUrl = id => `${location.origin}/?replay=${id}`;
  async function shareReplay(id) {
    const url = replayUrl(id);
    if (navigator.share) { try { await navigator.share({ title: '坦克對戰重播', url }); return; } catch { /* 取消 */ } }
    toast((await copyText(url)) ? '已複製重播連結（房間關閉後會失效）' : url);
  }
  function downloadReplay(id) {
    const [code, round] = id.split('-');
    const a = document.createElement('a');
    a.href = `/replay/${code}/${round}?download=1`;
    a.download = `tank-replay-${code}-${round}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function loadReplay(id) {
    const [code, round] = String(id).split('-');
    try {
      const res = await fetch(`/replay/${code}/${round}`);
      if (!res.ok) return toast('重播已經不存在了（房間關閉後重播會消失）');
      openReplay(await res.json(), id);
    } catch { toast('讀取重播失敗'); }
  }
  $('#rpShare').onclick = () => rp.id && shareReplay(rp.id);
  $('#rpDownload').onclick = () => {
    if (rp.id) return downloadReplay(rp.id);
    toast('這份重播是從檔案開啟的，已經在你的手機裡了');
  };
  $('#watchReplayBtn').onclick = () => lastResult && lastResult.replay && loadReplay(lastResult.replay);
  $('#shareReplayBtn').onclick = () => lastResult && lastResult.replay && shareReplay(lastResult.replay);
  $('#downloadReplayBtn').onclick = () => lastResult && lastResult.replay && downloadReplay(lastResult.replay);
  $('#replayFile').onchange = (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { try { openReplay(JSON.parse(String(reader.result))); } catch { toast('這不是重播檔'); } };
    reader.readAsText(f);
  };
  const urlReplay = new URLSearchParams(location.search).get('replay');
  if (urlReplay && /^\d{4}-\d+$/.test(urlReplay)) loadReplay(urlReplay);

  // ---------- 局後結果 ----------
  const REASONS = { last: '最後存活', draw: '同歸於盡', time: '時間到，剩餘命數較多', timeDraw: '時間到，平手', forced: '房主強制結束', koth: '佔點時間先達標', ctf: '搶旗次數先達標', pveWin: '撐過所有怪物', pveLose: '被怪物打倒了' };

  function renderResult() {
    if (!lastResult || !room) return;
    const r = lastResult;
    const finished = room.state === 'finished';
    const winSide = r.sides.find(s => s.key === r.winner);
    $('#resultTitle').innerHTML = finished ? '比賽結束' : (winSide ? `<span style="color:${winSide.color}">${esc(winSide.name)}</span> 獲勝` : '平手');
    $('#resultSub').textContent = `第 ${r.roundNo} 局・${REASONS[r.reason] || ''}・${r.seconds} 秒` + (finished && winSide ? `｜本局 ${winSide.name} 獲勝` : '');
    const clsName = c => c === 'bot' ? '電腦' : (info.classes[c] ? info.classes[c].name : c);
    const acc = t => t.shots ? Math.round(t.hits / t.shots * 100) + '%' : '-';
    const mvp = r.tanks.find(t => t.mvp);
    const mvpSide = mvp && r.sides.find(s => s.key === mvp.side);
    $('#roundTable').innerHTML = (mvp ? `<div class="mvp"><span class="medal">🏅</span><div><b>MVP：<span style="color:${mvpSide.color}">${esc(mvp.name)}${mvp.isBot ? '的電腦' : ''}</span></b>
        <span class="muted">擊殺 ${mvp.kills}・命中率 ${acc(mvp)}・閃避 ${mvp.dodges}${mvp.captures ? `・搶旗 ${mvp.captures}` : ''}${mvp.baseKills ? `・拆基地 ${mvp.baseKills}` : ''}</span></div></div>` : '') +
      `<div class="table-scroll"><table><tr><th>坦克</th><th class="num">擊殺</th><th class="num">陣亡</th><th class="num">命中率</th><th class="num">閃避</th><th class="num">道具</th>${r.objective === 'ctf' ? '<th class="num">搶旗</th>' : ''}<th class="num">分數</th></tr>${
      r.tanks.slice().sort((a, b) => b.score - a.score).map(t => {
        const side = r.sides.find(s => s.key === t.side);
        return `<tr class="${t.mvp ? 'is-mvp' : ''}"><td><span class="dot" style="display:inline-block;background:${side.color}"></span> ${t.mvp ? '🏅' : ''}${esc(t.name)}${t.isBot ? '的電腦' : ''}<span class="muted">・${clsName(t.cls)}</span></td>
          <td class="num">${t.kills}${t.baseKills ? `<span class="muted">+${t.baseKills}🏳️</span>` : ''}</td><td class="num">${t.deaths}</td><td class="num">${acc(t)}</td><td class="num">${t.dodges}</td><td class="num">${t.items}</td>${r.objective === 'ctf' ? `<td class="num">${t.captures}</td>` : ''}<td class="num">${t.score}</td></tr>`;
      }).join('')}</table></div>`;
    const standings = room.players.slice().sort((a, b) => b.wins - a.wins || b.kills - a.kills);
    $('#matchProgress').textContent = `${room.roundNo} / ${room.settings.rounds} 局`;
    $('#standings').innerHTML = `<table><tr><th>#</th><th>玩家</th><th class="num">勝場</th><th class="num">總擊殺</th></tr>${
      standings.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}${p.id === me.id ? '（你）' : ''}</td><td class="num">${p.wins}</td><td class="num">${p.kills}</td></tr>`).join('')}</table>`;

    const rep = r.myReport && r.myReport.bot;
    if (!rep) $('#botReport').innerHTML = '<p class="muted">沒有資料</p>';
    else {
      $('#botReport').innerHTML = `
        ${rep.initError ? `<div class="logbox err selectable">${esc(rep.initError)}</div>` : ''}
        <div class="rep-stats">
          <span>呼叫 <b>${rep.calls}</b> 次</span><span>平均 <b>${rep.avgMs}</b>ms</span><span>最慢 <b>${rep.maxMs}</b>ms</span>
          <span>錯誤 <b>${rep.errorCount}</b></span><span>逾時 <b>${rep.timeoutCount}</b></span><span>log <b>${rep.logCount}</b> 行</span>
        </div>
        ${rep.errors.length ? `<div class="muted small-text">最近的錯誤</div><div class="logbox err selectable">${esc(rep.errors.join('\n'))}</div>` : ''}
        ${rep.logs.length ? `<div class="muted small-text">console.log（最後 ${rep.logs.length} 行）</div><div class="logbox selectable">${esc(rep.logs.join('\n'))}</div>` : ''}
        ${rep.errors.length || rep.logs.length ? '<button class="btn small" id="copyReportBtn">複製這份報告（貼給 AI 討論）</button>' : ''}`;
      const btn = $('#copyReportBtn');
      if (btn) btn.onclick = async () => {
        const mine = r.tanks.find(t => t.owner === me.id && t.isBot);
        const text = `坦克對戰第 ${r.roundNo} 局，我的電腦坦克：擊殺 ${mine ? mine.kills : 0}、存活 ${mine && mine.lives ? '是' : '否'}。\n` +
          `呼叫 ${rep.calls} 次，平均 ${rep.avgMs}ms，錯誤 ${rep.errorCount} 次，逾時 ${rep.timeoutCount} 次。\n` +
          (rep.errors.length ? `錯誤：\n${rep.errors.join('\n')}\n` : '') + (rep.logs.length ? `log：\n${rep.logs.join('\n')}\n` : '');
        toast((await copyText(text)) ? '已複製' : '複製失敗');
      };
    }
    $('#replayPanel').classList.toggle('hidden', !r.replay);
    renderResultButtons();
  }

  function renderResultButtons() {
    if (!room) return;
    const finished = room.state === 'finished';
    const inter = room.state === 'intermission';
    const host = isHost();
    $('#codeBtn2').classList.toggle('hidden', !inter);
    $('#readyBtn2').classList.toggle('hidden', !inter);
    $('#nextBtn').classList.toggle('hidden', !inter || !host);
    $('#endMatchBtn').classList.toggle('hidden', !inter || !host);
    $('#toLobbyBtn').classList.toggle('hidden', !finished || !host);
    $('#classPanel2').classList.toggle('hidden', !inter || room.settings.codeOnly);
    const mp = myPlayer();
    $('#readyBtn2').textContent = mp && mp.ready ? '已準備 ✓' : '準備';
    $('#readyBtn2').classList.toggle('on', !!(mp && mp.ready));
    const humans = room.players.filter(p => !p.isAI);
    const readyN = humans.filter(p => p.ready).length;
    $('#readyList').textContent = inter ? `已準備 ${readyN}/${humans.length}${host ? (readyN === humans.length ? '，可以開始下一局' : '，房主也可以直接開始') : '，等待房主開始下一局'}`
      : finished ? (host ? '' : '等待房主回到大廳') : '';
  }
})();
