/* شركة دبلان — service worker
   1) قشرة التطبيق: stale-while-revalidate (فتح/تحديث فوري من الكاش + تحديث بالخلفية)
   2) إعادة التحميل القسري (?v= / ?_r= / ?_ck=): من الشبكة دائماً (أحدث نسخة)
   3) مكتبات CDN والخطوط: cache-first (تسريع)
   4) استقبال إشعارات Push */
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const CDN = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com/;
const SHELL_CACHE = 'nasq-shell-v1';
const CDN_CACHE = 'nasq-cdn-v1';

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;

  // --- app shell (page navigations) ---
  if (req.mode === 'navigate') {
    let forced = false;
    try { forced = /[?&](v|_r|_ck)=/.test(new URL(url).search); } catch (_) {}
    const key = self.registration.scope;
    if (forced) {
      // network-first: forced reload / auto-update must get the freshest version
      e.respondWith(
        fetch(req).then(r => {
          if (r && r.ok) caches.open(SHELL_CACHE).then(c => { try { c.put(key, r.clone()); } catch (_) {} });
          return r;
        }).catch(() => caches.open(SHELL_CACHE).then(c => c.match(key)).then(x => x || Response.error()))
      );
    } else {
      // stale-while-revalidate: instant from cache, refresh in background
      e.respondWith((async () => {
        const c = await caches.open(SHELL_CACHE);
        const cached = await c.match(key);
        const netP = fetch(req).then(r => { if (r && r.ok) { try { c.put(key, r.clone()); } catch (_) {} } return r; }).catch(() => null);
        return cached || (await netP) || Response.error();
      })());
    }
    return;
  }

  // --- CDN libs & fonts: cache-first ---
  if (CDN.test(url)) {
    e.respondWith(caches.open(CDN_CACHE).then(c =>
      c.match(req).then(hit => hit || fetch(req).then(resp => { try { c.put(req, resp.clone()); } catch (_) {} return resp; }))
    ));
    return;
  }

  // --- Supabase read (REST GET + auth user): network-first, fast fallback to cached (offline read + slow-net) ---
  if (req.method === 'GET' && /supabase\.co\/(rest\/v1|auth\/v1\/user)/.test(url)) {
    e.respondWith((async () => {
      const c = await caches.open('nasq-data-v1');
      const netP = fetch(req).then(r => { if (r && r.ok) { try { c.put(req, r.clone()); } catch (_) {} } return r; });
      const cached = await c.match(req);
      if (!cached) { try { return await netP; } catch (_) { return Response.error(); } }
      const timeout = new Promise(res => setTimeout(() => res(null), 3500));
      const winner = await Promise.race([netP.catch(() => null), timeout]);
      return winner || cached;
    })());
    return;
  }

  // --- everything else: network, fall back to cache if present ---
  e.respondWith(fetch(req).catch(() => caches.match(req).then(x => x || Response.error())));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'شركة دبلان', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'شركة دبلان';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', icon: './icon-192.png', badge: './icon-192.png',
    dir: 'rtl', lang: 'ar', vibrate: [80, 40, 80], data: { url: './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});
