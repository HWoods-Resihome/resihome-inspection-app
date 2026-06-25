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

// ---- signed-in user caching ----
// The auth cookie stays valid offline, but /api/auth/me can't be reached to
// CONFIRM it, which made the app think the inspector was signed out (blocking
// "New Inspection"). Cache the last known authenticated user so offline we can
// keep treating them as signed in.
const ME_KEY = 'resiwalk_me_v1';

export function loadCachedMe<T = any>(): T | null {
  if (typeof window === 'undefined') return null;
  try { const raw = localStorage.getItem(ME_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function saveCachedMe(data: any): void {
  if (typeof window === 'undefined' || !data) return;
  try { localStorage.setItem(ME_KEY, JSON.stringify(data)); } catch { /* non-fatal */ }
}

export function clearCachedMe(): void {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(ME_KEY); } catch { /* non-fatal */ }
}

// ---- inspection detail caching (keyed by record id) ----
// The full GET /api/inspections/[id] payload (inspection + answers + property
// context), so an inspection that's been opened once with service — or warmed
// from the home list — opens and is fully editable in a dead zone. LRU-capped.
const INSP_PREFIX = 'insp_v1:';
const INSP_INDEX = 'insp_index_v1';
const INSP_MAX = 30;   // holds a pre-cached day of active inspections + a few opened manually

export function loadCachedInspection<T = any>(id: string): T | null {
  if (typeof window === 'undefined' || !id) return null;
  try {
    const raw = localStorage.getItem(INSP_PREFIX + id);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

export function saveCachedInspection(id: string, payload: any): void {
  if (typeof window === 'undefined' || !id || !payload) return;
  try {
    localStorage.setItem(INSP_PREFIX + id, JSON.stringify(payload));
    let index: string[] = [];
    try { index = JSON.parse(localStorage.getItem(INSP_INDEX) || '[]'); } catch { index = []; }
    index = [id, ...index.filter((k) => k !== id)];
    while (index.length > INSP_MAX) {
      const evict = index.pop();
      if (evict !== undefined) localStorage.removeItem(INSP_PREFIX + evict);
    }
    localStorage.setItem(INSP_INDEX, JSON.stringify(index));
  } catch {
    /* quota / disabled — non-fatal: online still works, offline just lacks this one */
  }
}

// ---- question template caching (keyed by template type) ----
// Question templates rarely change and are shared across inspections, so one
// cache per template lets a questionnaire inspection open fully offline.
const QTMPL_PREFIX = 'qtmpl_v1:';

export function loadCachedQuestions<T = any>(template: string): T[] | null {
  if (typeof window === 'undefined' || !template) return null;
  try {
    const raw = localStorage.getItem(QTMPL_PREFIX + template);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

export function saveCachedQuestions(template: string, questions: any[]): void {
  if (typeof window === 'undefined' || !template || !Array.isArray(questions)) return;
  try { localStorage.setItem(QTMPL_PREFIX + template, JSON.stringify(questions)); }
  catch { /* quota / disabled — non-fatal */ }
}

// Small LRU-by-id cache helper, shared by the keyed caches below.
function lruGet<T>(prefix: string, id: string): T | null {
  if (typeof window === 'undefined' || !id) return null;
  try { const raw = localStorage.getItem(prefix + id); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
}
function lruPut(prefix: string, indexKey: string, max: number, id: string, payload: any): void {
  if (typeof window === 'undefined' || !id || payload == null) return;
  try {
    localStorage.setItem(prefix + id, JSON.stringify(payload));
    let index: string[] = [];
    try { index = JSON.parse(localStorage.getItem(indexKey) || '[]'); } catch { index = []; }
    index = [id, ...index.filter((k) => k !== id)];
    while (index.length > max) { const e = index.pop(); if (e !== undefined) localStorage.removeItem(prefix + e); }
    localStorage.setItem(indexKey, JSON.stringify(index));
  } catch { /* quota / disabled — non-fatal */ }
}
function lruRemove(prefix: string, indexKey: string, id: string): void {
  if (typeof window === 'undefined' || !id) return;
  try {
    localStorage.removeItem(prefix + id);
    let index: string[] = [];
    try { index = JSON.parse(localStorage.getItem(indexKey) || '[]'); } catch { index = []; }
    localStorage.setItem(indexKey, JSON.stringify(index.filter((k) => k !== id)));
  } catch { /* non-fatal */ }
}

// ---- QC re-inspect data caching (keyed by record id) ----
// The /api/inspections/[id]/qc-data payload (copied lines + before/after photos)
// so a Turn Re-Inspect QC opens offline like the other templates.
const QC_PREFIX = 'qcdata_v1:';
const QC_INDEX = 'qcdata_index_v1';
export function loadCachedQcData<T = any>(id: string): T | null { return lruGet<T>(QC_PREFIX, id); }
export function saveCachedQcData(id: string, payload: any): void { lruPut(QC_PREFIX, QC_INDEX, 30, id, payload); }

// ---- questionnaire answer drafts (keyed by record id) ----
// A mirror of the form's answer map, so offline edits re-appear if the
// inspector closes and reopens the inspection in a dead zone (the durable
// outbox guarantees they SYNC; this restores their VISIBILITY). Cleared on
// submit.
const ANS_PREFIX = 'ansdraft_v1:';
const ANS_INDEX = 'ansdraft_index_v1';
export function loadCachedAnswers<T = any>(id: string): T | null { return lruGet<T>(ANS_PREFIX, id); }
export function saveCachedAnswers(id: string, answers: any): void { lruPut(ANS_PREFIX, ANS_INDEX, 15, id, answers); }
export function clearCachedAnswers(id: string): void { lruRemove(ANS_PREFIX, ANS_INDEX, id); }
