/**
 * POST /api/services/[id]/review-decision — internal QC decision on a service
 * that is under Review. Both outcomes CLOSE the order to Completed:
 *   approve → full payout kept, review notes recorded.
 *   reject  → adjusted (reduced) payout + reason/notes recorded.
 *
 * Body: {
 *   decision: 'approve' | 'reject',
 *   notes?: string,                 // review notes ("speaker")
 *   vendorCost?: number,            // reject only: final vendor payout (default 0)
 *   reason?: string,                // reject only: adjustment reason
 * }
 * INTERNAL only (external users are view-only once submitted). Recomputes
 * client_cost from the final vendor cost + markup. Records reviewer + timestamp.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal reviewers only' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });
  const b = req.body || {};
  const decision = b.decision === 'reject' ? 'reject' : b.decision === 'approve' ? 'approve' : null;
  if (!decision) return res.status(400).json({ error: 'decision must be approve or reject' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ ok: true, preview: true }); // not configured / not found
    const p = rec.props;
    const originalVendorCost = Number(p.vendor_cost);
    const markup = Number(p.markup_pct);
    const now = new Date().toISOString();

    const props: Record<string, any> = {
      status: 'completed',
      review_decision: decision,
      review_notes: String(b.notes || '').slice(0, 2000),
      reviewed_by: email || '',
      reviewed_at: now,
      completed_at: now,
    };

    if (decision === 'reject') {
      // Default rejection zeroes the vendor payout; the reviewer may set another
      // final amount (e.g. the "back yard not serviced" −25% option computes it).
      const finalCost = b.vendorCost != null && b.vendorCost !== '' && Number.isFinite(Number(b.vendorCost))
        ? Math.max(0, Number(b.vendorCost)) : 0;
      props.vendor_cost = finalCost;
      if (Number.isFinite(markup)) props.client_cost = Math.round(finalCost * (1 + markup / 100) * 100) / 100;
      if (Number.isFinite(originalVendorCost)) props.vendor_cost_adjustment = Math.round((originalVendorCost - finalCost) * 100) / 100;
      props.vendor_cost_adjustment_reason = String(b.reason || b.notes || 'Rejected in review').slice(0, 500);
    }

    await patchServiceWorkOrder(id, props);
    return res.status(200).json({ ok: true, id, decision, status: 'completed', vendorCost: props.vendor_cost ?? originalVendorCost });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
