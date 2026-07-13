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
import { searchServiceRuleRecords, readServiceWorkOrderKeys, createServiceWorkOrder, searchPropertiesForCoverage, listServiceCommunities, fetchCommunityProperties } from '@/lib/hubspot';
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

  // Enrollment filter (best-effort). enroll_field like "Property Status", one or
  // more values (is / is any of / is not / changes to). "changes to" can't detect
  // the transition edge at generation time, so it's treated as membership (v1);
  // the enrollment_key dedup still guarantees one order per property.
  const enrollField = String(p.enroll_field || '').toLowerCase();
  const enrollOp = String(p.enroll_op || '');
  const enrollVals = parseVals(p.enroll_value).map((v) => v.trim().toLowerCase()).filter(Boolean);
  const statusMatch = (status: string): boolean => {
    if (!enrollVals.length || !/status/.test(enrollField)) return true; // no usable condition → include
    const s = status.trim().toLowerCase();
    const hit = enrollVals.some((v) => s === v || s.startsWith(v) || s.includes(v));
    return enrollOp === 'is not' ? !hit : hit; // is / is any of / changes to → membership
  };

  const included = new Set(parseArr(p.included_props_json).map(String));
  const listMode = p.props_mode === 'list';
  return props
    .filter((prop) => !listMode || included.has(prop.id))
    .filter((prop) => statusMatch(prop.status))
    .map((prop) => ({ id: prop.id, scope: 'property' as const, address: prop.address, locality: prop.locality, region: prop.region }));
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

  const result: GenerateResult = {
    mode: apply ? 'apply' : 'dry-run', today: todayISO, configured: true,
    rulesActive: 0, rulesSkipped: 0, wouldCreate: 0, created: 0, skippedExisting: 0, errors: 0,
    items: [], notes: [
      'Property targets: live Property records in the rule’s portfolios/regions, filtered by the enrollment condition (best-effort status match). Community targets: one per selected community.',
      'v1: stop conditions not yet evaluated. Due = created date + the active cadence’s “Due within” days (else the rule’s First Order Due, else +5).',
      'v1: first assigned vendor used for every order (no rotation).',
      'One open order per (rule, target) at a time — the next generates after the current completes/cancels.',
    ],
  };

  for (const { id: ruleId, props: p } of rules) {
    if (p.active !== 'true') { result.rulesSkipped++; continue; }
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
        vendor_name: vendor || '', vendor_email: vendorEmail(vendor) || '',
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

      try {
        const recordId = await createServiceWorkOrder(orderProps);
        openKeys.add(enrollmentKey); // guard against duplicate targets within a single run
        result.created++;
        result.items.push({ ...base, action: 'created', recordId: recordId || undefined });
        // Email the assigned vendor (best-effort, collected + awaited at the end).
        if (recordId && vendor) {
          notifyPromises.push(notifyServiceAssigned({
            serviceId: recordId, vendorEmail: vendorEmail(vendor), vendorName: vendor,
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
