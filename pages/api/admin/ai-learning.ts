import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { buildLearnedMatchModel, getLearnedMatchModel, isLearningEnabled } from '@/lib/aiLearning';

/**
 * AI self-improvement model admin.
 *
 *   GET  /api/admin/ai-learning        → current learned match model + whether
 *                                         application is enabled (AI_LEARNING_ENABLED).
 *   POST /api/admin/ai-learning        → rebuild the model from accumulated
 *                                         feedback (deliberate, reviewable step).
 *                                         Body: { days?: number } (default 90).
 *
 * Recommended flow: rebuild → review the deltas → run `npm run eval` with
 * AI_LEARNING_ENABLED=1 to confirm matching improves → enable the flag in prod.
 *
 * Gated to @resihome.com staff.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const days = Math.max(1, Math.min(365, Number(body.days) || 90));
      const model = await buildLearnedMatchModel(days);
      const codes = Object.keys(model.deltas);
      return res.status(200).json({
        rebuilt: true,
        days,
        enabledForServing: isLearningEnabled(),
        summary: {
          sampleSize: model.sampleSize,
          codesAdjusted: codes.length,
          boosted: codes.filter((c) => model.deltas[c] > 0).length,
          demoted: codes.filter((c) => model.deltas[c] < 0).length,
        },
        model,
      });
    }
    if (req.method === 'GET') {
      const model = await getLearnedMatchModel();
      return res.status(200).json({
        enabledForServing: isLearningEnabled(),
        hasModel: !!model,
        model,
      });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error('[ai-learning] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
