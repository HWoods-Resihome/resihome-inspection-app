/**
 * GET /api/admin/debug-listing-deals?inspectionId=<id>   (or ?listingId=<id>)
 *
 * Read-only diagnostic for the Move-In (lease-start) lookup. Dumps every deal
 * associated to the listing with the exact fields the lookup filters on
 * (pipeline / dealstage / hf_transaction_id / lease_start_date) and whether each
 * qualifies — so we can see WHY a Move-In date isn't pulling. App-admin only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { debugListingDeals, debugInspectionListings } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const inspectionId = typeof req.query.inspectionId === 'string' ? req.query.inspectionId : '';
  const listingId = typeof req.query.listingId === 'string' ? req.query.listingId : '';
  if (!inspectionId && !listingId) {
    return res.status(400).json({ error: 'Pass ?inspectionId=<id> or ?listingId=<id>' });
  }
  try {
    const result = listingId
      ? await debugListingDeals(listingId)
      : await debugInspectionListings(inspectionId);
    return res.status(200).json({ ok: true, ...result });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400) });
  }
}
