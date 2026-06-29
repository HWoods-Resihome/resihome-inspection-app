/**
 * Deferred create — replays locally-started inspections (lib/pendingInspections)
 * against the server the moment signal returns, then re-keys every queued item
 * from the temp id to the real HubSpot record id.
 *
 * Runs from the global background driver (lib/globalSync) BEFORE the answer/photo
 * drains, so by the time those run the queue already points at the real record.
 * Online-only, single-flight, never throws.
 *
 * Idempotent: the create is keyed by the client-generated external id, and the
 * server returns the EXISTING inspection if that external id was already created
 * (a retry after a partial success can't make a duplicate).
 */
import {
  pendingNeedingCreate, markCreating, markCreated, markError, type PendingInspection,
} from '@/lib/pendingInspections';
import { rekeyInspectionId as rekeyOutbox } from '@/lib/offlineOutbox';
import { rekeyInspectionId as rekeyAttach } from '@/lib/photoAttachOutbox';
import { rekeyInspectionId as rekeyPhotos } from '@/lib/offlinePhotoStore';
import { loadCachedInspection, saveCachedInspection, loadCachedAnswers, saveCachedAnswers } from '@/lib/offlineCache';

let inFlight = false;

async function createOne(p: PendingInspection): Promise<void> {
  markCreating(p.tempId);
  let res: Response;
  try {
    res = await fetch('/api/inspections/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...p.body }),
    });
  } catch (e: any) {
    // Offline / network — leave it pending and retry next tick.
    markError(p.tempId, `offline: ${String(e?.message || e).slice(0, 80)}`);
    throw e; // signal the caller to stop draining this tick
  }
  if (res.status === 401 || res.status === 403) {
    markError(p.tempId, `not authorized (HTTP ${res.status})`);
    throw new Error('auth'); // stop; re-auth needed
  }
  if (!res.ok) {
    // Permanent-ish server error — keep it (the inspector's offline work depends
    // on this create) and surface; the driver will retry on the next tick.
    const body = await res.text().catch(() => '');
    markError(p.tempId, `server ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    return;
  }
  const data = await res.json().catch(() => ({} as any));
  const realId = data?.inspectionId;
  if (!realId) { markError(p.tempId, 'create returned no inspectionId'); return; }

  // Re-key every durable queue from the temp id to the real record id. The temp
  // id is a unique opaque token, so each store does a blanket token replace.
  try { rekeyOutbox(p.tempId, realId); } catch { /* best-effort */ }
  try { rekeyAttach(p.tempId, realId); } catch { /* best-effort */ }
  try { await rekeyPhotos(p.tempId, realId); } catch { /* best-effort */ }

  // Move the cached inspection/answers payloads to the real id so a reload of the
  // (now real) route still opens instantly.
  try {
    const cInsp = loadCachedInspection(p.tempId);
    if (cInsp) saveCachedInspection(realId, JSON.parse(JSON.stringify(cInsp).split(p.tempId).join(realId)));
    const cAns = loadCachedAnswers(p.tempId);
    if (cAns) saveCachedAnswers(realId, cAns);
  } catch { /* best-effort */ }

  markCreated(p.tempId, realId);

  // Tell any open detail page on the temp route to swap to the real id.
  try {
    window.dispatchEvent(new CustomEvent('resiwalk:inspection-created', { detail: { tempId: p.tempId, realId } }));
  } catch { /* SSR / no window */ }
}

/**
 * Drain pending creates oldest-first. Stops at the first offline/auth failure so
 * order + connectivity are respected. Returns how many were created this pass.
 */
export async function drainPendingCreates(): Promise<number> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;
  if (inFlight) return 0;
  inFlight = true;
  let created = 0;
  try {
    for (const p of pendingNeedingCreate()) {
      try { await createOne(p); created++; }
      catch { break; } // offline/auth — stop; retry next tick
    }
  } finally {
    inFlight = false;
  }
  return created;
}
