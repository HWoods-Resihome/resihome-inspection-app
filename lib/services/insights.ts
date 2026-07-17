/**
 * lib/services/insights.ts — Services vendor-performance metrics (pure).
 *
 * Aggregates Service Work Orders into the coordinator-facing KPIs shown on the
 * Insights → Services tab, overall and per-vendor. Pure + deterministic (no I/O,
 * no clock) so it is unit-testable; the endpoint feeds it normalized rows.
 *
 * Split children (a per-property billing line off a community grass-cut master —
 * master_service_id set) are excluded upstream so completed counts / costs aren't
 * double-counted, mirroring the operational list.
 */

export interface SvcInsightsRow {
  status: string;             // estimated | assigned | submitted | review | completed | canceled
  isBidItem: boolean;
  ontime: boolean | null;     // null when not recorded (only completed rows carry it)
  reviewDecision: string;     // '' | approve | modify | reject
  vendor: string;             // vendor_name ('' → Unassigned)
  vendorCost: number | null;
}

export interface SvcMetrics {
  total: number;
  completed: number;
  completedPct: number;       // completed / non-canceled (0..1)
  onTimePct: number;          // on-time / completed-with-known-ontime (0..1)
  bidItemPct: number;         // bid items / total (0..1)
  closedOut: number;          // completed count
  reviewedCount: number;      // rows with a human review decision
  rejectModifyRate: number;   // (reject + modify) / reviewed (0..1)
  avgVendorCost: number;      // mean vendor_cost over completed rows that carry a cost
}

export interface VendorMetrics extends SvcMetrics { vendor: string; }

export interface ServiceInsights {
  overall: SvcMetrics;
  perVendor: VendorMetrics[];
  rows: number;               // rows considered (after exclusions)
}

const UNASSIGNED = 'Unassigned';

function metricsFor(rows: SvcInsightsRow[]): SvcMetrics {
  const total = rows.length;
  const canceled = rows.filter((r) => r.status === 'canceled').length;
  const nonCanceled = total - canceled;
  const completedRows = rows.filter((r) => r.status === 'completed');
  const completed = completedRows.length;

  const ontimeKnown = completedRows.filter((r) => r.ontime !== null);
  const onTime = ontimeKnown.filter((r) => r.ontime === true).length;

  const bidItems = rows.filter((r) => r.isBidItem).length;

  const reviewed = rows.filter((r) => !!r.reviewDecision);
  const rejectModify = reviewed.filter((r) => r.reviewDecision === 'reject' || r.reviewDecision === 'modify').length;

  const costRows = completedRows.filter((r) => r.vendorCost != null && Number.isFinite(r.vendorCost));
  const costSum = costRows.reduce((s, r) => s + (r.vendorCost as number), 0);

  return {
    total,
    completed,
    completedPct: nonCanceled ? completed / nonCanceled : 0,
    onTimePct: ontimeKnown.length ? onTime / ontimeKnown.length : 0,
    bidItemPct: total ? bidItems / total : 0,
    closedOut: completed,
    reviewedCount: reviewed.length,
    rejectModifyRate: reviewed.length ? rejectModify / reviewed.length : 0,
    avgVendorCost: costRows.length ? Math.round((costSum / costRows.length) * 100) / 100 : 0,
  };
}

/** Aggregate rows into overall + per-vendor metrics. Vendors sorted by volume desc,
 *  then name; blank vendor rolls up under "Unassigned". */
export function computeServiceInsights(rows: SvcInsightsRow[]): ServiceInsights {
  const byVendor = new Map<string, SvcInsightsRow[]>();
  for (const r of rows) {
    const v = (r.vendor || '').trim() || UNASSIGNED;
    const arr = byVendor.get(v) || [];
    arr.push(r);
    byVendor.set(v, arr);
  }
  const perVendor: VendorMetrics[] = Array.from(byVendor.entries())
    .map(([vendor, vrows]) => ({ vendor, ...metricsFor(vrows) }))
    .sort((a, b) => (b.total - a.total) || a.vendor.localeCompare(b.vendor));

  return { overall: metricsFor(rows), perVendor, rows: rows.length };
}
