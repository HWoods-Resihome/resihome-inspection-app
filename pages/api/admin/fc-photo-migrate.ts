/**
 * POST /api/admin/fc-photo-migrate?apply=1&after=<cursor>
 *
 * Moves Final Checklist photos from HubSpot → Vercel Blob and reconnects the FC
 * records to the Blob copies. The FC photos must already be RESTORED from the
 * HubSpot trash (live) — any still-404 photo is counted as skippedDead and left
 * for a later pass. Dry-run unless ?apply=1. Budgeted; loop by passing back the
 * returned `after` until done:true. Does NOT delete HubSpot originals (the
 * FC-aware reclaim does that afterward). Admin-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { migrateFinalChecklistPhotosBatch } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) return res.status(403).json({ error: 'Admin only' });
  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const after = typeof req.query.after === 'string' ? req.query.after : undefined;
  try {
    const batch = await migrateFinalChecklistPhotosBatch({ apply, after });
    return res.status(200).json({
      ...batch,
      mode: apply ? 'apply' : 'dry-run',
      note: 'skippedDead = FC photo still 404 (not yet restored from the HubSpot trash) — restore first, then re-run. Loop with ?after=<returned after> until done:true. Re-delete of HubSpot originals is handled by the (FC-aware) reclaim afterward.',
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
