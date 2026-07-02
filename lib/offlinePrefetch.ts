/**
 * Proactive OFFLINE prefetch of the inspections a field user is likely to open.
 *
 * Today an inspection only becomes openable offline AFTER it's been opened once
 * with service ("open it once on a good connection, then it'll work offline").
 * A user who drives straight to a dead-zone property and taps a walk they've
 * never opened hits the "hasn't been downloaded for offline use" wall. This warms
 * the offline cache (the full GET payload + questions) for the top of their list
 * so those walks open even with no signal.
 *
 * Gentle by design so it never re-triggers the HubSpot rate-limiting we just
 * fixed: online + good-connection only, deduped per session, skips anything
 * already cached, tightly bounded, and SPACED OUT (one at a time with a gap) so
 * it can never burst the API. Best-effort throughout — any failure is silent.
 */
import {
  loadCachedInspection, saveCachedInspection,
  loadCachedQuestions, saveCachedQuestions,
  loadCachedRateCard, saveCachedRateCard,
  loadCachedQcData, saveCachedQcData,
} from '@/lib/offlineCache';

const attempted = new Set<string>(); // ids tried this page session (dedupe)
const MAX_PREFETCH = 8;              // well under the 30-entry inspection cache cap
const GAP_MS = 900;                  // space requests so we never burst HubSpot
const FETCH_TIMEOUT_MS = 12000;

/** Only prefetch when online and NOT on a metered/slow link (respect Save-Data). */
function connectionOk(): boolean {
  if (typeof navigator === 'undefined' || navigator.onLine === false) return false;
  const c: any = (navigator as any).connection;
  if (c) {
    if (c.saveData) return false;
    if (typeof c.effectiveType === 'string' && /2g/.test(c.effectiveType)) return false;
  }
  return true;
}

async function fetchJson(url: string): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Warm the offline cache for the given inspection ids (in priority order — pass
 * the visible list top-first). No-ops off-line / on a slow link / for ids already
 * cached or already attempted this session. Runs on idle, one at a time.
 */
export function prefetchInspectionsForOffline(ids: string[]): void {
  if (typeof window === 'undefined' || !connectionOk()) return;
  const todo = ids
    .filter((id) => id && !id.startsWith('local_') && !attempted.has(id) && !loadCachedInspection(id))
    .slice(0, MAX_PREFETCH);
  if (!todo.length) return;
  todo.forEach((id) => attempted.add(id));

  const run = async () => {
    const cachedTemplates = new Set<string>();
    // The rate-card catalog + region matrix are global and large; fetch them at
    // most once per run, and only if we actually hit a scope/QC walk that needs
    // them for offline pricing.
    let rateCardEnsured = false;
    const ensureRateCardCached = async () => {
      if (rateCardEnsured) return;
      rateCardEnsured = true;
      if (loadCachedRateCard()) return; // already have catalog + regions
      const [cat, reg] = await Promise.all([
        fetchJson('/api/rate-card/catalog'),
        fetchJson('/api/rate-card/regions'),
      ]);
      const items = cat && Array.isArray(cat.items) ? cat.items : null;
      const regions = reg && Array.isArray(reg.regions) ? reg.regions : [];
      if (items && items.length) saveCachedRateCard(items, regions);
    };

    for (const id of todo) {
      if (!connectionOk()) break; // dropped offline / metered mid-run — stop
      const data = await fetchJson(`/api/inspections/${id}`);
      if (data && data.inspection) {
        // Store the full payload exactly as the detail page does, so an offline
        // open renders identically.
        saveCachedInspection(id, data);
        const tmpl: string = data.inspection.templateType || '';
        if (tmpl === 'pm_scope_rate_card') {
          // Scope walks price against the catalog/regions offline.
          await ensureRateCardCached();
        } else if (tmpl === 'pm_turn_reinspect_qc') {
          // QC re-inspect needs its qc-data payload cached to open offline, plus
          // the catalog for any pricing it surfaces.
          if (!loadCachedQcData(id)) {
            const qc = await fetchJson(`/api/inspections/${id}/qc-data`);
            if (qc) saveCachedQcData(id, qc);
          }
          await ensureRateCardCached();
        } else if (tmpl && !cachedTemplates.has(tmpl) && !loadCachedQuestions(tmpl)) {
          // Questionnaire templates need their questions cached.
          const q = await fetchJson(`/api/questions?template=${encodeURIComponent(tmpl)}`);
          if (q && Array.isArray(q.questions)) {
            saveCachedQuestions(tmpl, q.questions);
            cachedTemplates.add(tmpl);
          }
        }
      }
      await new Promise((r) => setTimeout(r, GAP_MS)); // spread the load
    }
  };

  const ric: any = (window as any).requestIdleCallback;
  if (typeof ric === 'function') ric(() => { void run(); }, { timeout: 5000 });
  else setTimeout(() => { void run(); }, 1500);
}
