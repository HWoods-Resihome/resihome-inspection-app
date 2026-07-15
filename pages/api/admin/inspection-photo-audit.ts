/**
 * GET /api/admin/inspection-photo-audit?inspection=<id> | ?q=<address>
 * Read-only triage for "report saved but photos missing": lists what photos each
 * answer record on an inspection actually holds — HubSpot / Blob / offline draft
 * / other — so you can tell whether photos are truly absent (never left the
 * device) or stuck as drafts (recoverable). Admin-only.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { auditInspectionPhotos } from '@/lib/hubspot';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) return res.status(403).json({ error: 'Admin only' });
  const inspection = typeof req.query.inspection === 'string' ? req.query.inspection.trim() : '';
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!inspection && !query) return res.status(400).json({ error: 'Pass ?inspection=<recordId> or ?q=<address>.' });
  try {
    const report = await auditInspectionPhotos({ inspectionId: inspection || undefined, query: query || undefined });
    return res.status(200).json({
      ...report,
      note: report.found
        ? 'draft>0 = stuck/unsynced (recoverable if the device still has the queue). A section with total:0 that should have photos = they never uploaded (lost).'
        : 'No inspection matched. Try the record id via ?inspection=.',
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
