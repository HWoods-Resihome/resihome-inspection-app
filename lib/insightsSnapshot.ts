/**
 * lib/insightsSnapshot.ts — pre-aggregation snapshot for ResiWalk Insights.
 *
 * Decision A: the dashboard never queries HubSpot live. A scheduled job (cron,
 * see /api/insights/rebuild) pages ALL non-cancelled inspections into a compact
 * snapshot stored in Vercel Blob; the dashboard reads that snapshot instantly
 * and does all filtering/aggregation client-side.
 *
 * Decision B (paging correctness): HubSpot Search returns at most 10,000 results
 * per query even with paging tokens, so naive paging SILENTLY UNDERCOUNTS past
 * 10k. Current non-cancelled volume is ~114 (the app's own status counter, i.e.
 * countInspectionsByStatus('all') — the same search) — two orders of magnitude
 * under the cap — so simple after-paging to completion IS complete today. We
 * record total/scanned/truncated so any undercount is VISIBLE (never silent);
 * if `truncated` ever trips, switch to date-windowed partitioning before trust.
 *
 * Data-only: no UI, no brand color. Reuses the existing, tested
 * searchInspectionsPage so rows match the rest of the app exactly.
 */
import { put, list } from '@vercel/blob';
import { searchInspectionsPage, countInspectionsCancelled, fetchQuestionsForTemplate, fetchAnswersForInspection, batchReadPropertyStatuses } from '@/lib/hubspot';
import { readAiFeedback } from '@/lib/aiFeedback';
import { getCachedCatalog } from '@/pages/api/rate-card/catalog';
import type { InspectionSummary } from '@/lib/types';

export const SNAPSHOT_BLOB_PATH = 'insights/snapshot.json';
export const HISTORY_BLOB_PREFIX = 'insights/history/';
const PAGE_SIZE = 100;
// Template literals here to avoid an import cycle with insightsMetrics, which
// imports the InsightsRow type from this file.
const TEMPLATE_1099 = 'leasing_agent_1099_property_inspection';
const TEMPLATE_SCOPE = 'pm_scope_rate_card';
// Concurrency + ceiling for the per-1099 answer reads (Grass Condition capture).
// Bounded so the 60s rebuild window is never at risk.
const GRASS_CONCURRENCY = 8;
const GRASS_MAX_INSPECTIONS = 600;

// Pass/fail tone of an answer label — MIRRORS components/QuestionItem.tsx
// answerTone() (the canonical app rule) so a "Grass Condition" fail here matches
// what the inspector saw. Kept inline (not imported) to avoid pulling a client
// component into the server snapshot build.
function answerTone(v: string): 'good' | 'fail' | null {
  const n = (v || '').trim().toLowerCase();
  if (/\b(fail|failed|poor|deficient)\b/.test(n)) return 'fail';
  if (/\b(good|pass|passed|satisfactory)\b/.test(n)) return 'good';
  return null;
}
// Safety ceiling: ~120 pages = 12,000 rows. Far past current volume; if we ever
// hit it the snapshot is flagged `truncated` rather than silently short.
const MAX_PAGES = 120;

/** Canonical status bucket (cancelled is excluded upstream by the search). */
export type StatusBucket = 'scheduled' | 'in_progress' | 'pending_approval' | 'completed' | 'other';

function statusBucket(s?: string | null): StatusBucket {
  const x = (s || '').trim().toLowerCase().replace(/[ -]/g, '_');
  if (x === 'scheduled') return 'scheduled';
  if (x === 'in_progress') return 'in_progress';
  if (x === 'pending_approval' || x === 'pendingapproval') return 'pending_approval';
  if (x === 'completed' || x === 'complete' || x === 'submitted') return 'completed';
  return 'other';
}

/** Compact per-inspection row the dashboard reads. Every field traces to a named
 *  InspectionSummary property — no derived/mocked values. */
export interface InsightsRow {
  recordId: string;
  inspectionIdExternal: string;
  inspectionName: string;
  templateType: string;
  status: StatusBucket;
  statusLabel: string;          // raw HubSpot status label (for display/debug)
  propertyAddress: string;
  inspectorName: string;
  inspectorEmail: string;
  region: string | null;
  scheduledDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  qcVerdict: 'pass' | 'fail' | null;
  qcPassCount: number | null;
  qcFailCount: number | null;
  inspectionResult: 'pass' | 'fail' | null;  // 1099/Vacancy overall pass/fail
  totalPhotos: number | null;                // total_photos_attached (stamped at submit)
  totalClientCost: number | null;            // Scope Rate Card $ (excluded from pass/fail)
  approverName: string | null;               // who approved (approved_by) — for the scope cost/approvals cards
  // Scope Rate Card per-category client cost { category: $ } (set on scope rows
  // that have rate-card lines; absent otherwise). Sums clientCost by the line's
  // catalog category. Powers the per-category scope-cost breakdown.
  scopeCategoryCosts?: Record<string, number>;
  reportUrl: string | null;     // best available report PDF (master → attachment)
  propertyId: string | null;                 // HubSpot Property record id (property_id_ref)
  propertyStatus: string | null;             // the property's CURRENT live status (e.g. 'Vacant - On Market') — for analytics filtering across ALL rows
  // 1099 Grass Condition capture (only set on 1099 rows that have been worked;
  // absent otherwise). grassTone uses the app's answerTone rule; grassPhotos are
  // the photo URLs attached to the Grass Condition answer.
  grassCondition?: string | null;
  grassTone?: 'good' | 'fail' | null;
  grassPhotos?: string[];
  // True when this inspection has ≥1 AI override event (drives the 'AI Overrides'
  // global filter). Set by enrichAiOverrides at build time.
  hasAiOverride?: boolean;
}

/** One human-overrode-the-AI event, joined to its inspection for attribution +
 *  drill-down. 'decision' is the override kind; code/category identify what was
 *  overridden. Powers the AI-overrides cards + the preference-overrides drill-down. */
export interface AiOverrideRow {
  inspectionId: string;
  // WHO made the override (the event actor — inspector OR approver), falling
  // back to the inspection's inspector for legacy events. Named "inspector*"
  // for back-compat with the grouping/filter helpers.
  inspectorName: string;
  inspectorEmail: string;
  region: string | null;
  templateType: string;
  propertyAddress: string;
  scheduledDate: string | null;
  propertyStatus: string | null;
  code: string | null;            // catalog line-item code the AI suggested
  category: string | null;        // resolved from the catalog (code → category)
  codeLabel: string | null;       // line-item description (catalog laborShortDescription)
  decision: string;               // decline | edit | move | remove | ignore
  query: string | null;           // the utterance/search that produced the suggestion
  ts: string;                     // event timestamp (ISO)
}

// Decisions where the human did something OTHER than accept the AI as-is.
const OVERRIDE_DECISIONS = new Set(['decline', 'edit', 'move', 'remove', 'ignore']);
// Cap the override rows shipped in the snapshot (newest first) — plenty for the
// cards + drill-down without bloating the client payload.
const MAX_OVERRIDE_ROWS = 2000;
// How far back to pull AI feedback for the overrides analytics.
const OVERRIDE_DAYS = 120;

export interface InsightsSnapshot {
  asOf: string;                 // ISO build time
  strategy: 'paged';            // upgrade path: 'windowed' if volume nears 10k
  total: number;                // HubSpot's reported match count (non-cancelled)
  scanned: number;              // rows actually fetched
  truncated: boolean;           // scanned < total OR hit the offset ceiling — DO NOT trust if true
  cancelledCount: number;       // cancelled inspections (excluded from rows; for cancellation-rate later)
  buildMs: number;
  rows: InsightsRow[];
  // AI override events (human ≠ AI), joined to inspector/inspection. Newest first,
  // capped at MAX_OVERRIDE_ROWS. Empty if feedback storage isn't configured.
  aiOverrides?: AiOverrideRow[];
}

/** Compact daily rollup banked each build so trend/sparkline/delta cards have a
 *  time series to draw (the live snapshot is overwritten, so it carries no
 *  history). One file per UTC day, overwritten by later builds the same day. */
export interface InsightsDailyRollup {
  date: string;                 // YYYY-MM-DD (UTC)
  asOf: string;                 // last build that updated this day
  total: number;                // non-cancelled
  cancelledCount: number;
  byStatus: Record<StatusBucket, number>;
  completed: number;
  // Pass/fail tallies (1099/Vacancy via inspection_result, QC via qcVerdict).
  passCount: number;
  failCount: number;
  // Avg total turnaround (completed/approved − scheduled) over completed rows, ms.
  avgTurnaroundMs: number | null;
}

function toRow(s: InspectionSummary): InsightsRow {
  return {
    recordId: s.recordId,
    inspectionIdExternal: s.inspectionIdExternal,
    inspectionName: s.inspectionName,
    templateType: s.templateType,
    status: statusBucket(s.status),
    statusLabel: s.status,
    propertyAddress: s.propertyAddressSnapshot,
    inspectorName: s.inspectorName,
    inspectorEmail: s.inspectorEmail,
    region: s.regionSnapshot || null,
    scheduledDate: s.scheduledDate,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    submittedAt: s.submittedAt,
    approvedAt: s.approvedAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    qcVerdict: s.qcVerdict,
    qcPassCount: s.qcPassCount,
    qcFailCount: s.qcFailCount,
    inspectionResult: s.inspectionResult ?? null,
    totalPhotos: s.totalPhotosAttached ?? null,
    totalClientCost: s.totalClientCost,
    approverName: s.approvedByName ?? null,
    reportUrl: s.pdfMasterUrl || s.pdfUrl || null,
    propertyId: s.propertyRecordId ?? null,
    // Seed with the list-mapper value (frozen for completed, live for active);
    // enrichCurrentPropertyStatus() then overrides ALL rows with the property's
    // CURRENT live status so analytics filtering by status is consistent across
    // completed + active inspections.
    propertyStatus: s.propertyStatus ?? null,
  };
}

/** Build the snapshot by paging ALL non-cancelled inspections to completion. */
export async function buildInsightsSnapshot(): Promise<InsightsSnapshot> {
  const t0 = Date.now();
  const byId = new Map<string, InsightsRow>(); // dedup by recordId (offset paging is racy)
  let total = 0;
  let page = 1;
  let hitCeiling = false;

  // No status filter → the search excludes cancelled by default (NOT_IN cancelled).
  // Sort by createdate so the page order is stable across the scan (less racy than
  // 'updated', which changes as the app is used mid-build).
  for (; page <= MAX_PAGES; page++) {
    const { items, total: t } = await searchInspectionsPage({
      sortField: 'scheduled', sortDir: 'asc', page, pageSize: PAGE_SIZE,
    });
    total = t;
    for (const it of items) byId.set(it.recordId, toRow(it));
    if (items.length < PAGE_SIZE) break;        // last page
    if (byId.size >= total) break;              // got everything HubSpot reports
    if (page * PAGE_SIZE >= 10000) { hitCeiling = true; break; } // offset cap
  }

  const rows = Array.from(byId.values());
  const truncated = hitCeiling || rows.length < total;
  // Enrichment passes are best-effort and INDEPENDENT: a slow/failing pass must
  // never abort the build (which would freeze the snapshot blob and stall every
  // card — including the core inspector/approver data). Each is wrapped + timed.
  const runPass = async (name: string, fn: () => Promise<void>): Promise<void> => {
    const t = Date.now();
    try { await fn(); }
    catch (e) { console.warn(`[insights] enrichment '${name}' failed (continuing):`, e); }
    finally { console.log(`[insights] pass ${name}: ${Date.now() - t}ms`); }
  };
  await runPass('property-status', () => enrichCurrentPropertyStatus(rows));
  await runPass('grass', () => enrichGrassConditions(rows));
  await runPass('scope-categories', () => enrichScopeCategoryCosts(rows));
  let aiOverrides: AiOverrideRow[] = [];
  await runPass('ai-overrides', async () => { aiOverrides = await buildAiOverrides(rows); });
  const cancelledCount = await countInspectionsCancelled().catch(() => 0);
  return {
    asOf: new Date().toISOString(),
    strategy: 'paged',
    total,
    scanned: rows.length,
    truncated,
    cancelledCount,
    buildMs: Date.now() - t0,
    rows,
    aiOverrides,
  };
}

/**
 * Build the AI-override rows: read recent AI feedback, keep the events where the
 * human did NOT accept the AI as-is (decline/edit/move/remove/ignore), and JOIN
 * each to its inspection (via inspectionId) for context (region / property /
 * template) + a drill-down link. Events with no resolvable inspection are
 * dropped. Also stamps row.hasAiOverride for the 'AI Overrides' global filter.
 *
 * Attribution: the override is credited to the ACTOR stamped on the event (the
 * signed-in user who made the decision — inspector OR approver), so an
 * approver's edits no longer inflate the inspection's original inspector. Legacy
 * events with no actor fall back to the inspection's inspector. Best-effort.
 */
async function buildAiOverrides(rows: InsightsRow[]): Promise<AiOverrideRow[]> {
  let events;
  try {
    events = await readAiFeedback(OVERRIDE_DAYS);
  } catch (e) {
    console.warn('[insights] ai-feedback read failed:', e);
    return [];
  }
  if (!events.length) return [];

  // code → category + human description (best-effort; bare code if unavailable).
  const catByCode = new Map<string, string>();
  const labelByCode = new Map<string, string>();
  try {
    for (const c of await getCachedCatalog()) {
      if (!c.lineItemCode) continue;
      if (c.category) catByCode.set(c.lineItemCode, c.category);
      if (c.laborShortDescription) labelByCode.set(c.lineItemCode, c.laborShortDescription);
    }
  } catch { /* no catalog → category/label stay null */ }

  const rowById = new Map(rows.map((r) => [r.recordId, r]));
  const out: AiOverrideRow[] = [];
  for (const e of events) {
    if (!OVERRIDE_DECISIONS.has(e.decision)) continue;
    const row = e.inspectionId ? rowById.get(e.inspectionId) : undefined;
    if (!row) continue; // can't attribute without the inspection → drop (never fake)
    row.hasAiOverride = true;
    const code = e.suggestion?.catalogCode || null;
    // Credit the actual editor (event actor) — falling back to the inspection's
    // inspector for legacy events that predate actor stamping.
    const actorEmail = (e.actorEmail || '').trim();
    const editorEmail = actorEmail || row.inspectorEmail;
    const editorName = actorEmail ? (e.actorName || e.actorEmail || actorEmail) : row.inspectorName;
    out.push({
      inspectionId: row.recordId,
      inspectorName: editorName,
      inspectorEmail: editorEmail,
      region: row.region,
      templateType: row.templateType,
      propertyAddress: row.propertyAddress,
      scheduledDate: row.scheduledDate,
      propertyStatus: row.propertyStatus,
      code,
      category: code ? (catByCode.get(code) || null) : null,
      codeLabel: code ? (labelByCode.get(code) || null) : null,
      decision: e.decision,
      query: e.suggestion?.query || null,
      ts: e.ts || new Date().toISOString(),
    });
  }
  // Newest first, capped.
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out.slice(0, MAX_OVERRIDE_ROWS);
}

/**
 * Override every row's propertyStatus with the property's CURRENT live status
 * (one batched read across the distinct property ids), so the dashboard's
 * status pivot/filter is consistent for completed AND active inspections —
 * otherwise completed rows (which carry a mostly-empty frozen status) all land
 * in "(unknown)" and filtering by a real status drops them, blanking the
 * completed-based KPIs. Best-effort: rows keep their seed value on miss/failure.
 */
async function enrichCurrentPropertyStatus(rows: InsightsRow[]): Promise<void> {
  const ids = rows.map((r) => r.propertyId).filter((id): id is string => !!id);
  if (ids.length === 0) return;
  try {
    const statusById = await batchReadPropertyStatuses(ids);
    for (const r of rows) {
      if (r.propertyId) {
        const live = statusById.get(r.propertyId);
        if (live) r.propertyStatus = live;
      }
    }
  } catch (e) {
    console.warn('[insights] current property-status enrichment failed:', e);
  }
}

/**
 * Capture each 1099 inspection's "Grass Condition" answer (value + tone +
 * photos) onto its row, powering the Grass Condition fails card. Reads the
 * answers per 1099 inspection — bounded by concurrency + a hard ceiling so the
 * 60s rebuild window is safe. Best-effort: any failure leaves the row's grass
 * fields unset (the card simply shows fewer rows), never failing the build.
 *
 * The Grass Condition question is found by matching question text /grass/i in
 * the 1099 template; rows still 'scheduled' (no answers yet) are skipped.
 */
async function enrichGrassConditions(rows: InsightsRow[]): Promise<void> {
  const targets = rows
    .filter((r) => r.templateType === TEMPLATE_1099 && r.status !== 'scheduled')
    .slice(0, GRASS_MAX_INSPECTIONS);
  if (targets.length === 0) return;

  // Find the Grass Condition question's external id (once).
  let grassQid: string | null = null;
  try {
    const { questions } = await fetchQuestionsForTemplate(TEMPLATE_1099, { includeDisabled: true });
    const grass = questions.find((q) => /grass/i.test(q.questionText || ''));
    grassQid = grass?.questionIdExternal || null;
  } catch (e) {
    console.warn('[insights-grass] could not load 1099 questions:', e);
    return;
  }
  if (!grassQid) {
    console.warn('[insights-grass] no Grass Condition question found in 1099 template');
    return;
  }

  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < targets.length) {
      const row = targets[i++];
      try {
        const answers = await fetchAnswersForInspection(row.recordId);
        const a = answers.find((x) => x.questionIdExternal === grassQid);
        if (!a) continue;
        const value = (a.answerValue || '').trim();
        row.grassCondition = value || null;
        row.grassTone = answerTone(value);
        row.grassPhotos = Array.isArray(a.photoUrls) ? a.photoUrls.filter(Boolean) : [];
      } catch {
        /* best-effort: leave this row's grass fields unset */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GRASS_CONCURRENCY, targets.length) }, worker));
}

/**
 * Sum each Scope Rate Card inspection's client cost by catalog CATEGORY (from
 * its rate-card line answers), powering the per-category scope-cost breakdown.
 * Reads answers per scope inspection that has a cost — bounded by concurrency +
 * ceiling, best-effort. category resolved via the cached catalog (code→category).
 */
async function enrichScopeCategoryCosts(rows: InsightsRow[]): Promise<void> {
  const targets = rows
    .filter((r) => r.templateType === TEMPLATE_SCOPE && (r.totalClientCost ?? 0) > 0)
    .slice(0, GRASS_MAX_INSPECTIONS);
  if (targets.length === 0) return;

  const catByCode = new Map<string, string>();
  try {
    for (const c of await getCachedCatalog()) {
      if (c.lineItemCode && c.category) catByCode.set(c.lineItemCode, c.category);
    }
  } catch (e) {
    console.warn('[insights-scope] catalog load failed:', e);
    return; // without categories there is nothing to break down
  }

  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < targets.length) {
      const row = targets[i++];
      try {
        const answers = await fetchAnswersForInspection(row.recordId);
        const byCat: Record<string, number> = {};
        for (const a of answers) {
          const line = a.rateCardLine;
          if (!line || typeof line.clientCost !== 'number') continue;
          const cat = catByCode.get(line.lineItemCode) || '(uncategorized)';
          byCat[cat] = (byCat[cat] || 0) + line.clientCost;
        }
        if (Object.keys(byCat).length) row.scopeCategoryCosts = byCat;
      } catch {
        /* best-effort: leave this scope's category breakdown unset */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GRASS_CONCURRENCY, targets.length) }, worker));
}

// --- Daily history (banked each build for trend/delta cards) -----------------

/** Build today's rollup from the snapshot. Date is UTC (matches the cron clock). */
export function buildDailyRollup(snap: InsightsSnapshot): InsightsDailyRollup {
  const byStatus: Record<StatusBucket, number> = {
    scheduled: 0, in_progress: 0, pending_approval: 0, completed: 0, other: 0,
  };
  let passCount = 0, failCount = 0, completed = 0, turnSum = 0, turnN = 0;
  for (const r of snap.rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.status === 'completed') {
      completed++;
      const end = r.approvedAt || r.completedAt;
      if (end && r.scheduledDate) {
        const ms = Date.parse(end) - Date.parse(r.scheduledDate);
        if (Number.isFinite(ms) && ms >= 0) { turnSum += ms; turnN++; }
      }
    }
    // Pass/fail: 1099/Vacancy via inspection_result, QC via qcVerdict (Scope excluded).
    const verdict = r.inspectionResult || r.qcVerdict;
    if (verdict === 'pass') passCount++;
    else if (verdict === 'fail') failCount++;
  }
  return {
    date: snap.asOf.slice(0, 10),
    asOf: snap.asOf,
    total: snap.total,
    cancelledCount: snap.cancelledCount,
    byStatus,
    completed,
    passCount,
    failCount,
    avgTurnaroundMs: turnN ? Math.round(turnSum / turnN) : null,
  };
}

/** Persist today's rollup (one file per UTC day; later builds overwrite it). */
export async function writeDailyRollup(rollup: InsightsDailyRollup): Promise<void> {
  await put(`${HISTORY_BLOB_PREFIX}${rollup.date}.json`, JSON.stringify(rollup), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
  });
}

/** Read the banked daily rollups (ascending by date) for trend/delta cards. */
export async function readInsightsHistory(maxDays = 180): Promise<InsightsDailyRollup[]> {
  try {
    const { blobs } = await list({ prefix: HISTORY_BLOB_PREFIX, limit: 1000 });
    const recent = blobs
      .filter((b) => b.pathname.endsWith('.json'))
      .sort((a, b) => a.pathname.localeCompare(b.pathname))
      .slice(-maxDays);
    const rollups = await Promise.all(recent.map((b) =>
      fetch(b.url + `?t=${b.uploadedAt ? new Date(b.uploadedAt).getTime() : ''}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null)));
    return rollups.filter((r): r is InsightsDailyRollup => !!r && typeof r.date === 'string')
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch (e) {
    console.warn('[insights-history] read failed:', e);
    return [];
  }
}

/** Persist the snapshot to Vercel Blob (stable path, overwritten each build). */
export async function writeInsightsSnapshot(snap: InsightsSnapshot): Promise<void> {
  await put(SNAPSHOT_BLOB_PATH, JSON.stringify(snap), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
  });
}

/** Read the latest snapshot from Blob, or null if none has been built yet. */
export async function readInsightsSnapshot(): Promise<InsightsSnapshot | null> {
  try {
    const { blobs } = await list({ prefix: SNAPSHOT_BLOB_PATH, limit: 1 });
    const blob = blobs.find((b) => b.pathname === SNAPSHOT_BLOB_PATH) || blobs[0];
    if (!blob) return null;
    // Cache-bust: Blob URLs are CDN-cached; append the upload time so a fresh
    // rebuild isn't served stale.
    const url = blob.url + (blob.uploadedAt ? `?t=${new Date(blob.uploadedAt).getTime()}` : '');
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as InsightsSnapshot;
  } catch (e) {
    console.warn('[insights-snapshot] read failed:', e);
    return null;
  }
}
