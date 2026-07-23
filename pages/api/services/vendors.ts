/**
 * GET /api/services/vendors — the assignable ResiWalk vendor list.
 *
 * The live source of vendor options for the pickers (rule assignment, new
 * service, reassign): approved Companies (resiwalk_access = Yes AND
 * eligible_for_recurring = Yes), returning { name, email }. Admin-gated — only
 * internal admins configure assignments.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { fetchApprovedVendorCompanies } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!(await servicesEnabled(session?.email).catch(() => false))) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    const list = await fetchApprovedVendorCompanies();
    const vendors = list
      .map((v) => ({ name: v.name, email: v.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Same list is fetched by every services screen (rules, new, reassign, calendar,
    // detail). Let the browser reuse it for 60s so re-navigations don't re-request.
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json({ vendors });
  } catch (e: any) {
    return res.status(500).json({ error: 'Could not load vendors' });
  }
}
