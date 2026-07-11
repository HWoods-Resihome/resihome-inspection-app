/**
 * POST /api/services/create — Phase 2: create a real Service Work Order from the
 * New Service form. Internal-gated. Returns { id } when the object is configured,
 * else { preview: true } so the form still shows a success state pre-go-live.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { createServiceWorkOrder } from '@/lib/hubspot';
import { SAMPLE_PROPERTIES, SAMPLE_COMMUNITIES } from '@/lib/services/sampleData';
import { vendorEmail } from '@/lib/services/vendors';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const b = req.body || {};
  const scope = b.scope === 'community' ? 'community' : 'property';
  const prop = scope === 'property' ? SAMPLE_PROPERTIES.find((p) => p.id === b.target) : null;
  const comm = scope === 'community' ? SAMPLE_COMMUNITIES.find((c) => c.name === b.target) : null;
  const address = prop?.address || b.target || 'New Service';
  const locality = prop?.locality || comm?.locality || '';

  const props: Record<string, any> = {
    service_name: address,
    worktype: b.worktype || '', subtype: b.subtype || '', status: 'assigned', is_bid_item: 'false', scope,
    service_description: b.description || '',
    due_date: b.dueDate || '',
    region_snapshot: prop?.region || '',
    address_snapshot: address, locality_snapshot: locality,
    community_name: scope === 'community' ? (comm?.name || b.target || '') : '',
    vendor_name: b.vendor || '', vendor_email: vendorEmail(b.vendor) || '',
    ...(b.vendorCost !== '' && b.vendorCost != null ? { vendor_cost: Number(b.vendorCost) } : {}),
    ...(b.markupPct !== '' && b.markupPct != null ? { markup_pct: Number(b.markupPct) } : {}),
    ...(b.clientCost !== '' && b.clientCost != null ? { client_cost: Number(b.clientCost) } : {}),
  };

  try {
    const id = await createServiceWorkOrder(props);
    return res.status(200).json({ ok: true, id, preview: !id });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
