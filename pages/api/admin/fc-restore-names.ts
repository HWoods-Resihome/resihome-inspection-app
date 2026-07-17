/**
 * GET /api/admin/fc-restore-names  (admin only)
 *
 * Returns the exact set of Final Checklist photo file BASENAMES (no extension)
 * that are HubSpot-hosted — i.e. the files the reclaim deleted that we need to
 * restore. Downloaded as fc-names.json and fed to the surgical bulk-restore
 * console script (which searches the HubSpot trash for just these and restores
 * only them, instead of the whole 76k-file folder).
 *
 * Basename (no extension) because HubSpot's file `name` field has no extension,
 * and the trash search matches on `name`.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { scanFinalChecklistPhotos } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) return res.status(403).json({ error: 'Admin only' });
  try {
    const scan = await scanFinalChecklistPhotos({ dumpUrls: true });
    const names = Array.from(new Set(
      (scan.hubspotUrls || []).map((u) => {
        const base = decodeURIComponent(u.split('#')[0].split('?')[0].split('/').pop() || '');
        return base.replace(/\.[a-z0-9]+$/i, '');   // strip extension → matches HubSpot `name`
      }).filter(Boolean),
    ));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="fc-names.json"');
    return res.status(200).json({ count: names.length, names });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
