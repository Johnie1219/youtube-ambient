/* 서비스 워커 — 앱 셸 캐시(오프라인/빠른 실행). HTTPS 또는 localhost에서만 등록됨.
   전략: HTML/JS/CSS는 "네트워크 우선"(항상 최신) + 오프라인 폴백,
        무겁고 잘 안 바뀌는 자원(Tone.js·아이콘)만 "캐시 우선". */
const CACHE = 'ambient-v34';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/audio/ambient-engine.js',
  '/audio/wav-encoder.js',
  '/vendor/Tone.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // API와 비GET·외부 도메인은 가로채지 않음 — 항상 네트워크로.
  if (req.method !== 'GET' || url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
    return;
  }

  // 무겁고 안정적인 자원만 캐시 우선(Tone.js, 아이콘)
  const cacheFirst = url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/');

  if (cacheFirst) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
      )
    );
    return;
  }

  // 그 외(HTML/JS/CSS 등): 네트워크 우선 → 받으면 캐시 갱신, 실패 시 캐시/인덱스로 폴백
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
