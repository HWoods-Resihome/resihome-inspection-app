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
import { searchInspectionsPage } from '@/lib/hubspot';
import type { InspectionSummary } from '@/lib/types';

export const SNAPSHOT_BLOB_PATH = 'insights/snapshot.json';
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
  reportUrl: string | null;     // best available report PDF (master → attachment)
}

export interface InsightsSnapshot {
  asOf: string;                 // ISO build time
  strategy: 'paged';            // upgrade path: 'windowed' if volume nears 10k
  total: number;                // HubSpot's reported match count (non-cancelled)
  scanned: number;              // rows actually fetched
  truncated: boolean;           // scanned < total OR hit the offset ceiling — DO NOT trust if true
  buildMs: number;
  rows: InsightsRow[];
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
    reportUrl: s.pdfMasterUrl || s.pdfUrl || null,
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
  return {
    asOf: new Date().toISOString(),
    strategy: 'paged',
    total,
    scanned: rows.length,
    truncated,
    buildMs: Date.now() - t0,
    rows,
  };
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
