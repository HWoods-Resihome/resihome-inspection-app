/*
 * ResiWalk service worker — gives the field app a reliable offline shell.
 *
 * Without this, reloading the page in a dead zone (or after the OS evicts a
 * backgrounded tab) shows a blank screen. Strategy:
 *   - Navigations: network-first, fall back to the last cached page, then to a
 *     cached shell. So inspectors always get *something* offline.
 *   - Static build assets (/_next/static, icons, css, js, fonts, images):
 *     stale-while-revalidate, so they load instantly and refresh in the
 *     background — new deploys are picked up without an SW bump.
 *   - API calls (/api/*): never cached. The app has its own offline outbox /
 *     IndexedDB queues; caching API responses would serve stale data.
 */

const CACHE = 'resiwalk-shell-v1';
const NAV_FALLBACK = '/';

self.addEventListener('install', () => {
  // Activate immediately so the offline shell is available on first load.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|svg|gif|webp|ico|webmanifest)$/i.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin alone
  if (url.pathname.startsWith('/api/')) return;     // never cache API

  // Navigations: network-first with a cached fallback so offline reloads work.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(req, fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match(req)) || (await cache.match(NAV_FALLBACK)) ||
            new Response('<h1>Offline</h1><p>Reconnect to load this page. Your saved work is safe on this device.</p>', { headers: { 'Content-Type': 'text/html' } });
        }
      })(),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(req);
        const network = fetch(req).then((res) => {
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        }).catch(() => undefined);
        return cached || (await network) || new Response('', { status: 504 });
      })(),
    );
  }
});
