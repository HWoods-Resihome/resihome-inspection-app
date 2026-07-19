/**
 * POST /api/webhooks/hubspot — HubSpot change notifications → cache invalidation.
 *
 * When a record changes in HubSpot — from our app OR out-of-band (a direct edit
 * in HubSpot, a workflow, another integration) — this hook drops the matching
 * in-memory caches and bumps the shared cross-instance generation, so the app
 * reflects the change on the next read instead of waiting out a TTL.
 *
 * WHAT to bust is selected by `?object=` (or an `object` field in the JSON
 * body); omit it for the original inspections-only behavior:
 *   ?object=inspections — inspection lists/counts (shared gen bump + re-warm)
 *   ?object=companies   — vendor roster/auth/flag caches (Vendor Management,
 *                         vendor logins, assignment pickers)
 *   ?object=services    — the service work-order list window
 *   ?object=all         — everything above
 *
 * Portal setup: a HubSpot workflow "Send a webhook" action per object type
 * (Inspection / Company / Service Work Order) POSTing here on create/update/
 * delete with the secret + the matching ?object= value.
 *
 * Auth: a shared secret you control (HUBSPOT_WEBHOOK_SECRET), sent as
 * `Authorization: Bearer <secret>` or `?key=<secret>`. FAILS CLOSED when the
 * secret isn't configured, so nobody can spam cache busts (which would just
 * force cache misses → extra HubSpot load, a mild DoS). Responds 200 fast and
 * never throws — HubSpot retries on non-2xx, so transient errors self-heal.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { bumpSharedGen } from '@/lib/sharedCache';
import { bustVendorCompaniesCache, bustServiceListCache } from '@/lib/hubspot';
import { warmInspectionsCache } from '@/pages/api/inspections';

export const config = { maxDuration: 15 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const secret = process.env.HUBSPOT_WEBHOOK_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'Webhook not configured.' });
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (typeof req.query.key === 'string' ? req.query.key : '');
  if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const objectRaw = (typeof req.query.object === 'string' ? req.query.object : String((req.body as any)?.object || '')).trim().toLowerCase();
  const object = ['inspections', 'companies', 'services', 'all'].includes(objectRaw) ? objectRaw : 'inspections';

  try {
    if (object === 'companies' || object === 'all') bustVendorCompaniesCache();
    if (object === 'services' || object === 'all') bustServiceListCache();
    if (object === 'inspections' || object === 'all') {
      // Invalidate the cross-instance cache first (bounded ≤500ms, never throws),
      // so a read immediately after this returns fresh data. Then re-warm the
      // default view in the background so cold reads are fresh too — fire-and-forget
      // so the webhook's 200 isn't held on HubSpot searches (HubSpot wants a fast
      // ack and will retry a slow/failed delivery).
      await bumpSharedGen();
      // Fire-and-forget, but attach a catch: warmInspectionsCache() can reject when
      // KV is connected AND HubSpot is failing (exactly a 429 storm), and it settles
      // AFTER this handler's try block returns the 200 — an un-caught rejection would
      // escape to Node's unhandledRejection. Mirrors the SWR background-refresh guard.
      void warmInspectionsCache().catch(() => {});
    }
  } catch {
    /* never fail a webhook loudly */
  }
  return res.status(200).json({ ok: true, object });
}
