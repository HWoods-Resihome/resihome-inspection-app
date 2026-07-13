/**
 * Community grass-cut billing split (RECURRING_SERVICES_PLAN.md — "PPW Replacement").
 *
 * A community Landscaping ▸ Grass Cut is ONE master service in the field (the crew
 * works it, one photo set, one submit) but bills as INDIVIDUAL per-property cuts.
 * On close-out the master splits into one COMPLETED Service Work Order per covered
 * property — the "completed billing line items". Children carry `master_service_id`
 * and reference the master's photos (never duplicated); a `for_billing` flag flips
 * master→false / children→true so billing never double-counts.
 *
 * Split runs on the reviewer's close-out decision (approve/modify). A rejection
 * denies payment: no children are created and the master is flagged out of billing.
 */
import { fetchCommunityProperties, createServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';
import { worktypeLabel, subtypeLabel } from './worktypes';

/** True when this Service Work Order is a community grass-cut MASTER that should
 *  split on close-out (not itself a child, and not already split). */
export function isCommunityCutMaster(p: Record<string, any>): boolean {
  return p.scope === 'community'
    && p.worktype === 'landscaping'
    && p.subtype === 'cut'
    && !String(p.master_service_id || '').trim()      // not a child
    && !!parseIds(p.covered_property_ids).length;      // has a covered snapshot
}

export function parseIds(s: any): string[] {
  try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(String).filter(Boolean) : []; }
  catch { return []; }
}

/** Split `finalVendorCost` across `count` line items in whole cents so the children
 *  sum EXACTLY to the master total (the remainder pennies go to the first items). */
function distributeCents(finalVendorCost: number, count: number): number[] {
  if (count <= 0) return [];
  const totalCents = Math.round((Number.isFinite(finalVendorCost) ? finalVendorCost : 0) * 100);
  const base = Math.floor(totalCents / count);
  let rem = totalCents - base * count;
  return Array.from({ length: count }, () => { const c = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; return c / 100; });
}

export interface SplitResult { childIds: string[]; count: number; skipped?: string }

/**
 * Create one completed per-property billing child for each covered property and
 * flip the master out of billing. `finalVendorCost` is the master's approved total
 * (post-modify); it is distributed evenly across children so they sum to it exactly.
 * Idempotent-ish: caller should only invoke once (guarded by master.for_billing).
 */
export async function splitMasterCommunityCut(opts: {
  masterId: string;
  masterProps: Record<string, any>;
  finalVendorCost: number;
  markupPct: number | null;
  closedAt: string;
  reviewedBy: string;
  reviewNotes: string;
  decision: 'approve' | 'modify';
}): Promise<SplitResult> {
  const { masterId, masterProps: p, finalVendorCost, markupPct, closedAt, reviewedBy, reviewNotes, decision } = opts;
  const coveredIds = parseIds(p.covered_property_ids);
  if (!coveredIds.length) return { childIds: [], count: 0, skipped: 'no covered properties' };

  const communityId = String(p.community_id_ref || '').trim();
  const all = communityId ? await fetchCommunityProperties(communityId) : [];
  const byId = new Map(all.map((x) => [x.id, x]));
  const wt = String(p.worktype || 'landscaping');
  const st = String(p.subtype || 'cut');
  const perChild = distributeCents(finalVendorCost, coveredIds.length);
  const childIds: string[] = [];

  for (let i = 0; i < coveredIds.length; i++) {
    const propId = coveredIds[i];
    const cp = byId.get(propId);
    const address = cp?.address || String(p.address_snapshot || '') || `Property ${propId}`;
    const vendorCost = perChild[i] ?? 0;
    const clientCost = markupPct != null && Number.isFinite(markupPct)
      ? Math.round(vendorCost * (1 + markupPct / 100) * 100) / 100 : vendorCost;
    // A self-describing COMPLETED billing line. No photos — it references the
    // master's photos via master_service_id (the UI/PDF resolves them there).
    const childProps: Record<string, any> = {
      service_name: `${worktypeLabel(wt)} · ${subtypeLabel(wt, st)} — ${address}`,
      worktype: wt, subtype: st, status: 'completed', is_bid_item: 'false', scope: 'property',
      service_description: String(p.service_description || ''),
      due_date: p.due_date || '', region_snapshot: cp?.region || p.region_snapshot || '',
      address_snapshot: address, locality_snapshot: cp?.locality || p.locality_snapshot || '',
      community_name: p.community_name || '', property_status_snapshot: cp?.status || '',
      vendor_name: p.vendor_name || '', vendor_email: p.vendor_email || '',
      vendor_cost: vendorCost, ...(markupPct != null && Number.isFinite(markupPct) ? { markup_pct: markupPct } : {}),
      client_cost: clientCost,
      submitted_at: p.submitted_at || '', completed_at: closedAt,
      review_decision: decision === 'modify' ? 'modify' : 'approve',
      review_notes: String(reviewNotes || '').slice(0, 2000), reviewed_by: reviewedBy || '', reviewed_at: closedAt,
      ai_verdict: p.ai_verdict || '', ai_notes: p.ai_notes || '',
      property_id_ref: propId, ...(communityId ? { community_id_ref: communityId } : {}),
      // Billing-split linkage: this child IS a billing line; the master is not.
      for_billing: 'true', master_service_id: masterId,
      per_property_rate: Number(p.per_property_rate) || vendorCost,
      enrollment_key: `split:${masterId}:${propId}`,
    };
    try {
      const cid = await createServiceWorkOrder(childProps);
      if (cid) childIds.push(cid);
    } catch (e: any) {
      console.warn(`[services/split] child create failed for ${propId}:`, e?.message || e);
    }
  }

  // Master leaves billing (its children now carry it) and records the split.
  await patchServiceWorkOrder(masterId, { for_billing: 'false', split_at: closedAt }).catch((e) =>
    console.warn('[services/split] master flag update failed:', e?.message || e));

  return { childIds, count: childIds.length };
}
