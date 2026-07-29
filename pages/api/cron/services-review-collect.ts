/**
 * GET /api/cron/services-review-collect — phase 2 of batch-mode service AI review.
 *
 * When SERVICE_AI_REVIEW_BATCH is on, the nightly /api/cron/services-review job
 * SUBMITS the submitted-order backlog to the Anthropic Message Batches API (50%
 * cheaper) and returns — it does NOT wait for results (a batch can take up to an
 * hour). This frequent cron polls each pending batch and, once it has ended,
 * applies the verdicts (clean → Completed, else → Review) through the same path
 * as the synchronous review. It's a cheap no-op when no batch is pending, so it's
 * harmless to run on an interval even while batch mode is disabled.
 *
 * Requires CRON_SECRET (Bearer from Vercel; `?key=` fallback for manual runs).
 * Safe no-op when CRON_SECRET isn't set.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { collectServiceAiReviewBatches } from '@/lib/services/aiReview';
import { easternTodayISO } from '@/lib/services/time';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(200).json({ ok: true, skipped: true, reason: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const r = await collectServiceAiReviewBatches(easternTodayISO());
    if (!r.configured) return res.status(200).json({ ok: true, skipped: true, reason: 'BLOB_READ_WRITE_TOKEN not configured.' });
    if (r.endedBatches || r.pendingBatches || r.errors) {
      console.log('[cron/services-review-collect]', JSON.stringify(r));
    }
    return res.status(200).json({ ok: true, ...r });
  } catch (e: any) {
    console.error('[cron/services-review-collect] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
