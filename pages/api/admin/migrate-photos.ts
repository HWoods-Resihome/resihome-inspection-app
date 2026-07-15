/**
 * POST /api/admin/migrate-photos?object=answer|service&apply=1[&after=<cursor>]
 * One time-budgeted batch of the HubSpot Files → Vercel Blob photo migration,
 * driven by the admin "Migrate Photos" button (loops answer → service, showing
 * progress). Copies + verifies + rewrites references; does NOT delete from
 * HubSpot. Admin-only. Requires &apply=1 to write.
 *
 * Response: { object, after, done, scanned, hubspotSeen, copied, verified,
 *             recordsUpdated, errors, errorSamples, configured }. The client
 * keeps calling with the returned `after` until `done`, then switches object.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { migratePhotosBatch, type MigratePhotoObject } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only' });
  }
  const object: MigratePhotoObject = req.query.object === 'service' ? 'service' : 'answer';
  const apply = req.query.apply === '1' || req.query.apply === 'true';
  const after = typeof req.query.after === 'string' && req.query.after ? req.query.after : undefined;
  try {
    // ~45s work budget keeps each batch safely under the 60s function ceiling.
    const rep = await migratePhotosBatch({ object, after, apply, budgetMs: 45000, photoCap: 60 });
    return res.status(200).json(rep);
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
