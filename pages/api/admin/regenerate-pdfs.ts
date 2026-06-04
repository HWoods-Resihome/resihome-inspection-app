/**
 * GET /api/admin/regenerate-pdfs
 *
 * Returns the HubSpot record ids of every completed scope inspection, so the
 * /admin/regenerate-pdfs page can re-finalize each one (PDFs only) to retrofit
 * the photo-gallery links into existing PDFs.
 *
 * Gated to authenticated @resihome.com staff. Read-only (the actual regenerate
 * happens by the page calling the normal finalize endpoint per id).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { listCompletedScopeInspectionIds } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const ids = await listCompletedScopeInspectionIds();
    return res.status(200).json({ ok: true, ids, count: ids.length });
  } catch (e: any) {
    console.error('[regenerate-pdfs] list failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
