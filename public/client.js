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
        info = { classes: m.classes, botClass: m.botClass, colors: m.colors, factionColors: m.factionColors, teamCount: m.teamCount };
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
        hudDirty = true;
        break;
      case 'roundEnd': onRoundEnd(m); break;
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
    $('#roomCode').textContent = m.code;
    renderLobby();
    renderResultButtons();
    if ($('#editor').classList.contains('show')) renderCodeNow();
    if (m.state === 'lobby') {
      if (!$('#lobby').classList.contains('active')) show('lobby');
    } else if (m.state === 'intermission' || m.state === 'finished') {
      if (lastResult) { renderResult(); if (!$('#result').classList.contains('active')) show('result'); }
      else show('lobby');
    } else if (m.state === 'playing') {
      if (!$('#game').classList.contains('active') && !roundMeta) show('lobby');
    }
  }

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
      <div class="set-row"><span>純代碼對戰</span>${sw('codeOnly', s.codeOnly)}</div>
      <div class="set-desc">玩家不下場，每人只派一台電腦坦克，大家一起看</div>
      <div class="set-row"><span>基地模式</span>${sw('baseMode', s.baseMode)}</div>
      <div class="set-desc">每隊有一座基地，被敵人打爆就整隊出局</div>
      <div class="set-row"><span>迷霧</span>${sw('fog', s.fog)}</div>
      <div class="set-desc">玩家只看得到自己周圍；電腦不受影響</div>
      <div class="set-row"><span>牆壁打不破</span>${sw('hardWalls', s.hardWalls)}</div>
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
  $('#settings').addEventListener('click', e => {
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

  function aiPrompt() {
    return `我在玩一款手機坦克對戰遊戲，需要你幫我寫「電腦隊友」的 JavaScript 代碼。
請完全依照下面的規格，寫出完整、可以直接執行的代碼（定義 think(view, memory)，可以加輔助函式）。
只輸出代碼，放在一個 \`\`\`javascript 區塊裡；不要用 import、require、setTimeout。

${specText}
## 參考：遊戲內建的範例 AI（可以改進它，也可以完全重寫）
\`\`\`javascript
${defaultBot}\`\`\`

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
        <div class="muted small-text">測試對戰中跑了 ${m.stats.calls} 次，平均 ${m.stats.avgMs}ms</div>`;
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
    if (renderer.myTank && victim === renderer.myTank.id) {
      lastDeath = { killer, cause, at: performance.now() };
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
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
    if (mine) { lastDeath = { killer: shooter, cause: 'base', at: performance.now() }; if (navigator.vibrate) navigator.vibrate([100, 50, 100]); }
    hudDirty = true;
  };
  $('#replayBox').addEventListener('pointerdown', (e) => { e.stopPropagation(); renderer.closeReplay(); $('#replayBox').classList.remove('show'); });

  function onRoundStart(m) {
    roundMeta = m;
    lastResult = null;
    lastDeath = null;
    $('#editor').classList.remove('show');
    $('#killFeed').innerHTML = '';
    renderer.setRound(m.meta, m.myTank);
    document.body.classList.toggle('spectator', !m.myTank);
    $('#game .controls').classList.toggle('hidden', !m.myTank);
    show('game');
    layoutGame();
    resetInput();
    requestWakeLock();
    hudDirty = true;
  }

  function onRoundEnd(m) {
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
          if (navigator.vibrate && n <= 3) navigator.vibrate(15);
        }
      } else if (shownCount !== null) {
        shownCount = null; goUntil = now + 700;
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
    const spect = $('#spectate');
    if (r.myTank) {
      const mine = r.lives.get(r.myTank.id) || { lives: 0, alive: false };
      const botMeta = r.meta.tanks.find(t => t.owner === r.myTank.owner && t.isBot);
      const bot = botMeta ? r.lives.get(botMeta.id) : null;
      $('#hudLives').innerHTML = `${'♥'.repeat(mine.lives)}<span style="opacity:.3">${'♥'.repeat(Math.max(0, 3 - mine.lives))}</span> 電腦${bot && bot.alive ? '✓' : '✕'}`;
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
  const input = { move: -1, fire: false };
  let sentInput = '';
  function pushInput(force) {
    const key = input.move + ',' + (input.fire ? 1 : 0);
    if (!force && key === sentInput) return;
    sentInput = key;
    send({ t: 'i', m: input.move, f: input.fire ? 1 : 0 });
  }
  setInterval(() => { if (roundMeta && (input.move >= 0 || input.fire)) pushInput(true); }, 250);
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
    let mv = -1;
    if (d > 12) {
      const ang = Math.atan2(-dy, dx);                       // 螢幕 y 向下，翻轉成數學角度
      const sector = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
      mv = SECTOR_TO_DIR[sector];
    }
    if (mv !== input.move && mv >= 0 && navigator.vibrate) navigator.vibrate(6);
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
    input.move = (x || y) ? VEC_TO_DIR[x + ',' + y] : -1;
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

  // ---------- 局後結果 ----------
  const REASONS = { last: '最後存活', draw: '同歸於盡', time: '時間到，剩餘命數較多', timeDraw: '時間到，平手' };

  function renderResult() {
    if (!lastResult || !room) return;
    const r = lastResult;
    const finished = room.state === 'finished';
    const winSide = r.sides.find(s => s.key === r.winner);
    $('#resultTitle').innerHTML = finished ? '比賽結束' : (winSide ? `<span style="color:${winSide.color}">${esc(winSide.name)}</span> 獲勝` : '平手');
    $('#resultSub').textContent = `第 ${r.roundNo} 局・${REASONS[r.reason] || ''}・${r.seconds} 秒` + (finished && winSide ? `｜本局 ${winSide.name} 獲勝` : '');
    const clsName = c => c === 'bot' ? '電腦' : (info.classes[c] ? info.classes[c].name : c);
    $('#roundTable').innerHTML = `<table><tr><th>隊伍</th><th>坦克</th><th class="num">擊殺</th><th class="num">陣亡</th><th class="num">剩命</th></tr>${
      r.tanks.map(t => {
        const side = r.sides.find(s => s.key === t.side);
        return `<tr><td><span class="dot" style="display:inline-block;background:${side.color}"></span> ${esc(side.name)}</td>
          <td>${esc(t.name)}${t.isBot ? '的電腦' : ''}<span class="muted">・${clsName(t.cls)}</span></td>
          <td class="num">${t.kills}${t.baseKills ? ` <span class="muted">+${t.baseKills}基地</span>` : ''}</td><td class="num">${t.deaths}</td><td class="num">${t.lives}</td></tr>`;
      }).join('')}</table>`;
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
