/**
 * GET /api/cron/services-generate — nightly rule → work-order generation.
 *
 * Runs the validated generation engine in APPLY mode: for each active Service
 * Rule, creates the Service Work Orders its coverage + enrollment call for
 * (idempotent — one open order per rule+target). Scheduled by Vercel Cron (see
 * vercel.json). Requires CRON_SECRET (Vercel sends it as a Bearer token; a
 * `?key=` fallback allows manual triggering). Skips as a safe no-op when
 * CRON_SECRET isn't set.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runServiceGeneration } from '@/lib/services/generate';
import { easternTodayISO } from '@/lib/services/time';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const today = easternTodayISO();
  try {
    const report = await runServiceGeneration(true, today);
    if (report === null) return res.status(200).json({ ok: true, skipped: true, reason: 'Service objects not configured.' });
    console.log('[cron/services-generate]', JSON.stringify({ created: report.created, skipped: report.skippedExisting, errors: report.errors }));
    return res.status(200).json({ ok: true, created: report.created, skippedExisting: report.skippedExisting, errors: report.errors });
  } catch (e: any) {
    console.error('[cron/services-generate] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
