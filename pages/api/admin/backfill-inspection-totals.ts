/**
 * GET /api/admin/backfill-inspection-totals
 *
 * One-time (resumable, idempotent) backfill that recomputes and stamps
 * `total_vendor_cost` / `total_client_cost` / `total_tenant_cost` on existing
 * inspections from their rate-card lines. New + edited inspections keep these in
 * sync automatically (rate-card-lines save + finalize); this fills the back
 * catalog. Inspections with no rate-card lines are skipped.
 *
 * Open the URL in the browser while signed in as @resihome.com staff. It
 * paginates internally until done (or a ~250s budget) and returns JSON; if
 * `nextAfter` is non-null (very large catalog), re-open with `?after=<cursor>`.
 *
 * Safe: only writes the three total properties; never changes status / sends
 * anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { backfillInspectionTotals } from '@/lib/hubspot';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { getCachedRegions } from '@/pages/api/rate-card/regions';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) {
    return res.status(403).json({ error: 'Admin only.' });
  }

  let after = typeof req.query.after === 'string' ? req.query.after : undefined;
  const deadline = Date.now() + 250_000; // stay under maxDuration
  let processed = 0, updated = 0, skipped = 0, errors = 0;
  let nextAfter: string | null = after || null;

  try {
    // Load the catalog + region matrix once so every inspection is RE-PRICED
    // live (matching the form), correcting rollups built from stale snapshots.
    const [catalog, regions] = await Promise.all([getCachedCatalog(), getCachedRegions()]);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await backfillInspectionTotals({ after, max: 150, catalog, regions });
      processed += r.processed; updated += r.updated; skipped += r.skipped; errors += r.errors;
      nextAfter = r.nextAfter;
      if (!r.nextAfter) break;
      after = r.nextAfter;
      if (Date.now() > deadline) break; // hand back a cursor to resume
    }
    return res.status(200).json({
      ok: true,
      processed, updated, skipped, errors,
      done: nextAfter === null,
      nextAfter,
      resume: nextAfter ? `/api/admin/backfill-inspection-totals?after=${encodeURIComponent(nextAfter)}` : null,
    });
  } catch (e: any) {
    console.error('[backfill-inspection-totals] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), processed, updated, skipped, errors, nextAfter });
  }
}
