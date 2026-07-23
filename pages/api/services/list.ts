/**
 * GET /api/services/list — the services home list, fetched AFTER navigation.
 *
 * The /services page used to load the entire work-order list inside
 * getServerSideProps, so tapping "Services" in the hamburger stalled on
 * HubSpot pagination before the screen could even switch. The page now
 * renders instantly with a skeleton and pulls the list from here; the same
 * endpoint powers pull-to-refresh, focus revalidation, and post-bulk-action
 * refreshes. Scoping matches the old gSSP exactly: vendors are resolved
 * server-side and only ever receive their own orders.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { searchServiceWorkOrders } from '@/lib/hubspot';
import { scopeServices } from '@/lib/services/scope';
import { resolveServiceViewerAsync, servicesViewerAllowed } from '@/lib/services/scopeServer';

export const config = { maxDuration: 60 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const ok = await servicesViewerAllowed(session?.vendor ? session?.email : (session?.realEmail || session?.email)).catch(() => false);
  if (!ok) return res.status(403).json({ error: 'Not available' });
  try {
    const viewer = await resolveServiceViewerAsync(session, req);
    const real = await searchServiceWorkOrders(viewer.canSeeAll ? {} : { vendorEmail: viewer.vendorEmail, vendorName: viewer.vendorName }).catch(() => null);
    // Community billing children roll up into their master — hidden from the
    // operational list (mirrors the old gSSP; see RECURRING_SERVICES_PLAN.md).
    const operational = (real ?? []).filter((s) => !s.masterServiceId);
    const services = scopeServices(operational, viewer);
    return res.status(200).json({ services, live: !!real });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
