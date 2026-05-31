/**
 * Offline photo store — durable IndexedDB queue of compressed photo blobs that
 * couldn't be uploaded because the device was offline. Photos are shown
 * immediately from a local object URL ("draft") and the blobs sync to HubSpot
 * automatically when connectivity returns.
 *
 * Why IndexedDB (not the localStorage outbox): photo blobs are far too large
 * for localStorage. We store the already-COMPRESSED jpeg (~600KB), produced by
 * compressToJpeg, which runs client-side and works offline.
 *
 * Display key: each queued photo is shown via a session object URL. We keep a
 * module-level localId -> objectURL map so the flusher can swap the placeholder
 * URL for the real HubSpot URL once it uploads. After a reload the URLs are
 * regenerated (rehydrate) and the map rebuilt, so syncing still works.
 */

import { compressToJpeg, uploadJpegBlob, toJpegName } from '@/lib/photoUpload';

export type QueuedPhoto = {
  localId: string;
  inspectionRecordId: string;
  sectionId: string;
  blob: Blob;
  filename: string;
  createdAt: number;
};

const DB_NAME = 'resiwalk_photos';
const STORE = 'queue';
const DB_VERSION = 1;

// localId -> live object URL (session-scoped; not persisted).
const objectUrlByLocalId = new Map<string, string>();

function idbAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'localId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

async function getAllRecords(): Promise<QueuedPhoto[]> {
  if (!idbAvailable()) return [];
  try { return (await tx<QueuedPhoto[]>('readonly', (s) => s.getAll())) || []; }
  catch { return []; }
}

async function putRecord(rec: QueuedPhoto): Promise<void> {
  await tx('readwrite', (s) => s.put(rec));
}

async function deleteRecord(localId: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(localId));
}

/** Was a thrown upload error a network/offline failure (vs a permanent 4xx)? */
function isOfflineErr(err: any): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String(err?.message || err || '');
  return !/HTTP 4\d\d/.test(msg);
}

/**
 * Compress a captured photo and try to upload it. On success returns the real
 * HubSpot URL. If the device is offline/transient, the compressed blob is
 * queued in IndexedDB and a local object URL ("draft") is returned for display.
 * Permanent errors (bad/undecodable image) re-throw so the caller can surface
 * them.
 */
export async function uploadPhotoOrQueue(
  file: File,
  inspectionRecordId: string,
  sectionId: string,
): Promise<string> {
  const blob = await compressToJpeg(file);
  const filename = toJpegName(file.name);
  try {
    return await uploadJpegBlob(blob, filename);
  } catch (e) {
    if (!isOfflineErr(e) || !idbAvailable()) throw e;
    const localId = `idbph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await putRecord({ localId, inspectionRecordId, sectionId, blob, filename, createdAt: Date.now() });
    const url = URL.createObjectURL(blob);
    objectUrlByLocalId.set(localId, url);
    return url;
  }
}

export async function countQueuedPhotos(inspectionRecordId: string): Promise<number> {
  const all = await getAllRecords();
  return all.filter((r) => r.inspectionRecordId === inspectionRecordId).length;
}

/**
 * Recreate object URLs for this inspection's queued photos (e.g. after a reload
 * while still offline) so they can be re-shown. Returns [{ localId, sectionId,
 * url }] for the caller to merge into its photo state.
 */
export async function rehydrateQueuedPhotos(
  inspectionRecordId: string,
): Promise<{ localId: string; sectionId: string; url: string }[]> {
  const all = await getAllRecords();
  const out: { localId: string; sectionId: string; url: string }[] = [];
  for (const r of all) {
    if (r.inspectionRecordId !== inspectionRecordId) continue;
    let url = objectUrlByLocalId.get(r.localId);
    if (!url) { url = URL.createObjectURL(r.blob); objectUrlByLocalId.set(r.localId, url); }
    out.push({ localId: r.localId, sectionId: r.sectionId, url });
  }
  return out;
}

/**
 * Upload all queued photos (oldest first). For each one that uploads, calls
 * onSynced with the local placeholder URL to replace and the new HubSpot URL.
 * Stops at the first offline failure so it retries cleanly next time.
 */
export async function flushQueuedPhotos(
  inspectionRecordId: string,
  onSynced: (info: { localId: string; sectionId: string; oldUrl: string; newUrl: string }) => void,
): Promise<{ synced: number; remaining: number }> {
  if (!idbAvailable()) return { synced: 0, remaining: 0 };
  // Only flush THIS inspection's photos — the mounted form is what persists the
  // section answer record after upload, so another inspection's photos must wait
  // until that inspection is open (otherwise they'd upload but never attach).
  const all = (await getAllRecords())
    .filter((r) => r.inspectionRecordId === inspectionRecordId)
    .sort((a, b) => a.createdAt - b.createdAt);
  let synced = 0;
  for (const rec of all) {
    let newUrl: string;
    try {
      newUrl = await uploadJpegBlob(rec.blob, rec.filename);
    } catch (e) {
      if (isOfflineErr(e)) break; // still offline — keep the rest queued
      // Permanent failure: drop so it can't wedge the queue.
      console.error(`[offlinePhotoStore] dropping ${rec.localId} after permanent error`, e);
      await deleteRecord(rec.localId);
      continue;
    }
    const oldUrl = objectUrlByLocalId.get(rec.localId) || '';
    await deleteRecord(rec.localId);
    onSynced({ localId: rec.localId, sectionId: rec.sectionId, oldUrl, newUrl });
    if (oldUrl) { try { URL.revokeObjectURL(oldUrl); } catch { /* noop */ } objectUrlByLocalId.delete(rec.localId); }
    synced++;
  }
  const remaining = (await getAllRecords()).filter((r) => r.inspectionRecordId === inspectionRecordId).length;
  return { synced, remaining };
}
