// 離線外殼：網路優先（拿得到新版就用新版，部署後不會卡在舊版），沒網路時才用快取
const CACHE = 'tank-shell-v1';
const SHELL = ['/', '/index.html', '/style.css', '/client.js', '/render.js', '/physics.js', '/sfx.js', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // 遊戲資料（規格、重播、擂台）不快取
  if (!SHELL.includes(url.pathname)) return;
  e.respondWith(fetch(e.request).then(res => {
    if (!res.ok) return res;          // 錯誤頁不要快取
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
