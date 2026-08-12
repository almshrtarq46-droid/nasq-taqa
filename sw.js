/* نسق الطاقة — service worker
   1) تفعيل التثبيت كتطبيق (بدون تخزين للصفحة — network-only)
   2) استقبال إشعارات Push وإظهارها على شاشة الجوال خارج التطبيق */
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => Response.error()));
});

/* استقبال الإشعار الخارجي */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'نسق الطاقة', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'نسق الطاقة';
  const body = d.body || '';
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    dir: 'rtl',
    lang: 'ar',
    vibrate: [80, 40, 80],
    data: { url: './' }
  }));
});

/* الضغط على الإشعار يفتح التطبيق */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
