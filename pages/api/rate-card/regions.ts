import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchRegionRates } from '@/lib/hubspot';
import { kvGetJSON, kvSetJSON } from '@/lib/sharedCache';
import type { RegionRate } from '@/lib/types';

// Shared-cache key (cross-instance L2 via Vercel KV; no-op when KV isn't set up).
const KV_REGIONS_KEY = 'ratecard:regions:v1';

/**
 * GET /api/rate-card/regions
 *
 * Returns the 18 region_rate records used by the math.
 *
 * Caching: same 60-minute in-memory TTL as /catalog, with ?refresh=1 escape hatch.
 *
 * Note: in normal operation the client doesn't need this endpoint — the server
 * does the math at line-save time. But it's exposed so we can:
 *   - Diagnose pricing issues from the client side
 *   - Build a future admin UI for editing rates
 *   - Show the inspector "rates as of <date>" if useful
 */

type CachedRegions = {
  data: RegionRate[];
  fetchedAt: number;
};

let CACHE: CachedRegions | null = null;
let INFLIGHT: Promise<RegionRate[]> | null = null;
const TTL_MS = 60 * 60 * 1000;

/** Internal: load + cache, coalescing concurrent fetches. */
async function loadRegions(forceRefresh: boolean): Promise<RegionRate[]> {
  if (!INFLIGHT || forceRefresh) {
    INFLIGHT = (async () => {
      try {
        // L2 (cross-instance) before HubSpot. No-op when KV isn't configured.
        if (!forceRefresh) {
          const shared = await kvGetJSON<RegionRate[]>(KV_REGIONS_KEY);
          if (Array.isArray(shared) && shared.length) {
            CACHE = { data: shared, fetchedAt: Date.now() };
            return shared;
          }
        }
        const regions = await fetchRegionRates();
        CACHE = { data: regions, fetchedAt: Date.now() };
        void kvSetJSON(KV_REGIONS_KEY, regions, Math.floor(TTL_MS / 1000)); // fire-and-forget
        return regions;
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

  if (fresh) {
    return res.status(200).json({
      regions: CACHE!.data,
      cached: true,
      ageSeconds: Math.round((now - CACHE!.fetchedAt) / 1000),
    });
  }

  try {
    const regions = await loadRegions(refresh);
    return res.status(200).json({
      regions,
      cached: false,
      ageSeconds: 0,
    });
  } catch (e: any) {
    console.error('GET /api/rate-card/regions failed:', e);
    // Serve-stale-on-error: a refresh failure shouldn't take pricing down if we
    // still have a last-good copy in memory.
    if (CACHE) {
      return res.status(200).json({
        regions: CACHE.data,
        cached: true,
        stale: true,
        ageSeconds: Math.round((now - CACHE.fetchedAt) / 1000),
      });
    }
    return res.status(500).json({ error: 'Could not load region rates.' });
  }
}

/**
 * Helper exported for server-side use elsewhere. Reuses the same cache and
 * in-flight coalescing as the HTTP handler.
 */
export async function getCachedRegions(forceRefresh = false): Promise<RegionRate[]> {
  const now = Date.now();
  const fresh = CACHE && (now - CACHE.fetchedAt) < TTL_MS && !forceRefresh;
  if (fresh) return CACHE!.data;
  try {
    return await loadRegions(forceRefresh);
  } catch (e) {
    // Serve-stale rather than fail a save/finalize when a refresh blips.
    if (CACHE) {
      console.warn('[getCachedRegions] refresh failed, serving stale cache:', e);
      return CACHE.data;
    }
    throw e;
  }
}
