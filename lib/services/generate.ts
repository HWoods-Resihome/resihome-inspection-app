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
 * Documented v1 simplifications (all Step-2 refinements, called out in the report):
 *  - Property targets come from SAMPLE_PROPERTIES (real Property object wiring is
 *    later); community targets come from the rule's own communities list.
 *  - Enrollment/stop conditions are assumed met (no CRM field evaluation yet).
 *  - No cadence date math — due date is today + First Order Due (days), else +5.
 *  - No vendor rotation — the first assigned vendor is used for every order.
 */
import { searchServiceRuleRecords, readServiceWorkOrderKeys, createServiceWorkOrder, searchPropertiesForCoverage, listServiceCommunities, fetchCommunityProperties, fetchApprovedVendorCompanies } from '@/lib/hubspot';
import { resolveCoords } from '@/lib/geocodeResolve';
import { WORKTYPES, type Worktype } from './worktypes';
import { vendorEmail } from './vendors';
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
function matchCriterion(prop: { rrqcPassDate: string; status: string }, c: Criterion): boolean {
  const field = c.field.toLowerCase();
  if (/rrqc/.test(field)) return c.op === 'is known' ? !!prop.rrqcPassDate : true;
  if (/status/.test(field)) {
    const s = (prop.status || '').toLowerCase();
    const vals = c.vals.map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (!vals.length) return true;
    const hit = vals.some((v) => s === v || s.startsWith(v) || s.includes(v));
    return c.op === 'is not' ? !hit : hit;
  }
  return true; // fields we can't evaluate here → best-effort include
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface Target { id: string; scope: 'property' | 'community'; address: string; locality: string; region: string; community?: string; }

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
  const enrollOk = (prop: { status: string; rrqcPassDate: string }): boolean => {
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
  const stopHit = (prop: { status: string; rrqcPassDate: string }): boolean => {
    if (!stopEnabled || !stopIsCondition || !stopCriteria.length) return false;
    const results = stopCriteria.map((c) => matchCriterion(prop, c));
    return stopCombinator === 'or' ? results.some(Boolean) : results.every(Boolean);
  };

  const included = new Set(parseArr(p.included_props_json).map(String));
  const listMode = p.props_mode === 'list';
  return props
    .filter((prop) => !listMode || included.has(prop.id))
    .filter((prop) => enrollOk(prop))
    .filter((prop) => !stopHit(prop))   // stop condition met → exclude
    .map((prop) => ({ id: prop.id, scope: 'property' as const, address: prop.address, locality: prop.locality, region: prop.region }));
}

// A criterion is evaluable at generation time only for the fields we can read on
// a property (Property Status, RRQC Pass Date). Others (and empty-value rows) are
// skipped so they neither block (AND) nor satisfy (OR) the combined result.
function isEvaluableCriterion(c: Criterion): boolean {
  const f = (c.field || '').toLowerCase();
  if (/rrqc/.test(f)) return c.op === 'is known'; // only "is known" is evaluable for the date field
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
  // For a single community grass-cut rule: how many properties the master covers.
  masterCoverage?: number;
}

/**
 * Compute (and, when apply, create) the Service Work Orders the active rules call
 * for. Returns null when the Service Work Order object isn't configured yet.
 */
export async function runServiceGeneration(apply: boolean, todayISO: string, onlyRuleId?: string): Promise<GenerateResult | null> {
  const allRules = await searchServiceRuleRecords();
  const existing = await readServiceWorkOrderKeys();
  if (allRules === null || existing === null) return null; // objects not configured
  // Ad-hoc: run a single rule (the "generate missing now" button) vs. the whole
  // set (nightly). Either way the enrollment-key dedup below prevents duplicates.
  const rules = onlyRuleId ? allRules.filter((r) => r.id === onlyRuleId) : allRules;

  // Enrollment keys with a currently-open (non-terminal) order — dedup set.
  const openKeys = new Set(existing.filter((e) => OPEN_STATUSES.has(e.status)).map((e) => e.key).filter(Boolean));
  // Total orders EVER generated per enrollment key (all statuses) — powers the
  // "stop after N services" cap ("all generated" counting basis).
  const genCountByKey = new Map<string, number>();
  for (const e of existing) if (e.key) genCountByKey.set(e.key, (genCountByKey.get(e.key) || 0) + 1);

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
  const notifyPromises: Promise<void>[] = [];
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
    return _vendorEmailByName.get(n.toLowerCase()) || vendorEmail(n) || '';
  };

  const result: GenerateResult = {
    mode: apply ? 'apply' : 'dry-run', today: todayISO, configured: true,
    rulesActive: 0, rulesSkipped: 0, wouldCreate: 0, created: 0, skippedExisting: 0, errors: 0,
    items: [], notes: [
      'Property targets: live Property records in the rule’s portfolios/regions, filtered by the enrollment criteria (Property Status / RRQC), combined with the rule’s AND/OR. Community targets: one per selected community.',
      'Stop enforced: condition (Property Status / RRQC), date (rule stops on/after the date), and count (stop after N generated per property). A rule with a future start date stays dormant. Due = created date + the active cadence’s “Due within” days (else First Order Due, else +5).',
      'v1: first assigned vendor used for every order (no rotation).',
      'One open order per (rule, target) at a time — the next generates after the current completes/cancels.',
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

    const worktype = (p.worktype || 'landscaping') as Worktype;
    const subtype = p.subtype || '';
    const vendors = parseArr(p.vendors_json);
    const vendor: string | null = vendors.length ? String(vendors[0]) : null;
    // Due window: the cadence covering the current month sets its own "Due within
    // N days"; fall back to the rule's First Order Due, then 5. Each cadence can
    // define a different completion window (e.g. cut every 10 days, due 4 later).
    const curMonth = new Date(`${todayISO}T00:00:00Z`).getUTCMonth();
    const activeCad = parseArr(p.cadences_json).find((c: any) => Array.isArray(c.months) && c.months.includes(curMonth));
    const cadDue = activeCad && String(activeCad.dueDays ?? '').trim() !== '' ? Number(activeCad.dueDays) : NaN;
    const ruleDue = Number(p.initial_due_days);
    const dueWindow = Number.isFinite(cadDue) && cadDue > 0 ? cadDue
      : (Number.isFinite(ruleDue) && ruleDue > 0 ? ruleDue : 5);
    const dueDate = addDays(todayISO, dueWindow);
    const vendorCost = Number(p.vendor_cost);
    const markupPct = Number(p.markup_pct);
    const clientCost = Number.isFinite(vendorCost) ? Math.round(vendorCost * (1 + (Number.isFinite(markupPct) ? markupPct : 0) / 100) * 100) / 100 : null;

    for (const t of await targetsForRule(p)) {
      const enrollmentKey = `gen:${ruleId}:${t.id}`;
      const base = {
        ruleId, ruleName: p.rule_name || 'Rule', target: t.address, worktype, subtype,
        dueDate, vendor, enrollmentKey,
      };
      // Stop-after-N: this target has already generated its cap → stop.
      if (stopCountMode && Number.isFinite(stopCount) && stopCount >= 1 && (genCountByKey.get(enrollmentKey) || 0) >= stopCount) {
        continue; // silently not created (won't count toward wouldCreate)
      }
      if (openKeys.has(enrollmentKey)) {
        result.skippedExisting++;
        result.items.push({ ...base, action: 'skip-open' });
        continue;
      }

      // Community + Landscaping + Grass Cut = a MASTER of individual house cuts.
      // Resolve the eligible property snapshot up front (used by BOTH the dry-run
      // coverage count and the apply pricing). Other community services stay a
      // single line. Eligibility is driven by the rule's enrollment criterion
      // (defaults to "RRQC Pass Date is known") — not hard-coded.
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
        if (!eligibleIds.length) { result.items.push({ ...base, action: 'skip-open' }); result.skippedExisting++; continue; }
        result.masterCoverage = eligibleIds.length;   // for the single-rule "would create" preview
      }

      if (!apply) {
        result.wouldCreate++;
        result.items.push({ ...base, action: 'CREATE' });
        continue;
      }

      // Build the Service Work Order property map.
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
        const masterVendor = Math.round(eligibleIds.length * perRate * 100) / 100;
        orderProps.covered_property_ids = JSON.stringify(eligibleIds);
        orderProps.covered_property_count = eligibleIds.length;
        orderProps.per_property_rate = perRate;
        orderProps.for_billing = 'true';
        orderProps.vendor_cost = masterVendor;
        orderProps.client_cost = Number.isFinite(markupPct) ? Math.round(masterVendor * (1 + markupPct / 100) * 100) / 100 : masterVendor;
      } else {
        if (Number.isFinite(vendorCost)) orderProps.vendor_cost = vendorCost;
        if (clientCost !== null) orderProps.client_cost = clientCost;
      }

      // Stamp reference coordinates NOW (best-effort) so the calendar map can plot
      // this service without a live geocode. Property scope resolves via the
      // property's stored coords/address; community scope via the community's
      // first property; both fall back to geocoding the address text.
      try {
        const c = await resolveCoords({
          address: [t.address, t.locality].filter(Boolean).join(', '),
          propertyId: t.scope === 'property' ? t.id : (commId || ''),
        });
        if (c) { orderProps.latitude = c.lat; orderProps.longitude = c.lng; }
      } catch { /* non-fatal — the map falls back to live geocoding */ }

      try {
        const recordId = await createServiceWorkOrder(orderProps);
        openKeys.add(enrollmentKey); // guard against duplicate targets within a single run
        result.created++;
        result.items.push({ ...base, action: 'created', recordId: recordId || undefined });
        // Email the assigned vendor (best-effort, collected + awaited at the end).
        if (recordId && vendor) {
          notifyPromises.push(notifyServiceAssigned({
            serviceId: recordId, vendorEmail: await resolveVendorEmail(vendor), vendorName: vendor,
            address: t.address, locality: t.locality, worktypeLabel: wtLabel(worktype), subtypeLabel: subLabel(worktype, subtype),
            dueDate, baseUrl: notifyBase,
          }));
        }
      } catch (e: any) {
        result.errors++;
        result.items.push({ ...base, action: 'error', error: String(e?.message || e).slice(0, 300) });
      }
    }
  }

  if (notifyPromises.length) await Promise.allSettled(notifyPromises);
  return result;
}
