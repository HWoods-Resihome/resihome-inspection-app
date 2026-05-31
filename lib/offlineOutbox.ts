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
  // Failed replay attempts; a wedged entry is dropped after MAX_ATTEMPTS so it
  // can't block the queue (and the "Syncing…" banner) forever.
  attempts?: number;
};

const KEY = 'resiwalk_outbox_v1';
const MAX_ATTEMPTS = 6;

/** Increment an entry's attempt counter in storage; returns the new count. */
function bumpAttempts(id: string): number {
  const list = read();
  const e = list.find((x) => x.id === id);
  if (!e) return Infinity; // already gone — treat as "drop"
  e.attempts = (e.attempts || 0) + 1;
  write(list);
  return e.attempts;
}

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
): Promise<{ synced: number; remaining: number; failedPermanently: number; lastError?: string }> {
  const list = read();
  if (list.length === 0) return { synced: 0, remaining: 0, failedPermanently: 0 };

  let synced = 0;
  let failedPermanently = 0;
  let lastError: string | undefined;
  list.sort((a, b) => a.createdAt - b.createdAt);

  for (const entry of list) {
    let res: Response;
    try {
      res = await fetch(entry.endpoint, {
        method: entry.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.body),
      });
    } catch (e: any) {
      // If the device is genuinely offline, keep everything and stop.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { lastError = 'Device is offline — will retry when back online.'; break; }
      // Online but the request failed (DNS/CORS/transient). Count the attempt;
      // drop+skip a wedged entry after too many so it can't block the queue
      // forever, otherwise stop and retry in order next time.
      lastError = `Network error reaching the server (${String(e?.message || e).slice(0, 80)}).`;
      if (bumpAttempts(entry.id) >= MAX_ATTEMPTS) {
        console.error(`[outbox] dropping entry ${entry.id} after ${MAX_ATTEMPTS} failed attempts (network)`);
        remove(entry.id); failedPermanently++; continue;
      }
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
      lastError = `Not authorized (HTTP ${res.status}) — your session may have expired. Sign in again to sync.`;
      break;
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      // Permanently bad request — dropping it prevents a poison entry from
      // wedging the queue. (Logged so it isn't silent.)
      const body = await res.text().catch(() => '');
      lastError = `Server rejected a change (HTTP ${res.status})${body ? `: ${body.slice(0, 120)}` : ''}. It was dropped.`;
      console.error(`[outbox] dropping entry ${entry.id} after ${res.status}: ${body.slice(0, 200)}`);
      remove(entry.id);
      failedPermanently++;
    } else {
      // 429 / 5xx — transient server error. Surface the server's message so a
      // recurring failure can be diagnosed. Count the attempt; after too many,
      // drop+skip so one bad entry can't wedge the queue indefinitely.
      const body = await res.text().catch(() => '');
      lastError = `Server error (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''} — retrying.`;
      if (bumpAttempts(entry.id) >= MAX_ATTEMPTS) {
        console.error(`[outbox] dropping entry ${entry.id} after ${MAX_ATTEMPTS} failed attempts (HTTP ${res.status})`);
        remove(entry.id); failedPermanently++; continue;
      }
      break;
    }
  }
  return { synced, remaining: read().length, failedPermanently, lastError };
}

/** Drop every queued entry for an inspection (manual "clear stuck items"). */
export function clearFor(inspectionRecordId: string): number {
  const list = read();
  const remaining = list.filter((e) => e.inspectionRecordId !== inspectionRecordId);
  write(remaining);
  return list.length - remaining.length;
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
