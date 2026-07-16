/**
 * /api/admin/migrate-photos-probe — diagnose & repair the answer records that
 * still hold HubSpot photo URLs (the "N left but can't migrate" stragglers).
 *
 *   GET (or ?apply=0)          → dry-run: list up to 40 straggler URLs (record id,
 *                                field, url) so we can see WHAT they are (admin).
 *   POST ?apply=1[&prune=1]    → migrate each straggler to Blob directly; with
 *                                prune=1 also drop dead (404/410) HubSpot URLs so
 *                                the remaining count can reach 0 (admin).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { reconcileStragglerPhotos } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const prune = req.query.prune === '1' || req.query.prune === 'true';
  try {
    const rep = await reconcileStragglerPhotos({ apply, prune });
    return res.status(200).json(rep);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
