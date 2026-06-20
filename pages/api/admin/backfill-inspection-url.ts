/**
 * GET /api/admin/backfill-inspection-url
 *
 * One-time (resumable, idempotent) backfill that stamps `resiwalk_inspection_url`
 * = `<origin>/inspection/<recordId>` on every existing inspection. New
 * inspections get it automatically at creation; this fills in the back catalog.
 *
 * Just open the URL in the browser while signed in as @resihome.com staff. It
 * paginates internally until done (or a ~250s time budget) and returns JSON. If
 * `nextAfter` comes back non-null (very large catalog), re-open with
 * `?after=<cursor>`. Origin: PUBLIC_APP_ORIGIN env → this request's origin →
 * https://resiwalk.com; override with `?origin=https://resiwalk.com`.
 *
 * Safe: only writes the URL property; never changes status / sends anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillInspectionUrls } from '@/lib/hubspot';
import { appOrigin, reqOriginOf } from '@/lib/appUrl';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) {
    return res.status(403).json({ error: 'Admin only.' });
  }

  const originOverride = typeof req.query.origin === 'string' ? req.query.origin : '';
  const origin = (originOverride || appOrigin(reqOriginOf(req))).replace(/\/+$/, '');
  let after = typeof req.query.after === 'string' ? req.query.after : undefined;

  const deadline = Date.now() + 250_000; // stay under maxDuration
  let processed = 0, updated = 0, skipped = 0, errors = 0;
  let nextAfter: string | null = after || null;

  try {
    // Loop pages internally so the operator only has to open one URL.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const r = await backfillInspectionUrls({ after, max: 200, origin });
      processed += r.processed; updated += r.updated; skipped += r.skipped; errors += r.errors;
      nextAfter = r.nextAfter;
      if (!r.nextAfter) break;
      after = r.nextAfter;
      if (Date.now() > deadline) break; // hand back a cursor to resume
    }
    return res.status(200).json({
      ok: true,
      origin,
      processed, updated, skipped, errors,
      done: nextAfter === null,
      nextAfter,
      resume: nextAfter ? `/api/admin/backfill-inspection-url?after=${encodeURIComponent(nextAfter)}` : null,
    });
  } catch (e: any) {
    console.error('[backfill-inspection-url] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), processed, updated, skipped, errors, nextAfter });
  }
}
