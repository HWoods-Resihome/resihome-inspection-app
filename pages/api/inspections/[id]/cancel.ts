import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchInspectionById, updateInspection } from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';
import { recordAuditEvent } from '@/lib/auditLog';
import { externalAccessDenial, isCompletedStatus } from '@/lib/userAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Missing inspection id' });
  }

  try {
    const insp = await fetchInspectionById(id);
    if (!insp) return res.status(404).json({ error: 'Inspection not found' });

    // A completed inspection can NEVER be cancelled — for anyone, internal or external.
    if (isCompletedStatus(insp.status)) {
      return res.status(409).json({ error: "Completed inspections can't be cancelled." });
    }

    // External (1099) users may only cancel the 1099 inspections they own.
    const denial = externalAccessDenial(session.email, insp.templateType, {
      write: true, status: insp.status, ownerEmail: insp.inspectorEmail,
    });
    if (denial) return res.status(403).json({ error: denial });

    await updateInspection(id, { status: 'cancelled' });
    void recordAuditEvent({ inspectionId: id, action: 'cancel', actorEmail: session.email, actorName: session.name, detail: 'Cancelled' });
    return res.status(200).json({ success: true });
  } catch (e: any) {
    console.error(`POST /api/inspections/${id}/cancel failed:`, e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
