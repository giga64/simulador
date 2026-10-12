// Service worker do SimulaBR: rede primeiro, cache como reserva para abrir o
// site sem conexão. A API ao vivo e a autenticação nunca passam pelo cache.
const CACHE = 'simulabr-v1';
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/data/season-2026.json',
  '/data/historical-backfill-2026.json',
  '/assets/logos.json',
  '/assets/simulabr-logo.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || Response.error())),
  );
});
