/**
 * Offline-sync telemetry (client).
 *
 * The offline outbox and photo queue retry a bounded number of times and then
 * DROP an entry (lib/offlineOutbox, lib/offlinePhotoStore). Today that loss is
 * silent — an inspector's edit/photo can vanish with nothing surfaced. This
 * reports each flush outcome to the server so work that isn't draining (or got
 * permanently dropped) is visible in a "stuck work" admin view.
 *
 * Fire-and-forget, throttled, never throws — telemetry must never make a bad
 * sync worse.
 */

const ENDPOINT = '/api/telemetry/sync';
const MIN_INTERVAL_MS = 4000; // collapse rapid repeat flushes per inspection
const lastSent = new Map<string, number>();

export interface SyncOutcome {
  inspectionId: string;
  outbox?: { synced?: number; remaining?: number; failedPermanently?: number };
  photos?: { synced?: number; remaining?: number; failedPermanently?: number };
  lastError?: string | null;
}

export function reportSyncOutcome(o: SyncOutcome): void {
  try {
    if (typeof window === 'undefined' || !o.inspectionId) return;

    const remaining = (o.outbox?.remaining || 0) + (o.photos?.remaining || 0);
    const failed = (o.outbox?.failedPermanently || 0) + (o.photos?.failedPermanently || 0);
    const synced = (o.outbox?.synced || 0) + (o.photos?.synced || 0);
    // Nothing happened and nothing pending — not worth a beacon.
    if (remaining === 0 && failed === 0 && synced === 0) return;

    // Throttle steady-state polling, but always let a permanent-drop through.
    const now = Date.now();
    const prev = lastSent.get(o.inspectionId) || 0;
    if (failed === 0 && now - prev < MIN_INTERVAL_MS) return;
    lastSent.set(o.inspectionId, now);

    const payload = {
      inspectionId: o.inspectionId,
      synced, remaining, failedPermanently: failed,
      outbox: o.outbox || {},
      photos: o.photos || {},
      lastError: o.lastError ? String(o.lastError).slice(0, 300) : undefined,
      online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      ts: new Date().toISOString(),
    };
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
    } else {
      void fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch {
    /* telemetry must never throw */
  }
}
