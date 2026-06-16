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
import { registerSyncedBlob, registerDraftFullRes, clearDraftFullRes } from '@/lib/photoDisplay';

// iOS/iPadOS WebKit (incl. Chrome on iOS, which is WebKit). Several canvas/bitmap
// paths misbehave here, so we branch on it below.
const IS_IOS_WEBKIT = typeof navigator !== 'undefined'
  && (/iP(hone|ad|od)/i.test(navigator.userAgent || '')
    || (/Macintosh/.test(navigator.userAgent || '') && ((navigator as any).maxTouchPoints || 0) > 1));

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
  attempts?: number;     // failed upload attempts (telemetry only — NEVER dropped)
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

// ---- Foreground flush coordination ------------------------------------------
// The background flush runs CONTINUOUSLY — including while the camera is open —
// so photos upload as they're taken ("Saved Offline" -> synced) and the
// inspector can exit mid-sync (Done is instant; remaining drafts keep uploading
// from the inspection page). Two lightweight signals coordinate it:
//   • kickFlush()      — ask the mounted form to drain the queue NOW (after a
//                        capture / on camera close), instead of waiting for its
//                        15s tick. Debounced so a burst kicks one flush.
//   • onPhotoSynced()  — notify listeners (the open camera) when a queued draft
//                        finishes uploading, so it can swap its draft URL for the
//                        real one (clears the badge; Done then hands back real
//                        URLs instead of a stale draft).
const flushKickListeners = new Set<() => void>();
let kickTimer: ReturnType<typeof setTimeout> | null = null;
export function onPhotoFlushResume(listener: () => void): () => void {
  flushKickListeners.add(listener);
  return () => { flushKickListeners.delete(listener); };
}
export function kickFlush(): void {
  if (kickTimer) return; // debounce a burst into one flush
  kickTimer = setTimeout(() => {
    kickTimer = null;
    for (const l of flushKickListeners) { try { l(); } catch { /* noop */ } }
  }, 700);
}

type PhotoSyncedInfo = { localId: string; oldUrl: string; newUrl: string };
const photoSyncedListeners = new Set<(info: PhotoSyncedInfo) => void>();
export function onPhotoSynced(listener: (info: PhotoSyncedInfo) => void): () => void {
  photoSyncedListeners.add(listener);
  return () => { photoSyncedListeners.delete(listener); };
}
function notifyPhotoSynced(info: PhotoSyncedInfo): void {
  for (const l of photoSyncedListeners) { try { l(info); } catch { /* noop */ } }
}

function idbAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

/**
 * Build a SMALL (~`maxEdge`px) jpeg thumbnail blob from a full-res photo blob.
 *
 * The form displays queued photos as tiny tiles. If the displayed url points at
 * the FULL-RES blob, the browser decodes the entire 1280–2048px bitmap (~5–12MB
 * each) per tile — and a photo-heavy OFFLINE inspection (where nothing can sync
 * to a small server thumbnail) decodes dozens at once and OOM-crashes the iOS
 * WebKit process ("A problem repeatedly occurred"). So we show a small LOCAL
 * thumbnail blob instead; the full-res original still rides in IndexedDB and is
 * what actually uploads. Best-effort — returns null if decoding isn't possible,
 * and the caller falls back to the full-res blob.
 */
// Serialize thumbnail decodes. Rapid capture (now uploading immediately, no
// batching) enqueues many at once; running several full-res createImageBitmap
// decodes CONCURRENTLY is what spiked iOS memory and jettisoned the WebKit
// process. Chaining them means only ONE decodes at a time — each is tiny and
// transient, so this keeps immediate per-shot saving from ever hanging the
// camera. The photo is already persisted to IndexedDB before its thumb is built,
// so a queued decode never risks the capture.
let _thumbChain: Promise<unknown> = Promise.resolve();
function makeThumbBlob(blob: Blob, maxEdge = 400): Promise<Blob | null> {
  const run = _thumbChain.then(() => _makeThumbBlob(blob, maxEdge));
  _thumbChain = run.then(() => undefined, () => undefined);
  return run;
}
async function _makeThumbBlob(blob: Blob, maxEdge = 400): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  let bmp: ImageBitmap | null = null;
  try {
    // iOS WebKit's createImageBitmap RESIZE options (resizeWidth/resizeQuality)
    // frequently decode to an ALL-BLACK bitmap — the cause of black thumbnail
    // tiles on iPhone while the full-res photo (same blob) opens fine. The catch
    // below only traps THROWS, not a silently-black result, so on iOS we skip the
    // resize path and downscale on the canvas instead. This decodes one full-res
    // bitmap transiently (released immediately via .close()), and makeThumbBlob is
    // awaited one photo at a time — NOT the dozens-at-once grid decode the resize
    // option was guarding against, so the memory cost is safe.
    if (IS_IOS_WEBKIT) {
      bmp = await createImageBitmap(blob);
    } else {
      // Elsewhere, decode straight to target size (lowest peak memory); fall back
      // to decode-then-downscale if the resize option isn't supported.
      try { bmp = await createImageBitmap(blob, { resizeWidth: maxEdge, resizeQuality: 'medium' } as any); }
      catch { bmp = await createImageBitmap(blob); }
    }
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.7));
    canvas.width = 0; canvas.height = 0; // free the backing store now (iOS)
    return out;
  } catch {
    return null;
  } finally {
    try { bmp?.close(); } catch { /* noop */ }
  }
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
    // Display a SMALL local thumbnail in grids (so a photo-heavy offline session
    // doesn't decode dozens of full-res bitmaps and OOM-crash iOS), but ALSO keep
    // a FULL-RES local blob so the full-size viewer shows the sharp original (with
    // a readable burned-in stamp) — mapped via registerDraftFullRes. Both are
    // local blob bytes (not decoded until shown); the full-res is freed on sync.
    const thumb = await makeThumbBlob(blob, 400);
    const url = URL.createObjectURL(thumb || blob);   // small thumb → grids + the photoUrls value
    const fullUrl = URL.createObjectURL(blob);         // full-res → the viewer
    urlByLocalId.set(localId, { displayUrl: url, revokables: [url, fullUrl] });
    registerDraftFullRes(url, fullUrl);
    void requestPhotoBackgroundSync();
    kickFlush(); // upload promptly in the background (during the session too)
    return url;
  };

  // QUEUE-FIRST: write the photo to the durable queue and return a draft URL
  // IMMEDIATELY (no network), so capture and the camera's "Done" are instant —
  // the inspector snaps freely, taps Done, returns to the inspection, and the
  // photos upload IN THE BACKGROUND from there (the form's flush is kicked the
  // moment the camera closes, and retries every 15s + on reconnect). Nothing
  // ever blocks on a slow/flaky upload.
  if (idbAvailable()) {
    try {
      return await queueDraft();
    } catch (e) {
      // Genuine out-of-storage → surface it so the inspector frees space; the
      // photo can't be queued and we shouldn't pretend otherwise.
      if (e instanceof StorageFullError || isQuotaError(e)) throw e;
      // The IndexedDB write failed for another reason. iOS Safari in particular
      // rejects IDB writes intermittently (and in private / locked-down modes),
      // which used to dead-end a captured photo on "couldn't be saved / Retry"
      // with NOTHING queued to sync — so it never uploaded even after reconnect.
      // Don't lose the shot: fall through to a direct inline upload instead.
      console.warn('[offlinePhotoStore] queue write failed; uploading inline instead', e);
    }
  }
  // No IndexedDB (private mode) OR the queue write failed → upload inline.
  return uploadJpegBlob(blob, filename, { attempts: 3, timeoutMs: 20000 });
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
    const pThumb = await makeThumbBlob(posterBlob, 400);
    const pObj = URL.createObjectURL(pThumb || posterBlob);
    const vObj = URL.createObjectURL(videoFile);
    const entry = makeVideoEntry(pObj, vObj);
    urlByLocalId.set(localId, { displayUrl: entry, revokables: [pObj, vObj] });
    void requestPhotoBackgroundSync();
    kickFlush();
    return entry;
  };
  // QUEUE-FIRST (see uploadPhotoOrQueue): return a draft entry now; the
  // background flush uploads the poster + clip after the camera closes.
  if (idbAvailable()) {
    try {
      return await queueDraft();
    } catch (e) {
      if (e instanceof StorageFullError || isQuotaError(e)) throw e;
      // IDB write failed (iOS Safari intermittent / private mode) — don't lose
      // the clip; fall through to a direct inline upload (see uploadPhotoOrQueue).
      console.warn('[offlinePhotoStore] video queue write failed; uploading inline instead', e);
    }
  }
  const [pUrl, vUrl] = await Promise.all([uploadJpegBlob(posterBlob, filename, { attempts: 3, timeoutMs: 20000 }), uploadVideo(videoFile)]);
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
        // Poster shown small; the clip itself isn't decoded as an image.
        const pThumb = await makeThumbBlob(r.blob, 400);
        const pObj = URL.createObjectURL(pThumb || r.blob);
        const vObj = URL.createObjectURL(r.videoBlob);
        entry = { displayUrl: makeVideoEntry(pObj, vObj), revokables: [pObj, vObj] };
      } else {
        // Small thumbnail for grids (sequential decode bounds peak memory on a
        // heavy reopen) + a full-res local blob for the viewer (registered so the
        // full-size view is sharp). Full-res original also stays in IndexedDB.
        const thumb = await makeThumbBlob(r.blob, 400);
        const url = URL.createObjectURL(thumb || r.blob);
        const fullUrl = URL.createObjectURL(r.blob);
        entry = { displayUrl: url, revokables: [url, fullUrl] };
        registerDraftFullRes(url, fullUrl);
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

type FlushResult = { synced: number; remaining: number; lastError?: string };
type FlushOnSynced = (info: { localId: string; sectionId: string; oldUrl: string; newUrl: string; replacesUrl?: string; lineExternalId?: string }) => void;

// Coalesce overlapping flushes per inspection. The 15s interval, the 'online'
// event, kickFlush() after a capture, visibility/foreground kicks, and a
// service-worker nudge can all fire within a beat of each other — without this
// guard two flushes read the SAME queued records and BOTH upload them
// (duplicate HubSpot files + a delete race). A concurrent caller just awaits the
// in-flight flush's result, so callers that read `remaining` still get truth.
const flushInFlight = new Map<string, Promise<FlushResult>>();

export async function flushQueuedPhotos(
  inspectionRecordId: string,
  onSynced: FlushOnSynced,
): Promise<FlushResult> {
  if (!idbAvailable()) return { synced: 0, remaining: 0 };
  // NOTE: uploads run IMMEDIATELY after each capture (kickFlush), INCLUDING while
  // the camera is open — the owner wants photos to start saving the instant
  // they're taken, not batched on camera close. It must never hang the camera:
  // uploads are async/background (never block the shutter), capped at low
  // concurrency, and the per-shot thumbnail decode is serialized (see
  // makeThumbBlob) so concurrent full-res decodes can't spike memory and jettison
  // the iOS WebKit process. (We previously SUSPENDED the flush while the camera
  // was open to avoid that memory spike; serializing the decode addresses the
  // spike without delaying the save.)
  const existing = flushInFlight.get(inspectionRecordId);
  if (existing) return existing;
  const run = doFlushQueuedPhotos(inspectionRecordId, onSynced);
  flushInFlight.set(inspectionRecordId, run);
  try { return await run; }
  finally { flushInFlight.delete(inspectionRecordId); }
}

async function doFlushQueuedPhotos(
  inspectionRecordId: string,
  onSynced: FlushOnSynced,
): Promise<FlushResult> {
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
    // Also tell any open camera so it can swap its draft URL for the real one
    // (clears "Saved Offline" live; Done then returns real URLs, not stale drafts).
    if (oldUrl) notifyPhotoSynced({ localId: rec.localId, oldUrl, newUrl });
    if (entry) {
      // Keep the small (~400px) local thumbnail blob ALIVE and map the photo's
      // REAL url to it, so grids keep showing that reliable local tile after the
      // offline->online swap instead of depending on the /api/photo-proxy fetch
      // (which, when it hiccuped, left broken/disappearing tiles). It's tiny and
      // GC'd on page unload (cache capped). A VIDEO's blobs are large → still
      // revoked (its poster will reload via the proxy/real url).
      if (rec.kind === 'video') {
        for (const u of entry.revokables) { try { URL.revokeObjectURL(u); } catch { /* noop */ } }
      } else {
        // Keep the small thumb (displayUrl) alive for the grid and map the real
        // url to it; revoke the full-res draft blob (the viewer now loads the real
        // HubSpot url) and drop its draft→full mapping.
        for (const u of entry.revokables) {
          if (u === entry.displayUrl) continue; // keep the thumb
          try { URL.revokeObjectURL(u); } catch { /* noop */ }
        }
        clearDraftFullRes(entry.displayUrl);
        if (oldUrl) registerSyncedBlob(newUrl, oldUrl);
      }
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
      // Genuinely offline → keep everything and stop taking new work this pass.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { lastError = 'Device is offline — photos will upload when back online.'; stop = true; return; }
      // Online but THIS upload failed (HubSpot hiccup, rate limit, oversized,
      // transient 4xx/5xx, etc.). NEVER delete an evidence photo — it's the
      // inspector's only copy. Keep it queued, count the attempt for telemetry,
      // and back off the rest of this batch so we don't hammer a flaky link; the
      // periodic flush + reconnect/foreground kicks retry it until it lands. The
      // submit gate refuses to finalize while any photo is still queued, so a
      // photo can no longer go silently missing — the old code dropped it after a
      // 4xx (incl. 429 rate-limit) or after N attempts, which is what made photos
      // vanish in the field.
      const attempts = (rec.attempts || 0) + 1;
      try { await putRecord({ ...rec, attempts }); } catch { /* keep the in-memory record; next flush retries */ }
      if (attempts >= MAX_ATTEMPTS) {
        lastError = `A photo has failed to upload ${attempts}×. It's kept safe and will keep retrying — check your signal before submitting.`;
        console.warn(`[offlinePhotoStore] ${rec.localId} still failing after ${attempts} attempts — kept (never dropped)`);
      }
      stop = true; // back off; the next flush retries from where we left off
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
