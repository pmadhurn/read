// App shell plus the books being read stay available offline (NF-9).
const SHELL = 'read-shell-v1';
const DATA = 'read-data-v1';
const OFFLINE_API = [/^\/api\/me$/, /^\/api\/books$/, /^\/api\/books\/\d+$/, /^\/api\/books\/\d+\/chapters\/\d+$/, /^\/api\/books\/\d+\/cover/, /^\/api\/profiles$/, /^\/api\/feed$/];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const key of await caches.keys()) if (![SHELL, DATA].includes(key)) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const isApi = url.pathname.startsWith('/api/');
  if (isApi && !OFFLINE_API.some((re) => re.test(url.pathname))) return;
  if (url.pathname.startsWith('/fonts/')) {
    event.respondWith(caches.open(SHELL).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; })));
    return;
  }
  // Network first, so a deploy or a changed passcode is seen at once; cache only when offline.
  // API entries are keyed per profile, because responses differ by the X-Profile-Id header.
  const key = isApi ? new Request(url.pathname + url.search + (url.search ? '&' : '?') + '_p=' + (req.headers.get('X-Profile-Id') || '')) : req;
  event.respondWith((async () => {
    const cache = await caches.open(isApi ? DATA : SHELL);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(key, res.clone());
      else if (res.status === 401) { await caches.delete(DATA); }
      return res;
    } catch (err) {
      const hit = await cache.match(key) || (req.mode === 'navigate' ? await cache.match('/') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || 'Read', { body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: data.url || '/' } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => (list[0] ? list[0].focus() : self.clients.openWindow(event.notification.data.url))));
});
