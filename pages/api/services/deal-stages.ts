/**
 * GET /api/services/deal-stages — the LEASING deal pipeline's stages, for the
 * Rules Engine "Deal Stage" enroll/stop criterion dropdowns. Admin-gated.
 * Returns { stages: [{ value: stageId, label }] }.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { fetchLeasingDealStages } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!(await servicesEnabled(session?.email).catch(() => false))) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    const stages = await fetchLeasingDealStages();
    return res.status(200).json({ stages });
  } catch {
    return res.status(500).json({ error: 'Could not load deal stages' });
  }
}
