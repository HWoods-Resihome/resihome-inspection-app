/**
 * GET /api/services/admin/backfill-community-geo        → dry-run (default)
 * GET /api/services/admin/backfill-community-geo?apply=1 → apply
 *
 * Backfills region + portfolio onto community-coverage Service Work Orders (every
 * status), derived from an associated community home, so they surface in Insights
 * billing. Fills blanks only — idempotent. Admin-gated.
 *
 * NOTE: run the schema provisioner first (/api/services/admin/provision?apply=1)
 * so the `portfolio_snapshot` property exists before applying.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillCommunityGeo } from '@/lib/services/backfillCommunityGeo';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const apply = req.query.apply === '1' || req.query.apply === 'true';
  try {
    const report = await backfillCommunityGeo(apply);
    if (report === null) return res.status(200).json({ configured: false, mode: apply ? 'apply' : 'dry-run', note: 'Service Work Order object type id not set — nothing to backfill.' });
    return res.status(200).json(report);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null, mode: apply ? 'apply' : 'dry-run' });
  }
}
