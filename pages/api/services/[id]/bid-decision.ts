/**
 * POST /api/services/[id]/bid-decision — internal review of an Estimated Bid Item.
 * Approve/Modify have TWO completion routes (via `finalize`):
 *   finalize='assign'   (default) → the vendor still has to do the work: sets a
 *                         days-until-due and moves the bid to ASSIGNED.
 *   finalize='complete' → the vendor ALREADY did the work (it was flagged and
 *                         performed on the same visit): the bid closes straight to
 *                         COMPLETED (skips assign → do → submit), so it flows to
 *                         billing now, and the vendor is emailed a completion
 *                         confirmation with the PDF.
 * In both cases:
 *   approve → keep the vendor's bid price. modify → revised vendor cost/markup
 *             (client cost recomputed). reject → the order moves to CANCELED.
 * A note is required for Modify and Reject (a plain Approve may proceed without one).
 *
 * Body: { decision:'approve'|'modify'|'reject', notes, vendorCost?, markupPct?, dueDays?, finalize? }
 * Internal only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder, fetchPropertyStatus } from '@/lib/hubspot';
import { recordServiceAudit } from '@/lib/services/serviceAudit';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { notifyServiceCompleted } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';
import { easternTodayISO, addDaysISO } from '@/lib/services/time';
import { waitUntil } from '@vercel/functions';

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
  // Modify/Reject must say why; a plain Approve may proceed without a note.
  if (!notes && decision !== 'approve') return res.status(400).json({ error: 'A decision note is required for Modify and Reject.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ ok: true, preview: true });
    const p = rec.props;
    if (p.is_bid_item !== 'true' || p.status !== 'estimated') {
      return res.status(409).json({ error: 'Not an estimated bid item.' });
    }
    const now = new Date().toISOString();
    // The reviewer's NAME (not email) shows to the vendor on the record + PDF.
    const base: Record<string, any> = {
      review_decision: decision, review_notes: notes.slice(0, 2000),
      reviewed_by: session?.name || email || '', reviewed_at: now,
    };

    if (decision === 'reject') {
      await patchServiceWorkOrder(id, { ...base, status: 'canceled' });
      void recordServiceAudit({ serviceId: id, action: 'bid', actorEmail: email, actorName: session?.name, detail: `Bid rejected → Canceled: ${notes}`.slice(0, 500), meta: { decision } });
      return res.status(200).json({ ok: true, id, status: 'canceled' });
    }

    // Approve / Modify — apply the (possibly edited) pricing.
    const vendorCost = b.vendorCost != null && b.vendorCost !== '' ? Math.max(0, Number(b.vendorCost)) : Number(p.vendor_cost) || 0;
    const markupPct = b.markupPct != null && b.markupPct !== '' ? Math.max(0, Number(b.markupPct)) : Number(p.markup_pct) || 0;
    const clientCost = Math.round(vendorCost * (1 + markupPct / 100) * 100) / 100;
    const verb = decision === 'modify' ? 'modified' : 'approved';
    const finalize = b.finalize === 'complete' ? 'complete' : 'assign';

    // finalize='complete' — the vendor already performed the flagged work, so close
    // the bid straight to Completed (skip assign → do → submit) and email them the
    // completion confirmation with the PDF, exactly like the QC completion review.
    if (finalize === 'complete') {
      // Freeze the property's current status onto the order (the "status at
      // completion" the billing report shows). The normal submit flow stamps this,
      // but this path skips submit — so without it a completed bid item had a blank
      // Property Status in billing. Property scope only; don't clobber an existing one.
      const completeProps: Record<string, any> = {
        ...base, status: 'completed',
        vendor_cost: vendorCost, markup_pct: markupPct, client_cost: clientCost,
        completed_at: now,
      };
      if (p.property_id_ref && !p.property_status_snapshot) {
        const liveStatus = await fetchPropertyStatus(String(p.property_id_ref)).catch(() => null);
        if (liveStatus) completeProps.property_status_snapshot = liveStatus;
      }
      await patchServiceWorkOrder(id, completeProps);
      void recordServiceAudit({ serviceId: id, action: 'bid', actorEmail: email, actorName: session?.name, detail: (notes ? `Bid ${verb} → Completed (vendor already performed the work): ${notes}` : `Bid ${verb} → Completed (vendor already performed the work)`).slice(0, 500), meta: { decision, finalize } });
      // Vendor completion email (PDF attached). Deferred via waitUntil — the PDF
      // render + send is seconds of work the reviewer's screen shouldn't wait on;
      // the record is already Completed above, so the background job re-reads it.
      waitUntil(
        notifyServiceCompleted({
          serviceId: id, vendorEmail: p.vendor_email, vendorName: p.vendor_name,
          address: p.address_snapshot || p.service_name || 'your service', locality: p.locality_snapshot,
          worktypeLabel: worktypeLabel(String(p.worktype || '')), subtypeLabel: subtypeLabel(String(p.worktype || ''), String(p.subtype || '')),
          baseUrl: appBaseUrl(req), decision, reviewerNote: notes,
        }).catch((e) => console.warn('[services/bid-decision] vendor notify failed:', e?.message || e)),
      );
      return res.status(200).json({ ok: true, id, status: 'completed', vendorCost, markupPct, clientCost });
    }

    // finalize='assign' (default) — the vendor still has to do the work: set a
    // days-until-due and move the bid to Assigned.
    const dueDays = Number.isFinite(Number(b.dueDays)) && Number(b.dueDays) > 0 ? Math.round(Number(b.dueDays)) : 5;
    await patchServiceWorkOrder(id, {
      ...base, status: 'assigned',
      vendor_cost: vendorCost, markup_pct: markupPct, client_cost: clientCost,
      due_date: addDays(dueDays),
    });
    void recordServiceAudit({ serviceId: id, action: 'bid', actorEmail: email, actorName: session?.name, detail: (notes ? `Bid ${verb} → Assigned: ${notes}` : `Bid ${verb} → Assigned`).slice(0, 500), meta: { decision, finalize } });
    return res.status(200).json({ ok: true, id, status: 'assigned', vendorCost, markupPct, clientCost });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
