/**
 * GET /api/admin/backfill-inspector-from-owner
 *
 * One-time (resumable, idempotent) sync of inspector_name/inspector_email FROM
 * each inspection's HubSpot record Owner (hubspot_owner_id). Run after
 * reassigning owners in HubSpot so the app's inspector reflects the new owner
 * everywhere (the home list also re-syncs on its own as rows are loaded, and the
 * detail page syncs on open — this is the bulk sweep).
 *
 * Open the URL in the browser while signed in as @resihome.com staff. It
 * paginates internally until done (or a ~250s budget); if `nextAfter` is
 * non-null, re-open with `?after=<cursor>` to continue.
 *
 * Safe: only writes inspector_name/inspector_email; never changes status / sends.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { backfillInspectorFromOwner } from '@/lib/hubspot';

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
      const r = await backfillInspectorFromOwner({ after, max: 150 });
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
      resume: nextAfter ? `/api/admin/backfill-inspector-from-owner?after=${encodeURIComponent(nextAfter)}` : null,
    });
  } catch (e: any) {
    console.error('[backfill-inspector-from-owner] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), processed, updated, skipped, errors, nextAfter });
  }
}
