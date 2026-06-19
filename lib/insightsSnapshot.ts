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
import { searchInspectionsPage, countInspectionsCancelled } from '@/lib/hubspot';
import type { InspectionSummary } from '@/lib/types';

export const SNAPSHOT_BLOB_PATH = 'insights/snapshot.json';
export const HISTORY_BLOB_PREFIX = 'insights/history/';
const PAGE_SIZE = 100;
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
  reportUrl: string | null;     // best available report PDF (master → attachment)
  propertyId: string | null;                 // HubSpot Property record id (property_id_ref)
  propertyStatus: string | null;             // the property's CURRENT status (e.g. 'Vacant - On Market')
}

export interface InsightsSnapshot {
  asOf: string;                 // ISO build time
  strategy: 'paged';            // upgrade path: 'windowed' if volume nears 10k
  total: number;                // HubSpot's reported match count (non-cancelled)
  scanned: number;              // rows actually fetched
  truncated: boolean;           // scanned < total OR hit the offset ceiling — DO NOT trust if true
  cancelledCount: number;       // cancelled inspections (excluded from rows; for cancellation-rate later)
  buildMs: number;
  rows: InsightsRow[];
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
    reportUrl: s.pdfMasterUrl || s.pdfUrl || null,
    propertyId: s.propertyRecordId ?? null,
    // propertyStatus comes from the list mapper: frozen-at-completion for
    // completed rows, live-enriched for active rows (see hubspot mapInspectionRow
    // + enrichPropertyStatuses). No separate read here.
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
  // propertyStatus is already on each row (from the list mapper: frozen for
  // completed, live-enriched for active) — no extra read needed here.
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
  };
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
