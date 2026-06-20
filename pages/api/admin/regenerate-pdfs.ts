/**
 * GET /api/admin/regenerate-pdfs
 *
 * Returns the HubSpot record ids (+ status) of every SUBMITTED, PENDING-APPROVAL,
 * and COMPLETED scope inspection, so the /admin/regenerate-pdfs page can
 * regenerate each one's PDFs IN PLACE (regenerate-only mode — no status change,
 * no email/ticket) to retrofit fixes like the photo-gallery links and the
 * downscaled thumbnails into existing PDFs.
 *
 * Gated to authenticated @resihome.com staff. Read-only (the actual regenerate
 * happens by the page calling the finalize endpoint per id with regenerateOnly).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { listRegenerableScopeInspectionIds } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const items = await listRegenerableScopeInspectionIds();
    return res.status(200).json({ ok: true, items, ids: items.map((i) => i.id), count: items.length });
  } catch (e: any) {
    console.error('[regenerate-pdfs] list failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
