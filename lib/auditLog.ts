/**
 * Inspection audit trail.
 *
 * Records the audit-significant lifecycle transitions for an inspection — who
 * submitted it, who approved (finalized) it, who reopened or cancelled it, and
 * when — so there's an answerable "what happened to this inspection, and who
 * did it" surfaced in the app (under the inspection ⚙️ menu) rather than only
 * inferable from a few scattered HubSpot timestamp fields.
 *
 * Storage mirrors ai-usage/ai-feedback (no database): one append-only blob per
 * event under audit/<inspectionId>/<sortable-ts>-<rand>.json. The structured
 * `[audit]` log line is the authoritative copy. Best-effort: an audit write must
 * never block or fail a lifecycle transition.
 */
import { put, list } from '@vercel/blob';

export type AuditAction =
  | 'submit'        // inspector submitted for approval (rate card) / completed (other)
  | 'approve'       // reviewer finalized — the approval
  | 'refinalize'    // re-finalized after a reopen (PDFs regenerated, no re-approve)
  | 'regenerate'    // PDFs regenerated only (status unchanged)
  | 'reopen'        // completed → in_progress
  | 'edit'          // answers edited (logged once per session / app re-entry, not per keystroke)
  | 'cancel';       // marked cancelled

export interface AuditEvent {
  inspectionId: string;
  action: AuditAction | string;
  actorEmail?: string;
  actorName?: string;
  detail?: string;
  meta?: Record<string, string | number | boolean | null | undefined>;
  ts: string; // ISO
}

function clip(s: unknown, n = 200): string | undefined {
  return s == null ? undefined : String(s).slice(0, n);
}

/** Record one lifecycle event. Best-effort; never throws. */
export async function recordAuditEvent(e: {
  inspectionId: string;
  action: AuditAction | string;
  actorEmail?: string;
  actorName?: string;
  detail?: string;
  meta?: AuditEvent['meta'];
}): Promise<void> {
  const ev: AuditEvent = {
    inspectionId: String(e.inspectionId),
    action: e.action,
    actorEmail: clip(e.actorEmail, 200),
    actorName: clip(e.actorName, 200),
    detail: clip(e.detail, 500),
    meta: e.meta,
    ts: new Date().toISOString(),
  };

  // 1) Structured log — authoritative, greppable in Vercel logs.
  try { console.log(`[audit] ${JSON.stringify(ev)}`); } catch { /* noop */ }

  // 2) Best-effort blob (append-only; ms-prefixed name sorts chronologically).
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  const name = `${Date.now().toString().padStart(15, '0')}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    await put(`audit/${ev.inspectionId}/${name}.json`, JSON.stringify(ev),
      { access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
  } catch (err: any) {
    console.warn('[audit] write failed:', String(err?.message || err).slice(0, 120));
  }
}

/** Read an inspection's recorded events, newest first. */
export async function readAuditLog(inspectionId: string): Promise<AuditEvent[]> {
  const out: AuditEvent[] = [];
  if (!process.env.BLOB_READ_WRITE_TOKEN || !inspectionId) return out;
  try {
    const { blobs } = await list({ prefix: `audit/${inspectionId}/` });
    const events = await Promise.all(blobs.map((b) => fetch(b.url).then((r) => r.json()).catch(() => null)));
    for (const ev of events) if (ev) out.push(ev as AuditEvent);
  } catch (e: any) {
    console.warn('[audit] read failed:', String(e?.message || e).slice(0, 120));
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)); // newest first
  return out;
}
