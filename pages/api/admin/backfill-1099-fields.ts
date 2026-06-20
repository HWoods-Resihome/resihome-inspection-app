/**
 * GET /api/admin/backfill-1099-fields
 *
 * One-time (resumable, idempotent) backfill that populates the standardized
 * 1099 Leasing Agent report fields (listing-price response/recommendation/
 * feedback + landscaping response/feedback) on existing inspections from their
 * saved answers. Run after provisioning the fields via /admin/setup.
 *
 * Open the URL in the browser while signed in as @resihome.com staff. It
 * paginates internally until done (or a ~250s budget) and returns JSON; if
 * `nextAfter` is non-null, re-open with `?after=<cursor>` to continue.
 *
 * Safe: only writes the five 1099 fields; never changes status / sends anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillLeasingAgent1099Fields } from '@/lib/hubspot';

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
      const r = await backfillLeasingAgent1099Fields({ after, max: 100 });
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
      resume: nextAfter ? `/api/admin/backfill-1099-fields?after=${encodeURIComponent(nextAfter)}` : null,
    });
  } catch (e: any) {
    console.error('[backfill-1099-fields] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), processed, updated, skipped, errors, nextAfter });
  }
}
