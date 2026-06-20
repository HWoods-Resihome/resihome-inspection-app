/**
 * GET /api/admin/regenerate-list   (app-admin only)
 *
 * One list of every inspection whose PDF can be regenerated, tagged with the
 * route that regenerates it, so the combined /admin/regenerate-pdfs page can let
 * the admin pick which inspection TYPES to regenerate and dispatch each id to
 * the right endpoint:
 *   route 'scope' → POST /api/inspections/<id>/finalize { regenerateOnly:true }
 *   route 'qa'    → GET  /api/admin/regenerate-inspection-pdfs?id=<id>
 *   route 'qc'    → GET  /api/admin/regenerate-qc-pdfs?id=<id>
 *
 * Scope is regeneratable while submitted / pending-approval / completed; the
 * other types only once completed.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections } from '@/lib/hubspot';
import { templateLabel as templateLabelFor } from '@/lib/templateLabels';

const SCOPE = 'pm_scope_rate_card';
const QA = new Set(['leasing_agent_1099_property_inspection', 'pm_vacancy_occupancy_check', 'pm_community_inspection']);
const QC = 'pm_turn_reinspect_qc';
const norm = (s: string) => (s || '').trim().toLowerCase().replace(/[ -]/g, '_');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }

  try {
    const all = await fetchInspections();
    const items: Array<{ id: string; templateType: string; label: string; address: string; status: string; route: 'scope' | 'qa' | 'qc' }> = [];
    for (const i of all) {
      const t = i.templateType;
      const st = norm(i.status);
      const completed = st === 'completed' || st === 'complete';
      let route: 'scope' | 'qa' | 'qc' | '' = '';
      if (t === SCOPE && (st === 'submitted' || st === 'pending_approval' || completed)) route = 'scope';
      else if (QA.has(t) && completed) route = 'qa';
      else if (t === QC && completed) route = 'qc';
      else continue;
      items.push({
        id: i.recordId,
        templateType: t,
        label: templateLabelFor(t) || t,
        address: i.propertyAddressSnapshot || '',
        status: i.status || '',
        route,
      });
    }
    return res.status(200).json({ ok: true, items, count: items.length });
  } catch (e: any) {
    console.error('[regenerate-list] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
