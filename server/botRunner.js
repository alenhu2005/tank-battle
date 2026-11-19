'use strict';

// 在隔離的 V8 沙盒（isolated-vm）裡執行玩家寫的電腦代碼。
// 玩家代碼拿不到伺服器的任何東西（檔案、網路、process），
// 而且每次呼叫都有時間上限，無窮迴圈不會卡住遊戲。

const ivm = require('isolated-vm');
const C = require('./constants');

const HARNESS = `
var __fn = (typeof think === 'function') ? think
  : (module.exports && typeof module.exports.think === 'function') ? module.exports.think
  : (typeof module.exports === 'function') ? module.exports
  : null;
var __memory = {};
function __call(viewJson) {
  if (!__fn) throw new Error('找不到 think 函式：請定義 function think(view, memory) { ... }');
  __dbg.length = 0;
  var r = __fn(JSON.parse(viewJson), __memory);
  var out = JSON.stringify(r === undefined ? null : r);
  return __dbg.length ? out + '\u0001' + JSON.stringify(__dbg) : out;
}
`;

const PRELUDE = `
var module = { exports: {} };
var exports = module.exports;
// 除錯繪圖：畫在遊戲畫面上，只有代碼的主人看得到（每個 tick 最多 60 個）
var __dbg = [];
var debug = (function () {
  function push(op) { if (__dbg.length < 60) __dbg.push(op); }
  function n(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : 0; }
  function c(v) { return typeof v === 'string' ? v.slice(0, 24) : '#ff0'; }
  return {
    line: function (x1, y1, x2, y2, color) { push(['l', n(x1), n(y1), n(x2), n(y2), c(color)]); },
    circle: function (x, y, r, color) { push(['c', n(x), n(y), n(r), c(color)]); },
    text: function (x, y, s, color) { push(['t', n(x), n(y), String(s).slice(0, 40), c(color)]); },
    path: function (pts, color) {
      if (!pts || !pts.length) return;
      var flat = [];
      for (var i = 0; i < pts.length && i < 40; i++) { var p = pts[i]; flat.push(n(p.x !== undefined ? p.x : p[0]), n(p.y !== undefined ? p.y : p[1])); }
      push(['p', flat, c(color)]);
    }
  };
})();
var console = (function () {
  function fmt(a) {
    var out = [];
    for (var i = 0; i < a.length; i++) {
      var v = a[i];
      if (typeof v === 'string') out.push(v);
      else { try { out.push(JSON.stringify(v)); } catch (e) { out.push(String(v)); } }
    }
    return out.join(' ');
  }
  var log = function () { __log(fmt(arguments)); };
  return { log: log, info: log, warn: log, error: log, debug: log };
})();
`;

// AI 助手常常會寫成 ES module 的樣子，這裡幫忙去掉 export，提高「貼上就能跑」的機率
function normalizeCode(code) {
  return String(code)
    .replace(/^\s*export\s+default\s+(?=(async\s+)?function|class|\()/gm, '')
    .replace(/^\s*export\s+default\s+think\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(async\s+)?function|const|let|var|class)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '');
}

function cleanError(err) {
  let msg = (err && err.message) ? err.message : String(err);
  if (/timed out/i.test(msg)) return null; // 由呼叫端處理成逾時訊息
  const stack = (err && err.stack) || '';
  const m = stack.match(/bot\.js:(\d+):(\d+)/);
  if (m) msg += `（第 ${m[1]} 行，第 ${m[2]} 字）`;
  return msg;
}

class BotSandbox {
  constructor(code, label) {
    this.label = label;
    this.logs = [];
    this.logCount = 0;
    this.errors = [];       // 最近的錯誤訊息
    this.errorCount = 0;
    this.timeoutCount = 0;
    this.calls = 0;
    this.totalMs = 0;
    this.maxMs = 0;
    this.dead = false;
    this.initError = null;

    if (Buffer.byteLength(String(code || '')) > C.BOT_CODE_MAX_BYTES) {
      this.initError = `代碼超過 ${C.BOT_CODE_MAX_BYTES / 1024}KB 上限`;
      this.dead = true;
      return;
    }

    try {
      this.isolate = new ivm.Isolate({ memoryLimit: C.BOT_MEMORY_MB });
      this.context = this.isolate.createContextSync();
      const jail = this.context.global;
      jail.setSync('globalThis', jail.derefInto());
      jail.setSync('__log', new ivm.Callback((line) => this._log(line)));
      this.context.evalSync(PRELUDE);
      const script = this.isolate.compileScriptSync(normalizeCode(code), { filename: 'bot.js' });
      script.runSync(this.context, { timeout: C.BOT_INIT_TIMEOUT_MS });
      this.context.evalSync(HARNESS);
      this.fn = jail.getSync('__call', { reference: true });
      const hasFn = this.context.evalSync('__fn !== null');
      if (!hasFn) throw new Error('找不到 think 函式：請定義 function think(view, memory) { ... }');
    } catch (e) {
      const msg = cleanError(e) || `初始化超過 ${C.BOT_INIT_TIMEOUT_MS}ms`;
      this.initError = (e instanceof SyntaxError || /SyntaxError/.test(e && e.name)) ? '語法錯誤：' + msg : msg;
      this.dead = true;
      this.dispose();
    }
  }

  _log(line) {
    this.logCount++;
    this.logs.push(`[t${this.currentTick || 0}] ${String(line).slice(0, 300)}`);
    if (this.logs.length > C.BOT_LOG_LINES) this.logs.shift();
  }

  _error(msg) {
    this.errorCount++;
    // 連續相同的錯誤只記一筆，後面標註重複次數
    const last = this.errors[this.errors.length - 1];
    if (last && last.msg === msg) { last.repeat++; return; }
    this.errors.push({ tick: this.currentTick || 0, msg, repeat: 1 });
    if (this.errors.length > 8) this.errors.shift();
  }

  _errorLines() {
    return this.errors.map(e => `[t${e.tick}] ${e.msg}${e.repeat > 1 ? `（之後同樣的錯誤又發生 ${e.repeat - 1} 次）` : ''}`);
  }

  // 回傳 { move, fire }，出錯則回傳 null（該 tick 不動）
  think(viewJson, tick) {
    if (this.dead) return null;
    this.currentTick = tick;
    const t0 = process.hrtime.bigint();
    let raw;
    try {
      raw = this.fn.applySync(undefined, [viewJson], { timeout: C.BOT_CALL_TIMEOUT_MS });
    } catch (e) {
      if (this.isolate.isDisposed) {
        this.dead = true;
        this._error('記憶體超過上限，沙盒已停止，本局不再動作');
        return null;
      }
      const msg = cleanError(e);
      if (msg === null) { this.timeoutCount++; this._error(`think() 超過 ${C.BOT_CALL_TIMEOUT_MS}ms，這個 tick 不動`); }
      else this._error(msg);
      return null;
    } finally {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      this.calls++; this.totalMs += ms; if (ms > this.maxMs) this.maxMs = ms;
    }
    const sep = raw.indexOf('\u0001');
    this.debugOps = null;
    if (sep >= 0) {
      try { this.debugOps = JSON.parse(raw.slice(sep + 1)); } catch { /* 忽略 */ }
      raw = raw.slice(0, sep);
    }
    return this._parseAction(raw);
  }

  _parseAction(raw) {
    let r;
    try { r = JSON.parse(raw); } catch { this._error('回傳值無法轉成 JSON'); return null; }
    if (r === null) return { move: null, fire: false };
    if (typeof r !== 'object' || Array.isArray(r)) {
      this._error('think() 必須回傳物件，例如 { move: "up", fire: true }');
      return null;
    }
    let move = r.move;
    if (move === undefined || move === '' || move === 'none' || move === 'stop') move = null;
    const extra = {};   // 打怪模式的抽卡與商店
    if (Number.isInteger(r.pick)) extra.pick = r.pick;
    if (typeof r.buy === 'string') extra.buy = r.buy;
    if (typeof move === 'number' && Number.isFinite(move)) return { move: ((move % 360) + 360) % 360, fire: !!r.fire, skill: !!r.skill, ...extra };
    if (move !== null && !C.DIRS.includes(move)) {
      this._error(`move 的值 ${JSON.stringify(move)} 無效：可以是角度（數字，0 = 上、90 = 右，順時針）、${C.DIRS.map(d => '"' + d + '"').join(' ')} 或 null`);
      move = null;
    }
    return { move, fire: !!r.fire, skill: !!r.skill, ...extra };
  }

  report() {
    return {
      initError: this.initError,
      errors: this._errorLines(),
      errorCount: this.errorCount,
      timeoutCount: this.timeoutCount,
      logs: this.logs.slice(),
      logCount: this.logCount,
      avgMs: this.calls ? +(this.totalMs / this.calls).toFixed(3) : 0,
      maxMs: +this.maxMs.toFixed(2),
      calls: this.calls,
    };
  }

  dispose() {
    try { if (this.isolate && !this.isolate.isDisposed) this.isolate.dispose(); } catch { /* ignore */ }
  }
}

module.exports = { BotSandbox };
