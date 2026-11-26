// عند كل نشر جديد: غيّر رقم VERSION ليتجدد الكاش (والـ shell يتحدّث تلقائيًا أيضًا بنمط stale-while-revalidate)
const VERSION = 'v3';
const APP_SHELL_CACHE = `moshafi-shell-${VERSION}`;
const RUNTIME_CACHE = `moshafi-runtime-${VERSION}`;
const AUDIO_CACHE = 'moshafi-audio-v1'; // يديره التطبيق (التنزيلات) ولا يُحذف هنا
const RUNTIME_MAX_ENTRIES = 200;

const SHELL_ASSETS = [
  './', './index.html', './manifest.json',
  './css/main.css', './css/mushaf.css', './css/player.css', './css/responsive.css',
  './js/app.js', './js/mushaf.js', './js/audio.js', './js/word-sync.js', './js/tafsir.js',
  './js/search.js', './js/storage.js', './js/config.js', './js/data.js', './js/quran-api.js', './js/progress.js',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png', './assets/icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => ![APP_SHELL_CACHE, RUNTIME_CACHE, AUDIO_CACHE].includes(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

async function trimCache(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function staleWhileRevalidate(request, cacheName, { trim = 0 } = {}) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) {
        cache.put(request, res.clone()).then(() => trim && trimCache(cache, trim));
      }
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === location.origin) {
    // التنقل بدون إنترنت يرجع إلى index.html
    if (request.mode === 'navigate') {
      event.respondWith(
        staleWhileRevalidate(request, APP_SHELL_CACHE).then((r) => r || caches.match('./index.html'))
      );
      return;
    }
    event.respondWith(staleWhileRevalidate(request, APP_SHELL_CACHE));
    return;
  }

  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('api.quran.com')) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE, { trim: RUNTIME_MAX_ENTRIES }));
  }
});
