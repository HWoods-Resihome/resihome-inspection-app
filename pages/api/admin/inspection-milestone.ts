/**
 * GET /api/admin/inspection-milestone?milestone=1000
 *     → dry-run: identify the inspection + inspector that hit the milestone, and
 *       whether it's already been celebrated.
 * GET /api/admin/inspection-milestone?milestone=1000&apply=1
 *     → send the celebration email to that inspector and record the once-only claim.
 * GET ...&apply=1&force=1
 *     → resend even if the milestone was already claimed (stuck claim / manual resend).
 *
 * Admin-gated. Used to send a milestone email the live completion path missed
 * (e.g. the portal crossed the threshold before the milestone feature shipped).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { resendInspectionMilestone } from '@/lib/inspectionMilestones';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const milestone = Number(req.query.milestone || 1000);
  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const force = req.query.force === '1' || req.query.force === 'true';
  try {
    const report = await resendInspectionMilestone(milestone, { apply, force });
    return res.status(200).json({ mode: apply ? 'apply' : 'dry-run', force, ...report });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
