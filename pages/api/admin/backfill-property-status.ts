/**
 * GET /api/admin/backfill-property-status
 *
 * One-time (resumable, idempotent) backfill that stamps
 * `property_status_at_completion` (+ the sortable snapshot) onto COMPLETED
 * inspections that are missing it — e.g. ones completed before the freeze logic
 * shipped. Uses each property's CURRENT status as the value.
 *
 * Open the URL in the browser while signed in as @resihome.com staff. It
 * paginates internally until done (or a ~250s budget) and returns JSON; if
 * `nextAfter` is non-null, re-open with `?after=<cursor>` to continue.
 *
 * Safe: only writes the two status fields; never changes status / sends anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillPropertyStatusAtCompletion } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) {
    return res.status(403).json({ error: 'Admin only.' });
  }

  let after = typeof req.query.after === 'string' ? req.query.after : undefined;
  const deadline = Date.now() + 250_000; // stay under maxDuration
  let processed = 0, updated = 0, skipped = 0, errors = 0;
  let nextAfter: string | null = after || null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await backfillPropertyStatusAtCompletion({ after, max: 150 });
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
      resume: nextAfter ? `/api/admin/backfill-property-status?after=${encodeURIComponent(nextAfter)}` : null,
    });
  } catch (e: any) {
    console.error('[backfill-property-status] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), processed, updated, skipped, errors, nextAfter });
  }
}
