/**
 * POST /api/admin/backfill-billing-fields
 *
 * One-time (resumable) backfill of the billing fields on existing inspections:
 * copies entity_id/full_address (property) + broker_code + vendor/client invoice
 * (agent matched by HubSpot owner) onto each inspection, and stamps
 * first_completed_date from completed_at where missing. Idempotent. Applies the
 * current vendor-cost rule: the matched agent's value wins; otherwise $50 for a
 * 1099 (external) inspector, $0 for internal — never null.
 *
 * AUTO-DRAINS: each call keeps processing batches until the whole dataset is done
 * OR a ~250s time budget is hit. If it hits the budget it returns `nextAfter` +
 * a `resume` URL — re-POST that to continue. Usually one call finishes everything.
 *
 * Gated to authenticated @resihome.com staff.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillBillingFields } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const batch = Number(req.query.max) || 300;        // records per internal batch
    const deadline = Date.now() + 250_000;             // stay under the 300s ceiling
    let after = typeof req.query.after === 'string' ? req.query.after : undefined;
    let processed = 0, updated = 0, errors = 0;
    let done = false;
    do {
      const s = await backfillBillingFields({ after, max: batch });
      processed += s.processed; updated += s.updated; errors += s.errors;
      after = s.nextAfter || undefined;
      done = !s.nextAfter;
    } while (!done && Date.now() < deadline);

    const resume = done ? null
      : `/api/admin/backfill-billing-fields?after=${encodeURIComponent(after || '')}&max=${batch}`;
    return res.status(200).json({ ok: true, done, processed, updated, errors, nextAfter: after || null, resume });
  } catch (e: any) {
    console.error('[backfill-billing-fields] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
