/**
 * Pre-cache active inspections for offline use.
 *
 * Problem: an inspection only opens in a dead zone if it was opened once on a
 * good connection (that's when its payload + template land in the offline
 * cache). Drive into a low-signal property cold and it just spins.
 *
 * Fix: when the home list loads on a good connection, quietly warm the offline
 * cache for every NON-COMPLETED inspection — the inspection payload, its
 * template questions (questionnaire templates), the shared Rate Card catalog,
 * and QC data — so they're all openable + editable offline later. Completed and
 * cancelled inspections are skipped (nothing left to do on them).
 *
 * Best-effort and bounded: online-only, throttled, capped, low concurrency, and
 * every write swallows quota errors. It never blocks or slows the visible list.
 */
import {
  saveCachedInspection, saveCachedQuestions, saveCachedRateCard, saveCachedQcData,
} from '@/lib/offlineCache';

const PRECACHE_TS_KEY = 'precache_last_v1';
// Don't re-run more than this often (a fresh list load each navigation shouldn't
// re-pull everything). A force flag bypasses it (e.g. an explicit refresh).
const MIN_INTERVAL_MS = 10 * 60 * 1000;
// localStorage is ~5MB/origin and each inspection payload (inspection + answers +
// property context) can be tens-to-hundreds of KB, so cap how many we warm to
// stay well under quota. The on-disk LRU (offlineCache INSP_MAX) holds the rest.
// A PRIOR home-screen prefetch was removed for firing dozens of heavy HubSpot
// calls and tripping the account-wide rate limit (429s that even broke the
// list/saves/submit). So this version is conservative AND self-defending:
//  - small cap + a SLOW sequential trickle (one detail fetch at a time, spaced),
//  - it only starts AFTER the live list has loaded (never competes with it),
//  - and it ABORTS for the rest of the session the moment ANY request comes back
//    429 (rate limited), so it can never pile on and degrade the list/saves.
const MAX_INSPECTIONS = 12;
const PACE_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Set when a request returns 429 — stops this session's pre-caching entirely so
// it can't keep hammering an already-rate-limited account.
let rateLimited = false;

const SCOPE = 'pm_scope_rate_card';
const QC = 'pm_turn_reinspect_qc';

let inFlight: Promise<void> | null = null;

async function safeJson(url: string): Promise<any | null> {
  if (rateLimited) return null;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    // Account-wide rate limit hit — stop ALL pre-caching this session so we don't
    // make the list/saves/submit flaky by piling on.
    if (r.status === 429) { rateLimited = true; return null; }
    if (!r.ok) return null;
    const d = await r.json();
    return d && !d.error ? d : null;
  } catch { return null; }
}

/** Warm the Rate Card catalog + regions once (shared by every scope inspection). */
async function precacheRateCard(): Promise<void> {
  try {
    const [cat, reg] = await Promise.all([
      safeJson('/api/rate-card/catalog'),
      safeJson('/api/rate-card/regions'),
    ]);
    const catalog = cat?.items || [];
    if (catalog.length > 0) saveCachedRateCard(catalog, reg?.regions || []);
  } catch { /* best-effort */ }
}

/** Warm a questionnaire template's questions once (shared across its inspections). */
async function precacheQuestions(template: string): Promise<void> {
  const d = await safeJson(`/api/questions?template=${encodeURIComponent(template)}`);
  if (d && Array.isArray(d.questions)) saveCachedQuestions(template, d.questions);
}

/**
 * Pull the signed-in user's inspections (all statuses, most-recent first) and
 * warm the offline cache for the non-completed ones. Idempotent + throttled.
 */
export async function precacheActiveInspections(opts?: { force?: boolean }): Promise<void> {
  if (typeof window === 'undefined') return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // online only
  if (inFlight) return inFlight;            // coalesce concurrent callers
  if (!opts?.force) {
    try {
      const last = Number(localStorage.getItem(PRECACHE_TS_KEY) || 0);
      if (last && Date.now() - last < MIN_INTERVAL_MS) return;
    } catch { /* ignore */ }
  }

  inFlight = (async () => {
    // Stamp up front so a navigation burst doesn't fire several passes.
    try { localStorage.setItem(PRECACHE_TS_KEY, String(Date.now())); } catch { /* ignore */ }

    // All statuses, newest first, bounded. facets=0 keeps it light.
    const list = await safeJson(`/api/inspections?pageSize=${MAX_INSPECTIONS}&facets=0&sort=updated&dir=desc`);
    const rows: any[] = Array.isArray(list?.inspections) ? list.inspections : [];
    const isDone = (s: string) => /^(completed?|cancell?ed)$/i.test((s || '').trim());
    const targets = rows.filter((i) => i?.recordId && !isDone(String(i.status || ''))).slice(0, MAX_INSPECTIONS);
    if (targets.length === 0) return;

    // Shared, dedupe-once datasets first: the scope catalog + each questionnaire
    // template. A handful of calls, run sequentially to stay gentle.
    const templates = new Set<string>(targets.map((t) => String(t.templateType || '')));
    if (templates.has(SCOPE)) { await precacheRateCard(); await sleep(PACE_MS); }
    for (const tmpl of templates) {
      if (tmpl && tmpl !== SCOPE && tmpl !== QC) { await precacheQuestions(tmpl); await sleep(PACE_MS); }
    }

    // Per-inspection payloads (+ QC data) ONE AT A TIME, spaced out — a slow
    // background trickle that never bursts HubSpot (see PACE_MS note above). Stops
    // early the moment the device drops offline.
    for (const t of targets) {
      if (rateLimited) break; // account hit a 429 — back off entirely
      if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      const id = String(t.recordId);
      const payload = await safeJson(`/api/inspections/${id}`);
      if (payload) saveCachedInspection(id, payload);
      if (String(t.templateType || '') === QC) {
        await sleep(PACE_MS);
        const qc = await safeJson(`/api/inspections/${id}/qc-data`);
        if (qc) saveCachedQcData(id, qc);
      }
      await sleep(PACE_MS);
    }
  })();

  try { await inFlight; }
  finally { inFlight = null; }
}
