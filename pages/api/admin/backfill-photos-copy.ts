/**
 * GET /api/admin/backfill-photos-copy?inspection=<id>&apply=1 — copy ONE
 * inspection's HubSpot-hosted answer photos to Vercel Blob and rewrite the
 * answer references to the new public Blob URLs. Verified per photo (re-download
 * + byte match). Does NOT delete anything from HubSpot (reclaim stays separate).
 *
 * Admin-only. Requires &apply=1 to write (a guard against accidental hits);
 * without it, returns instructions. Idempotent + resumable — already-migrated
 * (Blob) URLs are skipped, so a re-run after a timeout continues cleanly.
 *
 *   Copy one inspection:  /api/admin/backfill-photos-copy?inspection=<id>&apply=1
 *   Preview first:        /api/admin/backfill-photos-dryrun?inspection=<id>
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillPhotosCopyForInspection } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const inspection = typeof req.query.inspection === 'string' ? req.query.inspection.trim() : '';
  if (!inspection) return res.status(400).json({ error: 'inspection=<recordId> is required (this endpoint copies one inspection at a time).' });
  const apply = req.query.apply === '1' || req.query.apply === 'true';
  if (!apply) return res.status(200).json({ ok: true, note: 'Add &apply=1 to actually copy. For a read-only count use /api/admin/backfill-photos-dryrun?inspection=' + inspection });
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  try {
    const report = await backfillPhotosCopyForInspection({ inspectionId: inspection, apply: true, limit });
    return res.status(200).json({
      ...report,
      note: report.errors
        ? 'Completed with errors — see errorSamples. Re-run the same URL to retry only what did not migrate (already-copied photos are skipped).'
        : 'Copied + verified + references rewritten. HubSpot originals were NOT deleted. Re-run backfill-photos-dryrun to confirm hubspotPhotos is now 0.',
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
