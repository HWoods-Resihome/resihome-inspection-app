/**
 * POST /api/services/[id]/review-decision — internal QC decision on a service
 * that is under Review. ALL three outcomes CLOSE the order to Completed and
 * ALL require a decision note:
 *   approve → pricing kept as-is; note recorded.
 *   modify  → reviewer edits vendor cost and/or markup; client cost recomputed;
 *             note recorded.
 *   reject  → payment denied: vendor payout → $0 (client cost → $0); note recorded.
 *
 * Body: {
 *   decision: 'approve' | 'modify' | 'reject',
 *   notes: string,                  // REQUIRED for every decision
 *   vendorCost?: number,            // modify only: revised vendor payout
 *   markupPct?: number,             // modify only: revised markup %
 * }
 * INTERNAL only (external users are view-only once submitted). Records reviewer +
 * timestamp.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';
import { recordServiceAudit } from '@/lib/services/serviceAudit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal reviewers only' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });
  const b = req.body || {};
  const decision = ['approve', 'modify', 'reject'].includes(b.decision) ? b.decision as 'approve' | 'modify' | 'reject' : null;
  if (!decision) return res.status(400).json({ error: 'decision must be approve, modify, or reject' });
  // Every decision must carry a note (it's the reason, on the record).
  const notes = String(b.notes || '').trim();
  if (!notes) return res.status(400).json({ error: 'A decision note is required.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ ok: true, preview: true }); // not configured / not found
    const p = rec.props;
    const originalVendorCost = Number(p.vendor_cost);
    const now = new Date().toISOString();

    const props: Record<string, any> = {
      status: 'completed',
      review_decision: decision,
      review_notes: notes.slice(0, 2000),
      reviewed_by: email || '',
      reviewed_at: now,
      completed_at: now,
    };

    if (decision === 'modify') {
      // Reviewer revised the vendor payout and/or markup — recompute client cost.
      const finalCost = b.vendorCost != null && b.vendorCost !== '' && Number.isFinite(Number(b.vendorCost))
        ? Math.max(0, Number(b.vendorCost)) : (Number.isFinite(originalVendorCost) ? originalVendorCost : 0);
      const markup = b.markupPct != null && b.markupPct !== '' && Number.isFinite(Number(b.markupPct))
        ? Number(b.markupPct) : Number(p.markup_pct);
      props.vendor_cost = finalCost;
      if (Number.isFinite(markup)) { props.markup_pct = markup; props.client_cost = Math.round(finalCost * (1 + markup / 100) * 100) / 100; }
      if (Number.isFinite(originalVendorCost) && originalVendorCost !== finalCost) {
        props.vendor_cost_adjustment = Math.round((originalVendorCost - finalCost) * 100) / 100;
        props.vendor_cost_adjustment_reason = notes.slice(0, 500);
      }
    } else if (decision === 'reject') {
      // Rejection denies the payment: vendor payout → $0, client cost → $0.
      props.vendor_cost = 0;
      props.client_cost = 0;
      if (Number.isFinite(originalVendorCost)) props.vendor_cost_adjustment = Math.round(originalVendorCost * 100) / 100;
      props.vendor_cost_adjustment_reason = notes.slice(0, 500);
    }

    await patchServiceWorkOrder(id, props);
    const decisionLabel = decision === 'reject' ? 'Rejected — payment denied' : decision === 'modify' ? 'Modified pricing' : 'Approved';
    void recordServiceAudit({ serviceId: id, action: 'review', actorEmail: email, actorName: session?.name, detail: `${decisionLabel}: ${notes}`.slice(0, 500), meta: { decision } });
    return res.status(200).json({ ok: true, id, decision, status: 'completed', vendorCost: props.vendor_cost ?? originalVendorCost });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
