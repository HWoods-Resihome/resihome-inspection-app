/**
 * GET /api/admin/backfill-inspector-names
 *
 * One-time (resumable, idempotent) backfill that refreshes `inspector_name` on
 * existing inspections from the LATEST HubSpot user data, matched by
 * `inspector_email`. Use after filling in / correcting user names so older
 * inspections (which snapshotted a blank or stale name) reflect the current
 * value. Only writes when the resolved name differs — a no-op once in sync.
 *
 * Open the URL in the browser while signed in as @resihome.com staff. It
 * paginates internally until done (or a ~250s budget) and returns JSON; if
 * `nextAfter` is non-null (very large catalog), re-open with `?after=<cursor>`.
 *
 * Safe: only writes inspector_name; never changes status / sends anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillInspectorNames } from '@/lib/hubspot';

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
      const r = await backfillInspectorNames({ after, max: 200 });
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
      resume: nextAfter ? `/api/admin/backfill-inspector-names?after=${encodeURIComponent(nextAfter)}` : null,
    });
  } catch (e: any) {
    console.error('[backfill-inspector-names] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), processed, updated, skipped, errors, nextAfter });
  }
}
