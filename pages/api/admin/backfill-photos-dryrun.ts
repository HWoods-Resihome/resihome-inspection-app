/**
 * GET /api/admin/backfill-photos-dryrun — read-only inventory for the HubSpot
 * Files → Vercel Blob photo backfill. Counts how many inspection_answer photos
 * still live in HubSpot Files (would migrate), how many are already on Blob, and
 * other/external. Writes nothing, downloads nothing — safe to run anytime.
 *
 * Admin-only. Scope to one inspection with &inspection=<recordId> (fast), else it
 * scans all answers with photos. The actual copy/delete passes stay in the
 * standalone script (scripts/migratePhotosToBlob.mjs) — resumable + gated.
 *
 *   One inspection:  /api/admin/backfill-photos-dryrun?inspection=<id>
 *   Everything:      /api/admin/backfill-photos-dryrun
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { backfillPhotosDryRun } from '@/lib/hubspot';

export const config = { maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const inspection = typeof req.query.inspection === 'string' ? req.query.inspection.trim() : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  try {
    const report = await backfillPhotosDryRun({ inspectionId: inspection || undefined, limit });
    return res.status(200).json({
      ...report,
      note: 'DRY RUN — read-only. `hubspotPhotos` is how many photos would move to Blob. Run the copy/delete passes from scripts/migratePhotosToBlob.mjs (see MIGRATE_PHOTOS_RUNBOOK.md).',
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
