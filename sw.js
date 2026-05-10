/* HSH Mercado · Service Worker
 * Estratégia: cache-first para o app shell, network-first para o resto.
 * Versionar CACHE para invalidar em deploys (bumpe a cada release que muda assets).
 */
const CACHE = 'lecolista-v6';
const SHELL = [
  './',
  './index.html',
  './canvas.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './vendor/zxing.min.js',
  'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap',
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {/* tolerate partial */}))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Não interceptar POST/PUT
  if (e.request.method !== 'GET') return;

  // Open Food Facts e buscas externas: network-first com fallback de cache
  if (url.origin !== location.origin) {
    e.respondWith(
      fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // App shell: cache-first
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) {
        // refresca em background
        fetch(e.request).then((r) => {
          if (r && r.status === 200) {
            caches.open(CACHE).then((c) => c.put(e.request, r.clone())).catch(() => {});
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match('./index.html'));
    })
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
