/**
 * ResiWalk - Services — offline capture + sync (isolated from the inspection
 * offline store to avoid any regression to the live inspections flow, but reusing
 * the SAME fine-tuned primitives: compressToJpeg + uploadJpegBlob for compression/
 * upload, IndexedDB for durable blobs, and a draft→real URL rekey on sync).
 *
 * Model (mirrors how inspections behave, scoped to one service completion):
 *  • A photo captured OFFLINE is compressed, stored durably in IndexedDB, shown
 *    immediately from a session object URL (a real blob: URL, so the camera gallery
 *    and thumbnails render it), and uploaded automatically when connectivity
 *    returns — its draft is then rekeyed to the hosted URL.
 *  • Submit works OFFLINE too: the completion is queued (durably) with its photos
 *    referenced by local id; when back online the queued photos upload, their
 *    hosted URLs are substituted in, and the submit POST fires.
 *
 * Everything is SSR-safe (guards on window/indexedDB) and best-effort: any failure
 * leaves the durable queue intact so the next flush retries.
 */
import { compressToJpeg, uploadJpegBlob, toJpegName } from '@/lib/photoUpload';

const DB_NAME = 'resiwalk-services';
const DB_VERSION = 1;
const PHOTOS = 'photos';     // key localId → { localId, bytes, filename, createdAt }
const RESOLVED = 'resolved'; // key localId → { url }  (hosted URL after upload)
const SUBMITS = 'submits';   // key serviceId → queued completion payload (photos as ref:<localId>)

const hasIDB = () => typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
let _uid = 0;
const newLocalId = () => `svc_${Date.now().toString(36)}_${(_uid++).toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

// Session maps: draft blob URL ↔ localId, and localId → object URL (for rehydrate).
const draftToLocalId = new Map<string, string>();
const localIdToObjectUrl = new Map<string, string>();
type SyncListener = (info: { localId: string; url: string; draftUrl?: string }) => void;
const listeners = new Set<SyncListener>();

// ── IndexedDB helpers ──
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHOTOS)) db.createObjectStore(PHOTOS, { keyPath: 'localId' });
      if (!db.objectStoreNames.contains(RESOLVED)) db.createObjectStore(RESOLVED, { keyPath: 'localId' });
      if (!db.objectStoreNames.contains(SUBMITS)) db.createObjectStore(SUBMITS, { keyPath: 'serviceId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(store: string, value: any): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
}
async function idbGet<T = any>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  const out = await new Promise<T | undefined>((resolve, reject) => { const tx = db.transaction(store, 'readonly'); const r = tx.objectStore(store).get(key); r.onsuccess = () => resolve(r.result as T); r.onerror = () => reject(r.error); });
  db.close(); return out;
}
async function idbGetAll<T = any>(store: string): Promise<T[]> {
  const db = await openDb();
  const out = await new Promise<T[]>((resolve, reject) => { const tx = db.transaction(store, 'readonly'); const r = tx.objectStore(store).getAll(); r.onsuccess = () => resolve(r.result as T[]); r.onerror = () => reject(r.error); });
  db.close(); return out;
}
async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
}

export function onServiceSync(cb: SyncListener): () => void { listeners.add(cb); return () => listeners.delete(cb); }
const notify = (info: { localId: string; url: string; draftUrl?: string }) => listeners.forEach((l) => { try { l(info); } catch { /* noop */ } });

/**
 * Compress + upload a photo, or queue it durably when offline. Always returns a
 * displayable URL immediately (hosted URL when online, else a session blob: URL).
 */
export async function capturePhotoOrQueue(serviceId: string, file: File): Promise<string> {
  const compressed = await compressToJpeg(file);
  const filename = toJpegName(file.name || 'photo.jpg');
  if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
    try { return await uploadJpegBlob(compressed, filename, { attempts: 2 }); }
    catch { /* fall through to queue */ }
  }
  // Queue durably (bytes as ArrayBuffer — survives reload/OS reclaim) + draft URL.
  const localId = newLocalId();
  const draftUrl = URL.createObjectURL(compressed);
  draftToLocalId.set(draftUrl, localId);
  localIdToObjectUrl.set(localId, draftUrl);
  if (hasIDB()) { try { await idbPut(PHOTOS, { localId, serviceId, bytes: await compressed.arrayBuffer(), filename, createdAt: Date.now() }); } catch { /* keep session-only draft */ } }
  return draftUrl;
}

/** True while the app is online. */
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** Convert a display URL to a durable ref: draft blob URLs → `ref:<localId>`; hosted URLs pass through. */
function toRef(url: string): string { const lid = draftToLocalId.get(url); return lid ? `ref:${lid}` : url; }
async function resolveRef(ref: string): Promise<string | null> {
  if (!ref.startsWith('ref:')) return ref;
  const r = await idbGet<{ url: string }>(RESOLVED, ref.slice(4));
  return r?.url || null;
}

/** Upload every queued photo that hasn't been uploaded yet; rekey drafts on success. */
export async function flushServicePhotos(): Promise<number> {
  if (!hasIDB() || !online()) return 0;
  const queued = await idbGetAll<{ localId: string; bytes: ArrayBuffer; filename: string }>(PHOTOS);
  let done = 0;
  for (const q of queued) {
    try {
      const blob = new Blob([q.bytes], { type: 'image/jpeg' });
      const url = await uploadJpegBlob(blob, q.filename, { attempts: 2, dedupeKey: q.localId });
      await idbPut(RESOLVED, { localId: q.localId, url });
      await idbDelete(PHOTOS, q.localId);
      const draftUrl = localIdToObjectUrl.get(q.localId);
      notify({ localId: q.localId, url, draftUrl });
      done++;
    } catch { /* leave queued for the next flush */ }
  }
  return done;
}

export interface ServiceSubmitPayload {
  answers: Record<string, any>;
  before: string[]; after: string[]; petBefore: string[]; petAfter: string[];
  submittedAt: string;
}

async function postSubmit(serviceId: string, body: any): Promise<{ ok: boolean; status?: number; data?: any }> {
  const r = await fetch(`/api/services/${encodeURIComponent(serviceId)}/submit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

/**
 * Submit a completion, or queue it durably when offline / when photos are still
 * uploading. Returns { status: 'sent' | 'queued' } (+ review when sent).
 */
export async function submitServiceOrQueue(serviceId: string, p: ServiceSubmitPayload): Promise<{ status: 'sent' | 'queued'; review?: any }> {
  const record = {
    serviceId,
    answers: p.answers,
    before: p.before.map(toRef), after: p.after.map(toRef),
    petBefore: p.petBefore.map(toRef), petAfter: p.petAfter.map(toRef),
    submittedAt: p.submittedAt, createdAt: Date.now(),
  };
  // Persist first so an interrupted send is never lost.
  if (hasIDB()) { try { await idbPut(SUBMITS, record); } catch { /* fall back to direct send */ } }

  const sent = await trySendSubmit(record);
  if (sent.status === 'sent') return { status: 'sent', review: sent.review };
  return { status: 'queued' };
}

// Attempt to send ONE queued submit: upload its photos, substitute hosted URLs,
// POST when fully resolved and online. Returns 'sent' | 'queued'.
async function trySendSubmit(record: any): Promise<{ status: 'sent' | 'queued'; review?: any }> {
  if (!online()) return { status: 'queued' };
  await flushServicePhotos(); // resolve any queued photos first
  const groups = ['before', 'after', 'petBefore', 'petAfter'] as const;
  const resolved: Record<string, string[]> = {};
  for (const g of groups) {
    const out: string[] = [];
    for (const ref of (record[g] || [])) {
      const u = await resolveRef(ref);
      if (u == null) return { status: 'queued' }; // a photo hasn't uploaded yet — wait
      out.push(u);
    }
    resolved[g] = out;
  }
  try {
    const res = await postSubmit(record.serviceId, {
      answers: record.answers, ...resolved, submittedAt: record.submittedAt,
    });
    // 409 = already submitted on the server: treat as done (clear the queue).
    if (res.ok || res.status === 409) {
      if (hasIDB()) { try { await idbDelete(SUBMITS, record.serviceId); } catch { /* noop */ } }
      return { status: 'sent', review: res.data?.review };
    }
    return { status: 'queued' };
  } catch { return { status: 'queued' }; }
}

/** Flush all queued submits (called on reconnect / page load). */
export async function flushServiceSubmits(): Promise<number> {
  if (!hasIDB() || !online()) return 0;
  const subs = await idbGetAll<any>(SUBMITS);
  let sent = 0;
  for (const s of subs) { const r = await trySendSubmit(s); if (r.status === 'sent') sent++; }
  return sent;
}

/** Is there a completion queued (offline) for this service that hasn't synced yet? */
export async function hasPendingSubmit(serviceId: string): Promise<boolean> {
  if (!hasIDB()) return false;
  try { return !!(await idbGet(SUBMITS, serviceId)); } catch { return false; }
}

/** Count of pending service items on this device (queued photos + queued submits). */
export async function countServiceQueue(): Promise<number> {
  if (!hasIDB()) return 0;
  try {
    const [photos, submits] = await Promise.all([idbGetAll(PHOTOS), idbGetAll(SUBMITS)]);
    return photos.length + submits.length;
  } catch { return 0; }
}

let _wired = false;
/** Kick a sync now and (once) on every reconnect. Safe to call from any page mount. */
export function initServiceSync(): void {
  if (typeof window === 'undefined') return;
  const kick = () => { void flushServicePhotos().then(() => flushServiceSubmits()); };
  if (!_wired) { _wired = true; window.addEventListener('online', kick); }
  if (online()) kick();
}
