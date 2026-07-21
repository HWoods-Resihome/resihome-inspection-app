/**
 * ResiWalk - Services — Phase 3b generation engine (v1, manual dry-run/apply).
 *
 * Reads the persisted Service Rules Engine records and materialises the work
 * orders they call for as real `service_work_order` records in HubSpot. This is
 * the bridge from a rule ("cut the grass at every vacant Amherst property every
 * two weeks") to the individual Service Work Orders that field crews see.
 *
 * v1 is intentionally conservative and fully reviewable — it runs ONLY when an
 * admin hits the endpoint (no unattended cron yet), and every run defaults to a
 * dry-run that reports exactly what it *would* create. Apply is idempotent:
 * each (rule, target) pair carries a stable `enrollment_key = gen:<ruleId>:<target>`,
 * and a new order is only created when there is no OPEN (non-terminal) order for
 * that pair. So a recurring rule holds a single live order per target at a time;
 * the next one is generated after the current is completed or canceled.
 *
 * Targets come from live CRM data: property targets are Property records in the
 * rule's portfolios/regions filtered by its enrollment criteria (Property Status /
 * RRQC), combined with the rule's AND/OR; community targets are the rule's own
 * communities. Enrollment + stop conditions are evaluated against the CRM; due dates
 * follow the active cadence (else First Order Due, else +5); vendors are assigned by
 * equal-volume rotation with sticky-per-address (see ./rotation).
 */
import { searchServiceRuleRecords, readServiceWorkOrderKeys, createServiceWorkOrder, searchPropertiesForCoverage, listServiceCommunities, fetchCommunityProperties, fetchApprovedVendorCompanies, fetchPropertyLeasingDealStages, isTenantServicedPool, readGenEnrollSeen, writeGenEnrollSeen } from '@/lib/hubspot';
import { resolveCoords } from '@/lib/geocodeResolve';
import { WORKTYPES, type Worktype } from './worktypes';
import { DEFAULT_GRASS_TIERS } from './grassPricing';
import { buildRotationState, pickVendor } from './rotation';
import { notifyServiceAssigned } from '@/lib/notifications/triggers';
import { appBaseUrl } from '@/lib/notifications/send';

const parseArr = (s: any): any[] => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
// enroll_value: one plain string, or a JSON array when the operator is "is any of".
const parseVals = (s: any): string[] => {
  const raw = (s ?? '').toString();
  if (!raw) return [];
  if (raw.startsWith('[')) { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : [raw]; } catch { return [raw]; } }
  return [raw];
};
const OPEN_STATUSES = new Set(['estimated', 'assigned', 'submitted', 'review']);

const wtLabel = (id: string) => WORKTYPES.find((w) => w.id === id)?.label || id;
const subLabel = (wt: string, id: string) =>
  WORKTYPES.find((w) => w.id === wt)?.subtypes.find((s) => s.id === id)?.label || id;

/** Add N days to a YYYY-MM-DD date (UTC), returning YYYY-MM-DD. */
// Enrollment criteria (AND-combined). Parsed from the rule's enroll_criteria_json,
// falling back to the legacy single enroll_field/op/value.
interface Criterion { field: string; op: string; vals: string[] }
function parseCriteria(p: Record<string, any>): Criterion[] {
  try {
    const arr = JSON.parse(p.enroll_criteria_json || '[]');
    if (Array.isArray(arr) && arr.length) return arr.map((c: any) => ({ field: String(c.field || ''), op: String(c.op || 'is'), vals: Array.isArray(c.vals) ? c.vals.map(String) : [] }));
  } catch { /* fall through to legacy */ }
  const f = String(p.enroll_field || '');
  return f ? [{ field: f, op: String(p.enroll_op || 'is'), vals: parseVals(p.enroll_value) }] : [];
}
interface EvalProp { rrqcPassDate: string; status: string; dealStages?: string[]; poolFee?: number; poolServicer?: string; landscapingFee?: number }
// A property's leasing deals + their current stage id (for per-deal enrollment).
interface DealEntry { dealId: string; stage: string }
// Negating operators — the value set is a membership test, and these invert it.
// "is not" (single) and "is not any of" (multi) both exclude the listed values.
function isNegatingOp(op: string): boolean {
  return op === 'is not' || op === 'is not any of';
}

function matchCriterion(prop: EvalProp, c: Criterion): boolean {
  const field = c.field.toLowerCase();
  if (/rrqc/.test(field)) return c.op === 'is known' ? !!prop.rrqcPassDate : true;
  // Pool Fee > $0 — enrolls homes that carry a pool fee (a pool we service).
  if (/pool\s*fee/.test(field)) return (prop.poolFee ?? 0) > 0;
  // Landscaping Fee > $0 — enrolls homes that carry a landscaping fee.
  if (/landscap.*fee/.test(field)) return (prop.landscapingFee ?? 0) > 0;
  // Deal Stage — the property's associated leasing deal(s) current stage id(s).
  // vals hold stage ids; membership match, negated for "is not"/"is not any of".
  if (/deal/.test(field)) {
    const stages = prop.dealStages || [];
    const vals = c.vals.map((v) => v.trim()).filter(Boolean);
    if (!vals.length) return true;
    const hit = vals.some((v) => stages.includes(v));
    return isNegatingOp(c.op) ? !hit : hit;
  }
  if (/status/.test(field)) {
    const s = (prop.status || '').toLowerCase();
    const vals = c.vals.map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (!vals.length) return true;
    const hit = vals.some((v) => s === v || s.startsWith(v) || s.includes(v));
    return isNegatingOp(c.op) ? !hit : hit;
  }
  return true; // fields we can't evaluate here → best-effort include
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Cadence date math ─────────────────────────────────────────────────────────
const monthOf = (iso: string): number => Number(iso.slice(5, 7)) - 1;
// Day of week with MONDAY = 0 … SUNDAY = 6 (matches the rules UI's DOW array).
const dowMon0 = (iso: string): number => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
const daysInMonth = (y: number, m0: number): number => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
/** Next date on/after `iso` whose weekday (Mon=0) equals `dow`. */
function nextDowOnOrAfter(iso: string, dow: number): string {
  let d = iso;
  for (let i = 0; i < 7; i++) { if (dowMon0(d) === dow) return d; d = addDays(d, 1); }
  return iso;
}
/** Add `months` calendar months to `iso`, landing on day `dom` (0 = keep the same
 *  day-of-month), clamped to the target month's length (so day 31 → Feb 28/29). */
function addMonthsClampDom(iso: string, months: number, dom: number): string {
  const y = Number(iso.slice(0, 4)); const m0 = Number(iso.slice(5, 7)) - 1; const d = Number(iso.slice(8, 10));
  const t = m0 + months; const ny = y + Math.floor(t / 12); const nm = ((t % 12) + 12) % 12;
  const day = Math.min(dom > 0 ? dom : d, daysInMonth(ny, nm));
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
/** Next occurrence of day-of-month `dom` on/after `iso`. */
function nextDomOnOrAfter(iso: string, dom: number): string {
  const same = addMonthsClampDom(iso, 0, dom);
  return same >= iso ? same : addMonthsClampDom(iso, 1, dom);
}
/** Normalise any stored date/datetime (YYYY-MM-DD, ISO, or epoch-ms) to YYYY-MM-DD. */
function dateOnly(s: string): string {
  const raw = (s || '').trim(); if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(/^\d+$/.test(raw) ? Number(raw) : raw);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
const maxISO = (a: string, b: string): string => (!a ? b : !b ? a : a >= b ? a : b);

// ── Cadence model ─────────────────────────────────────────────────────────────
// A rule's cadence: "every N days" (unit days/weeks, dow = weekday anchor seed) or
// "monthly on day X" (unit months, dom = day-of-month). Legacy weekly cadences
// (unit 'weeks') are read as N×7 days. Each cadence owns a set of months.
type CUnit = 'days' | 'weeks' | 'months';
interface Cad { unit: CUnit; interval: number; dow: number; dom: number; months: number[] }
function parseCadences(p: Record<string, any>): Cad[] {
  return parseArr(p.cadences_json).map((c: any) => ({
    unit: (c.unit === 'days' || c.unit === 'months') ? c.unit : 'weeks',
    interval: Math.max(1, Number(c.interval) || 1),
    dow: Number(c.dow ?? -1), dom: Number(c.dom ?? 0),
    months: Array.isArray(c.months) ? c.months.map(Number) : [],
  }));
}
const isMonthly = (c: Cad): boolean => c.unit === 'months';
const intervalDaysOf = (c: Cad): number => (c.unit === 'weeks' ? c.interval * 7 : c.interval);
const cadenceForMonth = (cads: Cad[], monthIdx: number): Cad | null =>
  cads.find((c) => c.months.includes(monthIdx)) || cads[0] || null;
/** One cadence step from `iso` (dir +1 forward, -1 back). Monthly steps by calendar
 *  month on the cadence's day; day/week cadences step by whole days. */
function stepDate(iso: string, c: Cad, dir: 1 | -1): string {
  return isMonthly(c) ? addMonthsClampDom(iso, dir * c.interval, c.dom) : addDays(iso, dir * intervalDaysOf(c));
}
/** A month is generatable if some cadence covers it AND it isn't a skip month. */
const isActiveMonth = (monthIdx: number, cads: Cad[], skip: Set<number>): boolean =>
  cads.some((c) => c.months.includes(monthIdx)) && !skip.has(monthIdx);
/** Roll a candidate due date forward whole cadence steps until it lands in an
 *  active month (skip-months respected by the DUE date's month). Returns null if
 *  no active month is reachable within a year (e.g. every month skipped). */
function rollToActiveDue(iso: string, cads: Cad[], skip: Set<number>): { due: string; rolled: boolean } | null {
  let due = iso; let rolled = false;
  for (let i = 0; i < 24; i++) {
    if (isActiveMonth(monthOf(due), cads, skip)) return { due, rolled };
    const c = cadenceForMonth(cads, monthOf(due)); if (!c) return null;
    due = stepDate(due, c, 1); rolled = true;
  }
  return null;
}
/** First-order due date for a fresh enrollment: the "first order due earlier"
 *  window if set, else the cadence's weekday / day-of-month anchor, else one step
 *  out — then rolled into an active month. */
function seedFirstDue(p: Record<string, any>, cads: Cad[], todayISO: string, skip: Set<number>): { due: string; rolled: boolean } | null {
  const start = String(p.start_date || '').trim();
  const base = start && start > todayISO ? start : todayISO;
  const initial = Number(p.initial_due_days);
  const c0 = cadenceForMonth(cads, monthOf(base));
  let due: string;
  if (Number.isFinite(initial) && initial > 0) due = addDays(base, initial);
  else if (c0 && isMonthly(c0)) due = nextDomOnOrAfter(base, c0.dom > 0 ? c0.dom : Number(base.slice(8, 10)));
  else if (c0 && c0.dow >= 0) due = nextDowOnOrAfter(base, c0.dow);
  else if (c0) due = stepDate(base, c0, 1);
  else due = addDays(base, 7);
  return rollToActiveDue(due, cads, skip);
}

interface Target { id: string; scope: 'property' | 'community'; address: string; locality: string; region: string; community?: string;
  // Set only for a one-time, deal-triggered rule: the specific leasing deal whose
  // stage triggered enrollment. Folded into the enrollment key so each new deal
  // (new lease) re-triggers while the same deal sitting in the stage does not. */
  dealId?: string;
}

/**
 * Resolve the concrete targets a rule applies to, against LIVE data:
 *  - community scope → one target per selected community (community-level service);
 *  - property scope → every real Property in the selected portfolios/regions,
 *    filtered by the rule's enrollment condition (best-effort: when the enroll
 *    field looks like status and op is is/is-any-of, keep only properties whose
 *    status matches the enroll value, exact or prefix — e.g. "Vacant" → "Vacant - *").
 *    'list' mode restricts to the explicitly included property ids.
 */
async function targetsForRule(p: Record<string, any>): Promise<Target[]> {
  const scope = p.scope === 'community' ? 'community' : 'property';
  if (scope === 'community') {
    return parseArr(p.communities_json).map((name: string) => ({
      id: name, scope: 'community' as const, address: name, locality: '', region: '', community: name,
    }));
  }
  const portfolios = parseArr(p.portfolios_json);
  if (!portfolios.length) return [];
  const regions = parseArr(p.regions_json);
  const props = await searchPropertiesForCoverage({ portfolios, regions, limit: 2000 });

  // ── Enrollment: evaluate ALL criteria with the section combinator (AND/OR). ──
  // Only criteria we can evaluate here (Property Status, RRQC Pass Date) count;
  // if none are evaluable the property is included (best-effort). A criterion with
  // no value is skipped so an empty row can't block/allow everything.
  const enrollCombinator = p.enroll_combinator === 'or' ? 'or' : 'and';
  const enrollCriteria = parseCriteria(p).filter(isEvaluableCriterion);
  const enrollOk = (prop: EvalProp): boolean => {
    if (!enrollCriteria.length) return true;
    const results = enrollCriteria.map((c) => matchCriterion(prop, c));
    return enrollCombinator === 'or' ? results.some(Boolean) : results.every(Boolean);
  };

  // ── Stop (condition mode): multi-criteria + combinator. A property whose CURRENT
  // state meets the stop condition is dropped from generation — e.g. "stop when
  // Property Status is Occupied" halts new cuts the moment the home is occupied.
  // Date + count stop modes are enforced at the rule/loop level (not here).
  const stopEnabled = p.stop_enabled === 'true';
  const stopIsCondition = (p.stop_mode || 'condition') === 'condition';
  const stopCombinator = p.stop_combinator === 'or' ? 'or' : 'and';
  const stopCriteria = parseStopCriteria(p).filter(isEvaluableCriterion);
  const stopHit = (prop: EvalProp): boolean => {
    if (!stopEnabled || !stopIsCondition || !stopCriteria.length) return false;
    const results = stopCriteria.map((c) => matchCriterion(prop, c));
    return stopCombinator === 'or' ? results.some(Boolean) : results.every(Boolean);
  };

  const included = new Set(parseArr(p.included_props_json).map(String));
  const listMode = p.props_mode === 'list';
  const candidates = props.filter((prop) => !listMode || included.has(prop.id));

  // Deal Stage criteria (enroll or stop) → resolve each candidate's current
  // leasing deal(s) + stage via Property→Listing→Deal (only when actually used).
  const hasDealCrit = [...enrollCriteria, ...stopCriteria].some((c) => /deal/.test((c.field || '').toLowerCase()));
  const dealMap = hasDealCrit
    ? await fetchPropertyLeasingDealStages(candidates.map((c) => c.id)).catch(() => new Map<string, Map<string, string>>())
    : new Map<string, Map<string, string>>();
  const enrich = (prop: typeof candidates[number]): EvalProp & typeof candidates[number] & { dealEntries: DealEntry[] } => {
    const deals = dealMap.get(prop.id) || new Map<string, string>();
    return { ...prop, dealStages: [...new Set(deals.values())], dealEntries: [...deals].map(([dealId, stage]) => ({ dealId, stage })) };
  };

  // Per-deal enrollment: a ONE-TIME rule with a POSITIVE deal-stage ENROLL
  // criterion enrolls once PER triggering DEAL (so a new lease re-triggers). The
  // trigger stages are the positive deal criteria's values.
  const oneTime = p.recurring === 'false';
  const dealTriggerStages = new Set<string>(
    enrollCriteria
      .filter((c) => /deal/.test((c.field || '').toLowerCase()) && !isNegatingOp(c.op))
      .flatMap((c) => c.vals.map((v) => v.trim()).filter(Boolean)),
  );
  const perDeal = oneTime && dealTriggerStages.size > 0;

  // Pools worktype exception list: a pool whose pool_servicer is "Tenant Service"
  // is held out of new pool orders (the tenant handles it). HubSpot owns the
  // lifecycle of that field — a workflow flips it back to ResiHome when the home
  // leaves Tenant Leased — so ResiWalk simply honors the CURRENT value here.
  const isPools = String(p.worktype || '') === 'pools';
  const poolHeldOut = (prop: EvalProp): boolean =>
    isPools && isTenantServicedPool(prop.poolServicer);

  const enrolled = candidates
    .map(enrich)
    .filter((prop) => enrollOk(prop))
    .filter((prop) => !stopHit(prop))    // stop condition met → exclude
    .filter((prop) => !poolHeldOut(prop));   // Tenant-Service pool → excluded

  const out: Target[] = [];
  for (const prop of enrolled) {
    const propBase = { id: prop.id, scope: 'property' as const, address: prop.address, locality: prop.locality, region: prop.region };
    if (perDeal) {
      // One target per deal currently sitting in a trigger stage. (enrollOk already
      // guaranteed ≥1 matches unless the property enrolled via an OR of non-deal
      // criteria — then fall back to a single property-level target.)
      const triggering = prop.dealEntries.filter((d) => dealTriggerStages.has(d.stage));
      if (triggering.length) {
        for (const d of triggering) out.push({ ...propBase, dealId: d.dealId });
        continue;
      }
    }
    out.push(propBase);
  }
  return out;
}

// A criterion is evaluable at generation time only for the fields we can read on
// a property (Property Status, RRQC Pass Date). Others (and empty-value rows) are
// skipped so they neither block (AND) nor satisfy (OR) the combined result.
function isEvaluableCriterion(c: Criterion): boolean {
  const f = (c.field || '').toLowerCase();
  if (/rrqc/.test(f)) return c.op === 'is known'; // only "is known" is evaluable for the date field
  if (/pool\s*fee/.test(f)) return true;          // "is greater than $0" — self-contained gate
  if (/landscap.*fee/.test(f)) return true;       // "is greater than $0" — self-contained gate
  if (/deal/.test(f)) return c.vals.some((v) => v.trim() !== '');
  if (/status/.test(f)) return c.vals.some((v) => v.trim() !== '');
  return false;
}

// Stop criteria: prefer the JSON array (multi + combinator), fall back to the
// legacy single stop_field/op/value triple.
function parseStopCriteria(p: Record<string, any>): Criterion[] {
  try {
    const arr = JSON.parse(p.stop_criteria_json || '[]');
    if (Array.isArray(arr) && arr.length) {
      return arr.map((c: any) => ({ field: String(c.field || ''), op: String(c.op || 'is'), vals: Array.isArray(c.vals) ? c.vals.map(String) : (c.val != null ? [String(c.val)] : []) }));
    }
  } catch { /* fall through */ }
  const f = String(p.stop_field || '');
  return f ? [{ field: f, op: String(p.stop_op || 'is'), vals: parseVals(p.stop_value) }] : [];
}

export interface GenerateResult {
  mode: 'dry-run' | 'apply';
  today: string;
  configured: boolean;
  rulesActive: number;
  rulesSkipped: number;
  wouldCreate: number;
  created: number;
  skippedExisting: number;
  errors: number;
  items: {
    ruleId: string; ruleName: string; target: string; worktype: string; subtype: string;
    dueDate: string; vendor: string | null; enrollmentKey: string;
    action: 'CREATE' | 'created' | 'skip-open' | 'error'; recordId?: string; error?: string;
  }[];
  notes: string[];
  // Community contracts that have ≥3 open orders of the same type stacked up (the
  // vendor is behind). Surfaced to Admin ▸ Error Log by the nightly cron.
  communityBacklogAlerts: string[];
  // For a single community grass-cut rule: how many properties the master covers.
  masterCoverage?: number;
}

/**
 * Compute (and, when apply, create) the Service Work Orders the active rules call
 * for. Returns null when the Service Work Order object isn't configured yet.
 */
export async function runServiceGeneration(
  apply: boolean, todayISO: string, onlyRuleId?: string,
  // PREVIEW: dry-run the rule as the admin has it CONFIGURED RIGHT NOW (unsaved
  // edits), without persisting. When provided these props replace the matching
  // persisted rule (or stand in as a synthetic rule when it's brand-new). Only
  // honored in dry-run — an apply must go through the saved record.
  overrideProps?: Record<string, any>,
): Promise<GenerateResult | null> {
  const allRules = await searchServiceRuleRecords();
  const existing = await readServiceWorkOrderKeys();
  if (allRules === null || existing === null) return null; // objects not configured
  // Ad-hoc: run a single rule (the "generate missing now" button) vs. the whole
  // set (nightly). Either way the enrollment-key dedup below prevents duplicates.
  let rules = onlyRuleId ? allRules.filter((r) => r.id === onlyRuleId) : allRules;
  if (!apply && overrideProps && onlyRuleId) {
    const base = allRules.find((r) => r.id === onlyRuleId);
    rules = [{ id: onlyRuleId, props: { ...(base?.props || {}), ...overrideProps } }];
  }

  // Enrollment keys with a currently-open (non-terminal) order — dedup set.
  const openKeys = new Set(existing.filter((e) => OPEN_STATUSES.has(e.status)).map((e) => e.key).filter(Boolean));
  // Every key EVER generated (any status) — community date-keyed dedup across runs.
  const everKeys = new Set(existing.map((e) => e.key).filter(Boolean));
  // Total orders EVER generated per enrollment key (all statuses) — powers the
  // "stop after N services" cap ("all generated" counting basis).
  const genCountByKey = new Map<string, number>();
  for (const e of existing) if (e.key) genCountByKey.set(e.key, (genCountByKey.get(e.key) || 0) + 1);
  // Enroll-delay ("start N days after it meets the criteria") markers: enrollment
  // base key → YYYY-MM-DD it first met the criteria. Read once; marked/pruned as we
  // go (a key that stops qualifying is deleted so the clock resets); written back
  // at the end on apply. Prunes/marks in a dry-run stay in memory only.
  const enrollSeen: Record<string, string> = { ...((await readGenEnrollSeen()) || {}) };
  let enrollSeenDirty = false;

  // Most-recent CLOSED (terminal) order per key — the property self-healing anchor.
  // "Latest" by service date (submitted → completed → due). Only non-open statuses.
  const closedByKey = new Map<string, typeof existing[number]>();
  const closedAnchor = (o: typeof existing[number]) => dateOnly(o.serviceCompletedDate) || dateOnly(o.submittedAt) || dateOnly(o.completedAt) || dateOnly(o.dueDate);
  for (const e of existing) {
    if (!e.key || OPEN_STATUSES.has(e.status)) continue;
    const cur = closedByKey.get(e.key);
    if (!cur || closedAnchor(e) > closedAnchor(cur)) closedByKey.set(e.key, e);
  }

  // Vendor rotation state (equal-volume balance + sticky-per-address, §10.18).
  // Built from every existing order's key/status/vendor; pickVendor reserves each
  // assignment so multiple net-new enrollments in one run stay balanced.
  const rotation = buildRotationState(existing, (s) => OPEN_STATUSES.has(s));

  // Community NAME → HubSpot id, resolved lazily (community grass-cut masters need
  // the id to look up their properties). Cached for the run.
  let _commIdMap: Map<string, string> | null = null;
  const communityIdByName = async (name: string): Promise<string> => {
    if (!_commIdMap) _commIdMap = new Map((await listServiceCommunities().catch(() => null) || []).map((c) => [c.name, c.id]));
    return _commIdMap.get(name) || '';
  };

  // Assigned-vendor emails, collected across all creates and awaited at the end
  // (only on apply — a dry-run creates nothing). appBaseUrl() with no request
  // uses APP_PUBLIC_URL (this runs in the nightly cron).
  // Deferred as THUNKS (not started promises) so the sends run through a
  // concurrency cap at the end — a big run creating N orders must not fire N
  // simultaneous Gmail sends (rate limits) all at once.
  const notifyThunks: (() => Promise<void>)[] = [];
  const notifyBase = appBaseUrl();

  // Resolve an assigned vendor's notification email from the live approved
  // Companies list (the `email` field), falling back to the interim registry.
  // Built once per run and stamped onto each order (drives scoping + emails).
  let _vendorEmailByName: Map<string, string> | null = null;
  const resolveVendorEmail = async (name: string | null | undefined): Promise<string> => {
    const n = String(name || '').trim();
    if (!n) return '';
    if (!_vendorEmailByName) {
      const companies = await fetchApprovedVendorCompanies().catch(() => []);
      _vendorEmailByName = new Map(companies.map((c) => [c.name.trim().toLowerCase(), c.email]));
    }
    return _vendorEmailByName.get(n.toLowerCase()) || '';
  };

  const result: GenerateResult = {
    mode: apply ? 'apply' : 'dry-run', today: todayISO, configured: true,
    rulesActive: 0, rulesSkipped: 0, wouldCreate: 0, created: 0, skippedExisting: 0, errors: 0,
    items: [], communityBacklogAlerts: [], notes: [
      'Property targets: live Property records in the rule’s portfolios/regions, filtered by the enrollment criteria (Property Status / RRQC), combined with the rule’s AND/OR. Community targets: one per selected community.',
      'Property (self-healing): one open order per property. The next is created immediately after the current closes, due = max(scheduled due, service-completion date) + one cadence step — a late finish re-anchors the rhythm to when the work was actually done.',
      'Community (contract calendar): occurrences generate on a fixed schedule regardless of completion — the day after each due date mints the next (due = prior due + a step), so open orders can stack. ≥3 open of the same type raises a backlog alert.',
      'Cadence is “every N days” (weekday anchor seeds the first order) or “monthly on day X”. Skip months are respected by the DUE date’s month; a due rolled across a skip month isn’t created until within one step of it. First Order Due lets the first one land earlier.',
      'Vendor rotation: an address keeps its vendor for the enrollment’s life (sticky); net-new enrollments balance toward the rule vendor with the lowest open volume, ties by vendor order.',
    ],
  };

  for (const { id: ruleId, props: p } of rules) {
    if (p.active !== 'true') { result.rulesSkipped++; continue; }
    // Rule-level START DATE: the rule stays dormant (creates nothing) until this
    // calendar date. YYYY-MM-DD strings compare lexicographically.
    const startDate = String(p.start_date || '').trim();
    if (startDate && todayISO < startDate) { result.rulesSkipped++; continue; }
    // Stop DATE mode: once the date is reached the rule stops generating entirely.
    const stopEnabled = p.stop_enabled === 'true';
    const stopMode = String(p.stop_mode || 'condition');
    if (stopEnabled && stopMode === 'date') {
      const sd = String(p.stop_date || '').trim();
      if (sd && todayISO >= sd) { result.rulesSkipped++; continue; }
    }
    // Stop COUNT mode: per target, once N orders have been generated (all statuses),
    // stop making more.
    const stopCountMode = stopEnabled && stopMode === 'count';
    const stopCount = Number(p.stop_count);
    result.rulesActive++;

    // One-time (non-recurring) rule — e.g. a deal-stage-triggered move-in clean:
    // generate EXACTLY ONE order per target for the life of the rule, never
    // regenerating after it completes (recurring rules DO regenerate the next
    // occurrence once the current one closes).
    const recurring = p.recurring !== 'false';
    const scope = p.scope === 'community' ? 'community' : 'property';
    const worktype = (p.worktype || 'landscaping') as Worktype;
    const subtype = p.subtype || '';
    const vendors = parseArr(p.vendors_json).map(String);
    const vendorCost = Number(p.vendor_cost);
    const markupPct = Number(p.markup_pct);
    const clientCost = Number.isFinite(vendorCost) ? Math.round(vendorCost * (1 + (Number.isFinite(markupPct) ? markupPct : 0) / 100) * 100) / 100 : null;
    const cads = parseCadences(p);
    const skipSet = new Set<number>(parseArr(p.skip_months_json).map(Number));
    const ruleName = p.rule_name || 'Rule';

    // Create (or, in dry-run, preview) one Service Work Order for a target on a
    // given due date. Shared by the one-time, property-recurring, and
    // community-recurring paths — all the order-building / master-cut / pricing /
    // geocode / notify logic lives here so the three schedulers only decide WHEN
    // and WITH WHAT due date to call it.
    const emitOrder = async (t: Target, dueDate: string, enrollmentKey: string): Promise<void> => {
      const base: {
        ruleId: string; ruleName: string; target: string; worktype: string; subtype: string;
        dueDate: string; vendor: string | null; enrollmentKey: string;
      } = { ruleId, ruleName, target: t.address, worktype, subtype, dueDate, vendor: rotation.stickyByKey.get(enrollmentKey) ?? null, enrollmentKey };

      // Community + Landscaping + Grass Cut = a MASTER of individual house cuts.
      const isCommunityCut = t.scope === 'community' && worktype === 'landscaping' && subtype === 'cut';
      let commId = '';
      let eligibleIds: string[] = [];
      if (t.scope === 'community') commId = await communityIdByName(t.community || t.address);
      if (isCommunityCut) {
        // Eligibility = community properties matching ALL enrollment criteria
        // (e.g. "RRQC Pass Date is known" AND "Property Status is Vacant").
        const criteria = parseCriteria(p);
        const all = commId ? await fetchCommunityProperties(commId) : [];
        eligibleIds = all.filter((x) => criteria.every((c) => matchCriterion(x, c))).map((x) => x.id);
        if (!eligibleIds.length) { result.items.push({ ...base, action: 'skip-open' }); result.skippedExisting++; return; }
        result.masterCoverage = eligibleIds.length;   // for the single-rule "would create" preview
      }

      // Commit point — pick and RESERVE the vendor now (sticky-per-address, else
      // equal-volume balance) so the dry-run preview and the apply path agree.
      const vendor = pickVendor(vendors, enrollmentKey, rotation);
      base.vendor = vendor;

      if (!apply) { result.wouldCreate++; result.items.push({ ...base, action: 'CREATE' }); return; }

      const orderProps: Record<string, any> = {
        service_name: `${wtLabel(worktype)} · ${subLabel(worktype, subtype)} — ${t.address}`,
        worktype, subtype, status: 'assigned', is_bid_item: 'false',
        scope: t.scope, service_description: p.service_description || '',
        due_date: dueDate, region_snapshot: t.region, address_snapshot: t.address,
        locality_snapshot: t.locality, pet_stations: p.pet_stations === 'true' ? 'true' : 'false',
        vendor_name: vendor || '', vendor_email: await resolveVendorEmail(vendor),
        generated_by_rule_id: ruleId, enrollment_key: enrollmentKey,
      };
      if (t.community) orderProps.community_name = t.community;
      if (Number.isFinite(markupPct)) orderProps.markup_pct = markupPct;
      if (t.scope === 'property') orderProps.property_id_ref = t.id;
      if (t.scope === 'community' && commId) orderProps.community_id_ref = commId;

      if (isCommunityCut) {
        const perRate = Number.isFinite(vendorCost) ? vendorCost : 0;   // rule cost = per-property rate
        // Optional common-area cut: added to the master total on top of the house
        // cuts. On split it's distributed evenly across the children (even
        // distribution of the master total = per-house rate + commonArea/N), so
        // each per-property billing line carries its prorated share.
        const commonArea = p.include_common_areas === 'true' && Number.isFinite(Number(p.common_area_cost)) ? Math.max(0, Number(p.common_area_cost)) : 0;
        const houseSubtotal = Math.round(eligibleIds.length * perRate * 100) / 100;
        const masterVendor = Math.round((houseSubtotal + commonArea) * 100) / 100;
        orderProps.covered_property_ids = JSON.stringify(eligibleIds);
        orderProps.covered_property_count = eligibleIds.length;
        orderProps.per_property_rate = perRate;
        if (commonArea > 0) orderProps.common_area_cost = commonArea;
        orderProps.for_billing = 'true';
        orderProps.vendor_cost = masterVendor;
        orderProps.client_cost = Number.isFinite(markupPct) ? Math.round(masterVendor * (1 + markupPct / 100) * 100) / 100 : masterVendor;
      } else {
        if (Number.isFinite(vendorCost)) orderProps.vendor_cost = vendorCost;
        if (clientCost !== null) orderProps.client_cost = clientCost;
      }

      // Property grass cuts carry their tier payouts so submit can price by the
      // answered height with no rule lookup.
      if (t.scope === 'property' && worktype === 'landscaping' && subtype === 'cut') {
        const num = (v: any, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
        orderProps.grass_rate_standard = num(p.grass_rate_standard, DEFAULT_GRASS_TIERS.standard);
        orderProps.grass_rate_overgrown = num(p.grass_rate_overgrown, DEFAULT_GRASS_TIERS.overgrown);
        orderProps.grass_rate_heavy = num(p.grass_rate_heavy, DEFAULT_GRASS_TIERS.heavy);
      }

      // Stamp reference coordinates NOW (best-effort) so the calendar map can plot
      // this service without a live geocode.
      try {
        const c = await resolveCoords({
          address: [t.address, t.locality].filter(Boolean).join(', '),
          propertyId: t.scope === 'property' ? t.id : (commId || ''),
        });
        if (c) { orderProps.latitude = c.lat; orderProps.longitude = c.lng; }
      } catch { /* non-fatal — the map falls back to live geocoding */ }

      try {
        const recordId = await createServiceWorkOrder(orderProps);
        openKeys.add(enrollmentKey);
        genCountByKey.set(enrollmentKey, (genCountByKey.get(enrollmentKey) || 0) + 1);
        result.created++;
        result.items.push({ ...base, action: 'created', recordId: recordId || undefined });
        // Email the assigned vendor (best-effort, throttled + awaited at the end).
        if (recordId && vendor) {
          const vEmail = await resolveVendorEmail(vendor);
          const rid = recordId; const vName = vendor; const addr = t.address; const loc = t.locality;
          notifyThunks.push(() => notifyServiceAssigned({
            serviceId: rid, vendorEmail: vEmail, vendorName: vName,
            address: addr, locality: loc, worktypeLabel: wtLabel(worktype), subtypeLabel: subLabel(worktype, subtype),
            dueDate, baseUrl: notifyBase,
          }));
        }
      } catch (e: any) {
        result.errors++;
        result.items.push({ ...base, action: 'error', error: String(e?.message || e).slice(0, 300) });
      }
    };

    const skipItem = (t: Target, key: string, dueDate = '') => {
      result.skippedExisting++;
      result.items.push({ ruleId, ruleName, target: t.address, worktype, subtype, dueDate, vendor: rotation.stickyByKey.get(key) ?? null, enrollmentKey: key, action: 'skip-open' });
    };
    const targets = await targetsForRule(p);

    // Enroll DELAY: "Starts on → N days after it meets the criteria" (blank = no
    // delay). Gates the FIRST creation only — a target isn't created until it has
    // met the criteria for `delayDays` days. startGateOk marks a target's first-
    // qualified date and returns false until the delay elapses.
    const delayDays = Number(p.start_delay_days);
    const hasDelay = Number.isFinite(delayDays) && delayDays > 0;
    const startGateOk = (baseKey: string): boolean => {
      if (!hasDelay) return true;
      const seen = enrollSeen[baseKey];
      if (!seen) { enrollSeen[baseKey] = todayISO; enrollSeenDirty = true; return false; }   // first sighting → start clock
      return todayISO >= addDays(seen, delayDays);
    };
    // Reset the clock for any tracked key of THIS rule that no longer qualifies
    // (isn't in the current enrolled set) — so a home that lapses and re-qualifies
    // waits the full delay again.
    if (hasDelay) {
      const enrolledKeys = new Set(targets.map((t) => `gen:${ruleId}:${t.id}${t.dealId ? `:${t.dealId}` : ''}`));
      const prefix = `gen:${ruleId}:`;
      for (const k of Object.keys(enrollSeen)) {
        if (k.startsWith(prefix) && !enrolledKeys.has(k)) { delete enrollSeen[k]; enrollSeenDirty = true; }
      }
    }

    // ── ONE-TIME (non-recurring): exactly one order per target, ever. Due =
    // enrollment + First Order Due (fallback +5). ──
    if (!recurring) {
      const initDue = Number(p.initial_due_days);
      const oneTimeDue = addDays(todayISO, Number.isFinite(initDue) && initDue > 0 ? initDue : 5);
      for (const t of targets) {
        const key = `gen:${ruleId}:${t.id}${t.dealId ? `:${t.dealId}` : ''}`;
        if ((genCountByKey.get(key) || 0) >= 1 || openKeys.has(key)) { skipItem(t, key, oneTimeDue); continue; }
        if (!startGateOk(key)) continue;   // enroll delay hasn't elapsed yet
        await emitOrder(t, oneTimeDue, key);
      }
      continue;
    }

    if (!cads.length) continue;   // recurring rule with no cadence — nothing to schedule

    // ── COMMUNITY (contract calendar): generate on a fixed schedule, independent
    // of completion. The day AFTER each due date mints the next occurrence (due =
    // prior due + one cadence step), so overlapping open orders legitimately
    // stack. Each occurrence is keyed by its due date, so a date never doubles. ──
    if (scope === 'community') {
      for (const t of targets) {
        const baseKey = `gen:${ruleId}:${t.id}`;
        const priorDues = [...everKeys]
          .filter((k) => k.startsWith(`${baseKey}:`))
          .map((k) => k.slice(baseKey.length + 1))
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
        // Migration: a pre-existing order under the OLD dateless key seeds the
        // anchor from its due date, so we don't double-create alongside it.
        const legacy = existing.find((e) => e.key === baseKey);
        if (legacy) { const d = dateOnly(legacy.dueDate); if (d) priorDues.push(d); }
        let lastDue: string | null = priorDues.length ? priorDues.reduce((m, d) => (d > m ? d : m)) : null;
        let generatedForComm = priorDues.length;
        const stopReached = () => stopCountMode && Number.isFinite(stopCount) && stopCount >= 1 && generatedForComm >= stopCount;

        // Seed the first occurrence when this community has none yet.
        if (lastDue == null && !stopReached()) {
          if (!startGateOk(baseKey)) continue;   // enroll delay hasn't elapsed yet
          const seed = seedFirstDue(p, cads, todayISO, skipSet);
          if (!seed) continue;
          const cSeed = cadenceForMonth(cads, monthOf(seed.due)) || cads[0];
          // A seasonally-rolled first due isn't created until within one step of it.
          const createOn = seed.rolled ? stepDate(seed.due, cSeed, -1) : todayISO;
          if (todayISO < createOn) continue;
          const key = `${baseKey}:${seed.due}`;
          if (!everKeys.has(key)) { await emitOrder(t, seed.due, key); everKeys.add(key); generatedForComm++; }
          lastDue = seed.due;
        }

        // Catch up: mint every occurrence whose creation day (prior due + 1) has
        // arrived. `guard` bounds the loop; normal runs create 0–1 per community.
        for (let guard = 0; guard < 400 && lastDue && !stopReached(); guard++) {
          const cB = cadenceForMonth(cads, monthOf(lastDue)) || cads[0];
          const rolled = rollToActiveDue(stepDate(lastDue, cB, 1), cads, skipSet);
          if (!rolled) break;
          const cNd = cadenceForMonth(cads, monthOf(rolled.due)) || cads[0];
          const createOn = rolled.rolled ? stepDate(rolled.due, cNd, -1) : addDays(lastDue, 1);
          if (todayISO < createOn) break;   // next occurrence's creation day hasn't arrived
          // Don't back-fill occurrences already past due (migration / cron downtime);
          // advance the schedule to the next upcoming one instead.
          if (rolled.due >= todayISO) {
            const key = `${baseKey}:${rolled.due}`;
            if (!everKeys.has(key)) { await emitOrder(t, rolled.due, key); everKeys.add(key); generatedForComm++; }
          }
          lastDue = rolled.due;
        }

        // Backlog alert: ≥3 open orders of this type stacked on one community.
        const openForComm = [...openKeys].filter((k) => k.startsWith(`${baseKey}:`)).length;
        if (openForComm >= 3) {
          result.communityBacklogAlerts.push(`${ruleName} · ${t.address}: ${openForComm} open orders stacked up (vendor is behind on the contract cadence).`);
        }
      }
      continue;
    }

    // ── PROPERTY (self-healing): one open order per property. The next order is
    // created immediately after the current CLOSES, due = max(scheduled due,
    // service-completion date) + one cadence step; a late finish re-anchors the
    // rhythm to when the work was actually done (vendor-entered service completed
    // date, falling back to submitted/approved/due). ──
    for (const t of targets) {
      const key = `gen:${ruleId}:${t.id}${t.dealId ? `:${t.dealId}` : ''}`;
      if (stopCountMode && Number.isFinite(stopCount) && stopCount >= 1 && (genCountByKey.get(key) || 0) >= stopCount) continue;
      if (openKeys.has(key)) { skipItem(t, key); continue; }
      const prior = closedByKey.get(key);
      let candidate: { due: string; rolled: boolean } | null;
      if (!prior) {
        if (!startGateOk(key)) continue;   // enroll delay hasn't elapsed yet
        candidate = seedFirstDue(p, cads, todayISO, skipSet);
      } else {
        // Anchor on the date the work was actually DONE (vendor-entered service
        // completed date), not the submit/approval time — a Friday cut submitted
        // Monday still re-anchors from Friday.
        const anchor = dateOnly(prior.serviceCompletedDate) || dateOnly(prior.submittedAt) || dateOnly(prior.completedAt) || dateOnly(prior.dueDate);
        const baseDate = maxISO(dateOnly(prior.dueDate), anchor) || todayISO;
        const cB = cadenceForMonth(cads, monthOf(baseDate)) || cads[0];
        candidate = rollToActiveDue(stepDate(baseDate, cB, 1), cads, skipSet);
      }
      if (!candidate) continue;
      if (candidate.rolled) {
        // Seasonal dormancy: a due date rolled across skip months isn't created
        // until we're within one cadence step of it (no order sits open all winter).
        const cNd = cadenceForMonth(cads, monthOf(candidate.due)) || cads[0];
        if (todayISO < stepDate(candidate.due, cNd, -1)) continue;
      }
      await emitOrder(t, candidate.due, key);
    }
  }

  // Persist the enroll-delay markers (apply only — a dry-run must not mutate state).
  if (apply && enrollSeenDirty) { await writeGenEnrollSeen(enrollSeen).catch(() => {}); }

  // Throttled send: at most N in flight so a large run can't hit Gmail rate limits.
  const EMAIL_CONCURRENCY = 5;
  for (let i = 0; i < notifyThunks.length; i += EMAIL_CONCURRENCY) {
    await Promise.allSettled(notifyThunks.slice(i, i + EMAIL_CONCURRENCY).map((fn) => fn()));
  }
  return result;
}
