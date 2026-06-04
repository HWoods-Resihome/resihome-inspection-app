/**
 * GET /api/admin/config-check
 *
 * Ongoing-health check for code↔catalog drift. Today it reports any Final
 * Checklist add-line codes (hardcoded in lib/finalChecklist.ts) that are no
 * longer present in the live catalog — i.e. a rename/removal in the catalog
 * silently broke an FC "add line" button. The rate-card-line SAVE path already
 * rejects unknown codes (rate-card-lines.ts), so this covers the one place a
 * bad code is referenced from code rather than user input.
 *
 * Gated to authenticated @resihome.com staff. Read-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import { fcReferencedLineCodes, fcMissingLineCodes } from '@/lib/finalChecklist';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const catalog = await getCachedCatalog();
    const codes = new Set(catalog.map((c) => c.lineItemCode));
    const referenced = fcReferencedLineCodes();
    const missing = fcMissingLineCodes(codes);
    return res.status(200).json({
      ok: missing.length === 0,
      catalogSize: catalog.length,
      finalChecklist: {
        referencedCodes: referenced,
        missingCodes: missing, // non-empty ⇒ these FC add-line buttons are broken
      },
    });
  } catch (e: any) {
    console.error('[config-check] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
