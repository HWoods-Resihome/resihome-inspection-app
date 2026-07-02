import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import {
  searchInspectionsPage,
  countInspectionsByStatus,
  inspectionFacets,
  externalUnlockedView,
} from '@/lib/hubspot';
import type {
  InspectionQuery,
  InspectionStatusKey,
  InspectionSortField,
  InspectionCounts,
} from '@/lib/hubspot';
import { isExternalEmail } from '@/lib/userAccess';
import { getSharedGen, sharedGet, sharedSet, bumpSharedGen } from '@/lib/sharedCache';
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
// Status-chip counts change less visibly than the list and are busted immediately
// on create/cancel via bustInspectionsCache(), so they can cache far longer than
// the list. This is the biggest lever on the HubSpot 429s: each cold counts miss
// costs FIVE searches, so caching them longer directly cuts the search rate.
const COUNTS_TTL_MS = 3 * 60 * 1000;
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

// Bumped on every bust. An in-flight GET that STARTED before a create/cancel
// would otherwise resolve AFTER the bust and repopulate the cache with
// pre-mutation data (stale-after-write for a full TTL). withCache captures this
// at fetch start and refuses to write a result whose generation is stale.
let bustGeneration = 0;

// Per-user manual-refresh throttle. ?refresh=1 (pull-to-refresh) fully BYPASSES
// the cache → ~6 fresh HubSpot searches (1 list + 5 counts). A user re-pulling
// rapidly — or a wave of near-simultaneous pulls during a busy period — stampedes
// HubSpot's per-second search limit (the 429 spike). Collapse a user's repeat
// refreshes within a short window back to a normal cached/single-flight read;
// mutations still bust the cache instantly, so freshness after a real change is
// unaffected. Per-instance like the caches — good enough (a user's repeat pulls
// tend to hit the same warm lambda).
const REFRESH_MIN_INTERVAL_MS = 10 * 1000;
const lastRefreshAt = new Map<string, number>();

/**
 * Invalidate cached lists/counts after a create/cancel so the change shows at
 * once. Returns a promise that resolves once the SHARED (cross-instance)
 * generation has been bumped — mutation handlers should `await` it so other
 * instances stop serving pre-mutation data. The local clear is synchronous; the
 * shared bump is best-effort and fail-open (no-op when no KV store is connected).
 */
export function bustInspectionsCache(): Promise<void> {
  lists.cache.clear();
  counts.cache.clear();
  bustGeneration++; // in-flight fetches started before now won't write their (stale) result
  // Facets (inspector/template options) don't change on create/cancel — leave them.
  return bumpSharedGen();
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
  const startedGen = bustGeneration;
  const p = (async () => {
    try {
      // Capture the shared generation up front so a mutation racing this fetch
      // won't let us write stale data back to the shared cache under a new gen.
      const sharedGen = await getSharedGen();
      // Cross-instance hit: a cold instance can serve another instance's recent
      // result instead of re-hitting HubSpot. Skipped on a forced refresh.
      if (!force) {
        const shared = await sharedGet<T>(key, sharedGen);
        if (shared != null) {
          if (bustGeneration === startedGen) {
            if (store.cache.size >= MAX_KEYS) store.cache.clear();
            store.cache.set(key, { data: shared, at: Date.now() });
          }
          return shared;
        }
      }
      const data = await fn();
      // If a create/cancel busted the cache while we were fetching, this result
      // predates the mutation — don't write it back (it would serve stale data
      // for a full TTL). Return it to THIS caller, just don't cache it.
      if (bustGeneration === startedGen) {
        if (store.cache.size >= MAX_KEYS) store.cache.clear();
        store.cache.set(key, { data, at: Date.now() });
        // Populate the shared cache too (fire-and-forget; sharedSet re-checks the
        // generation and no-ops when no KV store is connected).
        void sharedSet(key, sharedGen, data, Math.ceil(ttl / 1000));
      }
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
  const SORT_FIELDS: InspectionSortField[] = ['date', 'updated', 'scheduled', 'address', 'inspector', 'price', 'property_status'];
  const sortRaw = str(req.query.sort);
  const sortField: InspectionSortField = (SORT_FIELDS as string[]).includes(sortRaw)
    ? (sortRaw as InspectionSortField) : 'date';
  const sortDir: 'asc' | 'desc' = str(req.query.dir) === 'asc' ? 'asc' : 'desc';
  const pageSize = Math.min(100, Math.max(1, parseInt(str(req.query.pageSize), 10) || 20));
  const page = Math.max(1, parseInt(str(req.query.page), 10) || 1);
  const refresh = str(req.query.refresh) === '1';
  // Throttle manual refreshes per user so a rapid re-pull can't stampede HubSpot.
  let force = refresh;
  if (refresh) {
    const now = Date.now();
    const prev = lastRefreshAt.get(session.email) || 0;
    if (now - prev < REFRESH_MIN_INTERVAL_MS) {
      force = false; // too soon since this user's last refresh — serve cache/single-flight
    } else {
      if (lastRefreshAt.size > 500) lastRefreshAt.clear(); // bound memory across users
      lastRefreshAt.set(session.email, now);
    }
  }

  // External (1099) users get a restricted visibility rule applied SERVER-SIDE:
  // only the 1099 inspections assigned to THEM, plus COMPLETED Scope/Re-Inspect
  // from anyone (view-only). Passing their email scopes the 1099 set per-user
  // (so it MUST be part of the cache key — external lists are no longer global).
  // It can't be widened by crafting a query param; they may still narrow within
  // the allowed set via the template facet (a disallowed selection is ignored).
  const externalEmail = isExternalEmail(session.email) ? session.email : null;
  const templates = templatesRaw;

  // State gate (external only): the view-only completed Scope/QC set is limited
  // to the regions in states where this user has an inspection of their own.
  // Empty array = no states unlocked yet (they see only their own 1099s). The
  // value is folded into every cache key below since it's per-user.
  let externalViewRegions: string[] | undefined;
  if (externalEmail) {
    try { externalViewRegions = (await externalUnlockedView(externalEmail)).regions; }
    catch { externalViewRegions = []; }
  }

  const baseQuery: InspectionQuery = { search, status, inspectors, templates, regions, externalEmail, externalViewRegions };
  // Stable key parts: sort the multi-value arrays so equivalent selections share
  // a cache entry regardless of click order.
  const insKey = [...inspectors].sort();
  const tmpKey = [...templates].sort();
  const regKey = [...regions].sort();
  // Per-user view-region unlock — part of every key (external lists vary by it).
  const viewKey = externalViewRegions ? [...externalViewRegions].sort() : null;
  // Counts ignore the selected status (each chip shows its own total) and the
  // page/sort, so cache them on just the constraining filters.
  const countKey = JSON.stringify({ search, inspectors: insKey, templates: tmpKey, regions: regKey, externalEmail, viewKey });
  const listKey = JSON.stringify({ search, status, inspectors: insKey, templates: tmpKey, regions: regKey, externalEmail, viewKey, sortField, sortDir, page, pageSize });
  // Facets are DEPENDENT: each dropdown is constrained by the other active
  // filters (status, search, and the other dimensions' selections), so the cache
  // key includes them all.
  const facetKey = JSON.stringify({ search, status, inspectors: insKey, templates: tmpKey, regions: regKey, externalEmail, viewKey });

  // The filter dropdown options (facets) require a multi-page scan and are NOT
  // needed to render the inspection cards. On a slow connection that scan would
  // hold up the whole response, so the client fetches them separately:
  //   ?only=facets  → return just the facets (dropdown options)
  //   ?facets=0     → skip facets; return the list + counts as fast as possible
  const only = str(req.query.only);
  const wantFacets = str(req.query.facets) !== '0';

  try {
    if (only === 'facets') {
      const facetData = await withCache(facets, facetKey, FACET_TTL_MS, force, () => inspectionFacets(baseQuery));
      return res.status(200).json({ facets: facetData });
    }
    const [list, statusCounts, facetData] = await Promise.all([
      withCache(lists, listKey, TTL_MS, force, () =>
        searchInspectionsPage({ ...baseQuery, sortField, sortDir, page, pageSize })),
      withCache(counts, countKey, COUNTS_TTL_MS, force, () =>
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
