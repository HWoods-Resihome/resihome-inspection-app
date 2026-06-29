/**
 * Pending (locally-created) inspections — the "start an inspection with NO
 * connection" store.
 *
 * Creating an inspection normally needs the server to mint a HubSpot record id
 * (lib + region + billing). In a dead zone that's impossible, so instead we:
 *   1) generate a TEMP record id (`local_<uuid>`) + the inspection's EXTERNAL id
 *      (`INSP-<date>-<uuid>`) entirely on the device,
 *   2) let the inspector fill out the whole inspection offline (answers + photos
 *      queue against the temp id exactly like any other inspection),
 *   3) replay the create against the server the moment signal returns (see
 *      lib/deferredCreate), which mints the REAL record id and re-keys every
 *      queued item from the temp id to the real one.
 *
 * The EXTERNAL id is generated here (not server-side) so every answer/photo
 * idempotency key the forms build is STABLE from the first offline tap — only
 * the record id changes on sync, and that's an opaque-token re-key.
 *
 * Stored in localStorage (small, JSON, survives reload/close). Photos/answers
 * live in their own durable queues keyed by the temp id.
 */

export interface PendingInspectionCreateBody {
  templateType: string;
  propertyRecordId: string;
  propertyAddressSnapshot: string;
  inspectorName: string;
  inspectorEmail?: string;
  bedrooms: number | null;
  bathrooms: number | null;
  scheduledDate?: string;
  sourceRateCardId?: string;
  /** Client-generated, passed to the server so it creates the record with THIS
   *  external id (keeps queued answer/photo idempotency keys valid). */
  externalId: string;
}

export interface PendingInspection {
  /** Temp record id used as the route param + queue key until the real id lands. */
  tempId: string;
  externalId: string;
  body: PendingInspectionCreateBody;
  /** What the home list shows for this not-yet-synced inspection. */
  display: {
    inspectionName: string;
    templateType: string;
    propertyAddress: string;
    inspectorName: string;
  };
  status: 'pending' | 'creating' | 'created' | 'error';
  /** The real HubSpot record id, once the deferred create succeeds. */
  realId?: string;
  lastError?: string;
  createdAt: number;
  attempts?: number;
}

const KEY = 'resiwalk_pending_inspections_v1';
const LOCAL_PREFIX = 'local_';

/** Is this a client-generated (not-yet-synced) inspection id? */
export function isLocalInspectionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(LOCAL_PREFIX);
}

function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
      return (crypto as any).randomUUID().replace(/-/g, '');
    }
  } catch { /* fall through */ }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** A fresh temp record id + matching external id for a new offline inspection. */
export function newLocalIds(now: number): { tempId: string; externalId: string } {
  const u = uuid();
  const day = new Date(now).toISOString().slice(0, 10);
  return { tempId: `${LOCAL_PREFIX}${u}`, externalId: `INSP-${day}-${u.slice(0, 8)}` };
}

function read(): PendingInspection[] {
  if (typeof window === 'undefined') return [];
  try { const raw = window.localStorage.getItem(KEY); const l = raw ? JSON.parse(raw) : []; return Array.isArray(l) ? l : []; }
  catch { return []; }
}
function write(list: PendingInspection[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota/disabled */ }
}

export function addPendingInspection(p: PendingInspection): void {
  const list = read().filter((x) => x.tempId !== p.tempId);
  list.push(p);
  write(list);
}

export function getPendingInspection(tempId: string): PendingInspection | null {
  return read().find((p) => p.tempId === tempId) || null;
}

/** All pending inspections, newest first (for the home list merge). */
export function listPendingInspections(): PendingInspection[] {
  return read().sort((a, b) => b.createdAt - a.createdAt);
}

/** Those still needing a server create (drained by the deferred-create driver). */
export function pendingNeedingCreate(): PendingInspection[] {
  return read().filter((p) => p.status === 'pending' || p.status === 'error').sort((a, b) => a.createdAt - b.createdAt);
}

export function markCreating(tempId: string): void {
  const list = read();
  const p = list.find((x) => x.tempId === tempId);
  if (p) { p.status = 'creating'; p.attempts = (p.attempts || 0) + 1; write(list); }
}

export function markCreated(tempId: string, realId: string): void {
  const list = read();
  const p = list.find((x) => x.tempId === tempId);
  if (p) { p.status = 'created'; p.realId = realId; p.lastError = undefined; write(list); }
}

export function markError(tempId: string, error: string): void {
  const list = read();
  const p = list.find((x) => x.tempId === tempId);
  if (p) { p.status = (p.status === 'creating' ? 'pending' : p.status); p.lastError = error; write(list); }
}

export function removePendingInspection(tempId: string): void {
  write(read().filter((p) => p.tempId !== tempId));
}

/** Map a temp id to its real id once created (used by the detail-page redirect). */
export function realIdFor(tempId: string): string | null {
  return read().find((p) => p.tempId === tempId)?.realId || null;
}
