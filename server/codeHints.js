'use strict';

// 送出代碼時的相容性提醒：粗略看代碼有沒有用到房間開著的新功能。只是提醒，不影響能不能用。
const C = require('./constants');

module.exports = function codeHints(code, settings = {}) {
  const hints = [];
  const m = /\/\/\s*spec\s*v(\d+)/i.exec(code);
  const ver = m ? Number(m[1]) : null;
  if (ver !== null && ver < C.SPEC_VERSION) {
    const missed = C.CHANGELOG.filter(([v]) => v > ver).map(([v, s]) => `v${v}：${s}`);
    hints.push({ key: 'version', text: `依舊版規格 v${ver} 撰寫；後續新增：${missed.join('；')}` });
  } else if (ver === null) hints.push({ key: 'version', text: '缺少「// spec v版本」標記，無法判斷規格版本' });
  const has = re => re.test(code);
  if (settings.hpSystem && !has(/\b(hp|maxHp)\b/)) hints.push({ key: 'hp', text: '未讀取血量（hp／maxHp）：無法判斷殘血與優先目標' });
  if (!has(/\bskill\b/)) hints.push({ key: 'skill', text: '未使用職業技能（skill）' });
  if (settings.zone && !has(/\bzone\b/)) hints.push({ key: 'zone', text: '未處理縮圈（view.zone）：可能停留圈外' });
  if (settings.terrain && has(/tiles/) && !has(/['"][HPO]['"]/)) hints.push({ key: 'terrain', text: '未處理特殊地形（O 油桶、H 補血站、P 傳送門）：尋路可能出錯' });
  return hints;
};
