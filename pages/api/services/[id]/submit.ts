/**
 * POST /api/services/[id]/submit — Phase 4: field crew submits a completed service.
 *
 * Writes the completion form answers + before/after (and pet-station) photo URLs
 * to the Service Work Order and moves it to **submitted** with a submitted_at
 * timestamp. Status stays "submitted" (the "AI Processing" tag is derived from
 * that on the list) until the Phase 5 AI review either auto-completes it or routes
 * it to Review. Internal-gated. Photos are uploaded client-side; only URLs arrive.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { resolveServiceViewerAsync, servicesViewerAllowed } from '@/lib/services/scopeServer';
import { serviceVisibleTo } from '@/lib/services/scope';
import type { SampleService } from '@/lib/services/sampleData';
import { fetchServiceWorkOrder, patchServiceWorkOrder, createServiceWorkOrder, readServiceForms, fetchPropertyStatus } from '@/lib/hubspot';
import { runServiceAiReview } from '@/lib/services/aiReview';
import { recordServiceAudit } from '@/lib/services/serviceAudit';
import { BID_SUBTYPE, defaultRateFor } from '@/lib/services/worktypes';
import { SAMPLE_FORMS, formKey, type ServiceQuestion } from '@/lib/services/serviceForms';

// The AI review call (Claude vision) can take a few seconds — allow headroom so
// the review runs inline the moment the work order is submitted.
export const config = { maxDuration: 120 };

const cleanUrls = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((u) => String(u || '').trim()).filter(Boolean) : [];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  // The assigned crew/vendor completes the service; allow any authorized Services
  // user. Once the order has left the editable states it's locked (view-only).
  const ok = await servicesViewerAllowed(email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not authorized' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });

  // Lock: a service that's already submitted/under review/completed/canceled can
  // no longer be edited or re-submitted.
  const existing = await fetchServiceWorkOrder(id).catch(() => null);
  // Ownership: a vendor may only submit a work order assigned to THEM.
  const viewer = await resolveServiceViewerAsync(email, req);
  if (!viewer.canSeeAll && existing && !serviceVisibleTo(
    { vendor: existing.props.vendor_name || null, vendorEmail: String(existing.props.vendor_email || '').trim() || null } as SampleService,
    viewer,
  )) {
    return res.status(403).json({ error: 'Not authorized for this service.' });
  }
  if (existing && ['submitted', 'review', 'completed', 'canceled'].includes(String(existing.props.status || ''))) {
    return res.status(409).json({ error: `This service is ${existing.props.status} and can no longer be edited.` });
  }

  const b = req.body || {};
  const before = cleanUrls(b.before);
  const after = cleanUrls(b.after);
  const petBefore = cleanUrls(b.petBefore);
  const petAfter = cleanUrls(b.petAfter);
  const answers = b.answers && typeof b.answers === 'object' ? b.answers : {};
  // submittedAt comes from the client (server clock is fine too); ISO 8601.
  const submittedAt = typeof b.submittedAt === 'string' && b.submittedAt ? b.submittedAt : new Date().toISOString();

  const props: Record<string, any> = {
    status: 'submitted',
    submitted_at: submittedAt,
    answers_json: JSON.stringify(answers),
    before_photo_urls: before.join('\n'),
    after_photo_urls: after.join('\n'),
    pet_before_photo_urls: petBefore.join('\n'),
    pet_after_photo_urls: petAfter.join('\n'),
  };

  // Hard-coded grass-cut price by height (NOT driven by the question form):
  // Standard <=6" = $45, Overgrown 6–12" = $60, Heavy 12"+ = $90.
  const grassCutRate = (heightAnswer: string): number => {
    const h = String(heightAnswer || '').toLowerCase();
    if (h.includes('heavy') || h.includes('over 12') || h.includes('12"+') || h.includes('12+')) return 90;
    if (h.includes('overgrown') || h.includes('6-12') || h.includes('6–12') || h.includes('6 - 12')) return 60;
    return 45;
  };

  // ── Completion-answer pricing + routing ──────────────────────────────────
  // Universal gate: "Service Completed? = No" → skip AI, route straight to human
  // Review, and set the payout (trip-fee rate if billing a trip fee, else $0).
  // Landscaping grass-cut: price by grass height ($45/$60/$90). Whether the back
  // yard was serviced is a QC check in the AI review, not a price adjustment.
  const p0 = existing?.props || {};
  const worktype = String(p0.worktype || '');
  const subtype = String(p0.subtype || '');
  // Cost logic below is PROPERTY-scoped only. Community services get their own
  // cost rules (coming later) — for now their assigned cost is left untouched.
  const isProperty = String(p0.scope || 'property') !== 'community';
  const origVendor = Number(p0.vendor_cost);
  const markup = Number(p0.markup_pct);
  const clientOf = (v: number) => (Number.isFinite(v) && Number.isFinite(markup) ? Math.round(v * (1 + markup / 100) * 100) / 100 : v);
  // Resolve the universal answers by id OR by label — a Form-Builder-edited form
  // can carry a different question id, and we must still detect completion / trip
  // fee / grass height to price + route correctly.
  const savedForms = await readServiceForms().catch(() => null);
  const form: ServiceQuestion[] = ({ ...SAMPLE_FORMS, ...(savedForms || {}) })[formKey(worktype, subtype)] || [];
  const answerFor = (idHint: string, labelRe: RegExp) => {
    if (answers[idHint] != null && answers[idHint] !== '') return answers[idHint];
    const q = form.find((x) => labelRe.test(x.label));
    return q ? answers[q.id] : undefined;
  };
  const completedAns = answerFor('svc_completed', /service\s*completed/i);
  const billAns = answerFor('bill_trip_fee', /trip\s*fee/i);
  const heightAns = answerFor('grass_height', /grass\s*height/i);
  const notCompleted = String(completedAns) === 'no';
  const billTrip = billAns === 'yes' || billAns === true;
  // The Bill Trip Fee question only surfaces when the work isn't being completed
  // (no access / can't finish), so ANY answer to it — Yes or No — is a trip-fee
  // close-out, regardless of what the completion gate is named. This is the fix
  // for forms where "Service Completed?" was renamed (e.g. "Able to Access the
  // Property?"): pricing must still key off Bill Trip Fee, not the gate's label.
  const billAnswered = billTrip || billAns === 'no' || billAns === false;
  const closeoutNoWork = notCompleted || billAnswered;
  let routeToReview = false;
  if (closeoutNoWork) {
    routeToReview = true;                 // not completed → human review, no AI
    props.ai_verdict = 'needs_review';
    // Cost close-out (trip fee / no charge) is PROPERTY-only; community keeps its
    // assigned cost until its own rules land.
    if (isProperty) {
      const tripRate = defaultRateFor('trip_fee', 'base_trip_fee') ?? 0;
      const finalV = billTrip ? tripRate : 0;
      props.vendor_cost = finalV;
      props.client_cost = clientOf(finalV);
      if (Number.isFinite(origVendor)) {
        props.vendor_cost_adjustment = Math.round((origVendor - finalV) * 100) / 100;
        props.vendor_cost_adjustment_reason = billTrip ? 'Not completed — trip fee billed' : 'Not completed — no charge';
      }
      props.ai_notes = billTrip ? 'Vendor marked NOT completed — trip fee billed. Routed to review (AI skipped).' : 'Vendor marked NOT completed — no charge. Routed to review (AI skipped).';
    } else {
      props.ai_notes = 'Vendor marked NOT completed. Routed to review (AI skipped) — community cost handled at review.';
    }
  } else if (isProperty && worktype === 'landscaping' && subtype === 'cut') {
    // Height-based hard rate. Whether the back yard was serviced is verified by
    // the AI review (a knowledge-base check), not priced here.
    const finalV = grassCutRate(String(heightAns || ''));
    props.vendor_cost = finalV;
    props.client_cost = clientOf(finalV);
  }
  if (routeToReview) props.status = 'review';

  // Property status: LIVE until now, then STAMPED and locked at submit. Freeze
  // the property's current status onto the work order (property scope only) so
  // the card/record shows the status as it was when the crew submitted.
  if (isProperty && p0.property_id_ref && !props.property_status_snapshot) {
    const liveStatus = await fetchPropertyStatus(String(p0.property_id_ref)).catch(() => null);
    if (liveStatus) props.property_status_snapshot = liveStatus;
  }

  try {
    const okp = await patchServiceWorkOrder(id, props);
    if (!okp) return res.status(200).json({ ok: true, preview: true }); // object not configured
    void recordServiceAudit({ serviceId: id, action: 'submit', actorEmail: email, actorName: session?.name, detail: 'Completion submitted' });

    // Bid item: the crew flagged additional work. Spawn a NEW Estimated "Bid Item"
    // service — same worktype/property/community/vendor as the parent — carrying
    // the description, photos, and bid cost, for internal review.
    let bidId: string | null = null;
    let bidError: string | null = null;
    const bid = b.bid;
    if (bid && typeof bid === 'object' && String(bid.description || '').trim() && Number(bid.vendorCost) > 0) {
      const pp = existing?.props || {};
      const vc = Number(bid.vendorCost);
      const markup = Number(pp.markup_pct);
      const client = Number.isFinite(vc) && Number.isFinite(markup) ? Math.round(vc * (1 + markup / 100) * 100) / 100 : vc;
      const addr = pp.address_snapshot || pp.service_name || 'Service';
      const bidProps: Record<string, any> = {
        service_name: `Bid Item — ${addr}`,
        worktype: pp.worktype || '', subtype: BID_SUBTYPE, is_bid_item: 'true', status: 'estimated',
        scope: pp.scope || 'property', service_description: String(bid.description).slice(0, 2000),
        region_snapshot: pp.region_snapshot || '', address_snapshot: addr, locality_snapshot: pp.locality_snapshot || '',
        community_name: pp.community_name || '', property_status_snapshot: pp.property_status_snapshot || '',
        vendor_name: pp.vendor_name || '', vendor_email: pp.vendor_email || '',
        vendor_cost: vc, ...(Number.isFinite(markup) ? { markup_pct: markup } : {}), client_cost: client,
        before_photo_urls: cleanUrls(bid.photos).join('\n'),
        ...(pp.property_id_ref ? { property_id_ref: pp.property_id_ref } : {}),
        ...(pp.community_id_ref ? { community_id_ref: pp.community_id_ref } : {}),
        generated_by_rule_id: id, enrollment_key: `bid:${id}`,
      };
      try { bidId = await createServiceWorkOrder(bidProps); }
      catch (e: any) {
        // Most likely the 'bid_item' subtype enum option isn't provisioned yet —
        // retry with the parent's subtype (still flagged is_bid_item=true so it
        // reads as a Bid Item), so the bid is never lost for a schema lag.
        console.warn('[services/submit] bid create failed, retrying with parent subtype:', e?.message || e);
        try { bidId = await createServiceWorkOrder({ ...bidProps, subtype: pp.subtype || BID_SUBTYPE }); }
        catch (e2: any) { console.warn('[services/submit] bid create retry failed:', e2?.message || e2); bidError = String(e2?.message || e2).slice(0, 200); }
      }
    }

    // Not completed → we already routed straight to Review and skipped AI.
    if (routeToReview) {
      void recordServiceAudit({ serviceId: id, action: 'ai_review', actorName: 'System', detail: 'Not completed — AI skipped, routed to Review', meta: { skipped: true } });
      return res.status(200).json({ ok: true, id, status: 'review', review: null, reviewError: null, skippedAi: true, bidId, bidError });
    }

    // Kick the AI review for THIS order immediately — don't wait for the nightly
    // bulk cron. Best-effort: if it errors (e.g. ANTHROPIC_API_KEY missing) the
    // order stays "submitted" and the cron picks it up. Result + any error are
    // surfaced to the client for diagnosis (vendor UI still just shows "under review").
    let review: { verdict: string; status: string } | null = null;
    let reviewError: string | null = null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const rep = await runServiceAiReview(true, today, id);
      if (!rep) {
        reviewError = 'Services object not configured — AI review skipped.';
      } else {
        const item = rep.items.find((i) => i.id === id) || rep.items[0];
        if (!item) reviewError = 'No submitted record found for AI review.';
        else if (item.action === 'error') reviewError = item.error || 'AI review failed.';
        else review = { verdict: item.verdict, status: item.action === 'completed' ? 'completed' : item.action === 'review' ? 'review' : 'submitted' };
      }
    } catch (e: any) {
      reviewError = String(e?.message || e).slice(0, 300);
      console.warn('[services/submit] inline AI review failed (cron will retry):', e);
    }

    return res.status(200).json({ ok: true, id, status: review?.status || 'submitted', review, reviewError, bidId, bidError });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
