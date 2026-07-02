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
import { enqueuePhotoAttach, type PhotoAttachTarget } from '@/lib/photoAttachOutbox';
import { isNativeBgUploadAvailable, mirrorPhotoToNativeBgUpload, clearNativeBgUploadPhoto, reconcileNativeBgUpload, scheduleNativeBgProcessing } from '@/lib/nativeBridge';
import { isLocalInspectionId, realIdFor } from '@/lib/pendingInspections';

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
  // Bytes of the jpeg (photo) / poster (video). Stored as an ArrayBuffer, NOT a
  // Blob: on iOS WebKit a Blob persisted in IndexedDB is a REFERENCE into a
  // separate file store that the OS can reclaim under storage pressure — it then
  // reads back EMPTY, so the upload sent 0 bytes and the server rejected it
  // forever (the "photo failed to upload 39×" loop, while freshly-captured photos
  // in the same session still uploaded). ArrayBuffers live inline in the record's
  // structured-clone value, so they survive. `blob` is kept optional only to read
  // legacy records written before this change (see blobFor()).
  bytes?: ArrayBuffer;
  blob?: Blob;           // legacy/back-compat (older queued records)
  filename: string;
  videoBytes?: ArrayBuffer; // video only — the clip bytes (durable, as above)
  videoBlob?: Blob;      // legacy/back-compat (older queued video records)
  videoType?: string;    // video only
  // Annotation/markup: this draft REPLACES an existing URL (in the section
  // strip and, if lineExternalId is set, on that line's photos) rather than
  // being a brand-new add.
  replacesUrl?: string;
  lineExternalId?: string;
  // Which field on the target line this photo belongs to: a regular line photo
  // ('photos') or an Internal-Resolution AFTER photo ('after'). Lets the rehydrate
  // + sync-swap re-attach a plain (non-annotation) line draft to the CORRECT array
  // even after a reload drops it from React state — otherwise after-photos that
  // upload while the form re-mounted get orphaned (uploaded but never attached).
  lineField?: 'photos' | 'after';
  // Durable background ATTACH descriptor: lets the photo attach to its record
  // server-side from any page / device, without the form open. 'section' →
  // section_photo (QC after-photos use this too); 'line' → a qa/rate_card_line
  // answer's photo_urls (inline per-question photos). Scope line/after photos
  // instead derive their target from lineExternalId + lineField.
  attach?: { kind: 'section' | 'line'; externalId: string; field?: 'photo_urls' | 'after_photo_urls'; section?: string; location?: string; summaryLabel?: string; inspectionIdExternal?: string };
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

// Reconstruct a fresh, valid Blob from a queued record. Prefers the durable
// ArrayBuffer bytes (new records); falls back to a legacy stored Blob. Returns
// null only when the record carries NEITHER usable bytes nor a non-empty blob —
// i.e. the data is genuinely gone (an old iOS-evicted record), so retrying it
// could never succeed.
function blobFor(rec: QueuedPhoto): Blob | null {
  if (rec.bytes && rec.bytes.byteLength > 0) return new Blob([rec.bytes], { type: 'image/jpeg' });
  if (rec.blob && rec.blob.size > 0) return rec.blob;
  return null;
}
function videoBlobFor(rec: QueuedPhoto): Blob | null {
  const type = rec.videoType || 'video/mp4';
  if (rec.videoBytes && rec.videoBytes.byteLength > 0) return new Blob([rec.videoBytes], { type });
  if (rec.videoBlob && rec.videoBlob.size > 0) return rec.videoBlob;
  return null;
}

// FC photo section tag — mirrors the forms' local FC_PHOTO_SECTION constant;
// inlined here to avoid importing a form module into the store.
const FC_PHOTO_SECTION = '__final_checklist__';

// The single source of truth for "where does this queued photo attach?" Used by
// BOTH the foreground flush (finishSynced → durable attach outbox) and the iOS
// native background-upload mirror, so the two paths can never drift:
//   • Final Checklist photo → 'fc' slot in the FINALCHECKLIST blob,
//   • line / after photo     → 'line' (field from lineField),
//   • section photo          → 'section' (explicit descriptor).
function attachTargetForRecord(
  rec: Pick<QueuedPhoto, 'kind' | 'sectionId' | 'lineExternalId' | 'lineField' | 'attach' | 'inspectionRecordId'>,
): PhotoAttachTarget | null {
  if (rec.kind === 'video') return null;
  if (rec.sectionId === FC_PHOTO_SECTION && rec.lineExternalId) {
    return { kind: 'fc', externalId: `FINALCHECKLIST-${rec.inspectionRecordId}`, fcSlot: rec.lineExternalId };
  }
  if (rec.lineExternalId) {
    return { kind: 'line', externalId: rec.lineExternalId, field: rec.lineField === 'after' ? 'after_photo_urls' : 'photo_urls' };
  }
  if (rec.attach && rec.attach.externalId) {
    return { kind: rec.attach.kind, externalId: rec.attach.externalId, field: rec.attach.field || 'photo_urls', section: rec.attach.section, location: rec.attach.location, summaryLabel: rec.attach.summaryLabel, inspectionIdExternal: rec.attach.inspectionIdExternal };
  }
  return null;
}

// ArrayBuffer → base64 (for handing photo bytes to the native iOS background
// uploader over the Capacitor bridge). Only ever called on iOS (gated by
// isNativeBgUploadAvailable), so the per-photo cost is never paid on web/Android.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  if (typeof btoa === 'undefined') return '';
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000; // build in chunks so a 2MB image doesn't blow the call stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

// localId -> live display URL + the raw object URLs to revoke (session-scoped;
// not persisted). For a video the display URL is the composite poster#v=video
// entry, and revokables holds both underlying object URLs.
const urlByLocalId = new Map<string, { displayUrl: string; revokables: string[] }>();

// localIds discarded (camera cancel / photo delete) WHILE a background flush may
// already be mid-upload on them. discardQueuedByUrls deletes the queue record,
// but a flush that had already loaded the record finishes and would enqueue a
// durable attach keyed by the photo's REAL (uploaded) url — which the caller
// can't remove because it only knows the DRAFT url. Recording the localId here
// lets finishSynced skip the attach for a photo the inspector already discarded,
// so a cancelled/deleted photo can't silently re-appear on the record.
const discardedLocalIds = new Set<string>();
function markLocalIdDiscarded(localId: string): void {
  discardedLocalIds.add(localId);
  // The race window is milliseconds; bound the set so a long session with many
  // retakes can't grow it unbounded (stale ids beyond the window are inert).
  if (discardedLocalIds.size > 2000) discardedLocalIds.clear();
}

// In-memory fallback queue: photos whose DURABLE IndexedDB write failed or
// stalled (private mode, quota, or an iOS/Android IDB chain stall). Volatile —
// lost if the tab is killed before they upload — but it keeps capture + "Done"
// instant and the photo uploading in the background, instead of blocking the
// camera on (or failing it from) a wedged IndexedDB write. listQueueMeta() merges
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

// Photos upload DURING the camera session (bounded concurrency), but kick one more
// flush the instant the LAST camera closes so anything still queued drains promptly
// without waiting for the form's next 15s tick — keeps post-Done sync feeling fast.
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

// Lightweight view of a queued record: everything EXCEPT the heavy byte payloads.
type QueuedPhotoMeta = Omit<QueuedPhoto, 'bytes' | 'blob' | 'videoBytes' | 'videoBlob'>;

function stripBytes(rec: QueuedPhoto): QueuedPhotoMeta {
  const m: Partial<QueuedPhoto> = { ...rec };
  delete m.bytes; delete m.blob; delete m.videoBytes; delete m.videoBlob;
  return m as QueuedPhotoMeta;
}

// Enumerate the queue as METADATA ONLY (no bytes), via a cursor so each record's
// bytes are deserialized one at a time and released as we advance — peak memory
// is ~one photo, not the whole backlog. getAll() (above) instead materializes
// EVERY record's bytes at once, which OOM-crashed the iOS WebKit renderer when a
// big offline queue (180+ shots) tried to sync. Use this for worklists/counts;
// load the actual bytes just-in-time with getRecord(). Merges the in-memory
// fallback queue (dedupe by localId).
async function listQueueMeta(): Promise<QueuedPhotoMeta[]> {
  const out: QueuedPhotoMeta[] = [];
  if (idbAvailable()) {
    try {
      const db = await withIdbTimeout(openDb(), 'open');
      await withIdbTimeout(new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result as IDBCursorWithValue | null;
          if (!cursor) return; // exhausted — t.oncomplete resolves
          out.push(stripBytes(cursor.value as QueuedPhoto));
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
        t.oncomplete = () => { try { db.close(); } catch { /* noop */ } resolve(); };
        t.onerror = () => reject(t.error || new Error('IndexedDB tx error'));
        t.onabort = () => reject(t.error || new Error('IndexedDB tx aborted'));
      }), 'readonly');
    } catch { /* fall back to the in-memory queue only */ }
  }
  if (memQueue.size === 0) return out;
  const seen = new Set(out.map((r) => r.localId));
  for (const r of memQueue.values()) if (!seen.has(r.localId)) out.push(stripBytes(r));
  return out;
}

// Fetch ONE full record (with its bytes) by localId — used to load a photo's
// bytes just-in-time, so only the photos actively uploading are ever resident.
async function getRecord(localId: string): Promise<QueuedPhoto | undefined> {
  if (!idbAvailable()) return undefined;
  try { return (await tx<QueuedPhoto | undefined>('readonly', (s) => s.get(localId))) || undefined; }
  catch { return undefined; }
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
  opts?: { replacesUrl?: string; lineExternalId?: string; lineField?: 'photos' | 'after'; attach?: QueuedPhoto['attach'] },
): Promise<string> {
  const blob = await compressToJpeg(file);
  const filename = toJpegName(file.name);
  // Cache the compressed blob to the durable IndexedDB queue and return a local
  // draft URL for immediate display. The photo is NEVER lost to a stuck spinner.
  const queueDraft = async (): Promise<string> => {
    const localId = `idbph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    // Store the bytes (ArrayBuffer), NOT the Blob — see QueuedPhoto.bytes. The
    // local `blob` var below still drives the immediate on-screen draft.
    const bytes = await blob.arrayBuffer();
    const rec: QueuedPhoto = {
      localId, inspectionRecordId, sectionId, kind: 'photo', bytes, filename,
      replacesUrl: opts?.replacesUrl, lineExternalId: opts?.lineExternalId, lineField: opts?.lineField, attach: opts?.attach, createdAt: Date.now(),
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
    // iOS-only: ALSO hand the (already-compressed) bytes + attach target to the
    // native background uploader, so the photo lands even after the app is force-
    // quit (iOS WebKit has no SW Background Sync — the one gap the foreground
    // global-sync driver can't cover). No-op on web/PWA and Android; base64 is
    // only computed when the native plugin is actually present, so no other
    // platform pays the cost. Idempotent with the foreground path (server dedupes
    // by URL; finishSynced clears the mirror), so they can't double-attach.
    if (isNativeBgUploadAvailable() && !isLocalInspectionId(inspectionRecordId)) {
      try {
        const target = attachTargetForRecord(rec);
        if (target) {
          mirrorPhotoToNativeBgUpload({
            localId, inspectionRecordId, base64: arrayBufferToBase64(bytes), filename,
            replacesUrl: opts?.replacesUrl, target,
          });
          scheduleNativeBgProcessing();
        }
      } catch { /* best-effort — the foreground flush still uploads it */ }
    }
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
    // A background flush may already be mid-upload on this record; record the
    // localId so finishSynced skips enqueueing its (real-url) attach.
    markLocalIdDiscarded(localId);
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
    // Durable ArrayBuffer bytes for both the poster and the clip (see
    // QueuedPhoto.bytes) — the local posterBlob/videoFile drive the live draft.
    const [bytes, videoBytes] = await Promise.all([posterBlob.arrayBuffer(), videoFile.arrayBuffer()]);
    await putRecord({
      localId, inspectionRecordId, sectionId, kind: 'video',
      bytes, filename, videoBytes, videoType: videoFile.type || 'video/mp4',
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

// Inspection ids whose FORM is currently mounted. The global background driver
// must NOT flush/attach these — the open form is the sole writer of its records
// (it swaps draft→real in state and writes the FULL photo list). A background
// no-op flush would delete the queue record without the form swapping its state,
// and the form's next full-list save (which strips blob: drafts) would then
// OVERWRITE the just-attached photo — i.e. the photo disappears. The page
// registers its inspection here on mount/unmount.
const activeFormInspections = new Set<string>();
export function setInspectionFormActive(id: string, active: boolean): void {
  if (!id) return;
  if (active) activeFormInspections.add(id); else activeFormInspections.delete(id);
}
export function isInspectionFormActive(id: string): boolean {
  return activeFormInspections.has(id);
}
export function getActiveFormInspectionIds(): Set<string> {
  const ids = new Set(activeFormInspections);
  // Also cover the REAL id of any active offline-started ("local_") inspection.
  // When a deferred create lands, it re-keys the queue temp→real and fires
  // `resiwalk:inspection-created` in the SAME sync tick — BEFORE router.replace
  // swaps the route and the form re-registers under the real id. In that window
  // the form is still registered under the temp id, but queuedInspectionIds()
  // already returns the real id, so the global driver would flush the real id
  // (no-op onSynced) behind the still-open form's back and its next full-list
  // save (which strips blob: drafts) could drop a just-attached photo. Expanding
  // to the real id keeps the "don't flush the open inspection" guard intact
  // until the route swap settles (then the form registers the real id directly).
  for (const id of activeFormInspections) {
    if (isLocalInspectionId(id)) {
      const real = realIdFor(id);
      if (real) ids.add(real);
    }
  }
  return ids;
}

/** Distinct inspection ids that currently have queued (un-uploaded) photos.
 *  Lets the global background driver upload photos for EVERY inspection from any
 *  page — the only background-upload path on iOS, which has no SW Background Sync. */
export async function queuedInspectionIds(): Promise<string[]> {
  const all = await listQueueMeta();
  return Array.from(new Set(all.map((r) => r.inspectionRecordId).filter(Boolean)));
}

/** Total queued (un-uploaded) photos across all inspections — for the global
 *  sync indicator. Metadata-only (no bytes loaded). */
export async function countAllQueuedPhotos(): Promise<number> {
  return (await listQueueMeta()).length;
}

export async function countQueuedPhotos(inspectionRecordId: string): Promise<number> {
  // Metadata-only (no bytes) — this is called frequently (submit gate + flush
  // polling); loading every photo's bytes just to count them was a recurring
  // memory spike on big queues.
  const all = await listQueueMeta();
  return all.filter((r) => r.inspectionRecordId === inspectionRecordId).length;
}

/**
 * Re-key every queued photo from a temp (local) inspection id to the real
 * HubSpot record id once a deferred create lands. Rewrites the record's
 * `inspectionRecordId` AND any record-id-derived key inside its `attach`
 * descriptor (e.g. a Final Checklist `FINALCHECKLIST-<id>` externalId) via a
 * blanket token replace — the temp id is a unique opaque token, so this can't
 * touch the (external-id-derived) keys that must stay stable. Preserves bytes.
 */
export async function rekeyInspectionId(tempId: string, realId: string): Promise<number> {
  if (!tempId || !realId || tempId === realId) return 0;
  const metas = await listQueueMeta();
  const targets = metas.filter((r) => r.inspectionRecordId === tempId);
  let n = 0;
  for (const meta of targets) {
    const rec = memQueue.get(meta.localId) || await getRecord(meta.localId);
    if (!rec) continue;
    // Token-replace everything EXCEPT the bytes (which we re-attach as-is).
    const { bytes, videoBytes, blob, videoBlob, ...rest } = rec as any;
    const rewritten: QueuedPhoto = { ...JSON.parse(JSON.stringify(rest).split(tempId).join(realId)), bytes, videoBytes, blob, videoBlob };
    if (memQueue.has(meta.localId)) memQueue.set(meta.localId, rewritten);
    try { await putRecord(rewritten); n++; } catch { /* keep going */ }
  }
  return n;
}

/** Discard every queued photo/video for an inspection (manual "clear stuck"). */
export async function clearQueuedPhotos(inspectionRecordId: string): Promise<number> {
  const all = await listQueueMeta();
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
): Promise<{ localId: string; sectionId: string; url: string; replacesUrl?: string; lineExternalId?: string; lineField?: 'photos' | 'after' }[]> {
  // Metadata first (no bytes), then load each record's bytes ONE AT A TIME below
  // so a heavy reopen (180+ queued shots) never materializes the whole queue's
  // bytes at once — the iOS WebKit OOM crash.
  const metas = (await listQueueMeta()).filter((r) => r.inspectionRecordId === inspectionRecordId);
  const out: { localId: string; sectionId: string; url: string; replacesUrl?: string; lineExternalId?: string; lineField?: 'photos' | 'after' }[] = [];
  for (const meta of metas) {
    let entry = urlByLocalId.get(meta.localId);
    if (!entry) {
      const r = memQueue.get(meta.localId) || await getRecord(meta.localId);
      if (!r) continue; // synced/removed since we listed — nothing to show
      const pb = blobFor(r);
      if (!pb) continue; // data gone (legacy iOS-evicted record) — nothing to show
      const vb = r.kind === 'video' ? videoBlobFor(r) : null;
      if (r.kind === 'video' && vb) {
        // Poster shown small; the clip itself isn't decoded as an image.
        const pThumb = await makeThumbBlob(pb, 400);
        const pObj = URL.createObjectURL(pThumb || pb);
        const vObj = URL.createObjectURL(vb);
        entry = { displayUrl: makeVideoEntry(pObj, vObj), revokables: [pObj, vObj] };
      } else {
        // Small thumbnail for grids (sequential decode bounds peak memory on a
        // heavy reopen) + a full-res local blob for the viewer (registered so the
        // full-size view is sharp). Full-res original also stays in IndexedDB.
        const thumb = await makeThumbBlob(pb, 400);
        const url = URL.createObjectURL(thumb || pb);
        const fullUrl = URL.createObjectURL(pb);
        entry = { displayUrl: url, revokables: [url, fullUrl] };
        registerDraftFullRes(url, fullUrl);
      }
      urlByLocalId.set(meta.localId, entry);
    }
    out.push({ localId: meta.localId, sectionId: meta.sectionId, url: entry.displayUrl, replacesUrl: meta.replacesUrl, lineExternalId: meta.lineExternalId, lineField: meta.lineField });
  }
  return out;
}

/**
 * Upload all queued photos for an inspection. For each one that uploads, calls
 * onSynced with the local placeholder URL to replace and the new HubSpot URL.
 *
 * ADAPTIVE concurrency (AIMD). Uploads used to run strictly ONE AT A TIME so a
 * weak signal gave each photo the full uplink. But on GOOD service that serial
 * pace can't keep up with a fast shutter — a photo-heavy Scope out-shoots a lone
 * uploader and a backlog snowballs (the "209 stacked up on good service even
 * though they should've been syncing all along" report, on iOS). iOS WebKit
 * exposes NO Network Information API, so we can't read signal strength to choose a
 * width — instead we LEARN it from outcomes: the pool runs several uploads at once
 * on a healthy link (queue keeps pace, no backlog) and each timeout/failure (the
 * weak-signal signature) multiplicatively backs the live target toward 1 — the
 * full-pipe-per-photo single-flight behavior the original tuning needed. A clean
 * upload additively ramps it back up. Each upload still makes just ONE attempt per
 * pass (a photo that can't go through now is skipped, not retried in place, so it
 * can't monopolize a worker for minutes) and is NEVER dropped — so this only
 * changes HOW MANY upload at once and WHEN each lands, never whether.
 */
const MAX_FLUSH_CONCURRENCY = 4;  // healthy-link ceiling — keeps the pipe full on a fast Scope
const MIN_FLUSH_CONCURRENCY = 1;  // weak-signal floor — full bandwidth per photo (the old behavior)
// Live target, shared across passes AND adjusted within a pass so a mid-Scope
// signal change is reacted to immediately. Starts mid-range, not at the ceiling,
// so a genuinely weak link converges DOWN within the first couple of photos
// before it can split the pipe N ways.
let _adaptiveConcurrency = 2;
function noteUploadOutcome(ok: boolean): void {
  if (ok) _adaptiveConcurrency = Math.min(MAX_FLUSH_CONCURRENCY, _adaptiveConcurrency + 1);
  else _adaptiveConcurrency = Math.max(MIN_FLUSH_CONCURRENCY, Math.floor(_adaptiveConcurrency / 2));
}

/**
 * Reconcile drafts the iOS native background uploader already uploaded + attached
 * after a force-quit. For each one native reports done, delete the local queue
 * record (so the foreground flush won't re-upload it) and swap any visible draft
 * tile to the real URL. No-op off-iOS / when nothing reconciled. Driven by the
 * global sync loop on resume. Idempotent and best-effort.
 */
export async function reconcileNativeBackgroundUploads(): Promise<number> {
  const done = await reconcileNativeBgUpload();
  if (done.length === 0) return 0;
  let n = 0;
  for (const { localId, url } of done) {
    const entry = urlByLocalId.get(localId);
    const oldUrl = entry?.displayUrl || '';
    memQueue.delete(localId);
    try { await deleteRecord(localId); } catch { /* memory-only / IDB gone — fine */ }
    if (oldUrl) {
      // Swap the on-screen draft to the real URL and keep the local thumb mapped
      // to it (same grid self-heal the foreground flush does in finishSynced).
      notifyPhotoSynced({ localId, oldUrl, newUrl: url });
      try { registerSyncedBlob(url, oldUrl); } catch { /* noop */ }
    }
    if (entry) {
      for (const u of entry.revokables) {
        if (u === entry.displayUrl) continue; // keep the small thumb alive for the grid
        try { URL.revokeObjectURL(u); } catch { /* noop */ }
      }
      clearDraftFullRes(entry.displayUrl);
      urlByLocalId.delete(localId);
    }
    n++;
  }
  return n;
}

type FlushResult = { synced: number; remaining: number; lastError?: string };
type FlushOnSynced = (info: { localId: string; sectionId: string; oldUrl: string; newUrl: string; replacesUrl?: string; lineExternalId?: string; lineField?: 'photos' | 'after' }) => void;

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
  opts?: { skipVideos?: boolean },
): Promise<FlushResult> {
  // NEVER flush photos for an offline-started ("local_") inspection: there's no
  // server record to attach them to yet. Uploading now would create an attach
  // instruction keyed to the temp id that the deferred-create re-key can't catch
  // (it ran already) → it 404s on /api/inspections/local_*/attach-photo and the
  // photo is dropped (the lost-photos bug). They stay queued until the deferred
  // create mints the real id + re-keys them, then flush under the real id.
  if (isLocalInspectionId(inspectionRecordId)) {
    const remaining = (await listQueueMeta()).filter((r) => r.inspectionRecordId === inspectionRecordId).length;
    return { synced: 0, remaining };
  }
  // Still run when IndexedDB is unavailable IF the in-memory fallback holds
  // photos to upload (private mode / a failed durable write).
  if (!idbAvailable() && memQueue.size === 0) return { synced: 0, remaining: 0 };
  // Coalesce per inspection AND per flush KIND. The background driver flushes with
  // a no-op onSynced (+ skipVideos); the open form flushes with a real onSynced
  // that swaps draft→real in its state. If both coalesced on the id alone, a form
  // flush that arrived while a background run was in-flight would ADOPT the no-op
  // run — its onSynced never fires, the form keeps blob: drafts, and its next
  // full-list save (which strips blob:) overwrites the just-attached photo on the
  // server (data loss). Separate keys let the form run its OWN pass (concurrent
  // runs are safe: uploadJpegBlob dedupes by localId, and a record already taken
  // by the other run is skipped).
  const flushKey = `${inspectionRecordId}|${opts?.skipVideos ? 'bg' : 'fg'}`;
  const existing = flushInFlight.get(flushKey);
  if (existing) return existing;
  // iOS uploads DURING the camera session too — photos save as they're taken, not
  // piled up until Done. Drain at the adaptive concurrency whether or not the
  // camera is open, so a long continuous Scope keeps pace with the shutter instead
  // of building a big backlog that only fully drains after the camera closes (what
  // let 180+ photos queue on good service). This is safe even when several upload
  // at once because: every IDB op is timeout-guarded (see tx/openDb); the per-shot
  // full-res thumbnail decode is still skipped while the camera is open
  // (makeThumbBlob guard); and the flush loads each photo's bytes just-in-time, so
  // only ~concurrency compressed images are ever resident — never the whole queue.
  const run = doFlushQueuedPhotos(inspectionRecordId, onSynced, opts);
  flushInFlight.set(flushKey, run);
  try { return await run; }
  finally { flushInFlight.delete(flushKey); }
}

async function doFlushQueuedPhotos(
  inspectionRecordId: string,
  onSynced: FlushOnSynced,
  opts?: { skipVideos?: boolean },
): Promise<FlushResult> {
  let lastError: string | undefined;
  // Only flush THIS inspection's photos — the mounted form is what persists the
  // section answer record after upload, so another inspection's photos must wait
  // until that inspection is open (otherwise they'd upload but never attach).
  // Worklist is METADATA ONLY (no bytes); each photo's bytes are loaded
  // just-in-time in processOne so the whole backlog is never resident at once.
  //
  // skipVideos: the GLOBAL background driver (no-op onSynced) sets this. Unlike
  // photos, a video has NO durable attach-outbox entry (finishSynced only queues
  // an attach for non-video records — a video carries just a sectionId, not a
  // full attach descriptor), so its ONLY attach path is the open form's live
  // onSynced (section swap). Uploading a video here would DELETE the queue record
  // with nothing to attach it → the clip uploads to HubSpot Files orphaned and is
  // permanently lost. So leave videos QUEUED for the background driver; they
  // upload + attach when the inspection's form is next open (which includes the
  // submit flush), never silently dropped.
  const all = (await listQueueMeta())
    .filter((r) => r.inspectionRecordId === inspectionRecordId)
    .filter((r) => !(opts?.skipVideos && r.kind === 'video'))
    .sort((a, b) => a.createdAt - b.createdAt);
  let synced = 0;
  let stop = false; // set when offline/transient — stop taking NEW work, retry next tick

  const finishSynced = async (rec: QueuedPhotoMeta, newUrl: string) => {
    // Discarded mid-upload (camera cancel / photo delete): the inspector removed
    // this photo while a flush was already uploading it. Do NOT enqueue an attach
    // or notify — that would re-add the cancelled photo to the record. The bytes
    // are already in HubSpot Files (harmless, unreferenced); just clean up.
    if (discardedLocalIds.has(rec.localId)) {
      discardedLocalIds.delete(rec.localId);
      clearNativeBgUploadPhoto(rec.localId);
      memQueue.delete(rec.localId);
      try { await deleteRecord(rec.localId); } catch { /* already gone */ }
      const e2 = urlByLocalId.get(rec.localId);
      if (e2) { for (const u of e2.revokables) { try { URL.revokeObjectURL(u); } catch { /* noop */ } } urlByLocalId.delete(rec.localId); }
      return;
    }
    const entry = urlByLocalId.get(rec.localId);
    const oldUrl = entry?.displayUrl || '';
    // Durable, form-independent ATTACH: record the instruction the MOMENT bytes
    // upload — BEFORE deleting the queue record — so the photo lands on its record
    // even if the inspector has left the form (the global driver replays it,
    // idempotently, and skips the currently-open inspection). ONE mechanism for
    // every photo type:
    //   • Final Checklist photo  → 'fc' slot in the FINALCHECKLIST blob,
    //   • line / after photo      → 'line' (field from lineField),
    //   • section photo           → 'section' (explicit descriptor).
    if (rec.kind !== 'video') {
      try {
        const target = attachTargetForRecord(rec);
        if (target) {
          enqueuePhotoAttach({ inspectionRecordId: rec.inspectionRecordId, url: newUrl, replacesUrl: rec.replacesUrl, target });
        }
      } catch { /* best-effort — the form's live attach still runs when open */ }
    }
    // The foreground path uploaded + queued the attach for this photo, so the iOS
    // native background uploader no longer needs its mirrored copy (idempotent
    // either way; this just keeps the native queue small). No-op off-iOS.
    clearNativeBgUploadPhoto(rec.localId);
    memQueue.delete(rec.localId);     // clear the in-memory fallback copy (if any)
    try { await deleteRecord(rec.localId); } catch { /* memory-only record, or IDB gone — fine */ }
    onSynced({ localId: rec.localId, sectionId: rec.sectionId, oldUrl, newUrl, replacesUrl: rec.replacesUrl, lineExternalId: rec.lineExternalId, lineField: rec.lineField });
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

  const processOne = async (meta: QueuedPhotoMeta) => {
    // Already uploaded by the background-sync service worker (tab was closed) —
    // skip the network and go straight to attaching it. No bytes needed.
    if (meta.uploadedUrl) { await finishSynced(meta, meta.uploadedUrl); return; }
    // Load THIS photo's bytes JUST-IN-TIME (in-memory fallback wins, else IDB) so
    // only the ~concurrency photos actively uploading are ever resident — never
    // the whole backlog, which is what OOM-crashed the iOS WebKit renderer mid-
    // sync on big offline queues (180+ shots). It may have been synced/removed by
    // a concurrent pass since we listed; if so, skip.
    const rec = memQueue.get(meta.localId) || await getRecord(meta.localId);
    if (!rec) return;
    // Reconstruct the bytes. If they're genuinely gone (an old record whose iOS
    // Blob was evicted — the root cause this change prevents going forward), the
    // upload can NEVER succeed: stop the futile "check your signal" retry loop,
    // surface a clear retake message, and remove the dead record so it can't
    // block submit. New records carry durable ArrayBuffer bytes, so this only
    // ever fires for pre-existing broken entries.
    const photoBlob = blobFor(rec);
    const videoBlob = rec.kind === 'video' ? videoBlobFor(rec) : null;
    if (!photoBlob || (rec.kind === 'video' && !videoBlob)) {
      lastError = 'A photo couldn’t be recovered from this device and was removed — please retake it.';
      console.warn(`[offlinePhotoStore] ${rec.localId} has no recoverable bytes (evicted) — removing dead record`);
      memQueue.delete(rec.localId);
      try { await deleteRecord(rec.localId); } catch { /* memory-only or IDB gone */ }
      const entry = urlByLocalId.get(rec.localId);
      if (entry) { for (const u of entry.revokables) { try { URL.revokeObjectURL(u); } catch { /* noop */ } } urlByLocalId.delete(rec.localId); }
      return;
    }
    let newUrl: string;
    try {
      if (rec.kind === 'video' && videoBlob) {
        const vFile = new File([videoBlob], `clip.${/(webm)/i.test(rec.videoType || '') ? 'webm' : /(quicktime|mov)/i.test(rec.videoType || '') ? 'mov' : 'mp4'}`, { type: rec.videoType || 'video/mp4' });
        // Photos compress to UP TO ~3MB (3024px / q0.92). On a weak field uplink a
        // 25s timeout aborts mid-upload and the photo retries forever ("stuck
        // syncing"), while a smaller/later shot slips through — exactly the
        // out-of-order stall inspectors hit. Give each attempt 60s and one extra
        // try so big evidence photos actually complete on a poor signal.
        const [pUrl, vUrl] = await Promise.all([uploadJpegBlob(photoBlob, rec.filename, { attempts: 1, timeoutMs: 60000, dedupeKey: rec.localId }), uploadVideo(vFile, { dedupeKey: rec.localId })]);
        newUrl = makeVideoEntry(pUrl, vUrl);
      } else {
        newUrl = await uploadJpegBlob(photoBlob, rec.filename, { attempts: 1, timeoutMs: 60000, dedupeKey: rec.localId });
      }
    } catch (e: any) {
      lastError = `Photo upload failed (${String(e?.message || e).slice(0, 90)}).`;
      // Genuinely offline → keep everything and stop taking new work this pass.
      // (Not a signal-quality outcome — don't let it move the adaptive target.)
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { lastError = 'Device is offline — photos will upload when back online.'; stop = true; return; }
      // Online but THIS upload failed/timed out — the weak-signal signature. Back
      // the concurrency target off toward single-flight so we stop splitting a thin
      // pipe N ways and give the next photo more of it.
      noteUploadOutcome(false);
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
    // Clean upload — ramp the concurrency target back up (additive) so a healthy
    // link converges toward MAX and a photo-heavy Scope keeps pace with the shutter.
    noteUploadOutcome(true);
    await finishSynced(rec, newUrl);
  };

  // Adaptive worker pool: up to MAX_FLUSH_CONCURRENCY workers exist, but only
  // _adaptiveConcurrency of them upload AT ONCE — a worker parks (cheap poll)
  // rather than claim work whenever the live count is at/over the target, so a
  // mid-Scope drop in signal (which halves the target via noteUploadOutcome)
  // immediately narrows the pool, and a clean stretch (which ramps it up) widens
  // it. Records are independent, so parallelism is safe; ordering doesn't matter
  // for attach.
  let idx = 0;
  let active = 0;
  const worker = async () => {
    while (!stop) {
      // Background run yields the moment the form for THIS inspection becomes
      // active: the open form is the sole writer of its records, so the remaining
      // photos should be drained by the form's own flush (with its real onSynced),
      // not uploaded behind its back here. Shrinks the inactive→active race window
      // to whatever's already in flight.
      if (opts?.skipVideos && isInspectionFormActive(inspectionRecordId)) break;
      if (active >= _adaptiveConcurrency) {
        // Over the live target — yield briefly and re-check instead of claiming
        // work (keeps the effective width == target without tearing down workers).
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      const i = idx++;
      if (i >= all.length) break;
      active++;
      try { await processOne(all[i]); }
      finally { active--; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_FLUSH_CONCURRENCY, all.length) }, worker));

  const remaining = (await listQueueMeta()).filter((r) => r.inspectionRecordId === inspectionRecordId).length;
  return { synced, remaining, lastError };
}
