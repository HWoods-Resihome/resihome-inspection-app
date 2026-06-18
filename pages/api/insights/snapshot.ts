/**
 * /api/insights/snapshot   (canView — app admin OR Insights-Only user)
 *
 *   GET -> { snapshot }   the latest pre-aggregated Insights snapshot (+ asOf).
 *
 * Serves the Blob snapshot instantly (no live HubSpot query). If none exists yet
 * (first ever load, before the cron has run), it builds one on-demand and caches
 * it so the portal is never empty. The dashboard reads this and does all
 * filtering/aggregation client-side.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { canViewInsights } from '@/lib/insightsAccess';
import { readInsightsSnapshot, buildInsightsSnapshot, writeInsightsSnapshot } from '@/lib/insightsSnapshot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await canViewInsights(session.email))) return res.status(403).json({ error: 'Insights access required.' });

  try {
    let snapshot = await readInsightsSnapshot();
    if (!snapshot) {
      // First load before any cron run — build once so the portal isn't empty.
      snapshot = await buildInsightsSnapshot();
      try { await writeInsightsSnapshot(snapshot); } catch { /* serve it even if the write fails */ }
    }
    return res.status(200).json({ snapshot });
  } catch (e: any) {
    console.error('[insights/snapshot] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
