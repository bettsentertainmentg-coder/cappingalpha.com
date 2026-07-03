// CappingAlpha service worker: offline shell + push notifications.
//
// Caching is deliberately conservative. Only immutable-ish things are cached
// (cache-busted ?v= URLs, /vendor/ files, icons); unversioned module files and
// every /api|/auth|/admin request always go to the network, so a deploy is never
// masked by a stale cache. Navigations are network-first with the cached shell
// as the offline fallback.
const CACHE = 'ca-shell-v2'; // bump wipes older caches on activation

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')).then(() => self.skipWaiting()));
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
  if (req.method !== 'GET') return;
  // Local dev: never cache. The pm2 workflow edits public/ files in place between
  // version bumps, and a cache-first hit would silently serve stale code.
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/admin')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((r) => {
        const cp = r.clone();
        caches.open(CACHE).then((c) => c.put('/', cp));
        return r;
      }).catch(() => caches.match('/'))
    );
    return;
  }

  const cacheable = url.search.includes('v=')
    || url.pathname.startsWith('/vendor/')
    || /\.(png|ico|webmanifest)$/.test(url.pathname);
  if (!cacheable) return;

  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); }
      return r;
    }))
  );
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'CappingAlpha', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/favicon-32.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});
