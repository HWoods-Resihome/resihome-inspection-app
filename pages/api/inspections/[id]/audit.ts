import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchInspectionById } from '@/lib/hubspot';
import { readAuditLog, type AuditEvent } from '@/lib/auditLog';

/**
 * GET /api/inspections/[id]/audit
 *
 * The inspection's audit trail, newest first. Returns the recorded lifecycle
 * events (lib/auditLog) and BACKFILLS from the inspection's existing HubSpot
 * timestamps (created / submitted / approved) so inspections that predate the
 * audit log still show a meaningful history. A derived event is included only
 * when there's no recorded event of the same action (no double-counting).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing inspection id' });

  try {
    const [recorded, inspection] = await Promise.all([
      readAuditLog(id),
      fetchInspectionById(id).catch(() => null),
    ]);

    const haveAction = new Set(recorded.map((e) => e.action));
    const derived: AuditEvent[] = [];
    const addDerived = (action: string, when: string | null, actorName?: string | null, actorEmail?: string | null, detail?: string) => {
      const ts = toIso(when);
      if (ts && !haveAction.has(action)) {
        derived.push({ inspectionId: id, action, ts, actorName: actorName || undefined, actorEmail: actorEmail || undefined, detail, meta: { derived: true } });
      }
    };

    if (inspection) {
      addDerived('create', inspection.createdAt, null, null, 'Inspection created');
      addDerived('submit', inspection.submittedAt, null, inspection.submittedByEmail, 'Submitted for approval');
      addDerived('approve', inspection.approvedAt, inspection.approvedByName, null, 'Approved & finalized');
    }

    const events = [...recorded, ...derived].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return res.status(200).json({ events, status: inspection?.status || null });
  } catch (e: any) {
    console.error(`GET /api/inspections/${id}/audit failed:`, e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}

// HubSpot datetimes come back as ISO strings or epoch-ms (submitted_at/approved_at
// are written as ms). Normalize either to ISO; null if unparseable.
function toIso(v: string | null): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) { const d = new Date(Number(s)); return isNaN(+d) ? null : d.toISOString(); }
  const d = new Date(s);
  return isNaN(+d) ? null : d.toISOString();
}
