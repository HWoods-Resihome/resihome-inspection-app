/**
 * GET /api/admin/ai-usage?days=7
 *
 * Returns aggregated AI usage + estimated cost for the last `days` days, summed
 * across every server instance's daily rollup blob (see lib/aiUsage.ts). Powers
 * the /admin/ai-usage dashboard. The structured `[ai-usage]` logs remain the
 * authoritative record; this is the convenient at-a-glance estimate.
 *
 * Gated to authenticated @resihome.com staff. Read-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { readAiUsage } from '@/lib/aiUsage';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const raw = Number(req.query.days);
    const days = Number.isFinite(raw) && raw > 0 ? Math.min(90, Math.round(raw)) : 7;
    const usage = await readAiUsage(days);
    return res.status(200).json({ ok: true, days, ...usage });
  } catch (e: any) {
    console.error('[ai-usage] endpoint failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
