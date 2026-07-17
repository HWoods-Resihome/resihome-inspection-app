/**
 * POST /api/services/[id]/bid-decision — internal review of an Estimated Bid Item.
 * Same three options as the completion review:
 *   approve → assign at the vendor's bid price; sets days-until-due → ASSIGNED.
 *   modify  → assign at a revised vendor cost/markup (client cost recomputed);
 *             sets days-until-due → ASSIGNED.
 *   reject  → the order moves to CANCELED.
 * A note is required for EVERY decision.
 *
 * Body: { decision:'approve'|'modify'|'reject', notes, vendorCost?, markupPct?, dueDays? }
 * Internal only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';
import { recordServiceAudit } from '@/lib/services/serviceAudit';
import { easternTodayISO, addDaysISO } from '@/lib/services/time';

// Due date = N days from Eastern "today" (business timezone).
const addDays = (days: number): string => addDaysISO(easternTodayISO(), days);

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
  const notes = String(b.notes || '').trim();
  if (!notes) return res.status(400).json({ error: 'A decision note is required.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ ok: true, preview: true });
    const p = rec.props;
    if (p.is_bid_item !== 'true' || p.status !== 'estimated') {
      return res.status(409).json({ error: 'Not an estimated bid item.' });
    }
    const now = new Date().toISOString();
    const base: Record<string, any> = {
      review_decision: decision, review_notes: notes.slice(0, 2000),
      reviewed_by: email || '', reviewed_at: now,
    };

    if (decision === 'reject') {
      await patchServiceWorkOrder(id, { ...base, status: 'canceled' });
      void recordServiceAudit({ serviceId: id, action: 'bid', actorEmail: email, actorName: session?.name, detail: `Bid rejected → Canceled: ${notes}`.slice(0, 500), meta: { decision } });
      return res.status(200).json({ ok: true, id, status: 'canceled' });
    }

    // Approve / Modify — assign with the (possibly edited) pricing + due date.
    const vendorCost = b.vendorCost != null && b.vendorCost !== '' ? Math.max(0, Number(b.vendorCost)) : Number(p.vendor_cost) || 0;
    const markupPct = b.markupPct != null && b.markupPct !== '' ? Math.max(0, Number(b.markupPct)) : Number(p.markup_pct) || 0;
    const clientCost = Math.round(vendorCost * (1 + markupPct / 100) * 100) / 100;
    const dueDays = Number.isFinite(Number(b.dueDays)) && Number(b.dueDays) > 0 ? Math.round(Number(b.dueDays)) : 5;
    await patchServiceWorkOrder(id, {
      ...base, status: 'assigned',
      vendor_cost: vendorCost, markup_pct: markupPct, client_cost: clientCost,
      due_date: addDays(dueDays),
    });
    const verb = decision === 'modify' ? 'modified' : 'approved';
    void recordServiceAudit({ serviceId: id, action: 'bid', actorEmail: email, actorName: session?.name, detail: `Bid ${verb} → Assigned: ${notes}`.slice(0, 500), meta: { decision } });
    return res.status(200).json({ ok: true, id, status: 'assigned', vendorCost, markupPct, clientCost });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
