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
import { fetchServiceWorkOrder, patchServiceWorkOrder, createServiceWorkOrder } from '@/lib/hubspot';
import { recordServiceAudit } from '@/lib/services/serviceAudit';
import { defaultRateFor } from '@/lib/services/worktypes';
import { isCommunityCutMaster, splitMasterCommunityCut } from '@/lib/services/split';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { notifyServiceCompleted } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';
import { easternTodayISO, addDaysISO } from '@/lib/services/time';

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

    // Community grass-cut MASTER → split into one completed per-property billing
    // line each (children carry for_billing; master leaves billing). A rejection
    // pays nothing, so no children — just flag the master out of billing.
    let split: { childIds: string[]; count: number } | null = null;
    if (isCommunityCutMaster(p) && p.for_billing !== 'false') {
      if (decision === 'reject') {
        await patchServiceWorkOrder(id, { for_billing: 'false', split_at: now }).catch(() => {});
      } else {
        try {
          const finalVendorCost = Number.isFinite(Number(props.vendor_cost)) ? Number(props.vendor_cost) : Number(p.vendor_cost) || 0;
          const markup = Number.isFinite(Number(props.markup_pct)) ? Number(props.markup_pct) : (Number.isFinite(Number(p.markup_pct)) ? Number(p.markup_pct) : null);
          split = await splitMasterCommunityCut({
            masterId: id, masterProps: p, finalVendorCost, markupPct: markup,
            closedAt: now, reviewedBy: email || '', reviewNotes: notes, decision,
          });
          void recordServiceAudit({ serviceId: id, action: 'review', actorEmail: email, actorName: session?.name, detail: `Split into ${split.count} per-property billing line${split.count === 1 ? '' : 's'}`.slice(0, 500), meta: { split: true, count: split.count } });
        } catch (e: any) {
          console.warn('[services/review-decision] community-cut split failed:', e?.message || e);
        }
      }
    }

    // Notify the vendor their service completed (approve/modify only — a
    // rejection denies payment, so it isn't a "completed" outcome to celebrate).
    if (decision !== 'reject') {
      await notifyServiceCompleted({
        serviceId: id, vendorEmail: p.vendor_email, vendorName: p.vendor_name,
        address: p.address_snapshot || p.service_name || 'your service', locality: p.locality_snapshot,
        worktypeLabel: worktypeLabel(String(p.worktype || '')), subtypeLabel: subtypeLabel(String(p.worktype || ''), String(p.subtype || '')),
        baseUrl: appBaseUrl(req),
      });
    }

    // Re-Issue: the reviewer wants the work redone. Spin up a fresh service with
    // the SAME requirements (worktype/subtype/description), property/community,
    // and vendor — due in N days — with the reviewer's note surfaced at the top
    // of the description for the vendor. The original above already closed out.
    let reissuedId: string | null = null;
    if (b.reissue) {
      const days = Math.max(1, Math.round(Number(b.reissueDays) || 0));
      const dueDate = addDaysISO(easternTodayISO(), days);
      const reNote = String(b.reissueNote || '').trim();
      // Recover the original job cost (submit had reduced vendor_cost to the trip
      // fee; adding back the recorded adjustment restores the real rate). Fall
      // back to the worktype/subtype default if it can't be reconstructed.
      const adj = Number(p.vendor_cost_adjustment);
      let jobCost = Number(p.vendor_cost);
      if (Number.isFinite(adj)) jobCost = (Number.isFinite(jobCost) ? jobCost : 0) + adj;
      if (!Number.isFinite(jobCost) || jobCost <= 0) jobCost = defaultRateFor(String(p.worktype || ''), String(p.subtype || '')) ?? 0;
      const markup = Number(p.markup_pct);
      const clientCost = Number.isFinite(markup) ? Math.round(jobCost * (1 + markup / 100) * 100) / 100 : jobCost;
      const origDesc = String(p.service_description || '');
      const reBy = session?.name || email || 'Office';
      const newDesc = (reNote ? `⚠ Re-issued by ${reBy}: ${reNote}\n\n${origDesc}` : origDesc).slice(0, 2000);
      const cloneProps: Record<string, any> = {
        service_name: p.service_name || p.address_snapshot || 'Service',
        worktype: p.worktype || '', subtype: p.subtype || '', status: 'assigned', is_bid_item: 'false',
        scope: p.scope || 'property', service_description: newDesc, due_date: dueDate,
        region_snapshot: p.region_snapshot || '', address_snapshot: p.address_snapshot || '', locality_snapshot: p.locality_snapshot || '',
        community_name: p.community_name || '', property_status_snapshot: p.property_status_snapshot || '',
        vendor_name: p.vendor_name || '', vendor_email: p.vendor_email || '',
        pet_stations: p.pet_stations === 'true' ? 'true' : 'false',
        vendor_cost: jobCost, ...(Number.isFinite(markup) ? { markup_pct: markup } : {}), client_cost: clientCost,
        ...(p.property_id_ref ? { property_id_ref: p.property_id_ref } : {}),
        ...(p.community_id_ref ? { community_id_ref: p.community_id_ref } : {}),
        generated_by_rule_id: id, enrollment_key: `reissue:${id}`,
      };
      try {
        reissuedId = await createServiceWorkOrder(cloneProps);
        void recordServiceAudit({ serviceId: id, action: 'review', actorEmail: email, actorName: session?.name, detail: `Re-issued → new service ${reissuedId || '(preview)'} due ${dueDate}${reNote ? ` · note: ${reNote}` : ''}`.slice(0, 500), meta: { reissue: true, reissuedId, dueDate } });
      } catch (e: any) {
        console.warn('[services/review-decision] re-issue create failed:', e?.message || e);
        // The original still closed out; surface the re-issue failure to the client.
        return res.status(200).json({ ok: true, id, decision, status: 'completed', vendorCost: props.vendor_cost ?? originalVendorCost, reissued: false, reissueError: String(e?.message || e).slice(0, 200) });
      }
    }
    return res.status(200).json({ ok: true, id, decision, status: 'completed', vendorCost: props.vendor_cost ?? originalVendorCost, reissued: !!b.reissue, reissuedId, split: split ? split.count : null });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
