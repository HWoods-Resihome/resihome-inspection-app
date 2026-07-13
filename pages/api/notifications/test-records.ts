/**
 * GET /api/notifications/test-records?object=inspections|services → a compact,
 * searchable list of records (open + completed) for the admin test-send picker.
 * Admin-only. Returns { records: [{ id, label }] } capped for the dropdown.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspections, searchServicesForPicker } from '@/lib/hubspot';
import { templateLabel } from '@/lib/templateLabels';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) return res.status(403).json({ error: 'Admin only' });

  const object = req.query.object === 'services' ? 'services' : 'inspections';
  try {
    if (object === 'inspections') {
      const list = await fetchInspections({}).catch(() => []);
      const records = list.slice(0, 400).map((i) => ({
        id: i.recordId,
        label: `${templateLabel(i.templateType)} — ${i.propertyAddressSnapshot || i.inspectionName}`.slice(0, 120),
        status: i.status || '',
      }));
      return res.status(200).json({ records });
    }
    const list = await searchServicesForPicker(400).catch(() => []);
    const records = list.filter((s) => !s.masterServiceId).map((s) => ({
      id: s.id,
      label: `${worktypeLabel(s.worktype)} · ${subtypeLabel(s.worktype, s.subtype)} — ${s.address}`.slice(0, 120),
      status: s.status || '',
    }));
    return res.status(200).json({ records });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
