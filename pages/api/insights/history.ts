/**
 * /api/insights/history   (canView — app admin OR Insights-Only user)
 *
 *   GET -> { history }   banked daily rollups (ascending by date) for the
 *                        trend / sparkline / "vs previous period" cards.
 *
 * Returns whatever has accrued so far — the cron banks one rollup per UTC day.
 * Until enough days exist, the trend/delta cards show "collecting history"
 * rather than faking a line.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { canViewInsights } from '@/lib/insightsAccess';
import { readInsightsHistory } from '@/lib/insightsSnapshot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await canViewInsights(session.email))) return res.status(403).json({ error: 'Insights access required.' });

  try {
    return res.status(200).json({ history: await readInsightsHistory() });
  } catch (e: any) {
    console.error('[insights/history] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
