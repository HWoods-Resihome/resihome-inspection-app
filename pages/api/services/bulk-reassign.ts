/**
 * POST /api/services/bulk-reassign — internal-only: reassign the vendor on many
 * services at once. Body: { ids: string[], vendorName: string }. Only services
 * currently in ASSIGNED status are reassigned (others are skipped and reported);
 * each reassigned order gets its vendor email updated and a 'reassign' audit
 * event. Returns per-id results.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { fetchServiceWorkOrder, patchServiceWorkOrder } from '@/lib/hubspot';
import { SERVICE_VENDORS } from '@/lib/services/vendors';
import { recordServiceAudit } from '@/lib/services/serviceAudit';

export const config = { maxDuration: 120 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map((x: any) => String(x)).filter((x: string) => /^\d+$/.test(x)) : [];
  const vendorName = String(b.vendorName || '').trim();
  const vendor = SERVICE_VENDORS.find((v) => v.name === vendorName);
  if (!vendor) return res.status(400).json({ error: 'Unknown vendor.' });
  if (!ids.length) return res.status(400).json({ error: 'No services selected.' });

  let reassigned = 0, skipped = 0, failed = 0;
  const results: { id: string; outcome: string }[] = [];
  for (const id of ids) {
    try {
      const rec = await fetchServiceWorkOrder(id);
      if (!rec || String(rec.props.status || '') !== 'assigned') { skipped++; results.push({ id, outcome: 'skipped' }); continue; }
      const from = rec.props.vendor_name || 'Unassigned';
      if (from === vendor.name) { skipped++; results.push({ id, outcome: 'unchanged' }); continue; }
      await patchServiceWorkOrder(id, { vendor_name: vendor.name, vendor_email: vendor.email });
      void recordServiceAudit({ serviceId: id, action: 'reassign', actorEmail: email, actorName: session?.name, detail: `Vendor reassigned (bulk): ${from} → ${vendor.name}` });
      reassigned++; results.push({ id, outcome: 'reassigned' });
    } catch { failed++; results.push({ id, outcome: 'failed' }); }
  }
  return res.status(200).json({ ok: true, vendorName: vendor.name, reassigned, skipped, failed, results });
}
