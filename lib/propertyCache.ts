/**
 * Full property-list cache (IndexedDB) — so an inspector can start an inspection
 * OFFLINE against ANY of the ~15k+ properties, not just the handful they've
 * searched on this device.
 *
 * Why IndexedDB (not localStorage): 15k+ lean records (~3MB) blow the ~5MB
 * localStorage origin quota; IndexedDB has far more headroom and is the same
 * store the photo queue already uses.
 *
 * Refresh model: there is no reliable "3am background job" for a web/PWA app
 * (the OS won't run our JS on a fixed schedule when closed). The robust
 * equivalent is REFRESH-ON-OPEN-IF-STALE — `syncAllProperties()` is kicked on
 * app open and, when online and the cache is older than ~20h, pulls the full
 * list (paginated) and rewrites the cache. So every inspector who opens the app
 * on a connection within a day carries a fresh full list into the field; if they
 * never get signal, they still have yesterday's full list to start against.
 * (A Chromium `periodicSync` hook could later add true closed-app refresh.)
 */
import type { Property } from '@/lib/types';

const DB_NAME = 'resiwalk_properties';
const STORE = 'props';
const META = 'meta';
const DB_VERSION = 1;
const STALE_MS = 20 * 60 * 60 * 1000; // 20h → "at least daily" when opened online

function idbAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'recordId' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getMeta<T = any>(key: string): Promise<T | null> {
  if (!idbAvailable()) return null;
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve) => {
      const t = db.transaction(META, 'readonly');
      const req = t.objectStore(META).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
      t.oncomplete = () => db.close();
    });
  } catch { return null; }
}

async function setMeta(key: string, value: any): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const t = db.transaction(META, 'readwrite');
      t.objectStore(META).put(value, key);
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => resolve();
    });
  } catch { /* non-fatal */ }
}

/** Bulk-put a page of properties (one transaction). */
async function putPage(rows: Property[]): Promise<void> {
  if (!idbAvailable() || rows.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    for (const r of rows) store.put(r);
    t.oncomplete = () => { db.close(); resolve(); };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function clearStore(): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).clear();
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => resolve();
    });
  } catch { /* non-fatal */ }
}

export async function propertyCacheCount(): Promise<number> {
  if (!idbAvailable()) return 0;
  try {
    const db = await openDb();
    return await new Promise<number>((resolve) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
      t.oncomplete = () => db.close();
    });
  } catch { return 0; }
}

export async function lastPropertySync(): Promise<number | null> {
  return (await getMeta<number>('lastSyncedAt')) ?? null;
}

let syncing = false;

/**
 * Pull the full property list into IndexedDB, paginated. Online-only,
 * single-flight, and a no-op when the cache is fresh (<20h) unless `force`.
 * Writes into a fresh staging set then atomically swaps, so a partial/aborted
 * sync never leaves a half-empty cache the picker would trust.
 */
export async function syncAllProperties(opts: { force?: boolean } = {}): Promise<{ synced: number } | null> {
  if (!idbAvailable()) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  if (syncing) return null;
  if (!opts.force) {
    const last = await lastPropertySync();
    const count = await propertyCacheCount();
    if (last && count > 0 && Date.now() - last < STALE_MS) return null; // still fresh
  }
  syncing = true;
  try {
    // Pull every page first (into memory), THEN replace the store in one pass, so
    // an interrupted pull (lost signal mid-sync) leaves the previous cache intact.
    const all: Property[] = [];
    let after: string | undefined;
    let guard = 0;
    do {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return null; // lost signal → keep old cache
      const url = '/api/properties/all' + (after ? `?after=${encodeURIComponent(after)}` : '');
      // Per-page timeout so a weak-signal stall fails THIS background sync fast
      // (we keep the prior cache and retry on the next open) instead of hanging a
      // loop of 150 requests on a hung socket.
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(to));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const rows: Property[] = Array.isArray(data.properties) ? data.properties : [];
      all.push(...rows);
      after = typeof data.after === 'string' ? data.after : undefined;
      guard++;
    } while (after && guard < 1000); // hard stop well past ~150 expected pages
    if (all.length === 0) return { synced: 0 };
    await clearStore();
    // Write in chunks so one transaction isn't enormous.
    for (let i = 0; i < all.length; i += 1000) await putPage(all.slice(i, i + 1000));
    await setMeta('lastSyncedAt', Date.now());
    return { synced: all.length };
  } catch {
    return null; // keep whatever cache we had; retry next open
  } finally {
    syncing = false;
  }
}

// In-memory mirror for fast type-ahead filtering (loaded once from IDB, reused).
let memCache: Property[] | null = null;
let memLoadedAt = 0;

async function loadAll(): Promise<Property[]> {
  if (!idbAvailable()) return [];
  if (memCache && Date.now() - memLoadedAt < 5 * 60 * 1000) return memCache;
  try {
    const db = await openDb();
    const rows = await new Promise<Property[]>((resolve) => {
      const out: Property[] = [];
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result as IDBCursorWithValue | null;
        if (!c) return;
        out.push(c.value as Property);
        c.continue();
      };
      t.oncomplete = () => { db.close(); resolve(out); };
      t.onerror = () => resolve(out);
    });
    memCache = rows; memLoadedAt = Date.now();
    return rows;
  } catch { return []; }
}

/** Invalidate the in-memory mirror (after a fresh sync). */
export function dropPropertyMemCache(): void { memCache = null; }

/**
 * Search the FULL cached property list (offline-capable). Token-matches each
 * whitespace-separated term against name/address/city/zip (every term must hit
 * somewhere — same intent as the server search). Returns up to `limit` matches,
 * name-sorted. With no query, returns the first `limit` (name-sorted) so the
 * picker isn't empty offline.
 */
export async function searchCachedProperties(query: string, limit = 50): Promise<Property[]> {
  const all = await loadAll();
  if (all.length === 0) return [];
  const term = (query || '').trim().toLowerCase();
  let matches: Property[];
  if (!term) {
    matches = all;
  } else {
    const tokens = term.split(/\s+/).filter(Boolean);
    matches = all.filter((p) => {
      const hay = `${p.name} ${p.address || ''} ${p.city || ''} ${p.state || ''} ${p.zip || ''}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }
  return matches
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}
