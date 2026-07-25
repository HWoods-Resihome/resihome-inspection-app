/**
 * GET /api/services/admin/backfill-pending        → dry-run (default): what would move
 * GET /api/services/admin/backfill-pending?apply=1 → apply: assigned → pending
 *
 * One-time migration for the new far-in-advance guard: any currently-ASSIGNED
 * order whose due date is still more than 7 days out is moved back to 'pending'
 * (internal-only) so vendors don't work it too early. The daily promotion job
 * releases each back to 'assigned' — alerting the vendor — as its due date comes
 * within the window. Estimates (bids) and submitted/review orders are left alone.
 * Admin-gated. Run the schema provisioner first so the 'pending' status option exists.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillAssignedToPending } from '@/lib/services/generate';
import { easternTodayISO } from '@/lib/services/time';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const apply = req.query.apply === '1' || req.query.apply === 'true';
  try {
    const report = await backfillAssignedToPending(apply, easternTodayISO());
    if (report === null) return res.status(200).json({ configured: false, mode: apply ? 'apply' : 'dry-run', note: 'Service Work Order object type id not set — nothing to backfill.' });
    return res.status(200).json({ mode: apply ? 'apply' : 'dry-run', ...report });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), mode: apply ? 'apply' : 'dry-run' });
  }
}
