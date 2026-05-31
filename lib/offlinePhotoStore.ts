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

import { compressToJpeg, uploadJpegBlob, uploadVideo, toJpegName } from '@/lib/photoUpload';
import { makeVideoEntry } from '@/lib/media';

export type QueuedPhoto = {
  localId: string;
  inspectionRecordId: string;
  sectionId: string;
  kind: 'photo' | 'video';
  blob: Blob;            // photo: the jpeg; video: the poster jpeg
  filename: string;
  videoBlob?: Blob;      // video only
  videoType?: string;    // video only
  createdAt: number;
};

const DB_NAME = 'resiwalk_photos';
const STORE = 'queue';
const DB_VERSION = 1;

// localId -> live display URL + the raw object URLs to revoke (session-scoped;
// not persisted). For a video the display URL is the composite poster#v=video
// entry, and revokables holds both underlying object URLs.
const urlByLocalId = new Map<string, { displayUrl: string; revokables: string[] }>();

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
    await putRecord({ localId, inspectionRecordId, sectionId, kind: 'photo', blob, filename, createdAt: Date.now() });
    const url = URL.createObjectURL(blob);
    urlByLocalId.set(localId, { displayUrl: url, revokables: [url] });
    return url;
  }
}

/**
 * Like uploadPhotoOrQueue but for a video clip: uploads the poster + video and
 * returns the composite `poster#v=video` entry. Offline, both blobs are queued
 * and a composite of local object URLs is returned for immediate playback.
 */
export async function uploadVideoEntryOrQueue(
  videoFile: File,
  posterBlob: Blob,
  inspectionRecordId: string,
  sectionId: string,
): Promise<string> {
  const filename = `clip_${Date.now()}_poster.jpg`;
  try {
    const [pUrl, vUrl] = await Promise.all([uploadJpegBlob(posterBlob, filename), uploadVideo(videoFile)]);
    return makeVideoEntry(pUrl, vUrl);
  } catch (e) {
    if (!isOfflineErr(e) || !idbAvailable()) throw e;
    const localId = `idbvid_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await putRecord({
      localId, inspectionRecordId, sectionId, kind: 'video',
      blob: posterBlob, filename, videoBlob: videoFile, videoType: videoFile.type || 'video/mp4',
      createdAt: Date.now(),
    });
    const pObj = URL.createObjectURL(posterBlob);
    const vObj = URL.createObjectURL(videoFile);
    const entry = makeVideoEntry(pObj, vObj);
    urlByLocalId.set(localId, { displayUrl: entry, revokables: [pObj, vObj] });
    return entry;
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
    let entry = urlByLocalId.get(r.localId);
    if (!entry) {
      if (r.kind === 'video' && r.videoBlob) {
        const pObj = URL.createObjectURL(r.blob);
        const vObj = URL.createObjectURL(r.videoBlob);
        entry = { displayUrl: makeVideoEntry(pObj, vObj), revokables: [pObj, vObj] };
      } else {
        const url = URL.createObjectURL(r.blob);
        entry = { displayUrl: url, revokables: [url] };
      }
      urlByLocalId.set(r.localId, entry);
    }
    out.push({ localId: r.localId, sectionId: r.sectionId, url: entry.displayUrl });
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
      if (rec.kind === 'video' && rec.videoBlob) {
        const vFile = new File([rec.videoBlob], `clip.${/(webm)/i.test(rec.videoType || '') ? 'webm' : /(quicktime|mov)/i.test(rec.videoType || '') ? 'mov' : 'mp4'}`, { type: rec.videoType || 'video/mp4' });
        const [pUrl, vUrl] = await Promise.all([uploadJpegBlob(rec.blob, rec.filename), uploadVideo(vFile)]);
        newUrl = makeVideoEntry(pUrl, vUrl);
      } else {
        newUrl = await uploadJpegBlob(rec.blob, rec.filename);
      }
    } catch (e) {
      if (isOfflineErr(e)) break; // still offline — keep the rest queued
      // Permanent failure: drop so it can't wedge the queue.
      console.error(`[offlinePhotoStore] dropping ${rec.localId} after permanent error`, e);
      await deleteRecord(rec.localId);
      continue;
    }
    const entry = urlByLocalId.get(rec.localId);
    const oldUrl = entry?.displayUrl || '';
    await deleteRecord(rec.localId);
    onSynced({ localId: rec.localId, sectionId: rec.sectionId, oldUrl, newUrl });
    if (entry) {
      for (const u of entry.revokables) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
      urlByLocalId.delete(rec.localId);
    }
    synced++;
  }
  const remaining = (await getAllRecords()).filter((r) => r.inspectionRecordId === inspectionRecordId).length;
  return { synced, remaining };
}
