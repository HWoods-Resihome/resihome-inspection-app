/**
 * Offline outbox — durable, localStorage-backed queue of save requests that
 * failed because the device was offline (or hit a transient server error),
 * replayed automatically when connectivity returns.
 *
 * Scope: JSON saves (rate-card line upserts/archives, section layout). Photo
 * uploads need the binary file and aren't queued here.
 *
 * Each entry is a self-describing HTTP request. Replaying is idempotent for
 * line upserts because they key on a stable answer_id_external (the server
 * upserts by external id), so a double-send updates rather than duplicates.
 */

export type OutboxEntry = {
  id: string;
  inspectionRecordId: string;
  endpoint: string;
  method: 'POST' | 'PATCH';
  body: any;
  kind: 'line' | 'lineArchive' | 'sectionList' | 'sectionPhoto';
  // For 'line': the section id + line so the UI can re-show it after a reload
  // that happened before the entry synced.
  meta?: { sectionId?: string; line?: any; externalId?: string };
  createdAt: number;
};

const KEY = 'resiwalk_outbox_v1';

function read(): OutboxEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: OutboxEntry[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota / disabled */ }
}

export function enqueue(entry: Omit<OutboxEntry, 'id' | 'createdAt'>): void {
  const list = read();
  list.push({
    ...entry,
    id: `ob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  });
  write(list);
}

export function entriesFor(inspectionRecordId: string): OutboxEntry[] {
  return read().filter((e) => e.inspectionRecordId === inspectionRecordId);
}

export function countFor(inspectionRecordId: string): number {
  return entriesFor(inspectionRecordId).length;
}

export function remove(id: string): void {
  write(read().filter((e) => e.id !== id));
}

/**
 * Replay queued entries (oldest first). Stops at the first network failure
 * (device still offline) so order is preserved. A permanent 4xx is dropped so a
 * poison entry can't block the queue forever. `onSynced` lets the caller stitch
 * server results (e.g. new record ids) back into UI state.
 *
 * Returns counts so the caller can update its indicator.
 */
export async function flushOutbox(
  onSynced?: (entry: OutboxEntry, responseData: any) => void
): Promise<{ synced: number; remaining: number; failedPermanently: number }> {
  const list = read();
  if (list.length === 0) return { synced: 0, remaining: 0, failedPermanently: 0 };

  let synced = 0;
  let failedPermanently = 0;
  list.sort((a, b) => a.createdAt - b.createdAt);

  for (const entry of list) {
    let res: Response;
    try {
      res = await fetch(entry.endpoint, {
        method: entry.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.body),
      });
    } catch {
      // Still offline / network error — keep this and everything after it.
      break;
    }
    if (res.ok) {
      let data: any = null;
      try { data = await res.json(); } catch { /* no body */ }
      remove(entry.id);
      synced++;
      try { onSynced?.(entry, data); } catch { /* non-fatal */ }
    } else if (res.status === 401 || res.status === 403) {
      // Session expired / not authorized — NOT a poison entry. Keep it (and
      // everything after) so re-logging in replays the queue intact. The
      // session guard surfaces a re-login prompt to the inspector.
      break;
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      // Permanently bad request — dropping it prevents a poison entry from
      // wedging the queue. (Logged so it isn't silent.)
      console.error(`[outbox] dropping entry ${entry.id} after ${res.status}`);
      remove(entry.id);
      failedPermanently++;
    } else {
      // 429 / 5xx — keep for the next flush.
      break;
    }
  }
  return { synced, remaining: read().length, failedPermanently };
}

/** Heuristic: was a thrown save error a network/offline failure (vs a 4xx)? */
export function isOfflineError(err: any): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = String(err?.message || err || '');
  // Our save path throws "HTTP 4xx: ..." for non-retryable; anything else
  // (TypeError: Failed to fetch, timeouts, 5xx-after-retries) is treated as
  // retry-worthy / offline.
  return !/HTTP 4\d\d/.test(msg);
}
