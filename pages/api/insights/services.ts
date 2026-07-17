/**
 * /api/insights/services   (canView — app admin OR Insights-Only user)
 *
 *   GET -> { insights }   vendor-performance metrics for the Insights → Services
 *                         tab: overall + per-vendor completion %, on-time %,
 *                         bid-item %, closed-out count, reject/modify rate, avg
 *                         vendor cost. Computed live from Service Work Orders
 *                         (volume is small); null insights when the object isn't
 *                         provisioned yet.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { canViewInsights } from '@/lib/insightsAccess';
import { fetchServiceInsightsRows } from '@/lib/hubspot';
import { computeServiceInsights } from '@/lib/services/insights';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await canViewInsights(session.email))) return res.status(403).json({ error: 'Insights access required.' });

  try {
    const rows = await fetchServiceInsightsRows();
    if (rows === null) return res.status(200).json({ insights: null, configured: false });
    return res.status(200).json({ insights: computeServiceInsights(rows), configured: true });
  } catch (e: any) {
    console.error('[insights/services] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
