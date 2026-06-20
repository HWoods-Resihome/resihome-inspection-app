/**
 * GET /api/admin/backfill-last-edited-date
 *
 * One-time (resumable, idempotent) backfill of `last_edited_at` for inspections
 * that don't have it — set from the scheduled date (falling back to created
 * date) so the combined "Date" sort orders scheduled-but-never-edited
 * inspections sensibly instead of dumping them at the end.
 *
 * Open the URL in the browser while signed in as @resihome.com staff. It
 * paginates internally until done (or a ~250s budget); if `nextAfter` is
 * non-null, re-open with `?after=<cursor>` to continue. Only fills empty values
 * — never overwrites a real edit timestamp.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { backfillLastEditedDate } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) {
    return res.status(403).json({ error: 'Admin only.' });
  }

  let after = typeof req.query.after === 'string' ? req.query.after : undefined;
  const deadline = Date.now() + 250_000;
  let processed = 0, updated = 0, skipped = 0, errors = 0;
  let nextAfter: string | null = after || null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await backfillLastEditedDate({ after, max: 150 });
      processed += r.processed; updated += r.updated; skipped += r.skipped; errors += r.errors;
      nextAfter = r.nextAfter;
      if (!r.nextAfter) break;
      after = r.nextAfter;
      if (Date.now() > deadline) break;
    }
    return res.status(200).json({
      ok: true,
      processed, updated, skipped, errors,
      done: nextAfter === null,
      nextAfter,
      resume: nextAfter ? `/api/admin/backfill-last-edited-date?after=${encodeURIComponent(nextAfter)}` : null,
    });
  } catch (e: any) {
    console.error('[backfill-last-edited-date] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), processed, updated, skipped, errors, nextAfter });
  }
}
