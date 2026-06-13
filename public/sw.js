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

const NAV_FALLBACK = '/';
// Cache name is tied to the build version passed in the registration URL
// (/sw.js?v=<build>), so every deploy gets a FRESH cache and the activate
// handler below deletes all older ones — no more stale shells surviving a
// deploy. Falls back to a static name when registered without a version.
const SW_VERSION = (() => {
  try { return new URL(self.location.href).searchParams.get('v') || 'v3'; }
  catch { return 'v3'; }
})();
const CACHE = 'resiwalk-shell-' + SW_VERSION;

self.addEventListener('install', () => {
  // Do NOT skipWaiting here: let the new SW WAIT so the app can apply the update
  // at a safe moment (on reopen, or when the user taps the reload banner). On a
  // first-ever install there's nothing to wait behind, so it still activates at
  // once. The client posts 'SKIP_WAITING' (below) to promote an update.
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

// Cap per-photo background attempts so a single un-uploadable image (corrupt
// blob, a file the server keeps rejecting) can't keep failing the sync forever.
const MAX_BG_PHOTO_ATTEMPTS = 6;

async function uploadQueuedPhotosInBackground() {
  let db;
  try { db = await idbOpen(); } catch { return; }
  const all = await idbGetAll(db);
  // Photos only — video uses a Vercel Blob client flow that can't run here; it
  // syncs via the foreground flush when the app reopens. Skip photos that have
  // exhausted their background attempts (they'll be retried by the foreground
  // flush when the app reopens, which surfaces errors to the user).
  const pending = all
    .filter((r) => r && r.kind === 'photo' && !r.uploadedUrl && r.blob && (r.bgAttempts || 0) < MAX_BG_PHOTO_ATTEMPTS)
    .sort((a, b) => a.createdAt - b.createdAt);

  let hadRetryableFailure = false;
  for (const rec of pending) {
    let res;
    try {
      const base64 = bufToBase64(await rec.blob.arrayBuffer());
      res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: rec.filename, contentType: 'image/jpeg', base64 }),
      });
    } catch (e) {
      // Network/offline — every upload will fail the same way; stop and let the
      // browser reschedule the whole sync. Records are left intact.
      throw (e instanceof Error ? e : new Error('background upload network error'));
    }
    if (res.status === 401 || res.status === 403) {
      // Session expired — every upload will fail; stop and let the browser retry
      // the whole sync once the user re-authenticates.
      throw new Error(`background upload auth failed: HTTP ${res.status}`);
    }
    if (!res.ok) {
      // Per-photo server error (e.g. one bad file): record the attempt and SKIP
      // to the next photo so one poison-pill image can't block the rest of the
      // queue. The browser will reschedule (we throw at the end).
      rec.bgAttempts = (rec.bgAttempts || 0) + 1;
      try { await idbPut(db, rec); } catch { /* ignore */ }
      hadRetryableFailure = true;
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.url) {
      rec.uploadedUrl = data.url;
      rec.bgAttempts = 0;
      await idbPut(db, rec);
    }
  }
  // If anything failed transiently, throw so the browser reschedules the sync.
  // Already-uploaded photos carry uploadedUrl and won't be retried.
  if (hadRetryableFailure) throw new Error('one or more background photo uploads failed; will retry');
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
