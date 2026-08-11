/* نسق الطاقة — service worker
   الهدف: تفعيل التثبيت كتطبيق فقط.
   لا نخزّن صفحة التطبيق إطلاقاً حتى لا يظهر أبداً إصدار قديم —
   كل طلب يذهب للشبكة مباشرة (network-only). */
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  // تمرير كل الطلبات للشبكة مباشرة، بدون أي تخزين مؤقت
  e.respondWith(fetch(e.request).catch(() => Response.error()));
});
