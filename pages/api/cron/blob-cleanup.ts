/**
 * GET /api/cron/blob-cleanup — daily lifecycle sweep of transient Vercel Blobs.
 *
 * Scheduled by Vercel Cron (see vercel.json). Vercel attaches
 * `Authorization: Bearer $CRON_SECRET` automatically; we require it (also accept
 * `?key=` for manual runs). Today it prunes ai-usage rollup blobs older than the
 * retention window — those accrue one blob per instance per day forever, which
 * both wastes storage and slows the dashboard's list() over time.
 *
 * Retention is env-tunable via AI_USAGE_RETENTION_DAYS (default 90).
 *
 * It also drives the AI self-improvement flywheel on a schedule: rebuild the
 * learned catalog-match model from accumulated feedback (so it stays fresh
 * without manual admin POSTs) and prune old feedback blobs.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { pruneOldAiUsage } from '@/lib/aiUsage';
import { pruneOldAiFeedback } from '@/lib/aiFeedback';
import { buildLearnedMatchModel } from '@/lib/aiLearning';
import { refreshLearnedKnowledge } from '@/lib/aiKnowledgeLearning';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const retentionDays = Math.max(1, Number(process.env.AI_USAGE_RETENTION_DAYS) || 90);
    const aiUsage = await pruneOldAiUsage(retentionDays);

    // AI flywheel: refresh the learned match model AND synthesize reviewable
    // learned-knowledge entries from feedback, then prune old feedback.
    // Best-effort — a failure here must not fail the cleanup sweep.
    let learning: any = null, knowledge: any = null, feedbackPrune: any = null;
    try {
      const model = await buildLearnedMatchModel(90);
      learning = { sampleSize: model.sampleSize, codesAdjusted: Object.keys(model.deltas).length };
    } catch (e: any) { learning = { error: String(e?.message || e).slice(0, 160) }; }
    try {
      knowledge = await refreshLearnedKnowledge(90);
    } catch (e: any) { knowledge = { error: String(e?.message || e).slice(0, 160) }; }
    try {
      feedbackPrune = await pruneOldAiFeedback(365);
    } catch (e: any) { feedbackPrune = { error: String(e?.message || e).slice(0, 160) }; }

    return res.status(200).json({ ok: true, aiUsage, retentionDays, learning, knowledge, feedbackPrune });
  } catch (e: any) {
    console.error('[cron/blob-cleanup] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
