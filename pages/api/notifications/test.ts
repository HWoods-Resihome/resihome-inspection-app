/**
 * POST /api/notifications/test { key, recordId } → send that notification email
 * to the ADMIN's own logged-in address, built from the chosen sample record.
 * Admin-only. Forces past the recipient's toggle (it's a test). Returns { sent }.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { fetchInspectionById, fetchServiceWorkOrder } from '@/lib/hubspot';
import { templateLabel } from '@/lib/templateLabels';
import { worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { appBaseUrl } from '@/lib/notifications/send';
import { notifyInspectionCompleted, notifyServiceAssigned, notifyServiceCompleted, notifyServicePastDue } from '@/lib/notifications/triggers';
import type { NotificationKey } from '@/lib/notifications/catalog';

export const config = { maxDuration: 60 };   // service-completed test renders a PDF

const normDate = (v: any): string => { const t = String(v ?? '').trim(); if (!t) return ''; if (/^\d{10,}$/.test(t)) return new Date(Number(t)).toISOString().slice(0, 10); return t.slice(0, 10); };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  if (!email || !(await isAppAdmin(email).catch(() => false))) return res.status(403).json({ error: 'Admin only' });

  const key = String((req.body || {}).key || '') as NotificationKey;
  const recordId = String((req.body || {}).recordId || '').trim();
  if (!recordId) return res.status(400).json({ error: 'Pick a record to base the test on.' });
  const baseUrl = appBaseUrl(req);

  try {
    if (key === 'inspection_completed') {
      const insp = await fetchInspectionById(recordId).catch(() => null);
      if (!insp) return res.status(404).json({ error: 'Inspection not found.' });
      await notifyInspectionCompleted({
        inspectionId: recordId, inspectorEmail: email, force: true,
        templateLabel: templateLabel(insp.templateType),
        address: insp.propertyAddressSnapshot || insp.inspectionName || 'the property',
        pdfUrl: insp.pdfMasterUrl || insp.pdfUrl, baseUrl,
      });
      return res.status(200).json({ ok: true, sentTo: email });
    }

    // Service-based tests.
    const rec = await fetchServiceWorkOrder(recordId).catch(() => null);
    if (!rec) return res.status(404).json({ error: 'Service not found.' });
    const p = rec.props;
    const common = {
      serviceId: recordId, vendorEmail: email, vendorName: p.vendor_name || '', force: true,
      address: p.address_snapshot || p.service_name || 'a property',
      worktypeLabel: worktypeLabel(String(p.worktype || '')), subtypeLabel: subtypeLabel(String(p.worktype || ''), String(p.subtype || '')),
      dueDate: normDate(p.due_date), baseUrl,
    };
    if (key === 'service_assigned') await notifyServiceAssigned(common);
    else if (key === 'service_completed') await notifyServiceCompleted(common);
    else if (key === 'service_past_due') await notifyServicePastDue(common);
    else return res.status(400).json({ error: 'Unknown notification.' });
    return res.status(200).json({ ok: true, sentTo: email });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 200) });
  }
}
