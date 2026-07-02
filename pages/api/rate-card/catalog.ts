import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchRateCardCatalog } from '@/lib/hubspot';
import { sharedGetRaw, sharedSetRaw } from '@/lib/sharedCache';
import type { RateCardLineItem } from '@/lib/types';

// Cross-instance cache key + TTL. The catalog rarely changes; a 10-minute KV TTL
// keeps cold instances (and post-deploy scale-ups) from re-paginating ~1,000 rows
// while still self-healing well within the 60-minute local window.
const CATALOG_SHARED_KEY = 'rc:catalog:v1';
const CATALOG_SHARED_TTL_S = 600;

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
let INFLIGHT_GEN = 0;
const TTL_MS = 60 * 60 * 1000;   // 60 minutes

/** Internal: load + cache, coalescing concurrent fetches. */
async function loadCatalog(forceRefresh: boolean): Promise<RateCardLineItem[]> {
  if (!INFLIGHT || forceRefresh) {
    // Tag each fetch with a generation. A ?refresh=1 that starts while an earlier
    // fetch is still running bumps the generation and replaces INFLIGHT; the
    // earlier fetch's finally then sees a newer generation and must NOT null the
    // pointer out from under the live refresh (that would let the next request
    // fire a redundant paginated fetch). Only the latest fetch clears INFLIGHT.
    const gen = ++INFLIGHT_GEN;
    INFLIGHT = (async () => {
      try {
        // Cross-instance: a cold instance (or a fresh deploy's fleet) serves
        // another instance's catalog from KV instead of re-paginating ~1,000 rows
        // — avoids a HubSpot pagination storm on scale-up. Skipped on ?refresh=1.
        if (!forceRefresh) {
          const shared = await sharedGetRaw<RateCardLineItem[]>(CATALOG_SHARED_KEY);
          if (Array.isArray(shared) && shared.length > 0) {
            CACHE = { data: shared, fetchedAt: Date.now() };
            return shared;
          }
        }
        const items = await fetchRateCardCatalog();
        // NEVER cache an empty catalog (mirrors offlineCache's guard): a HTTP-200
        // {results:[]} from a transiently-empty/eventually-consistent HubSpot
        // search "succeeds" and would otherwise poison the cache for the full TTL
        // — the line-item picker shows nothing and finalize/QC pricing loses live
        // catalog lookups. Return it to this caller but don't cache it.
        if (items.length > 0) {
          CACHE = { data: items, fetchedAt: Date.now() };
          void sharedSetRaw(CATALOG_SHARED_KEY, items, CATALOG_SHARED_TTL_S);
        }
        return items;
      } finally {
        if (gen === INFLIGHT_GEN) INFLIGHT = null;
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
