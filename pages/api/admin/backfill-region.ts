/**
 * GET /api/admin/backfill-region — stamp `region_snapshot` from the property on
 * inspections that are missing it (e.g. existing 1099 / Vacancy / Community
 * inspections, which historically only got a region on Rate Card / QC). Without
 * it they're invisible under the region filter.
 *
 * SAFE: dry-run by default — open signed in as an app admin to see how many WOULD
 * be stamped. Add ?apply=1 to write. Idempotent: skips inspections that already
 * have a region. Paginates with a resumable cursor under a ~250s budget; if
 * `nextAfter` is non-null, re-open with `?after=<cursor>` (and the same ?apply).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, readInspectionProps, fetchPropertyRegion, updateInspection } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email))) return res.status(403).json({ error: 'Admin only.' });

  const apply = String(req.query.apply || '') === '1';
  const startIdx = Math.max(0, Number(req.query.after) || 0);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));
  const deadline = Date.now() + 250_000;

  try {
    const all = await fetchInspections();
    const targets = all.filter((i) => !((i.regionSnapshot || '').trim()));

    let processed = 0, stamped = 0, skippedNoProperty = 0, skippedNoRegion = 0, errors = 0;
    const errorSamples: string[] = [];
    let i = startIdx;
    for (; i < targets.length && i < startIdx + limit; i++) {
      const insp = targets[i];
      processed++;
      try {
        const props = await readInspectionProps(insp.recordId, ['property_id_ref']);
        const propertyId = (props?.property_id_ref || '').toString().trim();
        if (!propertyId) { skippedNoProperty++; continue; }
        const region = await fetchPropertyRegion(propertyId);
        if (!region) { skippedNoRegion++; continue; }
        if (apply) await updateInspection(insp.recordId, { region_snapshot: region });
        stamped++;
      } catch (e: any) {
        errors++;
        if (errorSamples.length < 8) errorSamples.push(`${insp.recordId}: ${String(e?.message || e).slice(0, 160)}`);
      }
      if (Date.now() > deadline) { i++; break; }
    }

    const done = i >= targets.length;
    const nextAfter = done ? null : i;
    return res.status(200).json({
      ok: true,
      mode: apply ? 'apply' : 'dry-run (add ?apply=1 to write)',
      missingRegion: targets.length,
      processed,
      [apply ? 'stamped' : 'wouldStamp']: stamped,
      skippedNoProperty, skippedNoRegion, errors,
      done,
      nextAfter,
      resume: nextAfter != null
        ? `/api/admin/backfill-region?after=${nextAfter}&limit=${limit}${apply ? '&apply=1' : ''}`
        : null,
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-region] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
