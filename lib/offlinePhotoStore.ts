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
import { isQuotaError, StorageFullError } from '@/lib/storageQuota';

export type QueuedPhoto = {
  localId: string;
  inspectionRecordId: string;
  sectionId: string;
  kind: 'photo' | 'video';
  blob: Blob;            // photo: the jpeg; video: the poster jpeg
  filename: string;
  videoBlob?: Blob;      // video only
  videoType?: string;    // video only
  // Annotation/markup: this draft REPLACES an existing URL (in the section
  // strip and, if lineExternalId is set, on that line's photos) rather than
  // being a brand-new add.
  replacesUrl?: string;
  lineExternalId?: string;
  createdAt: number;
  attempts?: number;     // failed upload attempts; dropped after MAX_ATTEMPTS
  // Set by the service worker's Background Sync handler once the blob has been
  // uploaded to HubSpot with the tab closed. When present, the foreground flush
  // skips re-uploading and only performs the (cheap) attach step on next open.
  uploadedUrl?: string;
};

const DB_NAME = 'resiwalk_photos';
const STORE = 'queue';
const DB_VERSION = 1;
const MAX_ATTEMPTS = 6;

// localId -> live display URL + the raw object URLs to revoke (session-scoped;
// not persisted). For a video the display URL is the composite poster#v=video
// entry, and revokables holds both underlying object URLs.
const urlByLocalId = new Map<string, { displayUrl: string; revokables: string[] }>();

// ---- Flush suspension --------------------------------------------------------
// While the in-app camera is open, capture queues drafts to IndexedDB but we
// SUSPEND the background flush. Otherwise the periodic flush could upload (and
// then delete + revoke) a draft the still-open camera is holding, breaking the
// URL it later hands back on Done. The camera suspends on open and resumes on
// close; resume kicks any registered flush listeners so the backlog uploads at
// once. Counter (not bool) so nested/overlapping cameras are safe.
let flushSuspendCount = 0;
const flushKickListeners = new Set<() => void>();
export function suspendPhotoFlush(): void { flushSuspendCount++; }
export function resumePhotoFlush(): void {
  flushSuspendCount = Math.max(0, flushSuspendCount - 1);
  if (flushSuspendCount === 0) { for (const l of flushKickListeners) { try { l(); } catch { /* noop */ } } }
}
/** Register a callback that runs when the flush un-suspends (camera closed), so
 *  the mounted form can drain the queue promptly. Returns an unsubscribe fn. */
export function onPhotoFlushResume(listener: () => void): () => void {
  flushKickListeners.add(listener);
  return () => { flushKickListeners.delete(listener); };
}

function idbAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

/**
 * Ask the service worker to run a Background Sync for queued photos. The browser
 * fires the registered `sync` event when connectivity returns — even if the tab
 * has since been closed — so blobs can leave the device unattended. Where the
 * API isn't supported (notably iOS Safari) this is a no-op and the in-app
 * foreground flush still covers syncing while the app is open.
 */
export async function requestPhotoBackgroundSync(): Promise<void> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const reg: any = await navigator.serviceWorker.ready;
    if (reg && 'sync' in reg) await reg.sync.register('resiwalk-photo-sync');
  } catch { /* unsupported / permission denied — foreground flush still works */ }
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
  try {
    await tx('readwrite', (s) => s.put(rec));
  } catch (e) {
    // Out of device storage — surface a clear, actionable error instead of
    // letting the capture silently vanish.
    if (isQuotaError(e)) throw new StorageFullError();
    throw e;
  }
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
  opts?: { replacesUrl?: string; lineExternalId?: string },
): Promise<string> {
  const blob = await compressToJpeg(file);
  const filename = toJpegName(file.name);
  // Cache the compressed blob to the durable IndexedDB queue and return a local
  // draft URL for immediate display. The photo is NEVER lost to a stuck spinner.
  const queueDraft = async (): Promise<string> => {
    const localId = `idbph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await putRecord({
      localId, inspectionRecordId, sectionId, kind: 'photo', blob, filename,
      replacesUrl: opts?.replacesUrl, lineExternalId: opts?.lineExternalId, createdAt: Date.now(),
    });
    const url = URL.createObjectURL(blob);
    urlByLocalId.set(localId, { displayUrl: url, revokables: [url] });
    void requestPhotoBackgroundSync();
    return url;
  };

  // QUEUE-FIRST: write the photo to the durable queue and return a draft URL
  // IMMEDIATELY (no network), so capture and the camera's "Done" are instant —
  // the inspector snaps freely, taps Done, returns to the inspection, and the
  // photos upload IN THE BACKGROUND from there (the form's flush is kicked the
  // moment the camera closes, and retries every 15s + on reconnect). Nothing
  // ever blocks on a slow/flaky upload. (No IndexedDB — e.g. private mode — is
  // the only case we must upload inline.)
  if (idbAvailable()) return queueDraft();
  return uploadJpegBlob(blob, filename, { attempts: 2, timeoutMs: 20000 });
}

/**
 * Discard queued drafts by their display URL — used when the camera session is
 * cancelled, so photos taken-then-cancelled don't silently sync. Matches both
 * photo and video (composite) display URLs; deletes the IndexedDB record and
 * revokes the object URLs. Best-effort; unknown URLs are ignored.
 */
export async function discardQueuedByUrls(urls: string[]): Promise<number> {
  if (!idbAvailable() || urls.length === 0) return 0;
  const wanted = new Set(urls);
  let n = 0;
  for (const [localId, entry] of Array.from(urlByLocalId.entries())) {
    if (!wanted.has(entry.displayUrl)) continue;
    try { await deleteRecord(localId); n++; } catch { /* noop */ }
    for (const u of entry.revokables) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
    urlByLocalId.delete(localId);
  }
  return n;
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
  const queueDraft = async (): Promise<string> => {
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
    void requestPhotoBackgroundSync();
    return entry;
  };
  // QUEUE-FIRST (see uploadPhotoOrQueue): return a draft entry now; the
  // background flush uploads the poster + clip after the camera closes.
  if (idbAvailable()) return queueDraft();
  const [pUrl, vUrl] = await Promise.all([uploadJpegBlob(posterBlob, filename, { attempts: 2, timeoutMs: 20000 }), uploadVideo(videoFile)]);
  return makeVideoEntry(pUrl, vUrl);
}

export async function countQueuedPhotos(inspectionRecordId: string): Promise<number> {
  const all = await getAllRecords();
  return all.filter((r) => r.inspectionRecordId === inspectionRecordId).length;
}

/** Discard every queued photo/video for an inspection (manual "clear stuck"). */
export async function clearQueuedPhotos(inspectionRecordId: string): Promise<number> {
  const all = await getAllRecords();
  let n = 0;
  for (const r of all) {
    if (r.inspectionRecordId !== inspectionRecordId) continue;
    const entry = urlByLocalId.get(r.localId);
    if (entry) { for (const u of entry.revokables) { try { URL.revokeObjectURL(u); } catch { /* noop */ } } urlByLocalId.delete(r.localId); }
    try { await deleteRecord(r.localId); n++; } catch { /* noop */ }
  }
  return n;
}

/**
 * Recreate object URLs for this inspection's queued photos (e.g. after a reload
 * while still offline) so they can be re-shown. Returns [{ localId, sectionId,
 * url }] for the caller to merge into its photo state.
 */
export async function rehydrateQueuedPhotos(
  inspectionRecordId: string,
): Promise<{ localId: string; sectionId: string; url: string; replacesUrl?: string; lineExternalId?: string }[]> {
  const all = await getAllRecords();
  const out: { localId: string; sectionId: string; url: string; replacesUrl?: string; lineExternalId?: string }[] = [];
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
    out.push({ localId: r.localId, sectionId: r.sectionId, url: entry.displayUrl, replacesUrl: r.replacesUrl, lineExternalId: r.lineExternalId });
  }
  return out;
}

/**
 * Upload all queued photos for an inspection. For each one that uploads, calls
 * onSynced with the local placeholder URL to replace and the new HubSpot URL.
 *
 * Uploads run with bounded CONCURRENCY (not one-at-a-time) so a backlog from a
 * weak-signal property drains in parallel instead of serially — the old serial
 * loop could take ~1 minute PER photo on a bad signal, which is what made the
 * sync feel "very slow." Each upload also fails fast (2 attempts) so a single
 * stuck photo can't hog a slot; the periodic flush retries it next tick.
 */
const FLUSH_CONCURRENCY = 2; // gentle on HubSpot Files (too many parallel uploads timed out)

export async function flushQueuedPhotos(
  inspectionRecordId: string,
  onSynced: (info: { localId: string; sectionId: string; oldUrl: string; newUrl: string; replacesUrl?: string; lineExternalId?: string }) => void,
): Promise<{ synced: number; remaining: number; lastError?: string }> {
  if (!idbAvailable()) return { synced: 0, remaining: 0 };
  // Suspended while a camera session is open — don't upload/revoke drafts the
  // open camera is still holding. Resumes (and kicks a flush) on camera close.
  if (flushSuspendCount > 0) {
    const remaining = (await getAllRecords()).filter((r) => r.inspectionRecordId === inspectionRecordId).length;
    return { synced: 0, remaining };
  }
  let lastError: string | undefined;
  // Only flush THIS inspection's photos — the mounted form is what persists the
  // section answer record after upload, so another inspection's photos must wait
  // until that inspection is open (otherwise they'd upload but never attach).
  const all = (await getAllRecords())
    .filter((r) => r.inspectionRecordId === inspectionRecordId)
    .sort((a, b) => a.createdAt - b.createdAt);
  let synced = 0;
  let stop = false; // set when offline/transient — stop taking NEW work, retry next tick

  const finishSynced = async (rec: QueuedPhoto, newUrl: string) => {
    const entry = urlByLocalId.get(rec.localId);
    const oldUrl = entry?.displayUrl || '';
    await deleteRecord(rec.localId);
    onSynced({ localId: rec.localId, sectionId: rec.sectionId, oldUrl, newUrl, replacesUrl: rec.replacesUrl, lineExternalId: rec.lineExternalId });
    if (entry) {
      for (const u of entry.revokables) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
      urlByLocalId.delete(rec.localId);
    }
    synced++;
  };

  const processOne = async (rec: QueuedPhoto) => {
    // Already uploaded by the background-sync service worker (tab was closed) —
    // skip the network and go straight to attaching it.
    if (rec.uploadedUrl) { await finishSynced(rec, rec.uploadedUrl); return; }
    let newUrl: string;
    try {
      if (rec.kind === 'video' && rec.videoBlob) {
        const vFile = new File([rec.videoBlob], `clip.${/(webm)/i.test(rec.videoType || '') ? 'webm' : /(quicktime|mov)/i.test(rec.videoType || '') ? 'mov' : 'mp4'}`, { type: rec.videoType || 'video/mp4' });
        const [pUrl, vUrl] = await Promise.all([uploadJpegBlob(rec.blob, rec.filename, { attempts: 3, timeoutMs: 25000 }), uploadVideo(vFile)]);
        newUrl = makeVideoEntry(pUrl, vUrl);
      } else {
        newUrl = await uploadJpegBlob(rec.blob, rec.filename, { attempts: 3, timeoutMs: 25000 });
      }
    } catch (e: any) {
      lastError = `Photo upload failed (${String(e?.message || e).slice(0, 90)}).`;
      // Genuinely offline → keep everything and stop taking new work.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { lastError = 'Device is offline — photos will upload when back online.'; stop = true; return; }
      if (isOfflineErr(e)) {
        // Online but the upload failed in a network-ish way (HubSpot hiccup,
        // oversized blob, etc.). Count the attempt; after too many, drop+skip
        // so one wedged photo can't block the queue (and the banner) forever.
        const attempts = (rec.attempts || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          console.error(`[offlinePhotoStore] dropping ${rec.localId} after ${MAX_ATTEMPTS} failed attempts`);
          await deleteRecord(rec.localId);
          return;
        }
        try { await putRecord({ ...rec, attempts }); } catch { /* noop */ }
        stop = true; // back off the rest of the batch; the periodic flush retries
        return;
      }
      // Permanent failure (decodable 4xx etc.): drop so it can't wedge the queue.
      console.error(`[offlinePhotoStore] dropping ${rec.localId} after permanent error`, e);
      await deleteRecord(rec.localId);
      return;
    }
    await finishSynced(rec, newUrl);
  };

  // Worker pool: each worker pulls the next record until the list is exhausted
  // or a worker signals stop (offline/backoff). Records are independent, so
  // parallelism is safe; ordering doesn't matter for attach.
  let idx = 0;
  const worker = async () => {
    while (!stop) {
      const i = idx++;
      if (i >= all.length) break;
      await processOne(all[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FLUSH_CONCURRENCY, all.length) }, worker));

  const remaining = (await getAllRecords()).filter((r) => r.inspectionRecordId === inspectionRecordId).length;
  return { synced, remaining, lastError };
}
