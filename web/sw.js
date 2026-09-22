// Offline support (NF-9): the whole app shell is stored on install, and books
// marked "Keep offline" (or simply opened) are kept with their chapters.
const SHELL = 'read-shell-v3';
const DATA = 'read-data-v1';
const SHELL_FILES = [
  '/', '/styles.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable.png',
  '/js/api.js', '/js/app.js', '/js/ui.js', '/js/offline.js',
  ...['admin', 'badges', 'book', 'discover', 'home', 'library', 'profiles', 'reader', 'review', 'settings', 'social', 'stats', 'upload'].map((v) => `/js/views/${v}.js`),
  ...['atkinson-400', 'atkinson-700', 'inter', 'jetbrains-mono', 'literata', 'noto-sans-devanagari', 'noto-sans-gujarati',
    'noto-serif-devanagari', 'noto-serif-gujarati', 'opendyslexic-400', 'opendyslexic-700'].map((f) => `/fonts/${f}.woff2`),
];
const OFFLINE_API = [/^\/api\/me$/, /^\/api\/books$/, /^\/api\/books\/\d+$/, /^\/api\/books\/\d+\/chapters\/\d+$/, /^\/api\/books\/\d+\/cover/,
  /^\/api\/profiles$/, /^\/api\/feed$/, /^\/api\/access$/, /^\/api\/badges$/, /^\/api\/stats\/\d+$/, /^\/api\/leaderboard$/, /^\/api\/league$/];

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const cache = await caches.open(SHELL);
  // One missing file must not block the install of everything else.
  await Promise.all(SHELL_FILES.map((f) => cache.add(new Request(f, { credentials: 'same-origin' })).catch(() => {})));
  await self.skipWaiting();
})()));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const key of await caches.keys()) if (![SHELL, DATA].includes(key)) await caches.delete(key);
  await self.clients.claim();
})()));

// API entries are keyed per profile, because responses differ by the X-Profile-Id header.
const dataKey = (url, req) => new Request(url.pathname + url.search + (url.search ? '&' : '?') + '_p=' + (req.headers.get('X-Profile-Id') || ''));

self.addEventListener('fetch', (event) => {
  const req = event.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const isApi = url.pathname.startsWith('/api/');
  if (isApi && !OFFLINE_API.some((re) => re.test(url.pathname))) return;
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(caches.open(SHELL).then(async (c) => (await c.match(req)) || fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; })));
    return;
  }
  // Network first, so a deploy or a changed passcode is seen at once; the saved copy serves when offline.
  const key = isApi ? dataKey(url, req) : (req.mode === 'navigate' ? '/' : req);
  event.respondWith((async () => {
    const cache = await caches.open(isApi ? DATA : SHELL);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(key, res.clone());
      else if (res.status === 401) await caches.delete(DATA);
      return res;
    } catch (err) {
      const hit = await cache.match(key);
      if (hit) return hit;
      if (req.mode === 'navigate') return new Response('<!doctype html><meta charset=utf-8><title>Offline</title><p style="font:16px system-ui;padding:24px">You are offline and this app has not been opened on this device yet.', { headers: { 'Content-Type': 'text/html' } });
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
