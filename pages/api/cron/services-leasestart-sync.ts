/**
 * GET /api/cron/services-leasestart-sync — re-syncs lease-anchored move-in-clean
 * due dates as the leasing deal's lease start date populates: reschedules the due
 * to N days before lease start (floored to tomorrow), or cancels when the lease is
 * already within a day. Runs hourly so a freshly-populated date takes effect (and
 * the within-24h cancel fires) promptly. Requires CRON_SECRET.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { easternTodayISO } from '@/lib/services/model';
import { syncMoveInCleanDueDates } from '@/lib/services/leaseSync';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

  // Manual dry-run for an admin/operator: /api/cron/services-leasestart-sync?dry=1
  const apply = req.query.dry !== '1';
  try {
    const result = await syncMoveInCleanDueDates(apply, easternTodayISO());
    if (result === null) return res.status(200).json({ ok: true, skipped: true, reason: 'Services object not configured.' });
    if (result.rescheduled || result.canceled || result.errors) {
      console.log(`[leasestart-sync] apply=${apply} scanned=${result.scanned} rescheduled=${result.rescheduled} canceled=${result.canceled} pending=${result.stillPending} errors=${result.errors}`);
    }
    return res.status(200).json({ ok: true, apply, ...result });
  } catch (e: any) {
    console.error('[leasestart-sync] failed:', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 300) });
  }
}
