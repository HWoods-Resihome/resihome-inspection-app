import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import {
  searchInspectionsPage,
  countInspectionsByStatus,
  inspectionFacets,
} from '@/lib/hubspot';
import type {
  InspectionQuery,
  InspectionStatusKey,
  InspectionSortField,
  InspectionCounts,
} from '@/lib/hubspot';
import { isExternalEmail } from '@/lib/userAccess';
import type { InspectionSummary } from '@/lib/types';

/**
 * GET /api/inspections?search=&status=&inspector=&template=&sort=&dir=&page=&pageSize=
 *
 * The home screen's most-hit endpoint. To scale to 10,000+ inspections the
 * filter / sort / search / pagination / status-counts all run server-side in
 * HubSpot (see lib/hubspot.ts) rather than pulling a 500-record window and
 * working it client-side. We protect HubSpot with:
 *   - short-TTL in-memory caches keyed by the query (lists are global — the same
 *     query returns the same data for every user — so the cache is shared);
 *   - single-flight so a burst of identical loads awaits ONE fetch;
 *   - separate caches for the page, the status counts (independent of page/sort),
 *     and the filter facets (rarely change → longer TTL);
 *   - serve-stale-on-error so a transient HubSpot blip doesn't blank the list;
 *   - a ?refresh=1 bypass for manual pull-to-refresh.
 * Mutations (create / bulk-cancel) call bustInspectionsCache().
 */

// Lists + counts: cached long enough to spare HubSpot's search API under
// multi-user field load (each uncached query = 1 list search + 5 count
// searches). Mutations (create/cancel/line-save) bust this cache immediately
// via bustInspectionsCache(), so a longer TTL doesn't make a real change feel
// stale — it just stops repeated reads from re-searching and tripping 429s.
const TTL_MS = 45 * 1000;
const FACET_TTL_MS = 10 * 60 * 1000; // inspector/template options change rarely
const MAX_KEYS = 80;                 // bound memory across query variants

type ListResult = { items: InspectionSummary[]; total: number };
type Facets = { inspectors: string[]; templates: string[]; regions: string[] };
type CacheEntry<T> = { data: T; at: number };

function makeCache<T>() {
  return {
    cache: new Map<string, CacheEntry<T>>(),
    inflight: new Map<string, Promise<T>>(),
  };
}

const lists = makeCache<ListResult>();
const counts = makeCache<InspectionCounts>();
const facets = makeCache<Facets>();

/** Invalidate cached lists/counts after a create/cancel so the change shows at once. */
export function bustInspectionsCache(): void {
  lists.cache.clear();
  counts.cache.clear();
  // Facets (inspector/template options) don't change on create/cancel — leave them.
}

async function withCache<T>(
  store: { cache: Map<string, CacheEntry<T>>; inflight: Map<string, Promise<T>> },
  key: string,
  ttl: number,
  force: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!force) {
    const hit = store.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    const inflight = store.inflight.get(key);
    if (inflight) return inflight;
  }
  const p = (async () => {
    try {
      const data = await fn();
      if (store.cache.size >= MAX_KEYS) store.cache.clear();
      store.cache.set(key, { data, at: Date.now() });
      return data;
    } finally {
      store.inflight.delete(key);
    }
  })();
  store.inflight.set(key, p);
  return p;
}

const STATUS_KEYS: InspectionStatusKey[] = ['all', 'scheduled', 'in_progress', 'pending_approval', 'completed'];
const ZERO_COUNTS: InspectionCounts = { all: 0, scheduled: 0, in_progress: 0, pending_approval: 0, completed: 0 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Defense-in-depth: middleware already gates this, but verify the session here
  // too so the route is never reachable unauthenticated.
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  // Inspector/template can be repeated query params (multi-select) — collect all.
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean)
      : typeof v === 'string' && v.trim() ? [v.trim()] : [];
  const search = str(req.query.search).trim();
  const statusRaw = str(req.query.status);
  const status: InspectionStatusKey = (STATUS_KEYS as string[]).includes(statusRaw)
    ? (statusRaw as InspectionStatusKey) : 'all';
  const inspectors = arr(req.query.inspector);
  const templatesRaw = arr(req.query.template);
  const regions = arr(req.query.region);
  const SORT_FIELDS: InspectionSortField[] = ['updated', 'scheduled', 'address', 'inspector', 'price', 'property_status'];
  const sortRaw = str(req.query.sort);
  const sortField: InspectionSortField = (SORT_FIELDS as string[]).includes(sortRaw)
    ? (sortRaw as InspectionSortField) : 'updated';
  const sortDir: 'asc' | 'desc' = str(req.query.dir) === 'asc' ? 'asc' : 'desc';
  const pageSize = Math.min(100, Math.max(1, parseInt(str(req.query.pageSize), 10) || 20));
  const page = Math.max(1, parseInt(str(req.query.page), 10) || 1);
  const refresh = str(req.query.refresh) === '1';

  // External (1099) users get a restricted visibility rule applied SERVER-SIDE
  // (all their 1099s + COMPLETED Scope/Re-Inspect, view-only) so their
  // list/counts/facets can't be widened by crafting a query param. They may
  // still narrow within that allowed set via the template facet (intersected
  // server-side); a disallowed template selection is ignored.
  const external = isExternalEmail(session.email);
  const templates = templatesRaw;

  const baseQuery: InspectionQuery = { search, status, inspectors, templates, regions, external };
  // Stable key parts: sort the multi-value arrays so equivalent selections share
  // a cache entry regardless of click order.
  const insKey = [...inspectors].sort();
  const tmpKey = [...templates].sort();
  const regKey = [...regions].sort();
  // Counts ignore the selected status (each chip shows its own total) and the
  // page/sort, so cache them on just the constraining filters.
  const countKey = JSON.stringify({ search, inspectors: insKey, templates: tmpKey, regions: regKey, external });
  const listKey = JSON.stringify({ search, status, inspectors: insKey, templates: tmpKey, regions: regKey, external, sortField, sortDir, page, pageSize });
  // Facets are DEPENDENT: each dropdown is constrained by the other active
  // filters (status, search, and the other dimensions' selections), so the cache
  // key includes them all.
  const facetKey = JSON.stringify({ search, status, inspectors: insKey, templates: tmpKey, regions: regKey, external });

  // The filter dropdown options (facets) require a multi-page scan and are NOT
  // needed to render the inspection cards. On a slow connection that scan would
  // hold up the whole response, so the client fetches them separately:
  //   ?only=facets  → return just the facets (dropdown options)
  //   ?facets=0     → skip facets; return the list + counts as fast as possible
  const only = str(req.query.only);
  const wantFacets = str(req.query.facets) !== '0';

  try {
    if (only === 'facets') {
      const facetData = await withCache(facets, facetKey, FACET_TTL_MS, refresh, () => inspectionFacets(baseQuery));
      return res.status(200).json({ facets: facetData });
    }
    const [list, statusCounts, facetData] = await Promise.all([
      withCache(lists, listKey, TTL_MS, refresh, () =>
        searchInspectionsPage({ ...baseQuery, sortField, sortDir, page, pageSize })),
      withCache(counts, countKey, TTL_MS, refresh, () =>
        countInspectionsByStatus(baseQuery)),
      // Only compute facets inline when asked (back-compat for any caller that
      // doesn't split them out). The home screen passes facets=0.
      wantFacets
        ? withCache(facets, facetKey, FACET_TTL_MS, false, () => inspectionFacets(baseQuery))
        : Promise.resolve(undefined),
    ]);
    return res.status(200).json({
      inspections: list.items,
      total: list.total,
      counts: statusCounts,
      ...(facetData ? { facets: facetData } : {}),
      page,
      pageSize,
    });
  } catch (e: any) {
    console.error('GET /api/inspections failed:', e);
    // Serve-stale-on-error: a transient HubSpot failure shouldn't blank the list.
    const staleList = lists.cache.get(listKey)?.data;
    if (staleList) {
      return res.status(200).json({
        inspections: staleList.items,
        total: staleList.total,
        counts: counts.cache.get(countKey)?.data || ZERO_COUNTS,
        facets: facets.cache.get(facetKey)?.data || { inspectors: [], templates: [], regions: [] },
        page,
        pageSize,
        stale: true,
      });
    }
    return res.status(500).json({ error: 'Could not load inspections. Please try again.' });
  }
}
