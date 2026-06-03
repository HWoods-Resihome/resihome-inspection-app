/**
 * POST /api/admin/backfill-billing-fields
 *
 * One-time (resumable) backfill of the billing fields on existing inspections:
 * copies entity_id/full_address (property) + broker_code + vendor/client invoice
 * (agent matched by HubSpot owner) onto each inspection, and stamps
 * first_completed_date from completed_at where missing. Idempotent.
 *
 * Paginated: processes up to `max` (default 300) records per call starting from
 * the optional `after` cursor; returns `nextAfter` (null when done). Loop until
 * nextAfter is null.
 *
 * Gated to authenticated @resihome.com staff.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { backfillBillingFields } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    const max = Number(req.query.max) || 300;
    const summary = await backfillBillingFields({ after, max });
    return res.status(200).json({ ok: true, ...summary });
  } catch (e: any) {
    console.error('[backfill-billing-fields] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
