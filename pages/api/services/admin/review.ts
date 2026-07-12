/**
 * GET /api/services/admin/review            → dry-run (default): AI verdicts, no writes
 * GET /api/services/admin/review?apply=1     → apply: writes verdict + moves status
 * Optional &id=<recordId> to review a single submitted order; &today=YYYY-MM-DD.
 *
 * Phase 5 AI review for ResiWalk - Services. Reviews submitted orders' evidence
 * and either auto-completes (clean) or routes to Review. Admin-gated; PROD HubSpot
 * via the preview. No cron yet — manual only until the dry-run is validated.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { runServiceAiReview } from '@/lib/services/aiReview';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const onlyId = typeof req.query.id === 'string' && req.query.id.trim() ? req.query.id.trim() : undefined;
  const today = typeof req.query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.today)
    ? req.query.today : new Date().toISOString().slice(0, 10);
  try {
    const report = await runServiceAiReview(apply, today, onlyId);
    if (report === null) return res.status(200).json({ configured: false, mode: apply ? 'apply' : 'dry-run', note: 'Service Work Order object type id not set — nothing to review.' });
    return res.status(200).json(report);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400), detail: e?.detail || null, mode: apply ? 'apply' : 'dry-run' });
  }
}
