/**
 * offlineCache — tiny localStorage cache so the field app keeps working on weak
 * or no service.
 *
 * Two datasets the inspector hits constantly:
 *   • the Rate Card CATALOG + region rates — needed for the manual "add line
 *     item" search. It's the SAME for every inspection, so once it's been
 *     fetched on any decent connection we keep it locally and the search works
 *     instantly and fully offline thereafter.
 *   • recent PROPERTY search result pages — so re-opening a search the inspector
 *     already ran (or the default recent page) shows immediately instead of
 *     spinning on a stalled request.
 *
 * Everything is best-effort: a quota error, private-mode, or disabled storage is
 * swallowed — the app still works online, it just doesn't get the offline boost.
 */
import type { RateCardLineItem, RegionRate } from '@/lib/types';

// Bump the version suffix if the cached shape ever changes.
const RC_KEY = 'rc_data_v1';
const PROP_PREFIX = 'prop_q_v1:';
const PROP_INDEX = 'prop_q_index_v1';
const PROP_MAX_QUERIES = 40; // cap how many query pages we retain

export interface CachedRateCard {
  catalog: RateCardLineItem[];
  regions: RegionRate[];
  cachedAt: number;
}

export function loadCachedRateCard(): CachedRateCard | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(RC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.catalog) || parsed.catalog.length === 0) return null;
    return {
      catalog: parsed.catalog,
      regions: Array.isArray(parsed.regions) ? parsed.regions : [],
      cachedAt: typeof parsed.cachedAt === 'number' ? parsed.cachedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveCachedRateCard(catalog: RateCardLineItem[], regions: RegionRate[]): void {
  if (typeof window === 'undefined') return;
  if (!Array.isArray(catalog) || catalog.length === 0) return; // never cache an empty catalog
  try {
    localStorage.setItem(RC_KEY, JSON.stringify({ catalog, regions: regions || [], cachedAt: Date.now() }));
  } catch {
    /* quota / disabled — non-fatal */
  }
}

// ---- property search result caching (keyed by normalized query) ----

function normQuery(q: string): string {
  return (q || '').trim().toLowerCase();
}

export function loadCachedProperties<T = any>(query: string): T[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PROP_PREFIX + normQuery(query));
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

export function saveCachedProperties(query: string, results: any[]): void {
  if (typeof window === 'undefined' || !Array.isArray(results)) return;
  const key = normQuery(query);
  try {
    localStorage.setItem(PROP_PREFIX + key, JSON.stringify(results));
    // Maintain a small LRU index so we don't grow localStorage unbounded.
    let index: string[] = [];
    try { index = JSON.parse(localStorage.getItem(PROP_INDEX) || '[]'); } catch { index = []; }
    index = [key, ...index.filter((k) => k !== key)];
    while (index.length > PROP_MAX_QUERIES) {
      const evict = index.pop();
      if (evict !== undefined) localStorage.removeItem(PROP_PREFIX + evict);
    }
    localStorage.setItem(PROP_INDEX, JSON.stringify(index));
  } catch {
    /* quota / disabled — non-fatal */
  }
}
