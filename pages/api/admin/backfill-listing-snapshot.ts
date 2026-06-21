/**
 * GET /api/admin/backfill-listing-snapshot
 *
 * Freezes the listing snapshot (listing status / price / listed date / Move-in
 * Ready date / lease-start move-in) onto COMPLETED inspections that don't have
 * one yet — so going forward the header + report PDFs show the listing as it was
 * captured, instead of the live (drifting) listing. Mirrors
 * backfill-property-status.
 *
 * Scope: Scope, 1099, Vacancy, and Turn Re-Inspect QC (the types that show the
 * listing line). Community is skipped (its header never shows listing info).
 *
 * CAVEAT: for already-completed inspections the value at the ORIGINAL time of
 * inspection may be gone, so this captures the CURRENT live listing as the
 * best-available snapshot and freezes it from now on (same as the property-status
 * backfill). New inspections snapshot at completion automatically.
 *
 * SAFE: dry-run by default — open signed in as an app admin to see how many WOULD
 * be stamped. Add ?apply=1 to write. Idempotent: skips inspections that already
 * have a snapshot. Paginates with a resumable cursor under a ~250s budget; if
 * `nextAfter` is non-null, re-open with `?after=<cursor>` (and the same ?apply).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, readInspectionProps, stampListingSnapshotAtCompletion } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

const TEMPLATES = new Set([
  'pm_scope_rate_card',
  'leasing_agent_1099_property_inspection',
  'pm_vacancy_occupancy_check',
  'pm_turn_reinspect_qc',
]);

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
    const targets = all.filter((i) =>
      TEMPLATES.has(i.templateType) && (i.status || '').toLowerCase() === 'completed');

    let processed = 0, stamped = 0, skippedExisting = 0, errors = 0;
    const errorSamples: string[] = [];
    let i = startIdx;
    for (; i < targets.length && i < startIdx + limit; i++) {
      const insp = targets[i];
      processed++;
      try {
        const props = await readInspectionProps(insp.recordId, ['listing_snapshot_json']);
        if ((props?.listing_snapshot_json || '').toString().trim()) { skippedExisting++; continue; }
        if (apply) {
          await stampListingSnapshotAtCompletion(insp.recordId);
          stamped++;
        } else {
          stamped++; // would-stamp count in dry-run
        }
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
      totalTargets: targets.length,
      processed,
      [apply ? 'stamped' : 'wouldStamp']: stamped,
      skippedExisting,
      errors,
      done,
      nextAfter,
      resume: nextAfter != null
        ? `/api/admin/backfill-listing-snapshot?after=${nextAfter}&limit=${limit}${apply ? '&apply=1' : ''}`
        : null,
      errorSamples,
    });
  } catch (e: any) {
    console.error('[backfill-listing-snapshot] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
