// Service worker do SimulaBR: permite instalar o site e abrir offline com o último snapshot.
// Estratégia: rede primeiro (dados sempre frescos) e cache como reserva sem conexão.
// /api/* nunca passa por aqui; o app já tem seu próprio fallback para o feed ao vivo.
const CACHE = 'simulabr-shell-v1';
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/vendor/supabase.js',
  '/assets/simulabr-logo.png',
  '/assets/icon-192.png',
  '/assets/logos.json',
  '/data/season-2026.json',
  '/data/historical-backfill-2026.json',
  '/src/club-needs.js',
  '/src/history-integrity.js',
  '/src/live-feed.js',
  '/src/live-history.js',
  '/src/live-season.js',
  '/src/prediction-performance.js',
  '/src/random.js',
  '/src/scenario.js',
  '/src/season-data.js',
  '/src/standings-splits.js',
  '/src/supabase-config.js',
  '/src/ui/club-needs-card.js',
  '/src/ui/icons.js',
  '/src/ui/legal-content.js',
  '/src/ui/position-map.js',
  '/src/ui/sources.js',
  '/src/ui/splits-card.js',
  '/src/ui/team-buttons.js',
  '/src/ui/tour-steps.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => undefined))),
      )
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
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(request)
          .then((cached) => cached || (request.mode === 'navigate' ? caches.match('/index.html') : Response.error())),
      ),
  );
});
