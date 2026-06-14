/**
 * GET /api/cron/auto-cancel-stale — daily sweep that cancels abandoned inspections.
 *
 * Moves any inspection that is still "Scheduled" (never started) and a week or
 * more past its scheduled date to Cancelled. Scheduled by Vercel Cron (see
 * vercel.json). Vercel attaches `Authorization: Bearer $CRON_SECRET`
 * automatically when CRON_SECRET is set, so we require it (with a `?key=`
 * fallback for manual/local triggering). If CRON_SECRET isn't set we SKIP (a
 * safe no-op) and return 200 rather than erroring every run.
 *
 * The threshold defaults to 7 days; override with AUTO_CANCEL_DAYS_PAST_DUE.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runAutoCancelStaleScheduled } from '@/lib/autoCancelStale';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured — auto-cancel disabled.' });
  }
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const summary = await runAutoCancelStaleScheduled();
    console.log('[cron/auto-cancel-stale]', JSON.stringify(summary));
    return res.status(200).json({ ok: true, ...summary });
  } catch (e: any) {
    console.error('[cron/auto-cancel-stale] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
