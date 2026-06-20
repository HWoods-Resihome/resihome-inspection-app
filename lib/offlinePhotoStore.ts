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
import { isAnyCameraOpen, subscribeCameraOpen } from '@/lib/cameraOpenState';

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

// In-memory fallback queue: photos whose DURABLE IndexedDB write failed or
// stalled (private mode, quota, or an iOS/Android IDB chain stall). Volatile —
// lost if the tab is killed before they upload — but it keeps capture + "Done"
// instant and the photo uploading in the background, instead of blocking the
// camera on (or failing it from) a wedged IndexedDB write. getAllRecords() merges
// it in, so the flush + the queued-count submit gate treat these like any other
// queued photo. Keyed by localId.
const memQueue = new Map<string, QueuedPhoto>();

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

// On iOS the flush is SUSPENDED while a camera is open (memory safeguard), so the
// per-capture kickFlush() calls are no-ops during the session and the queue would
// otherwise sit untouched until the form's next 15s tick after Done. Kick the
// flush the instant the LAST camera closes so the queued photos start uploading
// immediately — this is what makes post-Done sync feel fast on iOS.
if (typeof window !== 'undefined') {
  subscribeCameraOpen((open) => { if (!open) kickFlush(); });
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
  // PREEMPTIVE iOS SAFEGUARD (central, covers every caller — photo, video poster,
  // and rehydrate). While a camera is open on iOS, NEVER decode a full-res bitmap
  // to build a thumbnail: createImageBitmap allocates a GPU/IOSurface that iOS is
  // slow to release, and stacked across rapid shots it jettisons the WebKit
  // content process — the 2nd-photo black screen. The flawless 6/13 build had no
  // such decode at all. Callers already handle null by falling back to the full
  // blob, which uploads immediately and is swapped for a proxied server thumbnail
  // on sync (PhotoThumb self-heals the grid). Off-camera and on Android, the
  // small-thumbnail path is unchanged.
  if (IS_IOS_WEBKIT && isAnyCameraOpen()) return Promise.resolve(null);
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

// EVERY IndexedDB op is wrapped in a hard timeout. iOS WebKit can STALL an IDB
// open/transaction under camera memory pressure — no success/error event ever
// fires — which used to hang the photo flush FOREVER: an upload that finished
// could never delete its queue record, so the flush promise never settled, the
// in-flight guard never cleared, and EVERY photo stuck on "Syncing…" (even after
// Done). This is exactly why photos taken in airplane mode synced fine later (that
// path returns before any IDB write) but photos taken online didn't. A timeout
// turns a stall into a fast rejection the flush recovers from on the next tick.
const IDB_OP_TIMEOUT_MS = 8000;
function withIdbTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`IndexedDB ${label} timed out`)), IDB_OP_TIMEOUT_MS)),
  ]);
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
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

// Serialize ALL IndexedDB transactions through one chain. iOS WebKit stalls/
// deadlocks when readwrite transactions on the same store OVERLAP — which is
// exactly what happens DURING the camera: new captures putRecord() at the same
// moment the flush deleteRecord()s a just-synced photo. That contention is why
// only the last photo synced (and only after leaving the camera, once captures
// stopped). Running every op strictly one-at-a-time (each is a few ms) removes the
// overlap, so mid-session uploads work without wedging. Opening one connection at
// a time also avoids the open-blocked path.
let _idbChain: Promise<unknown> = Promise.resolve();
function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const run = _idbChain.then(() => txInner<T>(mode, fn));
  _idbChain = run.then(() => undefined, () => undefined); // chain continues past success OR failure
  return run;
}

async function txInner<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await withIdbTimeout(openDb(), 'open');
  return withIdbTimeout(new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => { try { db.close(); } catch { /* noop */ } };
    t.onerror = () => reject(t.error || new Error('IndexedDB tx error'));
    t.onabort = () => reject(t.error || new Error('IndexedDB tx aborted'));
  }), mode);
}

async function getAllRecords(): Promise<QueuedPhoto[]> {
  let idb: QueuedPhoto[] = [];
  if (idbAvailable()) {
    try { idb = (await tx<QueuedPhoto[]>('readonly', (s) => s.getAll())) || []; }
    catch { idb = []; }
  }
  // Merge the in-memory fallback queue (photos whose durable IndexedDB write
  // failed/stalled). Dedupe by localId — a durable copy in IDB wins — so the
  // flush, the queued-count submit gate, and rehydrate all see these photos and
  // never lose them, even though they never reached IndexedDB.
  if (memQueue.size === 0) return idb;
  const seen = new Set(idb.map((r) => r.localId));
  return [...idb, ...Array.from(memQueue.values()).filter((r) => !seen.has(r.localId))];
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
    const rec: QueuedPhoto = {
      localId, inspectionRecordId, sectionId, kind: 'photo', blob, filename,
      replacesUrl: opts?.replacesUrl, lineExternalId: opts?.lineExternalId, createdAt: Date.now(),
    };
    // Persist durably in the BACKGROUND. The capture (and the camera's "Done")
    // must NEVER wait on — or fail from — a stalled IndexedDB write: the IDB ops
    // are serialized + 8s-timeout-guarded, so one wedged write used to stall every
    // subsequent capture past the camera's flush window and report good photos as
    // "did not upload" (and lose the in-flight ones). If the durable write
    // fails/stalls, hold the record in memory so the flush still uploads it.
    void putRecord(rec).catch((e) => {
      console.warn('[offlinePhotoStore] durable queue write failed; holding photo in memory', e);
      memQueue.set(localId, rec);
      kickFlush();
    });
    // Build the display URL for this draft. While a camera is open on iOS, do
    // NOT decode the full-res blob to make a thumbnail: the section grid is HIDDEN
    // during capture (RateCardForm gates it on !anyCameraOpen) and the in-camera
    // strip shows its OWN small thumb — so makeThumbBlob's full-res
    // createImageBitmap is a per-shot memory SPIKE that nothing on screen needs,
    // and stacked across rapid shots on WebKit's tight ceiling it jettisons the
    // content process (the black screen / boot-out on the 2nd photo, exactly what
    // 6/13 — which had no such decode — never hit). Use the full blob directly; it
    // uploads immediately and is swapped for a proxied server thumbnail on sync,
    // and PhotoThumb self-heals the grid. Off-camera (and on Android) we still
    // build the small local thumb + full-res viewer blob as before.
    let url: string;
    if (IS_IOS_WEBKIT && isAnyCameraOpen()) {
      url = URL.createObjectURL(blob);
      urlByLocalId.set(localId, { displayUrl: url, revokables: [url] });
    } else {
      // Display a SMALL local thumbnail in grids (so a photo-heavy offline session
      // doesn't decode dozens of full-res bitmaps and OOM-crash iOS), but ALSO keep
      // a FULL-RES local blob so the full-size viewer shows the sharp original (with
      // a readable burned-in stamp) — mapped via registerDraftFullRes. Both are
      // local blob bytes (not decoded until shown); the full-res is freed on sync.
      const thumb = await makeThumbBlob(blob, 400);
      url = URL.createObjectURL(thumb || blob);   // small thumb → grids + the photoUrls value
      const fullUrl = URL.createObjectURL(blob);  // full-res → the viewer
      urlByLocalId.set(localId, { displayUrl: url, revokables: [url, fullUrl] });
      registerDraftFullRes(url, fullUrl);
    }
    void requestPhotoBackgroundSync();
    kickFlush(); // upload promptly in the background (during the session too)
    return url;
  };

  // QUEUE-FIRST (all platforms): write the photo to the durable queue and return a
  // draft URL IMMEDIATELY (no network), so capture and the camera's "Done" are
  // instant — the inspector snaps freely, taps Done, and the photos upload IN THE
  // BACKGROUND afterward (the form kicks the flush on camera close + every 15s + on
  // reconnect). iOS is queue-first too now: the black screen was a muted camera
  // TRACK (a getUserMedia/stream issue), NOT this path. The two things that made
  // queue-first heavy on iOS are neutralized WHILE THE CAMERA IS OPEN — the
  // per-shot thumbnail DECODE is skipped (makeThumbBlob's IS_IOS_WEBKIT guard) and
  // the background flush (read-all-blobs + concurrent upload) is SUSPENDED until
  // the camera closes (flushQueuedPhotos) — so capture only does one lightweight
  // IndexedDB write per shot.
  // Queue-first on every platform: queueDraft returns a draft URL immediately
  // (durable write happens in the background; an in-memory fallback covers a
  // failed/stalled IndexedDB write or private mode), so a capture can never be
  // blocked by — or falsely reported as failing from — IndexedDB. The flush
  // uploads it (from IDB or memory) right after, and the submit gate refuses to
  // finalize while anything is still queued, so the photo is never lost.
  return queueDraft();
}

/**
 * Discard queued drafts by their display URL — used when the camera session is
 * cancelled, so photos taken-then-cancelled don't silently sync. Matches both
 * photo and video (composite) display URLs; deletes the IndexedDB record and
 * revokes the object URLs. Best-effort; unknown URLs are ignored.
 */
export async function discardQueuedByUrls(urls: string[]): Promise<number> {
  if (urls.length === 0) return 0;
  const wanted = new Set(urls);
  let n = 0;
  for (const [localId, entry] of Array.from(urlByLocalId.entries())) {
    if (!wanted.has(entry.displayUrl)) continue;
    memQueue.delete(localId);
    try { await deleteRecord(localId); } catch { /* memory-only or IDB gone */ }
    n++;
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
  // Still run when IndexedDB is unavailable IF the in-memory fallback holds
  // photos to upload (private mode / a failed durable write).
  if (!idbAvailable() && memQueue.size === 0) return { synced: 0, remaining: 0 };
  const existing = flushInFlight.get(inspectionRecordId);
  if (existing) return existing;
  // iOS uploads DURING the camera session too — photos save as they're taken, not
  // piled up until Done. This is now safe because the actual cause of the wedged
  // "Syncing…" is fixed at the root: every IndexedDB op is timeout-guarded (see
  // tx/openDb), so an iOS IDB stall during the camera can no longer hang the flush
  // forever. While a camera is open we still drain ONE AT A TIME (a single upload's
  // encode never overlaps the next capture) and skip the per-shot thumbnail decode
  // (makeThumbBlob guard); full concurrency once the camera is closed.
  const concurrency = (IS_IOS_WEBKIT && isAnyCameraOpen()) ? 1 : FLUSH_CONCURRENCY;
  const run = doFlushQueuedPhotos(inspectionRecordId, onSynced, concurrency);
  flushInFlight.set(inspectionRecordId, run);
  try { return await run; }
  finally { flushInFlight.delete(inspectionRecordId); }
}

async function doFlushQueuedPhotos(
  inspectionRecordId: string,
  onSynced: FlushOnSynced,
  concurrency: number = FLUSH_CONCURRENCY,
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
    memQueue.delete(rec.localId);     // clear the in-memory fallback copy (if any)
    try { await deleteRecord(rec.localId); } catch { /* memory-only record, or IDB gone — fine */ }
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
      const updated = { ...rec, attempts };
      // Persist the bumped attempt count durably; if the durable write isn't
      // possible (the very reason it may be memory-only), keep it in the
      // in-memory queue so the next flush still retries it — never dropped.
      try { await putRecord(updated); memQueue.delete(rec.localId); }
      catch { memQueue.set(rec.localId, updated); }
      if (attempts >= MAX_ATTEMPTS) {
        lastError = `A photo has failed to upload ${attempts}×. It's kept safe and will keep retrying — check your signal before submitting.`;
        console.warn(`[offlinePhotoStore] ${rec.localId} still failing after ${attempts} attempts — kept (never dropped)`);
      }
      // DON'T stop the whole batch — skip THIS photo and keep uploading the rest.
      // Previously a single failing/timing-out photo set stop=true and backed off
      // EVERY remaining photo; because the queue is processed oldest-first, one bad
      // shot got retried first each pass, failed, and left ALL photos stuck on
      // "Syncing…" forever. Genuine offline is handled above (that DOES stop). The
      // failed photo stays queued (never dropped) and retries on the next tick while
      // the others go through now.
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
  await Promise.all(Array.from({ length: Math.min(concurrency, all.length) }, worker));

  const remaining = (await getAllRecords()).filter((r) => r.inspectionRecordId === inspectionRecordId).length;
  return { synced, remaining, lastError };
}
