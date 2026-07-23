/**
 * GET /api/services/admin/backfill-timeonsite        → dry-run (default): shows what would update
 * GET /api/services/admin/backfill-timeonsite?apply=1 → apply: writes the time-on-site line
 *
 * One-time backfill of the "⏱ Time on site" line into the AI review notes of
 * services already in `completed` or `review` (reviewed before the field
 * existed). Never changes status or verdict — enriches ai_notes only. Idempotent.
 * Admin-gated.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillTimeOnSite } from '@/lib/services/aiReview';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const apply = req.query.apply === '1' || req.query.apply === 'true';
  try {
    const report = await backfillTimeOnSite(apply);
    if (report === null) return res.status(200).json({ configured: false, mode: apply ? 'apply' : 'dry-run', note: 'Service Work Order object type id not set — nothing to backfill.' });
    return res.status(200).json(report);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null, mode: apply ? 'apply' : 'dry-run' });
  }
}
