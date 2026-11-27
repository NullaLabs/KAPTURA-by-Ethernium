const CACHE_NAME = 'kaptura-studio-v3.2.1';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/kaptura-icon.svg',
  './css/fonts.css',
  './css/hud.css',
  './js/capabilities.js',
  './js/gif-encoder.js',
  './js/lanczos.js',
  './js/lanczos-gl.js',
  './js/scaler.js',
  './js/transcoder.js',
  './js/compressor.js',
  './js/svg-vector.js',
  './js/upskaletor.js',
  './js/bg-remover.js',
  './js/vault.js',
  './js/audio-mixer.js',
  './js/capture.js',
  './js/comparator.js',
  './js/liquid-shader.js',
  './js/studio-selects.js',
  './js/daemon-bridge.js',
  './js/preflight.js',
  './js/batch-queue.js',
  './js/matte-brush.js',
  './js/app.js',
];

const BYPASS_PREFIXES = [
  '/health',
  '/status',
  '/capabilities',
  '/telemetry',
  '/events',
  '/jobs',
  '/exports',
  '/probe',
  '/transcode',
  '/upscale-ai',
  '/remove-bg',
  '/trim',
  '/render',
  '/vault',
  '/cancel',
  '/ws',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => undefined)
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) {
    return;
  }

  if (url.pathname.includes('/fonts/') || url.pathname.includes('/icons/')) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return res;
      }))
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
