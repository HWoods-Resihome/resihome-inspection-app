/**
 * Photo ATTACH outbox — durable, localStorage-backed queue of "attach this
 * uploaded photo URL to this record" instructions.
 *
 * Uploading a photo's bytes and ATTACHING the resulting URL to its section/line/
 * checklist record are two steps. The form does the attach live while it's open,
 * but if the inspector leaves before it completes (the field data loss), the
 * attach was lost. This outbox makes the attach DURABLE and form-independent: the
 * photo flush records an instruction here the moment a photo uploads, and the
 * global background driver replays it against the idempotent
 * /api/inspections/[id]/attach-photo endpoint from ANY page (or device that holds
 * the queue), retrying until it lands. Idempotent (server dedupes by URL), so the
 * form's live attach + this replay can't double-add.
 */

export interface PhotoAttachTarget {
  // 'section' → a section_photo answer; 'line' → a rate_card_line / qa answer's
  // photo list; 'fc' → a slot inside the Final Checklist JSON blob.
  kind: 'section' | 'line' | 'fc';
  /** Stable answer_id_external of the target record (used to find/create it).
   *  For 'fc' this is the FINALCHECKLIST-<id> blob record's external id. */
  externalId: string;
  /** Which URL list to append to (section/line). */
  field?: 'photo_urls' | 'after_photo_urls';
  /** section_photo CREATE fields (used only when the record doesn't exist yet). */
  section?: string;
  location?: string;
  summaryLabel?: string;
  /** FC slot inside the blob: "<qid>:<key>" where key is 'photo' or a sticker id. */
  fcSlot?: string;
}

export interface PhotoAttachEntry {
  id: string;
  inspectionRecordId: string;
  url: string;            // the real (uploaded) URL to attach
  replacesUrl?: string;   // annotation: replace this URL instead of appending
  target: PhotoAttachTarget;
  createdAt: number;
  attempts?: number;
}

const KEY = 'resiwalk_photo_attach_v1';

function read(): PhotoAttachEntry[] {
  if (typeof window === 'undefined') return [];
  try { const raw = window.localStorage.getItem(KEY); const l = raw ? JSON.parse(raw) : []; return Array.isArray(l) ? l : []; }
  catch { return []; }
}
function write(list: PhotoAttachEntry[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota/disabled */ }
}

/** Record an attach instruction. Deduped by (inspection, url, field) so the same
 *  uploaded photo isn't queued twice (the live form attach + the flush both call
 *  this). */
export function enqueuePhotoAttach(e: Omit<PhotoAttachEntry, 'id' | 'createdAt'>): void {
  if (!e.url || e.url.startsWith('blob:')) return; // only real uploaded URLs
  const slot = (t: PhotoAttachTarget) => `${t.kind}|${t.field || ''}|${t.fcSlot || ''}|${t.externalId}`;
  const list = read();
  if (list.some((x) => x.inspectionRecordId === e.inspectionRecordId && x.url === e.url && slot(x.target) === slot(e.target))) return;
  list.push({ ...e, id: `pa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() });
  write(list);
}

export function countPhotoAttach(inspectionRecordId?: string): number {
  const list = read();
  return inspectionRecordId ? list.filter((e) => e.inspectionRecordId === inspectionRecordId).length : list.length;
}

/**
 * Re-key queued attach instructions from a temp (local) inspection id to the
 * real record id once a deferred create lands. Blanket token replace (the temp
 * id is a unique opaque token) rewrites the `inspectionRecordId` field — from
 * which the attach endpoint is built at drain time — and any record-id-derived
 * target (e.g. an 'fc' externalId `FINALCHECKLIST-<id>`) in one shot.
 */
export function rekeyInspectionId(tempId: string, realId: string): void {
  if (!tempId || !realId || tempId === realId) return;
  const list = read();
  if (!list.some((e) => e.inspectionRecordId === tempId)) return;
  write(JSON.parse(JSON.stringify(list).split(tempId).join(realId)));
}

/**
 * Replay queued attach instructions against the idempotent server endpoint.
 * Online-only; never throws. Drops an entry only on a permanent 4xx (so a poison
 * instruction can't wedge the queue) — transient failures stay and retry.
 */
export async function drainPhotoAttachOutbox(opts?: { skipInspectionIds?: Set<string> }): Promise<{ done: number; remaining: number }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { done: 0, remaining: read().length };
  const skip = opts?.skipInspectionIds;
  const list = read().sort((a, b) => a.createdAt - b.createdAt);
  let done = 0;
  for (const e of list) {
    // Skip the currently-open inspection — its form is the sole writer of those
    // records; the entry stays queued and attaches (idempotently) after they leave.
    if (skip && skip.has(e.inspectionRecordId)) continue;
    let res: Response;
    try {
      res = await fetch(`/api/inspections/${e.inspectionRecordId}/attach-photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: e.url, replacesUrl: e.replacesUrl, target: e.target }),
      });
    } catch {
      break; // offline / network — stop, retry next tick (order preserved)
    }
    if (res.ok) {
      // The endpoint may DEFER (the parent answer record doesn't exist yet — the
      // answer outbox hasn't synced it). Keep the entry so it retries next tick;
      // don't treat a deferral as done (that would silently drop the attach).
      const data = await res.json().catch(() => ({} as any));
      if (data && data.deferred) continue;
      write(read().filter((x) => x.id !== e.id)); done++; continue;
    }
    if (res.status === 401 || res.status === 403) break;           // re-auth needed — keep
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      // Permanently bad — drop so it can't wedge the queue (logged server-side).
      write(read().filter((x) => x.id !== e.id));
      continue;
    }
    break; // 429 / 5xx — transient, retry next tick
  }
  return { done, remaining: read().length };
}
