import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchRateCardCatalog } from '@/lib/hubspot';
import { kvGetJSON, kvSetJSON } from '@/lib/sharedCache';
import type { RateCardLineItem } from '@/lib/types';

// Shared-cache key (cross-instance L2 via Vercel KV; no-op when KV isn't set up).
const KV_CATALOG_KEY = 'ratecard:catalog:v1';

/**
 * GET /api/rate-card/catalog
 *
 * Returns the full catalog (~1,000+ active items, and growing) for the line-item
 * picker modal. Size is dynamic — the upstream fetch paginates with no cap.
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

/** Internal: load + cache, coalescing concurrent fetches. */
async function loadCatalog(forceRefresh: boolean): Promise<RateCardLineItem[]> {
  if (!INFLIGHT || forceRefresh) {
    INFLIGHT = (async () => {
      try {
        // L2 (cross-instance) before HubSpot: a cold instance reuses a sibling's
        // catalog instead of re-paginating ~10 calls. No-op when KV isn't configured.
        if (!forceRefresh) {
          const shared = await kvGetJSON<RateCardLineItem[]>(KV_CATALOG_KEY);
          if (Array.isArray(shared) && shared.length) {
            CACHE = { data: shared, fetchedAt: Date.now() };
            return shared;
          }
        }
        const items = await fetchRateCardCatalog();
        CACHE = { data: items, fetchedAt: Date.now() };
        void kvSetJSON(KV_CATALOG_KEY, items, Math.floor(TTL_MS / 1000)); // fire-and-forget
        return items;
      } finally {
        INFLIGHT = null;
      }
    })();
  }
  return INFLIGHT;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const refresh = String(req.query.refresh || '') === '1';
  const now = Date.now();
  const fresh = CACHE && (now - CACHE.fetchedAt) < TTL_MS && !refresh;

  // Let the browser reuse the (large) catalog response across quick form
  // re-mounts instead of re-downloading the full catalog each time. Private (it's
  // behind auth) and short, with stale-while-revalidate so an expiry never
  // blocks the picker. A catalog edit still propagates within ~2 min, and
  // ?refresh=1 bypasses it. Skipped on a forced refresh.
  if (!refresh) {
    res.setHeader('Cache-Control', 'private, max-age=120, stale-while-revalidate=600');
  }

  if (fresh) {
    return res.status(200).json({
      items: CACHE!.data,
      cached: true,
      ageSeconds: Math.round((now - CACHE!.fetchedAt) / 1000),
    });
  }

  try {
    const items = await loadCatalog(refresh);
    return res.status(200).json({
      items,
      cached: false,
      ageSeconds: 0,
    });
  } catch (e: any) {
    console.error('GET /api/rate-card/catalog failed:', e);
    // Serve-stale-on-error so a refresh blip doesn't break the picker.
    if (CACHE) {
      return res.status(200).json({
        items: CACHE.data,
        cached: true,
        stale: true,
        ageSeconds: Math.round((now - CACHE.fetchedAt) / 1000),
      });
    }
    return res.status(500).json({ error: 'Could not load the rate card catalog.' });
  }
}

/**
 * Helper exported for server-side use (finalize, qc-finalize, rate-card-lines)
 * so they reuse this 60-minute cache instead of re-paginating the full catalog
 * on every call. Mirrors getCachedRegions.
 */
export async function getCachedCatalog(forceRefresh = false): Promise<RateCardLineItem[]> {
  const now = Date.now();
  const fresh = CACHE && (now - CACHE.fetchedAt) < TTL_MS && !forceRefresh;
  if (fresh) return CACHE!.data;
  try {
    return await loadCatalog(forceRefresh);
  } catch (e) {
    if (CACHE) {
      console.warn('[getCachedCatalog] refresh failed, serving stale cache:', e);
      return CACHE.data;
    }
    throw e;
  }
}
