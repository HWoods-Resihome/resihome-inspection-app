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
import { vendorEmail } from '@/lib/services/vendors';
import { resolveCoords } from '@/lib/geocodeResolve';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && isInternalEmail(email);
  if (!ok) return res.status(403).json({ error: 'Internal users only' });

  const b = req.body || {};
  const scope = b.scope === 'community' ? 'community' : 'property';
  // Snapshot fields are resolved client-side from the LIVE Property / Community
  // pickers (address/locality/region + record ids); we just persist them.
  const communityName = scope === 'community' ? String(b.communityName || b.target || '') : '';
  const address = scope === 'community' ? (communityName || 'New Service') : (b.address || b.target || 'New Service');
  const locality = String(b.locality || '');

  const props: Record<string, any> = {
    service_name: address,
    worktype: b.worktype || '', subtype: b.subtype || '', status: 'assigned', is_bid_item: 'false', scope,
    service_description: b.description || '',
    due_date: b.dueDate || '',
    region_snapshot: String(b.region || ''),
    address_snapshot: address, locality_snapshot: locality,
    community_name: communityName,
    vendor_name: b.vendor || '', vendor_email: vendorEmail(b.vendor) || '',
    ...(scope === 'property' && b.propertyId ? { property_id_ref: String(b.propertyId) } : {}),
    ...(b.vendorCost !== '' && b.vendorCost != null ? { vendor_cost: Number(b.vendorCost) } : {}),
    ...(b.markupPct !== '' && b.markupPct != null ? { markup_pct: Number(b.markupPct) } : {}),
    ...(b.clientCost !== '' && b.clientCost != null ? { client_cost: Number(b.clientCost) } : {}),
  };

  // Stamp reference coordinates (best-effort) so the map plots it without a live
  // geocode. Property scope resolves via the property; community via its name/loc.
  try {
    const c = await resolveCoords({
      address: [address, locality].filter(Boolean).join(', '),
      propertyId: scope === 'property' ? String(b.propertyId || '') : String(b.communityId || ''),
    });
    if (c) { props.latitude = c.lat; props.longitude = c.lng; }
  } catch { /* non-fatal — map falls back to live geocoding */ }

  try {
    const id = await createServiceWorkOrder(props);
    return res.status(200).json({ ok: true, id, preview: !id });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
