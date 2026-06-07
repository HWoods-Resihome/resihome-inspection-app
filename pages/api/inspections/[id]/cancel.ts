import type { NextApiRequest, NextApiResponse } from 'next';
import { updateInspection } from '@/lib/hubspot';
import { getSessionFromRequest } from '@/lib/auth';
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

  try {
    await updateInspection(id, { status: 'cancelled' });
    void recordAuditEvent({ inspectionId: id, action: 'cancel', actorEmail: session.email, actorName: session.name, detail: 'Cancelled' });
    return res.status(200).json({ success: true });
  } catch (e: any) {
    console.error(`POST /api/inspections/${id}/cancel failed:`, e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
