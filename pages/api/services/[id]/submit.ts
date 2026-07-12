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
import { servicesEnabled } from '@/lib/servicesAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder, createServiceWorkOrder } from '@/lib/hubspot';
import { runServiceAiReview } from '@/lib/services/aiReview';
import { BID_SUBTYPE } from '@/lib/services/worktypes';

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
  const ok = await servicesEnabled(email).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not authorized' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });

  // Lock: a service that's already submitted/under review/completed/canceled can
  // no longer be edited or re-submitted.
  const existing = await fetchServiceWorkOrder(id).catch(() => null);
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

  try {
    const okp = await patchServiceWorkOrder(id, props);
    if (!okp) return res.status(200).json({ ok: true, preview: true }); // object not configured

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
