/**
 * POST /api/admin/backfill-inspection-property
 *
 * Maintenance: ensure EVERY existing inspection is associated to its Property
 * object in HubSpot (reads each inspection's property_id_ref and creates the
 * Inspection->Property association). Idempotent — safe to run repeatedly.
 *
 * Gated to authenticated @resihome.com staff. Returns a summary count.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { backfillInspectionPropertyAssociations } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const summary = await backfillInspectionPropertyAssociations();
    return res.status(200).json({ ok: true, ...summary });
  } catch (e: any) {
    console.error('[backfill-inspection-property] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
