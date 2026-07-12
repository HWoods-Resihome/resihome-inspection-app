/**
 * GET /api/cron/services-review — nightly AI review of submitted services.
 *
 * Runs the validated AI review engine in APPLY mode over every submitted order:
 * clean → Completed (+ completed_at, ontime), needs_review → Review. Scheduled by
 * Vercel Cron (see vercel.json). Requires CRON_SECRET (Bearer token from Vercel;
 * `?key=` fallback for manual runs). Safe no-op when CRON_SECRET isn't set.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { runServiceAiReview } from '@/lib/services/aiReview';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const today = new Date().toISOString().slice(0, 10);
  try {
    const report = await runServiceAiReview(true, today);
    if (report === null) return res.status(200).json({ ok: true, skipped: true, reason: 'Service objects not configured.' });
    console.log('[cron/services-review]', JSON.stringify({ reviewed: report.reviewed, completed: report.completed, review: report.routedToReview, errors: report.errors }));
    return res.status(200).json({ ok: true, reviewed: report.reviewed, completed: report.completed, routedToReview: report.routedToReview, errors: report.errors });
  } catch (e: any) {
    console.error('[cron/services-review] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
