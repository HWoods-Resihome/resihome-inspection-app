/**
 * GET /api/cron/training-guide-sync — push the committed ResiWalk Training Guide
 * HTML into its HubSpot file whenever the content has changed.
 *
 * Scheduled by Vercel Cron (see vercel.json). Vercel attaches
 * `Authorization: Bearer $CRON_SECRET`; we require it (also accept `?key=` for
 * manual runs). No-op when the HTML hash matches the last push (cheap), so it's
 * safe to run frequently. The actual HubSpot replace runs here (token + egress
 * live on Vercel).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { syncTrainingGuideToHubspot } from '@/lib/trainingGuide';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const result = await syncTrainingGuideToHubspot({ force: false });
    if (result.synced) console.log('[training-guide-sync]', JSON.stringify(result));
    return res.status(200).json(result);
  } catch (e: any) {
    console.error('[training-guide-sync] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
