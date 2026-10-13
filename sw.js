// Service worker do SimulaBR: notificações push e abertura sem conexão.
// Estratégia: rede primeiro, cache como reserva. A API nunca passa pelo cache.
const CACHE = 'simulabr-v3';
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/assets/logos.json',
  '/assets/simulabr-logo.webp',
  '/assets/fonts/inter-latin.woff2',
  '/assets/crests/map.json',
  '/data/season-2026.json',
  '/data/historical-backfill-2026.json',
  '/data/probability-history-2026.json',
  '/data/club-ratings-2026.json',
  '/data/club-ratings-overrides.json',
  '/src/client/cups.js',
  '/src/client/ui.js',
  '/src/client/simulation-runner.js',
  '/src/competitions/formats.js',
  '/src/competitions/elo.js',
  '/src/competitions/simulate.js',
  '/src/competitions/qualification.js',
];

// Escudos das copas e logos das competições: a lista vem de assets/crests/map.json.
async function crestFiles() {
  try {
    const map = await (await fetch('/assets/crests/map.json', { cache: 'no-cache' })).json();
    return [...Object.values(map.clubs || {}), ...Object.values(map.competitions || {})]
      .map((entry) => entry.file)
      .filter((file) => typeof file === 'string' && /^assets\/crests\/[\w/-]+\.png$/.test(file))
      .map((file) => `/${file}`);
  } catch {
    return [];
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (cache) => {
        await cache.addAll(PRECACHE);
        // Escudos são opcionais: uma falha não impede a instalação.
        await Promise.allSettled((await crestFiles()).map((file) => cache.add(file)));
      })
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
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches
          .match(event.request, { ignoreSearch: true })
          .then(
            (cached) => cached || (event.request.mode === 'navigate' ? caches.match('/index.html') : Response.error()),
          ),
      ),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'SimulaBR', body: event.data?.text() || '' };
  }
  const title = String(data.title || 'SimulaBR').slice(0, 80);
  event.waitUntil(
    self.registration.showNotification(title, {
      body: String(data.body || '').slice(0, 200),
      tag: String(data.tag || 'simulabr'),
      renotify: true,
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/icon-32.png',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => client.url.startsWith(self.location.origin));
      if (open) {
        open.navigate(target);
        return open.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
