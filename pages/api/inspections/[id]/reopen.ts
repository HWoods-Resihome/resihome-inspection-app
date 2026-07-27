import type { NextApiRequest, NextApiResponse } from 'next';
import { updateInspection, fetchInspectionById } from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';
import { externalWriteDenial } from '@/lib/inspectionGuard';
import { recordAuditEvent } from '@/lib/auditLog';

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

  // External (1099) users may reopen a completed inspection they OWN (to correct
  // their own finished walk); the guard still blocks other users' / other types.
  const denial = await externalWriteDenial(session.email, id);
  if (denial) return res.status(403).json({ error: denial });

  try {
    // Validate the record exists and is in a reopenable state. Previously this
    // unconditionally set in_progress + returned success — so a non-existent id
    // returned {success:true} (internal users skip the guard's fetch), and a
    // CANCELLED record could be resurrected straight to in_progress.
    const existing = await fetchInspectionById(id);
    if (!existing) return res.status(404).json({ error: 'Inspection not found' });
    const status = (existing.status || '').trim().toLowerCase();
    if (status === 'in_progress' || status === 'in progress') {
      return res.status(200).json({ success: true, alreadyOpen: true });
    }
    const REOPENABLE = new Set(['completed', 'complete', 'pending_approval', 'submitted']);
    if (!REOPENABLE.has(status)) {
      // e.g. cancelled — not a state we reopen from (un-cancelling is a separate,
      // deliberate action, not an implicit resurrection).
      return res.status(409).json({ error: `This inspection can't be reopened from its current state (${existing.status || 'unknown'}).` });
    }
    // Reopen → in_progress and CLEAR completed_at (it's no longer complete). The
    // first-completion stamp is preserved separately, and re-completing re-stamps
    // completed_at, so the historical record stays intact.
    await updateInspection(id, { status: 'in_progress', completed_at: '' });
    void recordAuditEvent({ inspectionId: id, action: 'reopen', actorEmail: session.email, actorName: session.name, detail: 'Reopened for editing' });
    return res.status(200).json({ success: true });
  } catch (e: any) {
    console.error(`POST /api/inspections/${id}/reopen failed:`, e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
