import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchInspections } from '@/lib/hubspot';
import { isExternalEmail, EXTERNAL_TEMPLATE } from '@/lib/userAccess';
import type { InspectionSummary } from '@/lib/types';

/**
 * GET /api/inspections?search=...
 *
 * The home screen's most-hit endpoint. fetchInspections paginates the HubSpot
 * search API (up to ~5 calls for the default list), so with many concurrent
 * users this is the top source of rate-limit pressure. We protect it with:
 *   - a short-TTL in-memory cache keyed by the search term (the list is global
 *     — filtered client-side — so the cache is safely shared across users);
 *   - single-flight so a burst of concurrent identical loads awaits ONE fetch
 *     instead of each firing its own paginated sweep (the "100 users open the
 *     app at once" case);
 *   - serve-stale-on-error so a transient HubSpot blip doesn't blank the list;
 *   - a ?refresh=1 bypass for manual pull-to-refresh.
 * Mutations (create / bulk-cancel) call bustInspectionsCache() so the same
 * instance reflects them immediately; other instances self-heal within the TTL.
 */

type Entry = { data: InspectionSummary[]; fetchedAt: number };
const CACHE = new Map<string, Entry>();
const INFLIGHT = new Map<string, Promise<InspectionSummary[]>>();
const TTL_MS = 15 * 1000; // short — the list must stay near-live for the field
const MAX_KEYS = 50;      // bound memory (varied search terms)

/** Invalidate cached lists after a create/cancel so the change shows at once. */
export function bustInspectionsCache(): void {
  CACHE.clear();
  // In-flight fetches are allowed to finish; they just won't be cached-as-fresh
  // for long since the next request past their resolution re-checks the TTL.
}

async function load(search: string, forceRefresh: boolean): Promise<InspectionSummary[]> {
  const key = search;
  if (!forceRefresh) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.data;
    const inflight = INFLIGHT.get(key);
    if (inflight) return inflight;
  }
  const p = (async () => {
    try {
      const data = await fetchInspections({ search });
      if (CACHE.size >= MAX_KEYS) CACHE.clear();
      CACHE.set(key, { data, fetchedAt: Date.now() });
      return data;
    } finally {
      INFLIGHT.delete(key);
    }
  })();
  INFLIGHT.set(key, p);
  return p;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Defense-in-depth: middleware already gates this, but verify the
  // session here too so the route is never reachable unauthenticated
  // even if the middleware matcher changes.
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const refresh = String(req.query.refresh || '') === '1';
  try {
    let inspections = await load(search, refresh);
    // External (1099) users only see 1099-type inspections.
    if (isExternalEmail(session.email)) {
      inspections = inspections.filter((i) => String(i.templateType || '') === EXTERNAL_TEMPLATE);
    }
    return res.status(200).json({ inspections });
  } catch (e: any) {
    console.error('GET /api/inspections failed:', e);
    // Serve-stale-on-error: a transient HubSpot failure shouldn't blank the list.
    const stale = CACHE.get(search);
    if (stale) return res.status(200).json({ inspections: stale.data, stale: true });
    return res.status(500).json({ error: 'Could not load inspections. Please try again.' });
  }
}
