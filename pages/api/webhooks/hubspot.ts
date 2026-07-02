/**
 * POST /api/webhooks/hubspot — HubSpot change notifications → cache invalidation.
 *
 * When an Inspection record changes in HubSpot — from our app OR out-of-band (a
 * direct edit in HubSpot, a workflow, another integration) — this hook bumps the
 * shared cache generation so every instance's cross-instance cache refreshes on
 * its next read, then re-warms the default home view. This keeps the list/counts
 * fresh without relying solely on TTL, and specifically catches changes our own
 * mutation paths (which already bust the cache) never see.
 *
 * Auth: a shared secret you control (HUBSPOT_WEBHOOK_SECRET), sent as
 * `Authorization: Bearer <secret>` or `?key=<secret>`. Configure a HubSpot
 * workflow "Send a webhook" action (or any automation) to POST here on inspection
 * create / update / delete, with that secret. FAILS CLOSED when the secret isn't
 * configured, so nobody can spam generation bumps (which would just force cache
 * misses → extra HubSpot load, a mild DoS). Responds 200 fast and never throws —
 * HubSpot retries on non-2xx, so a transient error self-heals on the next event.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { bumpSharedGen } from '@/lib/sharedCache';
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

  try {
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
  } catch {
    /* never fail a webhook loudly */
  }
  return res.status(200).json({ ok: true });
}
