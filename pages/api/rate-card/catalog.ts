import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchRateCardCatalog } from '@/lib/hubspot';
import type { RateCardLineItem } from '@/lib/types';

/**
 * GET /api/rate-card/catalog
 *
 * Returns the full catalog (~853 items) for the line item picker modal.
 *
 * Caching:
 *   - In-memory per server instance, 60-minute TTL.
 *   - Pass ?refresh=1 to force a fresh fetch (after editing the catalog in HubSpot
 *     and not wanting to wait for the TTL).
 *
 * Auth: any authenticated user. Catalog data isn't sensitive but isn't public either.
 *
 * Decisions locked: full payload (no filter params); server is authoritative on data.
 */

type CachedCatalog = {
  data: RateCardLineItem[];
  fetchedAt: number;        // ms epoch when populated
};

let CACHE: CachedCatalog | null = null;
// Tracks an in-flight catalog fetch so concurrent requests await the same
// promise rather than firing parallel paginated fetches. Cleared on success
// or failure.
let INFLIGHT: Promise<RateCardLineItem[]> | null = null;
const TTL_MS = 60 * 60 * 1000;   // 60 minutes

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const refresh = String(req.query.refresh || '') === '1';
  const now = Date.now();
  const fresh = CACHE && (now - CACHE.fetchedAt) < TTL_MS && !refresh;

  if (fresh) {
    return res.status(200).json({
      items: CACHE!.data,
      cached: true,
      ageSeconds: Math.round((now - CACHE!.fetchedAt) / 1000),
    });
  }

  try {
    // Coalesce concurrent loads: if another request is already fetching the
    // catalog, await its promise instead of starting a parallel paginated fetch.
    // Without this, two browser tabs hitting /api/rate-card/catalog at the same
    // time both trigger 9-page paginations that can blow HubSpot's secondly limit.
    if (!INFLIGHT || refresh) {
      INFLIGHT = (async () => {
        try {
          const items = await fetchRateCardCatalog();
          CACHE = { data: items, fetchedAt: Date.now() };
          return items;
        } finally {
          INFLIGHT = null;
        }
      })();
    }
    const items = await INFLIGHT;
    return res.status(200).json({
      items,
      cached: false,
      ageSeconds: 0,
    });
  } catch (e: any) {
    console.error('GET /api/rate-card/catalog failed:', e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
