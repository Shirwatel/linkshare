const CACHE = 'linkshare-v3';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/config.js', '/lib/supabase-bundle.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first, same-origin only: always try to fetch the latest file so
// redeploys (new config, new app code) take effect immediately, falling
// back to cache only when offline. Cross-origin requests (Supabase REST/
// Realtime) are left completely alone — they're dynamic data, not app
// shell, and the Cache API can't store non-GET requests anyway.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// Fires if the optional Web Push setup (see backend/README.md) is wired up.
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Link Share', {
      body: data.body || 'New item shared from your computer.',
      icon: 'icons/icon192.png',
      badge: 'icons/icon192.png',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'));
});
