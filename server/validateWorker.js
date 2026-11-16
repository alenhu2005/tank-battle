'use strict';

// 代碼檢查放在獨立的執行緒，慢的代碼不會卡住正在進行的遊戲。
const { Worker, isMainThread, parentPort } = require('worker_threads');

if (!isMainThread) {
  const { validateCode } = require('./validate');
  parentPort.on('message', ({ id, code }) => {
    let res;
    try { res = validateCode(code); } catch (e) { res = { ok: false, errors: ['檢查失敗：' + e.message], logs: [] }; }
    parentPort.postMessage({ id, res });
  });
} else {
  let worker = null;
  let nextId = 1;
  const pending = new Map();

  function getWorker() {
    if (worker) return worker;
    worker = new Worker(__filename);
    worker.on('message', ({ id, res }) => {
      const p = pending.get(id);
      if (p) { pending.delete(id); clearTimeout(p.timer); p.resolve(res); }
    });
    worker.on('error', (e) => console.error('validate worker error', e));
    worker.on('exit', () => {
      worker = null;
      for (const [id, p] of pending) { clearTimeout(p.timer); p.resolve({ ok: false, errors: ['檢查程序意外結束，請再試一次'], logs: [] }); pending.delete(id); }
    });
    return worker;
  }

  module.exports.validateAsync = function validateAsync(code) {
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, errors: ['檢查超過 20 秒，代碼可能太慢'], logs: [] });
        if (worker) worker.terminate();
      }, 20000);
      pending.set(id, { resolve, timer });
      getWorker().postMessage({ id, code });
    });
  };
}
