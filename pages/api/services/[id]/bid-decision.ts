/**
 * POST /api/services/[id]/bid-decision — internal review of an Estimated Bid Item.
 *   approve → the reviewer may edit the vendor cost and/or markup (client cost is
 *             computed + locked), sets days-until-due, and the order moves to
 *             ASSIGNED (follows the normal cadence).
 *   reject  → the order moves to CANCELED; a note is required.
 *
 * Body: { decision:'approve'|'reject', notes?, vendorCost?, markupPct?, dueDays? }
 * Internal only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';
import { recordServiceAudit } from '@/lib/services/serviceAudit';

function addDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
  if (!String(b.notes || '').trim() && decision === 'reject') return res.status(400).json({ error: 'A note is required to reject.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ ok: true, preview: true });
    const p = rec.props;
    if (p.is_bid_item !== 'true' || p.status !== 'estimated') {
      return res.status(409).json({ error: 'Not an estimated bid item.' });
    }
    const now = new Date().toISOString();
    const base: Record<string, any> = {
      review_decision: decision, review_notes: String(b.notes || '').slice(0, 2000),
      reviewed_by: email || '', reviewed_at: now,
    };

    if (decision === 'reject') {
      await patchServiceWorkOrder(id, { ...base, status: 'canceled' });
      void recordServiceAudit({ serviceId: id, action: 'bid', actorEmail: email, actorName: session?.name, detail: `Bid rejected → Canceled: ${String(b.notes || '')}`.slice(0, 500), meta: { decision } });
      return res.status(200).json({ ok: true, id, status: 'canceled' });
    }

    // Approve — lock in the (possibly edited) pricing and set the due date.
    const vendorCost = b.vendorCost != null && b.vendorCost !== '' ? Math.max(0, Number(b.vendorCost)) : Number(p.vendor_cost) || 0;
    const markupPct = b.markupPct != null && b.markupPct !== '' ? Math.max(0, Number(b.markupPct)) : Number(p.markup_pct) || 0;
    const clientCost = Math.round(vendorCost * (1 + markupPct / 100) * 100) / 100;
    const dueDays = Number.isFinite(Number(b.dueDays)) && Number(b.dueDays) > 0 ? Math.round(Number(b.dueDays)) : 5;
    await patchServiceWorkOrder(id, {
      ...base, status: 'assigned',
      vendor_cost: vendorCost, markup_pct: markupPct, client_cost: clientCost,
      due_date: addDays(dueDays),
    });
    void recordServiceAudit({ serviceId: id, action: 'bid', actorEmail: email, actorName: session?.name, detail: `Bid approved → Assigned${String(b.notes || '').trim() ? `: ${b.notes}` : ''}`.slice(0, 500), meta: { decision } });
    return res.status(200).json({ ok: true, id, status: 'assigned', vendorCost, markupPct, clientCost });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
