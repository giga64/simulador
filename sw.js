// Service worker do SimulaBR: notificações push e abertura sem conexão.
// Estratégia: rede primeiro, cache como reserva. A API nunca passa pelo cache.
const CACHE = 'simulabr-v2';
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/assets/logos.json',
  '/assets/simulabr-logo.webp',
  '/assets/fonts/inter-latin.woff2',
  '/data/season-2026.json',
  '/data/historical-backfill-2026.json',
  '/data/probability-history-2026.json',
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
