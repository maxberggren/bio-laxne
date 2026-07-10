const CACHE = 'bio-laxne-v7';
const SHELL = ['/', '/styles.css?v=7', '/app.js?v=7', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all(SHELL.map(async (url) => {
    const response = await fetch(url, { cache: 'reload' });
    await cache.put(url, response);
  }))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request, { cache: 'no-store' }).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === 'navigate' ? caches.match('/') : undefined))));
});

self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification(data.title || 'Bio Laxne', {
    body: data.body || 'Något nytt väntar bakom ridån.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
    vibrate: [120, 50, 120],
    tag: data.title || 'bio-laxne'
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).pathname === url);
    return existing ? existing.focus() : clients.openWindow(url);
  }));
});
