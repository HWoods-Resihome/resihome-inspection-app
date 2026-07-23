/**
 * POST /api/services/[id]/rerun-ai-review — ADMIN: re-run the AI review for ONE
 * service, regardless of its current status.
 *
 * Body: { apply?: boolean }
 *   - apply omitted/false → DRY RUN: returns what the verdict WOULD be (no writes).
 *   - apply true          → writes the verdict + moves status (clean → completed,
 *                           else → review), exactly like the backlog reviewer.
 *
 * Powers the admin-only "Re-run AI review" action under the gear menu in the
 * service record view. Admin-gated; vendors can never reach it.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { rerunServiceAiReview } from '@/lib/services/aiReview';
import { easternTodayISO } from '@/lib/services/time';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false)) && !session?.vendor;
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const id = String(req.query.id || '');
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'A valid service id is required.' });
  const apply = !!(req.body || {}).apply;
  try {
    const report = await rerunServiceAiReview(id, apply, easternTodayISO());
    if (report === null) return res.status(404).json({ error: 'Service not found (or Services not configured).' });
    const item = report.items[0] || null;
    return res.status(200).json({ ...report, item });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 400) });
  }
}
