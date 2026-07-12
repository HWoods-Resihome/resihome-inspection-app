/**
 * GET /api/services/[id]/audit — a Service Work Order's audit trail, newest first.
 *
 * Returns the recorded lifecycle events (lib/services/serviceAudit) and BACKFILLS
 * from the order's existing HubSpot timestamps (submitted / reviewed / completed)
 * so services that predate the audit log still show a meaningful history. A
 * derived event is included only when there's no recorded event of the same
 * action. Internal-only (the trail exposes actor emails + decision notes).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder } from '@/lib/hubspot';
import { readServiceAudit } from '@/lib/services/serviceAudit';
import type { AuditEvent } from '@/lib/auditLog';

function toIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) { const d = new Date(Number(s)); return isNaN(+d) ? null : d.toISOString(); }
  const d = new Date(s);
  return isNaN(+d) ? null : d.toISOString();
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(200).json({ events: [] }); // sample/non-live: nothing recorded

  try {
    const [recorded, rec] = await Promise.all([
      readServiceAudit(id).catch(() => [] as AuditEvent[]),
      fetchServiceWorkOrder(id).catch(() => null),
    ]);

    const haveAction = new Set(recorded.map((e) => e.action));
    const derived: AuditEvent[] = [];
    const addDerived = (action: string, when: string | null | undefined, detail: string, actorEmail?: string) => {
      const ts = toIso(when);
      if (ts && !haveAction.has(action)) derived.push({ inspectionId: `svc-${id}`, action, ts, detail, actorEmail, meta: { derived: true } });
    };
    if (rec) {
      const p = rec.props;
      addDerived('submit', p.submitted_at, 'Completion submitted', p.vendor_email || undefined);
      addDerived('review', p.reviewed_at, p.review_decision ? `Review: ${p.review_decision}` : 'Reviewed', p.reviewed_by || undefined);
    }

    const events = [...recorded, ...derived].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return res.status(200).json({ events, status: rec?.props.status || null });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
