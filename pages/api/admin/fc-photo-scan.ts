/**
 * GET /api/admin/fc-photo-scan?verify=1&after=<cursor>
 *
 * Blast-radius scan for the Final Checklist photo loss: enumerates every fc__all
 * blob across ALL inspections and classifies its embedded photos HubSpot / Blob /
 * draft. With ?verify=1 it also HEAD-checks the HubSpot ones so we can count how
 * many FC photos are actually GONE (404) vs still alive/recoverable. Budgeted;
 * loop it by passing back the returned `after` until `done:true`. Read-only,
 * admin-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { scanFinalChecklistPhotos } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) return res.status(403).json({ error: 'Admin only' });
  const verify = req.query.verify === '1' || req.query.verify === 'true';
  const after = typeof req.query.after === 'string' ? req.query.after : undefined;
  try {
    const batch = await scanFinalChecklistPhotos({ after, verify });
    return res.status(200).json({
      ...batch,
      note: 'hubspot = FC photos still pointing at HubSpot (the ones the reclaim could delete). With verify=1, dead = confirmed 404 (lost from HubSpot). Loop with ?after=<returned after> until done:true.',
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
