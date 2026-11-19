'use strict';

// 送出代碼時的相容性提醒：粗略看代碼有沒有用到房間開著的新功能。只是提醒，不影響能不能用。
const C = require('./constants');

module.exports = function codeHints(code, settings = {}) {
  const hints = [];
  const m = /\/\/\s*spec\s*v(\d+)/i.exec(code);
  const ver = m ? Number(m[1]) : null;
  if (ver !== null && ver < C.SPEC_VERSION) {
    const missed = C.CHANGELOG.filter(([v]) => v > ver).map(([v, s]) => `v${v}：${s}`);
    hints.push({ key: 'version', text: `這份代碼是照舊版規格（v${ver}）寫的，之後新增了：${missed.join('；')}` });
  } else if (ver === null) hints.push({ key: 'version', text: '代碼第一行沒有「// spec v版本」，看不出是照哪一版規格寫的' });
  const has = re => re.test(code);
  if (settings.hpSystem && !has(/\b(hp|maxHp)\b/)) hints.push({ key: 'hp', text: '沒有讀血量（hp／maxHp）：血量系統下不會判斷殘血、不會挑血少的敵人' });
  if (!has(/\bskill\b/)) hints.push({ key: 'skill', text: '沒有用到職業技能（skill）' });
  if (settings.zone && !has(/\bzone\b/)) hints.push({ key: 'zone', text: '沒有處理縮圈（view.zone）：可能會待在圈外被扣血' });
  if (settings.terrain && has(/tiles/) && !has(/['"][HPO]['"]/)) hints.push({ key: 'terrain', text: '沒有處理新地形（O 油桶、H 補血站、P 傳送門）：尋路時可能把它們當成牆，或想開過油桶' });
  return hints;
};
