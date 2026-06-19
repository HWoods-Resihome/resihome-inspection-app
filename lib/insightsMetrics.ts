/**
 * lib/insightsMetrics.ts — PURE computation for the ResiWalk Insights dashboard.
 *
 * No React, no fetch — just filtering + aggregation over the snapshot rows, so
 * every dashboard number is unit-testable and traces to a LOCKED definition:
 *
 *  - Completion time (total turnaround) = (approvedAt || completedAt) − scheduledDate;
 *    ONLY completed rows that have BOTH dates.
 *  - Time-to-start  = startedAt − scheduledDate;  rows with NO startedAt are
 *    EXCLUDED from the average (never counted as 0).
 *  - Time-to-finish = (approvedAt || completedAt) − startedAt.
 *  - Pass/Fail: ONLY 1099 (leasing_agent_1099_property_inspection) + Vacancy
 *    (pm_vacancy_occupancy_check) via inspectionResult, AND QC
 *    (pm_turn_reinspect_qc) via qcVerdict. Scope Rate Card (pm_scope_rate_card)
 *    is EXCLUDED from pass/fail — report total_client_cost instead. Rows with no
 *    verdict are excluded from pass-rate denominators.
 *  - # incomplete = count of status scheduled + in_progress.
 *  - Avg/total photos = totalPhotos.
 *  - PER-INSPECTOR grouping keys off inspectorEmail (lowercased) — NOT name.
 *    Display label = most frequent non-empty inspectorName for that email
 *    (fallback to the email).
 *
 * Every helper drops rows that lack the dates/verdict a definition requires
 * (never substitutes 0), so averages and rates are honest.
 */
import type { InsightsRow, InsightsDailyRollup, StatusBucket, AiOverrideRow } from '@/lib/insightsSnapshot';

// ---- Template-type sets the pass/fail rules key off --------------------------
export const TEMPLATE_1099 = 'leasing_agent_1099_property_inspection';
export const TEMPLATE_VACANCY = 'pm_vacancy_occupancy_check';
export const TEMPLATE_QC = 'pm_turn_reinspect_qc';
export const TEMPLATE_SCOPE = 'pm_scope_rate_card';

/** Templates whose pass/fail verdict comes from inspectionResult. */
const RESULT_VERDICT_TEMPLATES = new Set([TEMPLATE_1099, TEMPLATE_VACANCY]);

/** 1099 inspections whose Grass Condition answer failed (app answerTone rule),
 *  newest first. Photos live on row.grassPhotos. Powers the Grass fails card. */
export function grassConditionFails(rows: InsightsRow[]): InsightsRow[] {
  return rows
    .filter((r) => r.templateType === TEMPLATE_1099 && r.grassTone === 'fail')
    .sort((a, b) => {
      const da = a.completedAt || a.scheduledDate || a.createdAt || '';
      const db = b.completedAt || b.scheduledDate || b.createdAt || '';
      return db.localeCompare(da);
    });
}

// ---- Filters -----------------------------------------------------------------

export interface InsightsFilters {
  /** Inclusive scheduledDate window (YYYY-MM-DD), or null for open-ended. */
  dateFrom: string | null;
  dateTo: string | null;
  /** Lowercased inspector emails to include (empty = all). */
  inspectorEmails: string[];
  /** Exact propertyAddress values to include (empty = all). */
  properties: string[];
  /** Region values to include (empty = all). null region matches "(none)". */
  regions: string[];
  /** templateType values to include (empty = all). */
  templateTypes: string[];
  /** Current Property status values to include (empty = all). null → "(none)". */
  propertyStatuses: string[];
  /** When true, restrict to inspections that have ≥1 AI override event. */
  onlyAiOverrides: boolean;
}

export const EMPTY_FILTERS: InsightsFilters = {
  dateFrom: null, dateTo: null,
  inspectorEmails: [], properties: [], regions: [], templateTypes: [], propertyStatuses: [],
  onlyAiOverrides: false,
};

/** Sentinel used in the region multi-select for rows with a null region. */
export const REGION_NONE = '(none)';
/** Sentinel used in the property-status multi-select for rows with no status. */
export const STATUS_NONE = '(unknown)';

/** Count of active rail filters (a date window counts as one). Shared by the
 *  rail header and the collapsed-rail button badge so they never drift. */
export function countActiveFilters(f: InsightsFilters): number {
  return (f.dateFrom || f.dateTo ? 1 : 0)
    + f.inspectorEmails.length + f.properties.length
    + f.regions.length + f.templateTypes.length + (f.propertyStatuses?.length || 0)
    + (f.onlyAiOverrides ? 1 : 0);
}

function inDateWindow(scheduledDate: string | null, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  if (!scheduledDate) return false; // a date filter excludes rows with no scheduledDate
  const day = scheduledDate.slice(0, 10); // ISO → YYYY-MM-DD (lexicographic-safe)
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

/** Apply the global rail filters to the snapshot rows (client-side, pure). */
export function applyFilters(rows: InsightsRow[], f: InsightsFilters): InsightsRow[] {
  const emails = new Set(f.inspectorEmails.map((e) => e.toLowerCase()));
  const props = new Set(f.properties);
  const regions = new Set(f.regions);
  const types = new Set(f.templateTypes);
  const statuses = new Set(f.propertyStatuses || []);
  return rows.filter((r) => {
    if (!inDateWindow(r.scheduledDate, f.dateFrom, f.dateTo)) return false;
    if (emails.size && !emails.has((r.inspectorEmail || '').toLowerCase())) return false;
    if (props.size && !props.has(r.propertyAddress || '')) return false;
    if (regions.size) {
      const key = r.region == null || r.region === '' ? REGION_NONE : r.region;
      if (!regions.has(key)) return false;
    }
    if (types.size && !types.has(r.templateType)) return false;
    if (statuses.size) {
      const key = r.propertyStatus == null || r.propertyStatus === '' ? STATUS_NONE : r.propertyStatus;
      if (!statuses.has(key)) return false;
    }
    if (f.onlyAiOverrides && !r.hasAiOverride) return false;
    return true;
  });
}

// ---- AI overrides (who overrides the AI, and where) --------------------------

/** Apply the global rail filters to AI override rows (same dimensions as rows:
 *  date window on scheduledDate, inspector, region, template, property status). */
export function filterOverrides(overrides: AiOverrideRow[], f: InsightsFilters): AiOverrideRow[] {
  const emails = new Set(f.inspectorEmails.map((e) => e.toLowerCase()));
  const regions = new Set(f.regions);
  const types = new Set(f.templateTypes);
  const statuses = new Set(f.propertyStatuses || []);
  const props = new Set(f.properties);
  return overrides.filter((o) => {
    if (!inDateWindow(o.scheduledDate, f.dateFrom, f.dateTo)) return false;
    if (emails.size && !emails.has((o.inspectorEmail || '').toLowerCase())) return false;
    if (props.size && !props.has(o.propertyAddress || '')) return false;
    if (regions.size) {
      const key = o.region == null || o.region === '' ? REGION_NONE : o.region;
      if (!regions.has(key)) return false;
    }
    if (types.size && !types.has(o.templateType)) return false;
    if (statuses.size) {
      const key = o.propertyStatus == null || o.propertyStatus === '' ? STATUS_NONE : o.propertyStatus;
      if (!statuses.has(key)) return false;
    }
    return true;
  });
}

export interface OverrideGroup {
  key: string;            // inspector email (or '(unknown)') / category (or '(uncoded)')
  label: string;          // display name
  count: number;          // total override events in the group
  rows: AiOverrideRow[];  // the events (for drill-down)
}

/** Group override events by inspector (most overrides first) — "who overrides most". */
export function overridesByInspector(overrides: AiOverrideRow[]): OverrideGroup[] {
  const map = new Map<string, OverrideGroup>();
  for (const o of overrides) {
    const key = (o.inspectorEmail || '').toLowerCase() || '(unknown)';
    let g = map.get(key);
    if (!g) { g = { key, label: o.inspectorName || o.inspectorEmail || '(unknown)', count: 0, rows: [] }; map.set(key, g); }
    g.count++; g.rows.push(o);
    if (!g.label || g.label === '(unknown)') g.label = o.inspectorName || o.inspectorEmail || '(unknown)';
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/** Group override events by catalog category — "biggest training opportunity". */
export function overridesByCategory(overrides: AiOverrideRow[]): OverrideGroup[] {
  const map = new Map<string, OverrideGroup>();
  for (const o of overrides) {
    const key = o.category || '(uncoded)';
    let g = map.get(key);
    if (!g) { g = { key, label: key, count: 0, rows: [] }; map.set(key, g); }
    g.count++; g.rows.push(o);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/** Override events for a specific catalog code (preference-overrides drill-down). */
export function overridesForCode(overrides: AiOverrideRow[], code: string): AiOverrideRow[] {
  return overrides.filter((o) => o.code === code);
}

// ---- Scope Rate Card cost ----------------------------------------------------

/** Scope rows that carry a client cost (the population for the scope-cost card). */
export function scopeRows(rows: InsightsRow[]): InsightsRow[] {
  return rows.filter((r) => r.templateType === TEMPLATE_SCOPE && typeof r.totalClientCost === 'number' && (r.totalClientCost as number) > 0);
}

export interface ScopeTotals { total: number; count: number; avg: number | null; }
export function scopeTotals(rows: InsightsRow[]): ScopeTotals {
  const scopes = scopeRows(rows);
  const total = scopes.reduce((s, r) => s + (r.totalClientCost || 0), 0);
  return { total, count: scopes.length, avg: scopes.length ? total / scopes.length : null };
}

export interface ScopeInspectorRow {
  email: string; label: string;
  count: number; total: number; avg: number;
  scopes: { recordId: string; propertyAddress: string; cost: number; approverName: string | null; scheduledDate: string | null }[];
}

/** Avg total scope $ per inspector (mode A), highest average first. */
export function scopeCostByInspector(rows: InsightsRow[]): ScopeInspectorRow[] {
  const map = new Map<string, ScopeInspectorRow>();
  for (const r of scopeRows(rows)) {
    const email = (r.inspectorEmail || '').toLowerCase() || '(unknown)';
    let g = map.get(email);
    if (!g) { g = { email, label: r.inspectorName || r.inspectorEmail || '(unknown)', count: 0, total: 0, avg: 0, scopes: [] }; map.set(email, g); }
    g.count++; g.total += r.totalClientCost || 0;
    g.scopes.push({ recordId: r.recordId, propertyAddress: r.propertyAddress, cost: r.totalClientCost || 0, approverName: r.approverName, scheduledDate: r.scheduledDate });
  }
  const out = Array.from(map.values());
  for (const g of out) { g.avg = g.count ? g.total / g.count : 0; g.scopes.sort((a, b) => b.cost - a.cost); }
  return out.sort((a, b) => b.avg - a.avg);
}

/** Distinct scope categories present (for the mode-B category picker), by spend. */
export function scopeCategories(rows: InsightsRow[]): string[] {
  const totals = new Map<string, number>();
  for (const r of scopeRows(rows)) {
    for (const [cat, amt] of Object.entries(r.scopeCategoryCosts || {})) {
      totals.set(cat, (totals.get(cat) || 0) + (amt || 0));
    }
  }
  return Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

export interface ScopeApprovalRow {
  approver: string;
  count: number;          // scopes approved
  total: number;          // $ approved
  nte: number | null;     // this approver's not-to-exceed ceiling (if configured)
  overCount: number;      // # approvals over the NTE
  scopes: { recordId: string; propertyAddress: string; cost: number; over: boolean; scheduledDate: string | null }[];
}

/** Scopes approved per reviewer (count + $), flagging approvals over that
 *  approver's NTE ceiling. nte/overCount are null/0 until thresholds are set. */
export function scopeApprovalsByApprover(rows: InsightsRow[], nte: Record<string, number>): ScopeApprovalRow[] {
  const map = new Map<string, ScopeApprovalRow>();
  for (const r of scopeRows(rows)) {
    const approver = (r.approverName || '').trim();
    if (!approver) continue; // not yet approved → not an approval
    const limit = typeof nte[approver] === 'number' ? nte[approver] : null;
    const cost = r.totalClientCost || 0;
    const over = limit != null && cost > limit;
    let g = map.get(approver);
    if (!g) { g = { approver, count: 0, total: 0, nte: limit, overCount: 0, scopes: [] }; map.set(approver, g); }
    g.count++; g.total += cost; g.nte = limit;
    if (over) g.overCount++;
    g.scopes.push({ recordId: r.recordId, propertyAddress: r.propertyAddress, cost, over, scheduledDate: r.scheduledDate });
  }
  const out = Array.from(map.values());
  for (const g of out) g.scopes.sort((a, b) => b.cost - a.cost);
  // Over-NTE approvers first (most flags), then by $ approved.
  return out.sort((a, b) => (b.overCount - a.overCount) || (b.total - a.total));
}

export interface ScopeCategoryInspectorRow { email: string; label: string; count: number; total: number; avg: number; }

/** Avg cost of ONE category per inspector (mode B) — does someone scope e.g.
 *  cleaning higher than others? Averages over that inspector's scopes that
 *  include the category; highest average first. */
export function scopeCategoryCostByInspector(rows: InsightsRow[], category: string): ScopeCategoryInspectorRow[] {
  const map = new Map<string, ScopeCategoryInspectorRow>();
  for (const r of scopeRows(rows)) {
    const amt = (r.scopeCategoryCosts || {})[category];
    if (typeof amt !== 'number') continue;
    const email = (r.inspectorEmail || '').toLowerCase() || '(unknown)';
    let g = map.get(email);
    if (!g) { g = { email, label: r.inspectorName || r.inspectorEmail || '(unknown)', count: 0, total: 0, avg: 0 }; map.set(email, g); }
    g.count++; g.total += amt;
  }
  const out = Array.from(map.values());
  for (const g of out) g.avg = g.count ? g.total / g.count : 0;
  return out.sort((a, b) => b.avg - a.avg);
}

/** Distinct current property-status values present in the rows (for the rail). */
export function propertyStatusOptions(rows: InsightsRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) set.add(r.propertyStatus == null || r.propertyStatus === '' ? STATUS_NONE : r.propertyStatus);
  return Array.from(set).sort((a, b) => (a === STATUS_NONE ? 1 : b === STATUS_NONE ? -1 : a.localeCompare(b)));
}

/** Inspections grouped by current property status (count + completed), for the pivot card. */
export interface PropertyStatusGroup { status: string; total: number; completed: number; incomplete: number; }
export function inspectionsByPropertyStatus(rows: InsightsRow[]): PropertyStatusGroup[] {
  const map = new Map<string, PropertyStatusGroup>();
  for (const r of rows) {
    const status = r.propertyStatus == null || r.propertyStatus === '' ? STATUS_NONE : r.propertyStatus;
    let g = map.get(status);
    if (!g) { g = { status, total: 0, completed: 0, incomplete: 0 }; map.set(status, g); }
    g.total++;
    if (r.status === 'completed') g.completed++;
    else if (r.status === 'scheduled' || r.status === 'in_progress') g.incomplete++;
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

// ---- Filter-option discovery (for the rail) ----------------------------------

export interface InspectorOption { email: string; label: string; count: number; }

/** Distinct inspectors keyed by lowercased email; label = most frequent name. */
export function inspectorOptions(rows: InsightsRow[]): InspectorOption[] {
  // email -> { count, names: name->freq }
  const map = new Map<string, { count: number; names: Map<string, number> }>();
  for (const r of rows) {
    const email = (r.inspectorEmail || '').toLowerCase().trim();
    if (!email) continue;
    let e = map.get(email);
    if (!e) { e = { count: 0, names: new Map() }; map.set(email, e); }
    e.count++;
    const name = (r.inspectorName || '').trim();
    if (name) e.names.set(name, (e.names.get(name) || 0) + 1);
  }
  const out: InspectorOption[] = [];
  for (const [email, e] of map) {
    let best = '', bestN = 0;
    for (const [name, n] of e.names) { if (n > bestN) { bestN = n; best = name; } }
    out.push({ email, label: best || email, count: e.count });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** Distinct non-empty property addresses (sorted). */
export function propertyOptions(rows: InsightsRow[]): string[] {
  const s = new Set<string>();
  for (const r of rows) { const p = (r.propertyAddress || '').trim(); if (p) s.add(p); }
  return Array.from(s).sort((a, b) => a.localeCompare(b));
}

/** Distinct region values (null → REGION_NONE), sorted with "(none)" last. */
export function regionOptions(rows: InsightsRow[]): string[] {
  const s = new Set<string>();
  let hasNone = false;
  for (const r of rows) {
    if (r.region == null || r.region === '') hasNone = true;
    else s.add(r.region);
  }
  const out = Array.from(s).sort((a, b) => a.localeCompare(b));
  if (hasNone) out.push(REGION_NONE);
  return out;
}

/** Distinct templateType values present in the data (sorted). */
export function templateTypeOptions(rows: InsightsRow[]): string[] {
  const s = new Set<string>();
  for (const r of rows) { if (r.templateType) s.add(r.templateType); }
  return Array.from(s).sort((a, b) => a.localeCompare(b));
}

// ---- Duration helpers (return ms or null; never 0-substitute) ----------------

function diffMs(end: string | null, start: string | null): number | null {
  if (!end || !start) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Total turnaround for one row, or null if not a completed row with both dates. */
export function completionTimeMs(r: InsightsRow): number | null {
  if (r.status !== 'completed') return null;
  return diffMs(r.approvedAt || r.completedAt, r.scheduledDate);
}

/** Time-to-start: startedAt − scheduledDate (null if no startedAt). */
export function timeToStartMs(r: InsightsRow): number | null {
  return diffMs(r.startedAt, r.scheduledDate);
}

/** Time-to-finish: (approvedAt || completedAt) − startedAt. */
export function timeToFinishMs(r: InsightsRow): number | null {
  return diffMs(r.approvedAt || r.completedAt, r.startedAt);
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Average of a per-row duration getter over rows that HAVE the value. */
export function avgDuration(rows: InsightsRow[], get: (r: InsightsRow) => number | null): number | null {
  const vals: number[] = [];
  for (const r of rows) { const v = get(r); if (v != null) vals.push(v); }
  return mean(vals);
}

// ---- Pass / fail -------------------------------------------------------------

/** The pass/fail verdict for a row per the locked rules, or null if excluded. */
export function rowVerdict(r: InsightsRow): 'pass' | 'fail' | null {
  if (RESULT_VERDICT_TEMPLATES.has(r.templateType)) return r.inspectionResult ?? null;
  if (r.templateType === TEMPLATE_QC) return r.qcVerdict ?? null;
  return null; // Scope and everything else are excluded from pass/fail
}

export interface PassFail { pass: number; fail: number; total: number; rate: number | null; }

/** Pass/fail tally over the rows that carry a verdict. rate = pass / (pass+fail). */
export function passFail(rows: InsightsRow[]): PassFail {
  let pass = 0, fail = 0;
  for (const r of rows) {
    const v = rowVerdict(r);
    if (v === 'pass') pass++;
    else if (v === 'fail') fail++;
  }
  const total = pass + fail;
  return { pass, fail, total, rate: total ? pass / total : null };
}

// ---- KPI summary -------------------------------------------------------------

export interface Kpis {
  completed: number;
  incomplete: number;       // scheduled + in_progress
  passRate: number | null;  // 0..1
  passFail: PassFail;
  avgCompletionMs: number | null;
  avgTimeToStartMs: number | null;
  avgTimeToFinishMs: number | null;
  avgPhotos: number | null;
  totalPhotos: number;
  scopeTotalClientCost: number; // sum of totalClientCost for Scope Rate Card rows
  // On-time = share of COMPLETED inspections whose total turnaround
  // ((approvedAt||completedAt) − scheduledDate) is ≤ 24h. Denominator is
  // completed rows that have a measurable turnaround (both dates); null if none.
  onTimeRate: number | null;
}

/** Turnaround SLA threshold for the on-time gauge: 24 hours in ms. */
export const ON_TIME_MS = 24 * 60 * 60 * 1000;

export function computeKpis(rows: InsightsRow[]): Kpis {
  let completed = 0, incomplete = 0, totalPhotos = 0, photoRows = 0, scopeCost = 0;
  let onTimeDenom = 0, onTimeNum = 0;
  for (const r of rows) {
    if (r.status === 'completed') completed++;
    if (r.status === 'scheduled' || r.status === 'in_progress') incomplete++;
    if (typeof r.totalPhotos === 'number') { totalPhotos += r.totalPhotos; photoRows++; }
    if (r.templateType === TEMPLATE_SCOPE && typeof r.totalClientCost === 'number') {
      scopeCost += r.totalClientCost;
    }
    const turn = completionTimeMs(r); // null unless completed with both dates
    if (turn != null) { onTimeDenom++; if (turn <= ON_TIME_MS) onTimeNum++; }
  }
  const pf = passFail(rows);
  return {
    completed,
    incomplete,
    passRate: pf.rate,
    passFail: pf,
    avgCompletionMs: avgDuration(rows, completionTimeMs),
    avgTimeToStartMs: avgDuration(rows, timeToStartMs),
    avgTimeToFinishMs: avgDuration(rows, timeToFinishMs),
    avgPhotos: photoRows ? totalPhotos / photoRows : null,
    totalPhotos,
    scopeTotalClientCost: scopeCost,
    onTimeRate: onTimeDenom ? onTimeNum / onTimeDenom : null,
  };
}

// ---- Grouped pass/fail (for the stacked-bar card) ----------------------------

export type GroupBy = 'inspector' | 'type' | 'region';

export interface GroupedPassFail { key: string; label: string; pass: number; fail: number; total: number; }

/** Pass/fail grouped by inspector (email-keyed), template type, or region. */
export function passFailByGroup(rows: InsightsRow[], by: GroupBy): GroupedPassFail[] {
  // Pre-compute inspector labels once so the email→name mapping is consistent.
  const inspLabels = new Map<string, string>();
  if (by === 'inspector') for (const o of inspectorOptions(rows)) inspLabels.set(o.email, o.label);

  const map = new Map<string, GroupedPassFail>();
  for (const r of rows) {
    const v = rowVerdict(r);
    if (v == null) continue; // only verdict-bearing rows count
    let key: string, label: string;
    if (by === 'inspector') {
      key = (r.inspectorEmail || '').toLowerCase().trim() || '(unknown)';
      label = inspLabels.get(key) || key;
    } else if (by === 'type') {
      key = r.templateType; label = r.templateType; // caller maps to templateLabel
    } else {
      key = r.region == null || r.region === '' ? REGION_NONE : r.region; label = key;
    }
    let g = map.get(key);
    if (!g) { g = { key, label, pass: 0, fail: 0, total: 0 }; map.set(key, g); }
    if (v === 'pass') g.pass++; else g.fail++;
    g.total++;
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

// ---- Inspector roster (keyed by email) ---------------------------------------

export interface InspectorRow {
  email: string;
  label: string;
  count: number;            // # inspections (all statuses, after filters)
  incomplete: number;       // scheduled + in_progress
  avgTurnaroundMs: number | null;  // (approved||completed) − scheduledDate, completed rows
  avgWorkMs: number | null;        // (approved||completed) − startedAt, active work
  avgPhotos: number | null;
  totalPhotos: number;
}

/** One row per inspector (email-keyed), label = most-frequent name. */
export function inspectorRoster(rows: InsightsRow[]): InspectorRow[] {
  const labels = new Map<string, string>();
  for (const o of inspectorOptions(rows)) labels.set(o.email, o.label);

  const groups = new Map<string, InsightsRow[]>();
  for (const r of rows) {
    const email = (r.inspectorEmail || '').toLowerCase().trim() || '(unknown)';
    let arr = groups.get(email);
    if (!arr) { arr = []; groups.set(email, arr); }
    arr.push(r);
  }

  const out: InspectorRow[] = [];
  for (const [email, rs] of groups) {
    let incomplete = 0, totalPhotos = 0, photoRows = 0;
    for (const r of rs) {
      if (r.status === 'scheduled' || r.status === 'in_progress') incomplete++;
      if (typeof r.totalPhotos === 'number') { totalPhotos += r.totalPhotos; photoRows++; }
    }
    out.push({
      email,
      label: labels.get(email) || email,
      count: rs.length,
      incomplete,
      avgTurnaroundMs: avgDuration(rs, completionTimeMs),
      avgWorkMs: avgDuration(rs, timeToFinishMs),
      avgPhotos: photoRows ? totalPhotos / photoRows : null,
      totalPhotos,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

// ---- Completed-inspections table ---------------------------------------------

export interface CompletedRow {
  recordId: string;
  inspectorLabel: string;
  inspectorEmail: string;
  date: string | null;       // best completion date (approved → completed → submitted)
  templateType: string;
  status: StatusBucket;
  statusLabel: string;
  reportUrl: string | null;
  propertyAddress: string;
}

/** Rows for the completed-inspections table (status === completed), newest first. */
export function completedRows(rows: InsightsRow[]): CompletedRow[] {
  const labels = new Map<string, string>();
  for (const o of inspectorOptions(rows)) labels.set(o.email, o.label);

  const out: CompletedRow[] = [];
  for (const r of rows) {
    if (r.status !== 'completed') continue;
    const email = (r.inspectorEmail || '').toLowerCase().trim();
    out.push({
      recordId: r.recordId,
      inspectorLabel: labels.get(email) || r.inspectorName || email || '—',
      inspectorEmail: r.inspectorEmail || '',
      date: r.approvedAt || r.completedAt || r.submittedAt || null,
      templateType: r.templateType,
      status: r.status,
      statusLabel: r.statusLabel,
      reportUrl: r.reportUrl,
      propertyAddress: r.propertyAddress || '',
    });
  }
  return out.sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return db - da;
  });
}

// ---- History-derived trend + deltas ------------------------------------------

export interface TrendPoint { date: string; completed: number; avgTurnaroundMs: number | null; }

export function trendSeries(history: InsightsDailyRollup[]): TrendPoint[] {
  return history.map((h) => ({
    date: h.date, completed: h.completed, avgTurnaroundMs: h.avgTurnaroundMs,
  }));
}

export interface Delta { current: number; previous: number; diff: number; pct: number | null; }

/**
 * "vs previous period" delta over the history series: compare the last value to
 * the second-to-last. Returns null when there aren't >=2 days. `get` pulls the
 * metric off a rollup; rollups where it's null are skipped.
 */
export function periodDelta(
  history: InsightsDailyRollup[],
  get: (h: InsightsDailyRollup) => number | null,
): Delta | null {
  const pts: number[] = [];
  for (const h of history) { const v = get(h); if (v != null) pts.push(v); }
  if (pts.length < 2) return null;
  const current = pts[pts.length - 1];
  const previous = pts[pts.length - 2];
  const diff = current - previous;
  const pct = previous !== 0 ? diff / previous : null;
  return { current, previous, diff, pct };
}

/** Sparkline value series for a KPI, derived from history. */
export function sparkValues(history: InsightsDailyRollup[], get: (h: InsightsDailyRollup) => number | null): number[] {
  const out: number[] = [];
  for (const h of history) { const v = get(h); if (v != null) out.push(v); }
  return out;
}

/** Pass-rate per rollup (0..1) or null when no verdicts that day. */
export function rollupPassRate(h: InsightsDailyRollup): number | null {
  const total = h.passCount + h.failCount;
  return total ? h.passCount / total : null;
}

// ---- Formatting (shared by the cards) ----------------------------------------

/** Human duration from ms: "2d 4h", "5h 12m", "43m", "—" for null. */
export function fmtDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return '<1m';
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtPct(rate: number | null, digits = 0): string {
  if (rate == null || !Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(digits)}%`;
}

export function fmtNumber(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

export function fmtCurrency(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

/** Localized date for table cells; "—" for null/unparseable. */
export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString();
}
