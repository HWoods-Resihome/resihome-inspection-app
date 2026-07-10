/**
 * GET /api/admin/backfill-community-inspections
 *
 * Backfills the NEW Community / Visit inspection format onto existing
 * pm_community_inspection records:
 *   - property_address_snapshot → "<Community Name>, City, St, Zip"
 *   - region_snapshot           → the Community object's region, or (if blank)
 *                                 the region of the FIRST property associated to
 *                                 that community.
 *
 * SCOPE: only records whose property_id_ref resolves to a real COMMUNITY object
 * are touched (the new model). Community inspections still tied to a PROPERTY
 * (the old model — completed/started before this change) do NOT resolve as a
 * community and are skipped, per "ones already tied to a property we don't need
 * to touch." Cancelled records ARE included so the new format can be verified.
 *
 * SAFE: dry-run by default — open the URL signed in as an app admin to see what
 * it WOULD write. Add ?apply=1 to actually write. Idempotent: re-running just
 * recomputes and rewrites the same values. Paginates internally within a ~250s
 * budget; if `nextAfter` is non-null, re-open with `?after=<n>` (same ?apply /
 * ?limit) to continue.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import {
  fetchInspections, updateInspection, readInspectionProps,
  resolveCommunityDisplay, formatCommunityLocation,
} from '@/lib/hubspot';

export const config = { maxDuration: 300 };

const COMMUNITY_TEMPLATE = 'pm_community_inspection';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const apply = String(req.query.apply || '') === '1';
  const startIdx = Math.max(0, Number(req.query.after) || 0);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const deadline = Date.now() + 250_000;

  try {
    const all = await fetchInspections();
    const targets = all.filter((i) => i.templateType === COMMUNITY_TEMPLATE);

    let processed = 0, wrote = 0, skippedNoCommunityRef = 0, skippedNotCommunity = 0,
      skippedNoChange = 0, errors = 0;
    const changes: Array<{
      id: string; status: string;
      addressBefore: string; addressAfter: string;
      fullAddressBefore: string; fullAddressAfter: string;
      regionBefore: string; regionAfter: string;
    }> = [];
    const errorSamples: string[] = [];

    let i = startIdx;
    for (; i < targets.length && i < startIdx + limit; i++) {
      const insp = targets[i];
      processed++;
      try {
        const communityId = (insp.propertyRecordId || '').trim();
        if (!communityId) { skippedNoCommunityRef++; continue; }

        // Only NEW-model records: property_id_ref must resolve to a real Community
        // object. Old-model records (tied to a property) return null here → skip.
        const cd = await resolveCommunityDisplay(communityId);
        if (!cd || !cd.name) { skippedNotCommunity++; continue; }

        const loc = formatCommunityLocation(cd);
        const addressAfter = loc ? `${cd.name}, ${loc}` : cd.name;
        const regionAfter = (cd.region || '').trim();

        const addressBefore = insp.propertyAddressSnapshot || '';
        const regionBefore = insp.regionSnapshot || '';
        // full_address is a SEPARATE inspection field (normally copied from the
        // property during billing sync); community inspections have none, so it's
        // set to the same "<Community>, City, St, Zip" string.
        const fullBefore = ((await readInspectionProps(insp.recordId, ['full_address']))?.full_address || '').toString();

        const props: Record<string, any> = {};
        if (addressAfter && addressAfter !== addressBefore) props.property_address_snapshot = addressAfter;
        if (addressAfter && addressAfter !== fullBefore) props.full_address = addressAfter;
        if (regionAfter && regionAfter !== regionBefore) props.region_snapshot = regionAfter;

        if (Object.keys(props).length === 0) { skippedNoChange++; continue; }

        changes.push({
          id: insp.recordId, status: insp.status,
          addressBefore, addressAfter: props.property_address_snapshot ?? addressBefore,
          fullAddressBefore: fullBefore, fullAddressAfter: props.full_address ?? fullBefore,
          regionBefore, regionAfter: props.region_snapshot ?? regionBefore,
        });

        if (apply) {
          await updateInspection(insp.recordId, props);
          wrote++;
        } else {
          wrote++; // would-write count in dry-run
        }
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 8) errorSamples.push(`${insp.recordId}: ${String(e?.message || e).slice(0, 160)}`);
        console.error(`[backfill-community] ${insp.recordId} failed:`, String(e?.message || e).slice(0, 200));
      }
      if (Date.now() > deadline) { i++; break; }
    }

    const done = i >= targets.length;
    const nextAfter = done ? null : i;
    return res.status(200).json({
      ok: true,
      mode: apply ? 'apply' : 'dry-run (add ?apply=1 to write)',
      totalCommunityInspections: targets.length,
      processed,
      [apply ? 'wrote' : 'wouldWrite']: wrote,
      skippedNotCommunity,   // tied to a property (old model) — left untouched
      skippedNoCommunityRef, // no property_id_ref at all
      skippedNoChange,       // already in the correct format
      errors,
      done,
      nextAfter,
      resume: nextAfter != null
        ? `/api/admin/backfill-community-inspections?after=${nextAfter}&limit=${limit}${apply ? '&apply=1' : ''}`
        : null,
      sample: changes.slice(0, 50),
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-community] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
