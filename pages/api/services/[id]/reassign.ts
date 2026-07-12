/**
 * POST /api/services/[id]/reassign — internal-only: reassign the vendor on a
 * service. Body: { vendorName: string } (must be a known Services vendor). The
 * vendor email snapshot is updated to match. Terminal orders (completed/canceled)
 * are refused. Records a 'reassign' audit event.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';
import { SERVICE_VENDORS } from '@/lib/services/vendors';
import { recordServiceAudit } from '@/lib/services/serviceAudit';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Missing service id' });

  const vendorName = String((req.body || {}).vendorName || '').trim();
  const vendor = SERVICE_VENDORS.find((v) => v.name === vendorName);
  if (!vendor) return res.status(400).json({ error: 'Unknown vendor.' });

  try {
    const rec = await fetchServiceWorkOrder(id);
    if (!rec) return res.status(200).json({ ok: true, preview: true });
    const status = String(rec.props.status || '');
    if (['completed', 'canceled'].includes(status)) return res.status(409).json({ error: `This service is ${status} and can’t be reassigned.` });
    const from = rec.props.vendor_name || 'Unassigned';
    if (from === vendor.name) return res.status(200).json({ ok: true, id, vendorName: vendor.name, unchanged: true });

    await patchServiceWorkOrder(id, { vendor_name: vendor.name, vendor_email: vendor.email });
    void recordServiceAudit({ serviceId: id, action: 'reassign', actorEmail: email, actorName: session?.name, detail: `Vendor reassigned: ${from} → ${vendor.name}` });
    return res.status(200).json({ ok: true, id, vendorName: vendor.name });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
