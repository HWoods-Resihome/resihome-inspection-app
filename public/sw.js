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

const CACHE = 'resiwalk-shell-v3';
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

/* ------------------------------------------------------------------
 * Web Push — approval alerts (and any future server-sent notification).
 * The server (lib/pushSender) sends a JSON body { title, body, url, tag }.
 * Tapping the notification focuses an open tab (navigating it if needed) or
 * opens a new one at `url`.
 * ------------------------------------------------------------------ */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { /* non-JSON */ }
  const title = data.title || 'ResiWalk';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // Focus an existing tab; navigate it to the target if it supports it.
      if ('focus' in c) {
        try { if (c.url !== target && 'navigate' in c) await c.navigate(target); } catch (_) { /* cross-origin guard */ }
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

/* ------------------------------------------------------------------ *
 * Background Sync: upload queued photos even after the tab is closed.
 *
 * Queued captures live in IndexedDB (resiwalk_photos/queue), written by
 * lib/offlinePhotoStore.ts. When connectivity returns the browser fires this
 * `sync` event (Chromium; iOS Safari has no Background Sync, where it's a
 * no-op and the in-app flush handles it).
 *
 * If a window is open we let the page run its normal upload+attach flow (it
 * has the form context to attach URLs to sections/lines). Only when no window
 * is open do we upload blobs here, recording the resulting HubSpot URL back on
 * the record so the cheap attach step completes next time the app opens.
 * Throwing makes the browser retry the sync later.
 * ------------------------------------------------------------------ */
const PHOTO_DB = 'resiwalk_photos';
const PHOTO_STORE = 'queue';
const PHOTO_SYNC_TAG = 'resiwalk-photo-sync';

self.addEventListener('sync', (event) => {
  if (event.tag === PHOTO_SYNC_TAG) event.waitUntil(handlePhotoSync());
});

async function handlePhotoSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length > 0) {
    // A tab is open — it can do the full upload AND attach correctly.
    for (const c of clients) c.postMessage({ type: 'resiwalk-flush' });
    return;
  }
  await uploadQueuedPhotosInBackground();
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB, 1);
    // Don't create the store here — if it doesn't exist there's nothing to sync.
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll(db) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(PHOTO_STORE)) return resolve([]);
    const t = db.transaction(PHOTO_STORE, 'readonly');
    const req = t.objectStore(PHOTO_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, rec) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(PHOTO_STORE, 'readwrite');
    t.objectStore(PHOTO_STORE).put(rec);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

function bufToBase64(buffer) {
  // Chunked to avoid a call-stack overflow on large arrays.
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function uploadQueuedPhotosInBackground() {
  let db;
  try { db = await idbOpen(); } catch { return; }
  const all = await idbGetAll(db);
  // Photos only — video uses a Vercel Blob client flow that can't run here; it
  // syncs via the foreground flush when the app reopens.
  const pending = all
    .filter((r) => r && r.kind === 'photo' && !r.uploadedUrl && r.blob)
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const rec of pending) {
    const base64 = bufToBase64(await rec.blob.arrayBuffer());
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: rec.filename, contentType: 'image/jpeg', base64 }),
    });
    if (!res.ok) {
      // 401 (session expired) / 5xx / offline — stop and let the browser retry
      // the whole sync later. Leaves the record intact for the next attempt.
      throw new Error(`background upload failed: HTTP ${res.status}`);
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.url) {
      rec.uploadedUrl = data.url;
      await idbPut(db, rec);
    }
  }
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    /\.(?:js|css|woff2?|ttf|otf|png|jpe?g|svg|gif|webp|ico)$/i.test(url.pathname)
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin alone
  if (url.pathname.startsWith('/api/')) return;     // never cache API
  // NEVER intercept the manifest or the SW itself — they must always come
  // straight from the network. A cached/stale (or HTML) response here breaks
  // Chrome's installability check (manifest must parse as JSON).
  if (url.pathname === '/manifest.webmanifest' || url.pathname === '/sw.js') return;

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
