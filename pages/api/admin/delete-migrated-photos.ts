/**
 * POST /api/admin/delete-migrated-photos?apply=1[&after=<cursor>]  (app-admin only)
 *
 * Reclaim HubSpot storage after the Files → Vercel Blob migration by deleting the
 * now-orphaned HubSpot photo originals. SAFE-BY-DESIGN: only files in the app's
 * /inspection_photos folder whose exact URL is NOT in the COMPLETE set of
 * still-referenced record URLs are removed — an un-migrated photo is never
 * touched. Dry-run unless &apply=1 (preview returns the orphaned/kept counts).
 * The client loops with the returned `after` until `done`.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { deleteMigratedHubspotPhotosBatch } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const after = typeof req.query.after === 'string' && req.query.after ? req.query.after : undefined;
  try {
    const rep = await deleteMigratedHubspotPhotosBatch({ apply, after });
    return res.status(200).json(rep);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
