import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { FIELD_LABEL } from '@/components/formStyles';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { descriptionFor, defaultRateFor, mergeWorktypes, type Worktype, type CustomWorktypeDef } from '@/lib/services/worktypes';
import { DEFAULT_GRASS_TIERS } from '@/lib/services/grassPricing';
import { PriceField } from '@/components/PriceField';
import { MultiFilter } from '@/components/MultiFilter';
import { DatePicker } from '@/components/DatePicker';
import { ListPicker } from '@/components/ListPicker';
import { AutoGrowTextarea } from '@/components/AutoGrowTextarea';
import { searchServiceRuleRecords, readServiceTaxonomy, readServiceWorkOrderKeys } from '@/lib/hubspot';
import { isViewingAsVendor } from '@/lib/services/viewAs';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  if (isViewingAsVendor(ctx.req)) return { redirect: { destination: '/services', permanent: false } };
  const recs = await searchServiceRuleRecords().catch(() => null);
  const canGenerate = await isAppAdmin(session?.email).catch(() => false);
  const taxonomy = await readServiceTaxonomy().catch(() => null);
  // Current OPEN service volume per vendor — the basis for the equal-volume rotation
  // count shown next to each company in the vendor picker (real Service Work Orders).
  const keys = await readServiceWorkOrderKeys().catch(() => null);
  const vendorOpen: Record<string, number> = {};
  for (const k of keys || []) {
    if (k.vendor && OPEN_SERVICE_STATUSES.includes(k.status)) vendorOpen[k.vendor] = (vendorOpen[k.vendor] || 0) + 1;
  }
  return { props: { ruleRecords: recs, live: !!recs, canGenerate, taxonomy: (taxonomy as CustomWorktypeDef[] | null) || null, vendorOpen } };
};

// Real coverage catalog, loaded client-side from /api/services/coverage (portfolios
// and per-portfolio regions from the Property object; community names from the
// Community object). Empty until fetched.
interface Coverage {
  portfolios: { key: string; count: number }[];
  regionsByPortfolio: Record<string, { key: string; count: number }[]>;
  regions: { key: string; count: number }[];
  communities: { id: string; name: string; units: number }[];
  statuses: { label: string; value: string }[];   // real Property status enum (enrollment values)
}
const EMPTY_COVERAGE: Coverage = { portfolios: [], regionsByPortfolio: {}, regions: [], communities: [], statuses: [] };
// A single Property row for the 'list'-mode drill-down (loaded on demand).
interface CoverageProp { id: string; address: string; locality: string; region: string; portfolio: string; status: string; }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Open service statuses — the basis for the equal-volume rotation count shown next
// to each company in the vendor picker (computed from real orders in gSSP).
const OPEN_SERVICE_STATUSES = ['estimated', 'assigned', 'submitted', 'review'];
const DEFAULT_MARKUP = '20';   // default markup % on all services
const baseRate = (wt: Worktype, sub: string): string => { const r = defaultRateFor(wt, sub); return r != null ? String(r) : ''; };
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Enrollment / stop criteria fields. LIMITED to the fields the generator actually
// evaluates (lib/services/generate matchCriterion): Property Status (membership/
// prefix) and RRQC Pass Date (is-known). The old list also offered Home Type,
// Recurring Services, Has Pool, Occupancy, and Deal Stage — none did any real
// logic (they fell through to "include everything"), so they were removed to
// avoid implying rules that don't exist. Re-add a field here only once the
// generator can evaluate it.
const PROPERTY_FIELDS: { field: string; options: string[] }[] = [
  { field: 'Property Status', options: ['Vacant', 'Pending MOI/Rekey', 'Occupied', 'Under Turnkey', 'Eviction'] },
  // Date field (no enum values) — used with "is known" to gate community grass-cut
  // eligibility on properties that have passed RRQC (`rrqc_pass_date`).
  { field: 'RRQC Pass Date', options: [] },
  // The property's associated LEASING deal stage (via Property→Listing→Deal). Its
  // value options are the leasing pipeline stages, loaded live (see dealStages).
  // e.g. enroll when the deal enters "Pre-Lease Compliance" → a move-in clean.
  { field: 'Deal Stage', options: [] },
  // Numeric gate on the property's pool_fee — "is greater than $0" enrolls homes
  // that carry a pool fee (i.e. have a pool we service). No enum values.
  { field: 'Pool Fee', options: [] },
];
const FIELD_NAMES = PROPERTY_FIELDS.map((f) => f.field);
const optsFor = (field: string) => PROPERTY_FIELDS.find((f) => f.field === field)?.options ?? [];
// Operators the generator honors, PER FIELD (lib/services/generate matchCriterion):
// membership fields (Property Status, Deal Stage) → is / is any of / is not;
// RRQC Pass Date is a date gate → only "is known". "changes to" was removed
// (no field history at generation time). Showing only field-valid operators keeps
// a rule from being built on an operator the generator won't actually evaluate.
const opsFor = (field: string): string[] =>
  field === 'RRQC Pass Date' ? ['is known']
    : field === 'Pool Fee' ? ['is greater than $0']
      : ['is', 'is any of', 'is not', 'is not any of'];
// Operators that select a SET of values (multi-select UI + JSON array value).
const isMultiOp = (op: string): boolean => op === 'is any of' || op === 'is not any of';
// Operators that take NO value (self-contained gates).
const NO_VALUE_OPS = new Set(['is known', 'is greater than $0']);
interface EnrollCriterion { field: string; op: string; vals: string[] }
// Community + Landscaping + Grass Cut defaults its enrollment to "RRQC Pass Date
// is known" (the per-house eligibility gate). Admin can add/change criteria after.
const cutEnroll = (scope: string, worktype: string, subtype: string): Partial<{ enrollField: string; enrollOp: string; enrollVals: string[]; enrollCriteria: EnrollCriterion[] }> =>
  (scope === 'community' && worktype === 'landscaping' && subtype === 'cut')
    ? { enrollField: 'RRQC Pass Date', enrollOp: 'is known', enrollVals: [], enrollCriteria: [{ field: 'RRQC Pass Date', op: 'is known', vals: [] }] }
    : {};

// Rules-list sort (mirrors the Services home sort: tap a field, re-tap to flip).
type RuleSortField = 'name' | 'coverage' | 'worktype' | 'region' | 'community';
const RULE_SORT: { value: RuleSortField; label: string }[] = [
  { value: 'name', label: 'Name' }, { value: 'coverage', label: 'Coverage' }, { value: 'worktype', label: 'Work Type' },
  { value: 'region', label: 'Region' }, { value: 'community', label: 'Community' },
];

// Cadence is either "every N days" (unit 'days'; dow = optional weekday anchor
// that seeds the first order — Mon=0…Sun=6, -1 = any day) or "monthly on day X"
// (unit 'months'; interval = every N months, dom = day-of-month, 0 = any). Legacy
// 'weeks' cadences are migrated to days (×7) on load. interval is a STRING so it
// can be cleared/retyped. The due date IS the scheduled service date — there is no
// separate "due within N days" window (recurring regeneration is self-healing).
type Unit = 'days' | 'months';
interface Cadence { id: number; unit: Unit; interval: string; dow: number; dom: number; months: number[]; }
interface Rule {
  id: number; recordId?: string;            // HubSpot Service Rule record id (undefined = not saved yet)
  name: string; active: boolean; worktype: Worktype; subtype: string;
  petStations: boolean;                     // community only: capture dedicated pet-station before/after
  scope: 'property' | 'community'; portfolios: string[]; communities: string[];
  regions: string[];                        // property scope: dependent region filter (empty = all)
  propsMode: 'all' | 'list';                // 'all' = every applicable property incl. future adds; 'list' = a fixed subset
  includedProps: string[];                  // property scope, 'list' mode only: the specific property ids included
  vendorCost: string; markupPct: string;   // strings so decimals can be typed freely
  // Grass-cut tier payouts (property grass cuts only) — optional; blank/undefined
  // falls back to DEFAULT_GRASS_TIERS at generation.
  grassStandard?: string; grassOvergrown?: string; grassHeavy?: string;
  vendors: string[];                        // assigned company/companies (1 = always; many = equal-volume rotation)
  description: string;                      // scope-of-work language (defaults from the worktype; editable)
  recurring: boolean;                       // false = one-time (no cadence); true = recurring (cadences required)
  cadences: Cadence[];
  initialDueDays: string;                   // optional: first order due N days after enrollment (blank = standard cadence)
  skipMonths: number[];                     // months explicitly set to NO service
  enrollField: string; enrollOp: string; enrollVals: string[];   // legacy single (= first criterion, kept in sync)
  enrollCriteria: EnrollCriterion[];         // enrollment criteria (source of truth)
  enrollCombinator: 'and' | 'or';            // combine enrollment criteria with ALL (AND) / ANY (OR)
  startDate: string;                         // rule-level start date — dormant until (YYYY-MM-DD, blank = now)
  stopEnabled: boolean;
  stopMode: 'condition' | 'date' | 'count';  // how enrollment stops
  stopCriteria: EnrollCriterion[];           // stopMode 'condition' — AND/OR combined (source of truth)
  stopCombinator: 'and' | 'or';              // combine stop criteria with ALL (AND) / ANY (OR)
  stopField: string; stopOp: string; stopVal: string;   // legacy single stop (= first stop criterion, synced)
  stopDate: string;                          // stopMode 'date'  (YYYY-MM-DD)
  stopCount: string;                         // stopMode 'count' (services generated)
}

let _cid = 100;
const newCadence = (months: number[] = []): Cadence => ({ id: ++_cid, unit: 'days', interval: '7', dow: -1, dom: 1, months });

// Searchable, multi-select, scrollable dropdown for portfolio/community/region
// coverage, with Select all / Deselect all over the current search results.
function CoveragePicker({ noun, options, selected, onToggle, onSetMany }: {
  noun: string; options: { key: string; count: number }[]; selected: string[];
  onToggle: (k: string) => void; onSetMany?: (keys: string[], on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const filtered = options.filter((o) => o.key.toLowerCase().includes(q.trim().toLowerCase()));
  const nounTitle = noun.charAt(0).toUpperCase() + noun.slice(1);
  const summary = selected.length === 0 ? `Select ${nounTitle}…` : selected.length === 1 ? selected[0] : `${selected.length} ${nounTitle} Selected`;
  return (
    <div className="relative max-w-md">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center justify-between gap-2 text-[13px] font-semibold px-3 py-2 border rounded-lg bg-white ${selected.length ? 'border-brand/50 text-ink' : 'border-gray-300 text-gray-500'}`}>
        <span className="truncate">{summary}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 z-40 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
            <div className="p-2 border-b border-gray-100">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${noun}…`}
                className="w-full text-[13px] px-2.5 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:border-brand" />
            </div>
            {onSetMany && filtered.length > 0 && (
              <div className="flex gap-4 px-3 py-2 text-[12px] font-semibold border-b border-gray-100">
                <button type="button" onClick={() => onSetMany(filtered.map((o) => o.key), true)} className="text-brand">Select all</button>
                <button type="button" onClick={() => onSetMany(filtered.map((o) => o.key), false)} className="text-gray-500 hover:text-ink">Deselect all</button>
              </div>
            )}
            <div className="max-h-56 overflow-y-auto py-1">
              {filtered.map((o) => {
                const on = selected.includes(o.key);
                return (
                  <button key={o.key} type="button" onClick={() => onToggle(o.key)} className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-gray-50 text-left">
                    <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] font-bold shrink-0 ${on ? 'bg-brand border-brand text-white' : 'border-gray-300'}`}>{on ? '✓' : ''}</span>
                    <span className="flex-1 truncate text-ink">{o.key}</span>
                    <span className="text-[11px] text-gray-400 tabular-nums">{o.count.toLocaleString()}</span>
                  </button>
                );
              })}
              {filtered.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-gray-400">No matches</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const SEED: Rule[] = [
  {
    id: 1, name: 'Amherst Grass Cut', active: true, worktype: 'landscaping', subtype: 'cut', petStations: false, scope: 'property',
    portfolios: ['Amherst Sunbelt'], communities: [], regions: [], propsMode: 'all', includedProps: [], vendorCost: '45', markupPct: '20', vendors: [], description: descriptionFor('landscaping', 'cut'),
    recurring: true,
    cadences: [
      { id: 11, unit: 'days', interval: '14', dow: 3, dom: 1, months: [2, 3, 4, 5, 6, 7, 8, 9] },
      { id: 12, unit: 'months', interval: '1', dow: 0, dom: 15, months: [10, 11] },
    ],
    initialDueDays: '5', skipMonths: [0, 1],
    enrollField: 'Property Status', enrollOp: 'is', enrollVals: ['Vacant'],
    enrollCriteria: [{ field: 'Property Status', op: 'is', vals: ['Vacant'] }], enrollCombinator: 'and', startDate: '',
    stopEnabled: true, stopMode: 'condition', stopCriteria: [{ field: 'Property Status', op: 'is', vals: ['Occupied'] }], stopCombinator: 'and', stopField: 'Property Status', stopOp: 'is', stopVal: 'Occupied', stopDate: '', stopCount: '',
  },
  {
    id: 2, name: 'ATL Community Grass', active: true, worktype: 'landscaping', subtype: 'cut', petStations: true, scope: 'community',
    portfolios: [], communities: ['Woodbine Crossing', 'River Glen'], regions: [], propsMode: 'all', includedProps: [], vendorCost: '45', markupPct: '20', vendors: [], description: descriptionFor('landscaping', 'cut'),
    recurring: true,
    cadences: [{ id: 21, unit: 'days', interval: '7', dow: 1, dom: 1, months: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }],
    initialDueDays: '5', skipMonths: [],
    enrollField: 'Property Status', enrollOp: 'is', enrollVals: ['Vacant'],
    enrollCriteria: [{ field: 'Property Status', op: 'is', vals: ['Vacant'] }], enrollCombinator: 'and', startDate: '',
    stopEnabled: false, stopMode: 'condition', stopCriteria: [{ field: 'Property Status', op: 'is', vals: ['Occupied'] }], stopCombinator: 'and', stopField: 'Property Status', stopOp: 'is', stopVal: 'Occupied', stopDate: '', stopCount: '',
  },
  {
    // Run-once dispatch: a move-in clean for a home about to be occupied. (The
    // original Deal-Stage "changes to Move-In Scheduled" trigger was removed —
    // Deal Stage carried no generator logic; enroll on Property Status until an
    // event trigger is actually built.)
    id: 3, name: 'ATL Move-In Cleans', active: true, worktype: 'cleaning', subtype: 'move_in_clean', petStations: false, scope: 'property',
    portfolios: ['Progress'], communities: [], regions: [], propsMode: 'all', includedProps: [], vendorCost: '75', markupPct: '20', vendors: [], description: descriptionFor('cleaning', 'move_in_clean'),
    recurring: false,
    cadences: [],
    initialDueDays: '2', skipMonths: [],
    enrollField: 'Property Status', enrollOp: 'is', enrollVals: ['Pending MOI/Rekey'],
    enrollCriteria: [{ field: 'Property Status', op: 'is', vals: ['Pending MOI/Rekey'] }], enrollCombinator: 'and', startDate: '',
    stopEnabled: false, stopMode: 'condition', stopCriteria: [{ field: 'Property Status', op: 'is', vals: ['Occupied'] }], stopCombinator: 'and', stopField: 'Property Status', stopOp: 'is', stopVal: 'Occupied', stopDate: '', stopCount: '',
  },
];

// ── HubSpot Service Rule ↔ Rule mappers (Phase 3 persistence) ──
const parseArr = (s: any): any[] => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
// enroll_value holds one plain string, or a JSON array when "is any of". Parse both.
const parseVals = (s: any): string[] => {
  const raw = (s ?? '').toString();
  if (!raw) return [];
  if (raw.startsWith('[')) { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : [raw]; } catch { return [raw]; } }
  return [raw];
};
const serializeVals = (a: string[]): string => (a.length <= 1 ? (a[0] || '') : JSON.stringify(a));
// Enrollment criteria: prefer the JSON array; fall back to the legacy single
// enroll_field/op/value triple so rules saved before multi-criteria still load.
function parseCriteria(p: Record<string, any>): EnrollCriterion[] {
  const arr = parseArr(p.enroll_criteria_json)
    .map((c: any) => ({ field: String(c?.field || ''), op: String(c?.op || 'is'), vals: Array.isArray(c?.vals) ? c.vals.map(String) : [] }))
    .filter((c: EnrollCriterion) => c.field);
  if (arr.length) return arr;
  return [{ field: p.enroll_field || 'Property Status', op: p.enroll_op || 'is', vals: parseVals(p.enroll_value) }];
}
// Stop criteria: prefer the JSON array; fall back to the legacy single
// stop_field/op/value triple so rules saved before multi-criteria still load.
function parseStopCriteria(p: Record<string, any>): EnrollCriterion[] {
  const arr = parseArr(p.stop_criteria_json)
    .map((c: any) => ({ field: String(c?.field || ''), op: String(c?.op || 'is'), vals: Array.isArray(c?.vals) ? c.vals.map(String) : [] }))
    .filter((c: EnrollCriterion) => c.field);
  if (arr.length) return arr;
  return [{ field: p.stop_field || 'Property Status', op: p.stop_op || 'is', vals: parseVals(p.stop_value) }];
}
let _rid = 900;
function rulePropsToRule(rec: { id: string; props: Record<string, any> }): Rule {
  const p = rec.props;
  // Migrate legacy cadences: 'weeks' → 'days' (×7); the old per-cadence "dueDays"
  // completion window is dropped (the due date is now the scheduled service date).
  const cadences: Cadence[] = parseArr(p.cadences_json).map((c: any) => {
    const rawUnit = String(c.unit || 'weeks');
    const unit: Unit = rawUnit === 'months' ? 'months' : 'days';
    const interval = rawUnit === 'weeks' ? String((Number(c.interval) || 1) * 7) : String(c.interval ?? '');
    return { id: ++_cid, unit, interval, dow: Number(c.dow ?? -1), dom: Number(c.dom ?? 0), months: Array.isArray(c.months) ? c.months : [] };
  });
  return {
    id: ++_rid, recordId: rec.id,
    name: p.rule_name || 'Rule', active: p.active === 'true',
    worktype: (p.worktype || 'landscaping') as Worktype, subtype: p.subtype || '',
    petStations: p.pet_stations === 'true', scope: p.scope === 'community' ? 'community' : 'property',
    portfolios: parseArr(p.portfolios_json), communities: parseArr(p.communities_json), regions: parseArr(p.regions_json),
    propsMode: p.props_mode === 'list' ? 'list' : 'all', includedProps: parseArr(p.included_props_json),
    vendorCost: p.vendor_cost != null ? String(p.vendor_cost) : '', markupPct: p.markup_pct != null ? String(p.markup_pct) : '',
    grassStandard: p.grass_rate_standard != null ? String(p.grass_rate_standard) : undefined,
    grassOvergrown: p.grass_rate_overgrown != null ? String(p.grass_rate_overgrown) : undefined,
    grassHeavy: p.grass_rate_heavy != null ? String(p.grass_rate_heavy) : undefined,
    vendors: parseArr(p.vendors_json), description: p.service_description || '',
    recurring: p.recurring !== 'false', cadences,
    initialDueDays: p.initial_due_days != null ? String(p.initial_due_days) : '', skipMonths: parseArr(p.skip_months_json),
    enrollField: p.enroll_field || 'Property Status', enrollOp: p.enroll_op || 'is', enrollVals: parseVals(p.enroll_value),
    enrollCriteria: parseCriteria(p),
    enrollCombinator: p.enroll_combinator === 'or' ? 'or' : 'and',
    startDate: p.start_date ? String(p.start_date).slice(0, 10) : '',
    stopEnabled: p.stop_enabled === 'true', stopMode: (p.stop_mode || 'condition') as Rule['stopMode'],
    stopCriteria: parseStopCriteria(p),
    stopCombinator: p.stop_combinator === 'or' ? 'or' : 'and',
    stopField: p.stop_field || 'Property Status', stopOp: p.stop_op || 'is', stopVal: p.stop_value || '',
    stopDate: p.stop_date ? String(p.stop_date).slice(0, 10) : '', stopCount: p.stop_count != null ? String(p.stop_count) : '',
  };
}
function ruleToProps(r: Rule): Record<string, any> {
  const props: Record<string, any> = {
    rule_name: r.name, active: r.active ? 'true' : 'false', worktype: r.worktype, subtype: r.subtype, scope: r.scope,
    pet_stations: r.petStations ? 'true' : 'false', props_mode: r.propsMode,
    vendors_json: JSON.stringify(r.vendors), service_description: r.description,
    recurring: r.recurring ? 'true' : 'false', cadences_json: JSON.stringify(r.cadences),
    skip_months_json: JSON.stringify(r.skipMonths), included_props_json: JSON.stringify(r.includedProps),
    portfolios_json: JSON.stringify(r.portfolios), communities_json: JSON.stringify(r.communities), regions_json: JSON.stringify(r.regions),
    // enrollCriteria is the source of truth; keep the legacy single triple in
    // sync with the first criterion for back-compat with older readers.
    enroll_criteria_json: JSON.stringify(r.enrollCriteria),
    enroll_combinator: r.enrollCombinator === 'or' ? 'or' : 'and',
    enroll_field: r.enrollCriteria[0]?.field || r.enrollField,
    enroll_op: r.enrollCriteria[0]?.op || r.enrollOp,
    enroll_value: serializeVals(r.enrollCriteria[0]?.vals || r.enrollVals),
    stop_enabled: r.stopEnabled ? 'true' : 'false', stop_mode: r.stopMode,
    // stopCriteria is the source of truth; keep the legacy single triple synced
    // with the first stop criterion for back-compat.
    stop_criteria_json: JSON.stringify(r.stopCriteria),
    stop_combinator: r.stopCombinator === 'or' ? 'or' : 'and',
    stop_field: r.stopCriteria[0]?.field || r.stopField,
    stop_op: r.stopCriteria[0]?.op || r.stopOp,
    stop_value: serializeVals(r.stopCriteria[0]?.vals || (r.stopVal ? [r.stopVal] : [])),
  };
  if (r.vendorCost !== '') props.vendor_cost = Number(r.vendorCost);
  if (r.markupPct !== '') props.markup_pct = Number(r.markupPct);
  // Persist grass tiers only for property grass cuts (and only when set).
  if (r.scope === 'property' && r.worktype === 'landscaping' && r.subtype === 'cut') {
    if (r.grassStandard != null && r.grassStandard !== '') props.grass_rate_standard = Number(r.grassStandard);
    if (r.grassOvergrown != null && r.grassOvergrown !== '') props.grass_rate_overgrown = Number(r.grassOvergrown);
    if (r.grassHeavy != null && r.grassHeavy !== '') props.grass_rate_heavy = Number(r.grassHeavy);
  }
  if (r.initialDueDays !== '') props.initial_due_days = Number(r.initialDueDays);
  if (r.startDate) props.start_date = r.startDate;
  if (r.stopDate) props.stop_date = r.stopDate;
  if (r.stopCount !== '') props.stop_count = Number(r.stopCount);
  return props;
}

export default function RulesEngine({ ruleRecords, live, canGenerate, taxonomy, vendorOpen }: { ruleRecords: { id: string; props: Record<string, any> }[] | null; live: boolean; canGenerate: boolean; taxonomy?: CustomWorktypeDef[] | null; vendorOpen: Record<string, number> }) {
  // Built-in taxonomy merged with the admin's custom work types / subtypes.
  const defs = useMemo(() => mergeWorktypes(taxonomy), [taxonomy]);
  const subsOfD = (wt: string) => defs.find((w) => w.id === wt)?.subtypes || [];
  const wtLabelD = (wt: string) => defs.find((w) => w.id === wt)?.label || wt;
  const subLabelD = (wt: string, st: string) => subsOfD(wt).find((s) => s.id === st)?.label || st;
  const firstSubOf = (wt: string) => subsOfD(wt)[0]?.id || '';
  const [rules, setRules] = useState<Rule[]>(() => (ruleRecords ? ruleRecords.map(rulePropsToRule) : SEED));
  // Live assignable vendors from the approved Companies list (resiwalk_access +
  // eligible_for_recurring = Yes). Loaded client-side; the picker uses these.
  const [vendorNames, setVendorNames] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/services/vendors').then((r) => r.json()).then((d) => {
      if (alive && Array.isArray(d?.vendors)) setVendorNames(d.vendors.map((v: any) => String(v.name)).filter(Boolean));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // Leasing-pipeline deal stages for the "Deal Stage" criterion value dropdown.
  const [dealStages, setDealStages] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/services/deal-stages').then((r) => r.json()).then((d) => {
      if (alive && Array.isArray(d?.stages)) setDealStages(d.stages.filter((s: any) => s && s.value));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const [savingRule, setSavingRule] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState('');
  // Accurate "would create" count from the server dry-run (a real property query),
  // not the coverage catalog (which can be incomplete for some portfolios). null =
  // loading. Bumping wcReload re-runs it (after a generate).
  const [wouldCreate, setWouldCreate] = useState<number | null>(null);   // NEW services the rule would create (dry-run)
  const [masterCoverage, setMasterCoverage] = useState<number | null>(null); // community grass-cut: properties the master covers
  const [coveredLive, setCoveredLive] = useState<number | null>(null);   // accurate applicable-property count (live query)
  const [wcReload, setWcReload] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);   // null = list view; else editing that rule
  const [propsOpen, setPropsOpen] = useState(false);
  const [propSearch, setPropSearch] = useState('');
  const [showSkip, setShowSkip] = useState(false);   // No-Service block is added on demand
  // Section 1/2/3 collapse state (reset each time a rule is opened).
  const [openSec, setOpenSec] = useState<Record<1 | 2 | 3, boolean>>({ 1: true, 2: true, 3: true });
  // Rules-list search / filter / sort (mirrors the Services home).
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fWork, setFWork] = useState<string[]>([]);
  const [fSub, setFSub] = useState<string[]>([]);
  const [fRegion, setFRegion] = useState<string[]>([]);
  const [fCommunity, setFCommunity] = useState<string[]>([]);
  const [sortField, setSortField] = useState<RuleSortField>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [sortOpen, setSortOpen] = useState(false);
  const rule = rules.find((r) => r.id === openId) || rules[0];

  // Real coverage catalog (portfolios / regions / communities). Cached in
  // localStorage so the property counts render INSTANTLY (the server-side scan of
  // the whole Property object is slow on a cold cache); we then revalidate in the
  // background and only re-render if the numbers actually changed.
  const [coverage, setCoverage] = useState<Coverage>(EMPTY_COVERAGE);
  // Until the catalog is loaded, counts show "…" instead of a misleading 0.
  const [covLoaded, setCovLoaded] = useState(false);
  useEffect(() => {
    const CACHE_KEY = 'resiwalk.services.coverage.v2';   // v2: excludes inactive/sold/test properties + test portfolios
    const shape = (d: any): Coverage => ({
      portfolios: d.portfolios || [], regionsByPortfolio: d.regionsByPortfolio || {},
      regions: d.regions || [], communities: d.communities || [], statuses: d.statuses || [],
    });
    // 1) Instant paint from cache (so repeat visits show real counts immediately).
    try { const c = localStorage.getItem(CACHE_KEY); if (c) { setCoverage(shape(JSON.parse(c))); setCovLoaded(true); } } catch { /* ignore */ }
    // 2) Revalidate in the background; update + re-cache only when it differs.
    let alive = true;
    fetch('/api/services/coverage').then((r) => r.json()).then((d) => {
      if (!alive || !d || d.error) return;
      const next = JSON.stringify(d);
      try { if (localStorage.getItem(CACHE_KEY) !== next) localStorage.setItem(CACHE_KEY, next); } catch { /* ignore */ }
      setCoverage(shape(d)); setCovLoaded(true);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // Count → display: real number once the catalog is loaded, else a loading dash.
  const countLabel = (n: number) => (covLoaded ? n.toLocaleString() : '…');
  const portfolioCount = useMemo(() => Object.fromEntries(coverage.portfolios.map((p) => [p.key, p.count])), [coverage]);
  const communityUnits = useMemo(() => Object.fromEntries(coverage.communities.map((c) => [c.name, c.units])), [coverage]);

  // Individual Property rows for the 'list'-mode drill-down — fetched on demand
  // for the open rule's selected portfolios/regions (only when the panel is open).
  const [coverageProps, setCoverageProps] = useState<CoverageProp[]>([]);
  const [loadingProps, setLoadingProps] = useState(false);
  const pfKey = rule && rule.scope === 'property' ? rule.portfolios.join(',') : '';
  const rgKey = rule && rule.scope === 'property' ? rule.regions.join(',') : '';
  useEffect(() => {
    if (!propsOpen || !rule || rule.scope !== 'property' || !rule.portfolios.length) { setCoverageProps([]); return; }
    const ctrl = new AbortController();
    setLoadingProps(true);
    const qs = new URLSearchParams({ portfolios: pfKey, regions: rgKey });
    fetch(`/api/services/properties?${qs.toString()}`, { signal: ctrl.signal })
      .then((r) => r.json()).then((d) => setCoverageProps(d.properties || []))
      .catch(() => {}).finally(() => setLoadingProps(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propsOpen, pfKey, rgKey]);

  // Accurate applicable-property COUNT for the open property-scope rule (a live
  // query — the coverage catalog can be incomplete for some portfolios). This is
  // "Properties Covered" (all in the portfolios+regions); it differs from the
  // dry-run "would create" (which also applies the enrollment condition).
  useEffect(() => {
    if (!rule || rule.scope !== 'property' || !rule.portfolios.length) { setCoveredLive(null); return; }
    const ctrl = new AbortController();
    setCoveredLive(null);
    const qs = new URLSearchParams({ portfolios: pfKey, regions: rgKey });
    fetch(`/api/services/properties?${qs.toString()}`, { signal: ctrl.signal })
      .then((r) => r.json()).then((d) => setCoveredLive(Array.isArray(d.properties) ? d.properties.length : 0))
      .catch(() => {});
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule?.scope, pfKey, rgKey]);

  const toggleSec = (n: 1 | 2 | 3) => setOpenSec((s) => ({ ...s, [n]: !s[n] }));
  const openRule = (id: number) => {
    setOpenId(id); setOpenSec({ 1: true, 2: true, 3: true }); setPropsOpen(false); setPropSearch('');
    setShowSkip((rules.find((r) => r.id === id)?.skipMonths.length ?? 0) > 0);
  };
  const closeRule = () => setOpenId(null);

  const patch = (p: Partial<Rule>) => setRules((rs) => rs.map((r) => (r.id === openId ? { ...r, ...p } : r)));
  // ── Enrollment criteria (AND-combined) mutators ──
  const patchCrit = (i: number, c: Partial<EnrollCriterion>) =>
    patch({ enrollCriteria: (rule?.enrollCriteria || []).map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const addCrit = () =>
    patch({ enrollCriteria: [...(rule?.enrollCriteria || []), { field: 'Property Status', op: 'is', vals: [] }] });
  const removeCrit = (i: number) =>
    patch({ enrollCriteria: (rule?.enrollCriteria || []).filter((_, j) => j !== i) });
  // ── Stop criteria (condition mode; AND/OR-combined) mutators ──
  const patchStopCrit = (i: number, c: Partial<EnrollCriterion>) =>
    patch({ stopCriteria: (rule?.stopCriteria || []).map((x, j) => (j === i ? { ...x, ...c } : x)) });
  const addStopCrit = () =>
    patch({ stopCriteria: [...(rule?.stopCriteria || []), { field: 'Property Status', op: 'is', vals: [] }] });
  const removeStopCrit = (i: number) =>
    patch({ stopCriteria: (rule?.stopCriteria || []).filter((_, j) => j !== i) });
  const patchCadence = (cid: number, p: Partial<Cadence>) =>
    patch({ cadences: rule.cadences.map((c) => (c.id === cid ? { ...c, ...p } : c)) });
  const toggleMonth = (cid: number, m: number) =>
    patch({
      // a month belongs to ONE cadence — and is pulled out of the no-service set.
      cadences: rule.cadences.map((c) => c.id === cid
        ? { ...c, months: c.months.includes(m) ? c.months.filter((x) => x !== m) : [...c.months, m] }
        : { ...c, months: c.months.filter((x) => x !== m) }),
      skipMonths: rule.skipMonths.filter((x) => x !== m),
    });
  // Mark/unmark a month as NO service — removes it from every cadence.
  const toggleSkipMonth = (m: number) =>
    patch({
      skipMonths: rule.skipMonths.includes(m) ? rule.skipMonths.filter((x) => x !== m) : [...rule.skipMonths, m],
      cadences: rule.cadences.map((c) => ({ ...c, months: c.months.filter((x) => x !== m) })),
    });
  const toggleCoverage = (key: string) => {
    if (rule.scope === 'property') patch({ portfolios: rule.portfolios.includes(key) ? rule.portfolios.filter((x) => x !== key) : [...rule.portfolios, key] });
    else patch({ communities: rule.communities.includes(key) ? rule.communities.filter((x) => x !== key) : [...rule.communities, key] });
  };
  const setManyCoverage = (keys: string[], on: boolean) => {
    if (rule.scope === 'property') patch({ portfolios: on ? [...new Set([...rule.portfolios, ...keys])] : rule.portfolios.filter((k) => !keys.includes(k)) });
    else patch({ communities: on ? [...new Set([...rule.communities, ...keys])] : rule.communities.filter((k) => !keys.includes(k)) });
  };
  const setManyRegions = (keys: string[], on: boolean) =>
    patch({ regions: on ? [...new Set([...rule.regions, ...keys])] : rule.regions.filter((k) => !keys.includes(k)) });
  const toggleRegion = (r: string) =>
    patch({ regions: rule.regions.includes(r) ? rule.regions.filter((x) => x !== r) : [...rule.regions, r] });
  const toggleVendor = (v: string) =>
    patch({ vendors: rule.vendors.includes(v) ? rule.vendors.filter((x) => x !== v) : [...rule.vendors, v] });
  const setManyVendors = (keys: string[], on: boolean) =>
    patch({ vendors: on ? [...new Set([...rule.vendors, ...keys])] : rule.vendors.filter((k) => !keys.includes(k)) });

  // Property-scope drill-down: portfolios → regions → individual properties.
  // Regions come from the coverage catalog (union of the selected portfolios'
  // regions); individual properties are the lazily-fetched coverageProps.
  // Guarded: `rule` is undefined when the (live) rules list is empty and none is open.
  const regionOptions = useMemo(() => {
    if (!rule || rule.scope !== 'property') return [] as { key: string; count: number }[];
    const m = new Map<string, number>();
    for (const pf of rule.portfolios) for (const x of (coverage.regionsByPortfolio[pf] || [])) m.set(x.key, (m.get(x.key) || 0) + x.count);
    return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key));
  }, [rule, coverage]);
  // Enrollment/stop VALUE options: real Property status enum for "Property Status",
  // else the curated sample list (Deal Stage etc., wired to those objects later).
  const valueOptsFor = (field: string): { value: string; label: string }[] =>
    field === 'Property Status' && coverage.statuses.length
      ? coverage.statuses.map((s) => ({ value: s.value, label: s.label }))
      : field === 'Deal Stage'
        ? dealStages
        : optsFor(field).map((o) => ({ value: o, label: o }));
  // ENROLLMENT can't target inactive statuses — you don't start servicing a home
  // because it was sold or dropped from management. (Stop criteria still can, so a
  // rule can end when a home hits one of these.) Filtered by label/value.
  const ENROLL_HIDDEN_STATUSES = ['property sold', 'properties sold', 'not managed'];
  const enrollValueOptsFor = (field: string): { value: string; label: string }[] =>
    field === 'Property Status'
      ? valueOptsFor(field).filter((o) =>
          !ENROLL_HIDDEN_STATUSES.includes(o.label.toLowerCase().trim()) &&
          !ENROLL_HIDDEN_STATUSES.includes(o.value.toLowerCase().trim()))
      : valueOptsFor(field);
  const applicableProps = coverageProps;   // server-filtered to the selected portfolios + regions
  // Search matches address, region, AND the City/ST/ZIP locality (so a city or
  // zip narrows the list).
  const visibleProps = applicableProps.filter((p) => !propSearch.trim() || `${p.address} ${p.locality} ${p.region}`.toLowerCase().includes(propSearch.trim().toLowerCase()));
  const isPropOn = (id: string) => !!rule && (rule.propsMode === 'all' || rule.includedProps.includes(id));
  // Current included id set: everything applicable in 'all' mode, else the fixed list.
  const effectiveIncluded = () => new Set(rule && rule.propsMode === 'all' ? applicableProps.map((p) => p.id) : (rule?.includedProps || []));
  // Any manual pick makes it a FIXED list (no future auto-include).
  const toggleProp = (id: string) => {
    const cur = effectiveIncluded();
    cur.has(id) ? cur.delete(id) : cur.add(id);
    patch({ propsMode: 'list', includedProps: [...cur] });
  };
  const selectAllProps = () => {
    // Unfiltered "Select all" = the WHOLE set → 'all' mode (future adds auto-include).
    if (!propSearch.trim()) { patch({ propsMode: 'all', includedProps: [] }); return; }
    const cur = effectiveIncluded(); visibleProps.forEach((p) => cur.add(p.id));
    patch({ propsMode: 'list', includedProps: [...cur] });
  };
  const deselectAllProps = () => {
    const cur = effectiveIncluded(); visibleProps.forEach((p) => cur.delete(p.id));
    patch({ propsMode: 'list', includedProps: [...cur] });
  };

  const addRule = () => {
    const id = (rules.length ? Math.max(...rules.map((r) => r.id)) : 0) + 1;
    setRules((rs) => [...rs, { ...SEED[0], id, name: 'New rule', portfolios: [], communities: [], regions: [], propsMode: 'all', includedProps: [], subtype: 'cut', petStations: false, vendorCost: baseRate('landscaping', 'cut'), markupPct: DEFAULT_MARKUP, vendors: [], description: descriptionFor('landscaping', 'cut'), recurring: true, cadences: [newCadence([...Array(12).keys()])], initialDueDays: '', skipMonths: [], enrollVals: [], enrollCriteria: [], enrollCombinator: 'and', startDate: '', stopEnabled: false, stopCriteria: [{ field: 'Property Status', op: 'is', vals: [] }], stopCombinator: 'and' }]);
    openRule(id);
  };
  const duplicateRule = () => {
    const id = (rules.length ? Math.max(...rules.map((r) => r.id)) : 0) + 1;
    setRules((rs) => [...rs, { ...rule, id, name: `${rule.name} (copy)`, cadences: rule.cadences.map((c) => ({ ...c, id: ++_cid })) }]);
    openRule(id);
  };
  const deleteRule = (id: number) => {
    const recId = rules.find((r) => r.id === id)?.recordId;
    setRules((rs) => rs.filter((r) => r.id !== id));
    if (id === openId) closeRule();
    if (recId) void fetch('/api/services/rules/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: true, recordId: recId }) }).catch(() => {});
  };

  // Covered count from the catalog (no per-property fetch): community units, or
  // property counts summed over selected portfolios (× region filter). In 'list'
  // mode the count is the fixed included set.
  const countFor = (r: Rule) => {
    if (r.scope === 'community') return r.communities.reduce((n, name) => n + (communityUnits[name] || 0), 0);
    if (r.propsMode === 'list') return r.includedProps.length;
    return r.portfolios.reduce((n, pf) => {
      if (r.regions.length === 0) return n + (portfolioCount[pf] || 0);
      return n + (coverage.regionsByPortfolio[pf] || []).filter((x) => r.regions.includes(x.key)).reduce((s, x) => s + x.count, 0);
    }, 0);
  };
  // Regions a rule covers (property scope only): its explicit list, else every
  // region present in its selected portfolios. Drives the list Region filter.
  const regionsOf = (r: Rule): string[] => {
    if (r.scope !== 'property') return [];
    if (r.regions.length) return r.regions;
    const s = new Set<string>();
    for (const pf of r.portfolios) for (const x of (coverage.regionsByPortfolio[pf] || [])) s.add(x.key);
    return [...s];
  };

  // Filtered + sorted rules for the LIST view.
  const visibleRules = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rules.filter((r) =>
      (!q || r.name.toLowerCase().includes(q)) &&
      (fWork.length === 0 || fWork.includes(r.worktype)) &&
      (fSub.length === 0 || fSub.includes(r.subtype)) &&
      (fRegion.length === 0 || regionsOf(r).some((rg) => fRegion.includes(rg))) &&
      (fCommunity.length === 0 || (r.scope === 'community' && r.communities.some((c) => fCommunity.includes(c))))
    );
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = (r: Rule) => ({
      name: r.name.toLowerCase(), coverage: countFor(r), worktype: wtLabelD(r.worktype),
      region: (regionsOf(r)[0] || '~').toLowerCase(), community: (r.communities[0] || '~').toLowerCase(),
    }[sortField]);
    return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * dir);
  }, [rules, search, fWork, fSub, fRegion, fCommunity, sortField, sortDir]);

  // Subtype filter options: the union of subtypes across the chosen work types
  // (or every subtype when no work type is selected).
  const subFilterOptions = (fWork.length === 0 ? defs : defs.filter((w) => fWork.includes(w.id)))
    .flatMap((w) => w.subtypes.map((s) => [s.id, s.label] as const));
  const subFilterUnique = [...new Map(subFilterOptions).entries()].map(([value, label]) => ({ value, label }));

  const coveredCount = useMemo(() => (rule ? countFor(rule) : 0), [rule]);
  // Property scope → the accurate live count (…​ while loading); community scope →
  // the catalog unit count.
  const coveredDisplay = rule && rule.scope === 'property'
    ? (coveredLive != null ? coveredLive.toLocaleString() : '…')
    : countLabel(coveredCount);

  // A month is "accounted for" if it's in a cadence OR explicitly set to no service.
  const coveredMonths = useMemo(() => new Set(rule ? [...rule.cadences.flatMap((c) => c.months), ...rule.skipMonths] : []), [rule]);
  const missingMonths = MONTHS.map((_, i) => i).filter((i) => !coveredMonths.has(i));

  // One property → one rule per worktype + subtype: block save if this rule shares
  // any portfolio/community with ANOTHER active rule of the same worktype AND
  // subtype. Different subtypes of the same worktype (e.g. Grass Cut vs. Tree
  // Trimming) may cover the same property, so they never conflict.
  const overlap = useMemo(() => {
    if (!rule) return null;
    for (const other of rules) {
      if (other.id === rule.id || !other.active || other.worktype !== rule.worktype || other.subtype !== rule.subtype || other.scope !== rule.scope) continue;
      const a = new Set(rule.scope === 'property' ? rule.portfolios : rule.communities);
      const shared = (other.scope === 'property' ? other.portfolios : other.communities).filter((k) => a.has(k));
      if (shared.length) return { rule: other, shared };
    }
    return null;
  }, [rules, rule]);

  const clientCost = rule ? (parseFloat(rule.vendorCost || '0') * (1 + parseFloat(rule.markupPct || '0') / 100)) : 0;
  const saveErrors: string[] = [];
  if (rule) {
    if (overlap) saveErrors.push(`Overlaps “${overlap.rule.name}” on: ${overlap.shared.join(', ')}. A property can only belong to one rule per work type + subtype (here: ${wtLabelD(rule.worktype)} · ${subLabelD(rule.worktype, rule.subtype)}).`);
    if (rule.recurring && missingMonths.length) saveErrors.push(`Every month must be tied to a cadence or set to no service. Missing: ${missingMonths.map((i) => MONTHS[i]).join(', ')}.`);
    if (!rule.recurring && !rule.initialDueDays.trim()) saveErrors.push('Set the first order due (days after enrollment) — a one-time service has no cadence to schedule from.');
    if (rule.vendors.length === 0) saveErrors.push('Assign at least one vendor.');
    // Enrollment criteria are OPTIONAL — with none, every applicable property
    // enrolls immediately. Any criterion that IS present still needs a value.
    if (rule.enrollCriteria.some((c) => !NO_VALUE_OPS.has(c.op) && !c.vals.length)) saveErrors.push('Every enrollment criterion needs a value.');
    if (rule.stopEnabled && rule.stopMode === 'condition') {
      if (!rule.stopCriteria.length) saveErrors.push('Add at least one stop criterion.');
      if (rule.stopCriteria.some((c) => !NO_VALUE_OPS.has(c.op) && !c.vals.length)) saveErrors.push('Every stop criterion needs a value.');
    }
    if (rule.stopEnabled && rule.stopMode === 'date' && !rule.stopDate) saveErrors.push('Set a stop date.');
    if (rule.stopEnabled && rule.stopMode === 'count' && (!rule.stopCount || Number(rule.stopCount) < 1)) saveErrors.push('Set the number of services before stopping.');
  }
  const canSave = saveErrors.length === 0;

  // Persist the open rule to HubSpot (create or update), stamp the returned id, close.
  const saveRule = async () => {
    if (!canSave || !rule) { closeRule(); return; }
    setSavingRule(true);
    try {
      const r = await fetch('/api/services/rules/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordId: rule.recordId, props: ruleToProps(rule) }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.id) patch({ recordId: d.id });
    } catch { /* preview / offline — keep local */ }
    finally { setSavingRule(false); closeRule(); }
  };

  // Ad-hoc: run THIS rule now to create any missing work orders. Idempotent — the
  // enrollment-key dedup means it only creates targets without an open order, so
  // it never duplicates what the nightly job (or a prior run) already made.
  const generateNow = async () => {
    if (!rule?.recordId || genBusy) return;
    setGenBusy(true); setGenMsg('');
    try {
      const r = await fetch(`/api/services/admin/generate?apply=1&ruleId=${encodeURIComponent(rule.recordId)}`);
      const d = await r.json();
      if (!r.ok) { setGenMsg(d.error || 'Generation failed.'); return; }
      if (d.configured === false) { setGenMsg('Services objects aren’t configured yet.'); return; }
      if (!d.rulesActive) { setGenMsg('This rule is inactive — nothing generated.'); return; }
      const created = d.created ?? 0, skipped = d.skippedExisting ?? 0, errors = d.errors ?? 0;
      const parts: string[] = [];
      if (created) parts.push(`Created ${created} work order${created === 1 ? '' : 's'}`);
      if (skipped) parts.push(`${skipped} already open`);
      if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
      setGenMsg(created ? parts.join(' · ') : (skipped ? `Up to date — ${skipped} already open` : 'No missing work orders to create.'));
      setWcReload((n) => n + 1);   // refresh the would-create count (some are now open)
    } catch { setGenMsg('Couldn’t reach the server. Try again.'); }
    finally { setGenBusy(false); }
  };

  // Fetch the accurate would-create count for the open (saved) rule.
  useEffect(() => {
    if (!canGenerate || !rule?.recordId) { setWouldCreate(null); return; }
    let alive = true;
    setWouldCreate(null);
    fetch(`/api/services/admin/generate?ruleId=${encodeURIComponent(rule.recordId)}`)
      .then((r) => r.json())
      .then((d) => { if (alive) { setWouldCreate(typeof d.wouldCreate === 'number' ? d.wouldCreate : 0); setMasterCoverage(typeof d.masterCoverage === 'number' ? d.masterCoverage : null); } })
      .catch(() => { if (alive) { setWouldCreate(null); setMasterCoverage(null); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rule?.recordId, canGenerate, wcReload]);

  const sec = 'bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm';
  const lbl = FIELD_LABEL;
  const ctl = 'text-[13px] px-2.5 py-1.5 border border-gray-300 rounded-lg bg-white text-ink';
  // Branded ListPicker trigger — replaces the native grey <select> boxes.
  const pick = 'text-[13px] px-2.5 py-1.5 border border-gray-300 rounded-lg bg-white text-ink flex items-center justify-between gap-1';
  const pickerCls = (active: boolean) =>
    `w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between ${active ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`;
  // Section header: click to expand/collapse, with a rotating chevron.
  const SecHead = ({ n, title }: { n: 1 | 2 | 3; title: string }) => (
    <button type="button" onClick={() => toggleSec(n)} aria-expanded={openSec[n]} className="w-full flex items-center justify-between gap-2 text-left">
      <h3 className="font-heading font-bold text-[15px] text-ink"><span className="text-brand">{n}.</span> {title}</h3>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-gray-400 transition-transform ${openSec[n] ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
    </button>
  );
  // Compact select: hides the wide native arrow and draws a small chevron, so the
  // cadence controls fit on one line without the day/day-of-week select clipping.
  const arrowStyle: React.CSSProperties = {
    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    backgroundImage: 'linear-gradient(45deg,transparent 50%,#9ca3af 50%),linear-gradient(135deg,#9ca3af 50%,transparent 50%)',
    backgroundPosition: 'calc(100% - 12px) center, calc(100% - 7px) center',
    backgroundSize: '5px 5px, 5px 5px', backgroundRepeat: 'no-repeat',
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader title="Rules Engine" onBack={() => { if (typeof window !== 'undefined' && window.history.length > 1) window.history.back(); else window.location.href = '/services'; }} backHref="/services" maxW="max-w-3xl" />

      {openId === null ? (
        /* ───────────── LIST VIEW: search + filters + rule cards ───────────── */
        <main className="max-w-3xl mx-auto w-full px-4 py-3">
          {/* Search + filter toggle — mirrors the Services home. */}
          <div className="flex items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-0">
              <input type="text" placeholder="Search rules by name…" value={search} onChange={(e) => setSearch(e.target.value)}
                className="w-full text-sm border border-gray-300 rounded-lg pl-3 pr-9 py-2.5 bg-white focus:outline-none focus:border-brand" />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </div>
            <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-label="Filters"
              className="shrink-0 inline-flex items-center justify-center gap-1 w-14 h-11 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50 transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${filtersOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          </div>

          {/* Collapsible: Work Type / Subtype / Region / Community + Sort. */}
          {filtersOpen && (
            <div className="mb-3">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <MultiFilter label="Type" selected={fWork} onChange={(next) => { setFWork(next); setFSub([]); }} className={pickerCls(fWork.length > 0)}
                  options={defs.map((w) => ({ value: w.id, label: w.label }))} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Sub" selected={fSub} onChange={setFSub} className={pickerCls(fSub.length > 0)} options={subFilterUnique} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Region" selected={fRegion} onChange={setFRegion} className={pickerCls(fRegion.length > 0)}
                  options={coverage.regions.map((r) => ({ value: r.key, label: r.key }))} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Com" selected={fCommunity} onChange={setFCommunity} className={pickerCls(fCommunity.length > 0)}
                  options={coverage.communities.map((c) => ({ value: c.name, label: c.name }))} />
              </div>
              {/* Sort — tap a field to sort; tap the active field again to flip direction. */}
              <div className="relative shrink-0">
                <button type="button" onClick={() => setSortOpen((o) => !o)} aria-expanded={sortOpen}
                  className="inline-flex items-center gap-1 text-[11px] font-heading font-semibold text-gray-700 hover:text-brand px-2 py-1.5 border border-gray-300 rounded-md bg-white"
                  title="Choose how to sort. Tap the selected field again to reverse the order.">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6" /><line x1="7" y1="12" x2="17" y2="12" /><line x1="10" y1="18" x2="14" y2="18" /></svg>
                  <span>Sort</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${sortOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
                </button>
                {sortOpen && (<><div className="fixed inset-0 z-30" onClick={() => setSortOpen(false)} />
                  <div className="absolute right-0 z-40 mt-1 w-40 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                    {RULE_SORT.map((opt) => {
                      const active = sortField === opt.value;
                      return (
                        <button key={opt.value} type="button"
                          onClick={() => { active ? setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')) : setSortField(opt.value); }}
                          className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-heading font-semibold text-left ${active ? 'text-brand bg-pink-50' : 'text-gray-700 hover:bg-gray-50'}`}>
                          <span>{opt.label}</span>
                          {active && <span className="text-brand">{sortDir === 'asc' ? '↑' : '↓'}</span>}
                        </button>
                      );
                    })}
                  </div></>)}
              </div>
            </div>
            {(fWork.length > 0 || fSub.length > 0 || fRegion.length > 0 || fCommunity.length > 0 || search) && (
              <div className="flex justify-end mt-1.5">
                <button type="button" onClick={() => { setFWork([]); setFSub([]); setFRegion([]); setFCommunity([]); setSearch(''); }}
                  className="text-[11px] font-heading font-semibold text-gray-500 hover:text-brand underline">Clear filters</button>
              </div>
            )}
            </div>
          )}

          <button onClick={addRule} className="w-full mb-3 text-brand bg-brand/5 border border-dashed border-brand/40 rounded-xl py-2.5 text-[13px] font-heading font-bold">+ New Rule</button>

          <div className="space-y-2">
            {visibleRules.map((r) => (
              <div key={r.id} role="button" tabIndex={0} onClick={() => openRule(r.id)} onKeyDown={(e) => { if (e.key === 'Enter') openRule(r.id); }}
                className={`bg-white border rounded-xl p-3.5 cursor-pointer hover:border-brand/40 transition ${r.active ? 'border-gray-200' : 'border-gray-200 opacity-60'}`}>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-heading font-bold text-[14px] text-ink leading-tight">
                      {r.name} <span className="text-brand font-extrabold whitespace-nowrap">({countLabel(countFor(r))})</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.scope === 'community' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{r.scope === 'community' ? 'Community' : 'SFR'}</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{wtLabelD(r.worktype)} · {subLabelD(r.worktype, r.subtype)}</span>
                      {!r.active && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Paused</span>}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1 truncate">
                      {r.scope === 'community'
                        ? (r.communities.join(', ') || 'No communities')
                        : `${r.portfolios.join(', ') || 'No portfolios'} · ${r.regions.length ? r.regions.join(', ') : 'All regions'}`}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, active: !x.active } : x)); }}
                      title={r.active ? 'Active — click to pause' : 'Inactive — click to activate'}
                      className={`relative rounded-full transition ${r.active ? 'bg-brand' : 'bg-gray-300'}`} style={{ height: 18, width: 32 }}>
                      <span className="absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition" style={{ transform: r.active ? 'translateX(14px)' : 'none' }} />
                    </button>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-gray-300"><polyline points="9 18 15 12 9 6" /></svg>
                  </div>
                </div>
              </div>
            ))}
            {visibleRules.length === 0 && (
              <div className="text-center text-gray-500 text-sm py-12 border border-dashed border-gray-300 rounded-xl">No rules match these filters.</div>
            )}
          </div>
        </main>
      ) : (
        /* ───────────── EDIT VIEW: one rule, collapsible sections ───────────── */
        <main className="max-w-3xl mx-auto w-full space-y-4 p-4">
          <div className="flex items-center gap-3">
            <button onClick={closeRule} className="inline-flex items-center gap-1 text-sm font-semibold text-gray-600 hover:text-brand shrink-0">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
              Rules
            </button>
            <div className="ml-auto text-right shrink-0">
              <div className="text-xl font-heading font-extrabold text-ink tabular-nums leading-none">{coveredDisplay}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Properties Covered</div>
            </div>
          </div>
          <div>
            <label className={lbl}>Rule Name</label>
            <div className="flex items-end gap-2">
              <input value={rule.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Name this rule"
                className="flex-1 min-w-0 font-heading font-extrabold text-xl text-ink bg-white border border-gray-300 rounded-lg px-3 py-1.5 focus:border-brand focus:outline-none" />
              <button onClick={duplicateRule} className="shrink-0 text-[12px] font-semibold text-gray-500 hover:text-brand border border-gray-300 rounded-lg px-2.5 py-2 bg-white">Duplicate</button>
              <button onClick={() => deleteRule(rule.id)} className="shrink-0 text-[12px] font-semibold text-gray-500 hover:text-red-600 border border-gray-300 rounded-lg px-2.5 py-2 bg-white">Delete</button>
            </div>
          </div>

          {/* SECTION 1 — scope & pricing */}
          <section className={sec}>
            <SecHead n={1} title="Work Type, Coverage & Pricing" />
            {openSec[1] && (<div className="mt-4">
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div className="w-40">
                <label className={lbl}>Work Type</label>
                <ListPicker value={rule.worktype} ariaLabel="Work type" className={`${pick} w-full`}
                  options={defs.filter((w) => w.scopes.includes(rule.scope)).map((w) => ({ value: w.id, label: w.label }))}
                  onChange={(v) => { const wt = v as Worktype; const sub = firstSubOf(wt); patch({ worktype: wt, subtype: sub, vendorCost: baseRate(wt, sub), description: descriptionFor(wt, sub), ...cutEnroll(rule.scope, wt, sub) }); }} />
              </div>
              <div className="w-40">
                <label className={lbl}>Subtype</label>
                <ListPicker value={rule.subtype} ariaLabel="Subtype" className={`${pick} w-full`}
                  options={subsOfD(rule.worktype).map((st) => ({ value: st.id, label: st.label }))}
                  onChange={(v) => patch({ subtype: v, vendorCost: baseRate(rule.worktype, v), description: descriptionFor(rule.worktype, v), ...cutEnroll(rule.scope, rule.worktype, v) })} />
              </div>
              <div>
                <label className={lbl}>Coverage</label>
                <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
                  <button onClick={() => patch({ scope: 'property' })} className={`px-3 py-1.5 rounded-md ${rule.scope === 'property' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600'}`}>Property</button>
                  <button onClick={() => patch({ scope: 'community', ...cutEnroll('community', rule.worktype, rule.subtype) })} className={`px-3 py-1.5 rounded-md ${rule.scope === 'community' ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-600'}`}>Community</button>
                </div>
              </div>
            </div>
            {rule.scope === 'community' && !(rule.worktype === 'landscaping' && rule.subtype === 'cut') && (
              <div className="mb-4">
                <label className={lbl}>Include Pet Stations?</label>
                <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
                  <button onClick={() => patch({ petStations: true })} className={`px-4 py-1.5 rounded-md ${rule.petStations ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>Yes</button>
                  <button onClick={() => patch({ petStations: false })} className={`px-4 py-1.5 rounded-md ${!rule.petStations ? 'bg-white text-ink shadow-sm' : 'text-gray-600'}`}>No</button>
                </div>
              </div>
            )}
            <div className="mb-4">
              <label className={lbl}>Service Description</label>
              <AutoGrowTextarea value={rule.description} onChange={(e) => patch({ description: e.target.value })} minPx={60}
                className="w-full text-[13px] border border-gray-300 rounded-lg px-3 py-2 bg-white text-ink focus:outline-none focus:border-brand" />
            </div>
            <label className={lbl}>{rule.scope === 'property' ? 'Portfolios' : 'Communities'}</label>
            <CoveragePicker
              noun={rule.scope === 'property' ? 'portfolios' : 'communities'}
              options={rule.scope === 'property' ? coverage.portfolios : coverage.communities.map((c) => ({ key: c.name, count: c.units }))}
              selected={rule.scope === 'property' ? rule.portfolios : rule.communities}
              onToggle={toggleCoverage}
              onSetMany={setManyCoverage}
            />
            {(rule.scope === 'property' ? rule.portfolios : rule.communities).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2 mb-4">
                {(rule.scope === 'property' ? rule.portfolios : rule.communities).map((k) => (
                  <span key={k} className="inline-flex items-center gap-1.5 text-[12px] font-semibold bg-brand/10 text-brand border border-brand/30 rounded-full pl-2.5 pr-1.5 py-0.5">
                    {k}<button onClick={() => toggleCoverage(k)} className="hover:text-red-600" aria-label={`Remove ${k}`}>×</button>
                  </span>
                ))}
              </div>
            )}
            {/* Property scope: dependent Region filter + individual property drill-down. */}
            {rule.scope === 'property' && rule.portfolios.length > 0 && (
              <div className="mt-3">
                <label className={lbl}>Regions <span className="text-gray-400 normal-case font-normal">— from the selected portfolios</span></label>
                <CoveragePicker noun="regions" options={regionOptions} selected={rule.regions} onToggle={toggleRegion} onSetMany={setManyRegions} />
                {rule.regions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {rule.regions.map((k) => (
                      <span key={k} className="inline-flex items-center gap-1.5 text-[12px] font-semibold bg-brand/10 text-brand border border-brand/30 rounded-full pl-2.5 pr-1.5 py-0.5">
                        {k}<button onClick={() => toggleRegion(k)} className="hover:text-red-600" aria-label={`Remove ${k}`}>×</button>
                      </span>
                    ))}
                  </div>
                )}

                <label className={`${lbl} mt-3`}>Applicable Properties</label>
                <div className="border border-gray-200 rounded-xl max-w-md">
                  <button type="button" onClick={() => setPropsOpen((o) => !o)} className="w-full flex items-center justify-between px-3 py-2.5 text-[13px] font-semibold text-ink">
                    <span className="text-brand font-bold">{coveredDisplay} <span className="text-gray-500 font-semibold">included</span></span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${propsOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                  {propsOpen && (
                    <div className="border-t border-gray-100">
                      <div className="p-2 border-b border-gray-100">
                        <input value={propSearch} onChange={(e) => setPropSearch(e.target.value)} placeholder="Search address, city, or zip…"
                          className="w-full text-[13px] px-2.5 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:border-brand" />
                      </div>
                      <div className="flex gap-4 px-3 py-2 text-[12px] font-semibold border-b border-gray-100">
                        <button onClick={selectAllProps} className="text-brand">Select all</button>
                        <button onClick={deselectAllProps} className="text-gray-500 hover:text-ink">Deselect all</button>
                        <span className="ml-auto text-gray-400 font-normal">{rule.propsMode === 'all' ? 'All · new auto-include' : `${coveredCount} of ${applicableProps.length}`}</span>
                      </div>
                      <div className="max-h-60 overflow-y-auto">
                        {visibleProps.map((p) => {
                          const on = isPropOn(p.id);
                          return (
                            <button key={p.id} type="button" onClick={() => toggleProp(p.id)} className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-gray-50 text-left">
                              <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] font-bold shrink-0 ${on ? 'bg-brand border-brand text-white' : 'border-gray-300'}`}>{on ? '✓' : ''}</span>
                              <span className="flex-1 min-w-0">
                                <span className="block truncate text-ink">{p.address}</span>
                                {p.locality && <span className="block truncate text-[11px] text-gray-400">{p.locality}</span>}
                              </span>
                              <span className="text-[11px] text-gray-400 shrink-0">{p.region.replace('GA: ', '')}</span>
                            </button>
                          );
                        })}
                        {visibleProps.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-gray-400">{loadingProps ? 'Loading properties…' : applicableProps.length === 0 ? 'No properties for these portfolios/regions.' : 'No properties match your search.'}</div>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label className={lbl}>Cost Detail</label>
              {rule.scope === 'property' && rule.worktype === 'landscaping' && rule.subtype === 'cut' ? (
                <>
                  {/* Grass cut: the vendor payout is set by the grass height at
                      completion, so pricing is three tiers. Standard also drives the
                      base vendor/client shown before completion. All five fields
                      sit on ONE row (scrolls horizontally on a narrow screen). */}
                  <div className="flex flex-nowrap items-end gap-3 sm:justify-start overflow-x-auto">
                    <PriceField label="Standard (<6 in)" adorn="$" minDecimals={2} colClass="shrink-0 w-24"
                      value={rule.grassStandard ?? String(DEFAULT_GRASS_TIERS.standard)} onChange={(v) => patch({ grassStandard: v, vendorCost: v })} />
                    <PriceField label="Overgrown (6–12 in)" adorn="$" minDecimals={2} colClass="shrink-0 w-24"
                      value={rule.grassOvergrown ?? String(DEFAULT_GRASS_TIERS.overgrown)} onChange={(v) => patch({ grassOvergrown: v })} />
                    <PriceField label="Heavy (>12 in)" adorn="$" minDecimals={2} colClass="shrink-0 w-24"
                      value={rule.grassHeavy ?? String(DEFAULT_GRASS_TIERS.heavy)} onChange={(v) => patch({ grassHeavy: v })} />
                    <PriceField label="Markup %" adorn="%" side="right" minDecimals={1} colClass="shrink-0 w-24" value={rule.markupPct} onChange={(v) => patch({ markupPct: v })} />
                    <PriceField label="Client (Standard)" adorn="$" highlight readOnly colClass="shrink-0 w-28" value={clientCost.toFixed(2)} />
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1.5">Vendor payout is set by the grass height at completion; the markup applies to each tier.</p>
                </>
              ) : (
                <div className="flex flex-nowrap items-end justify-center gap-4 sm:justify-start">
                  <PriceField label="Vendor Cost" adorn="$" minDecimals={2} colClass="shrink-0 w-24" value={rule.vendorCost} onChange={(v) => patch({ vendorCost: v })} />
                  <PriceField label="Markup %" adorn="%" side="right" minDecimals={1} colClass="shrink-0 w-24" value={rule.markupPct} onChange={(v) => patch({ markupPct: v })} />
                  <PriceField label="Client Cost" adorn="$" highlight readOnly colClass="shrink-0 w-24" value={clientCost.toFixed(2)} />
                </div>
              )}
            </div>

            {/* Vendor Assignment — one or more companies; count = current open volume. */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label className={lbl}>Vendor Assignment</label>
              <CoveragePicker noun="vendors" options={vendorNames.map((v) => ({ key: v, count: vendorOpen[v] || 0 }))} selected={rule.vendors} onToggle={toggleVendor} onSetMany={setManyVendors} />
              {rule.vendors.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {rule.vendors.map((v) => (
                    <span key={v} className="inline-flex items-center gap-1.5 text-[12px] font-semibold bg-brand/10 text-brand border border-brand/30 rounded-full pl-2.5 pr-1.5 py-0.5">
                      {v}<button onClick={() => toggleVendor(v)} className="hover:text-red-600" aria-label={`Remove ${v}`}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
                {rule.vendors.length <= 1
                  ? 'One vendor → every service on this rule is assigned to them.'
                  : `${rule.vendors.length} vendors → new enrollments are rotated to keep open volume even across them. A property keeps the same vendor for every service until enrollment stops; if it re-enrolls later it rejoins the equal-volume rotation.`}
              </p>
            </div>
            </div>)}
          </section>

          {/* SECTION 2 — cadence */}
          <section className={sec}>
            <SecHead n={2} title="Cadence" />
            {openSec[2] && (<div className="mt-3">
            {/* First order due — optional (required when one-time); blank = due on the enrollment date. */}
            <div className="mb-3">
              <label className={lbl}>First Order Due{!rule.recurring && <span className="text-brand"> *</span>}</label>
              <div className="bg-brand/5 border border-brand/20 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 whitespace-nowrap text-[13px]">
                  <input value={rule.initialDueDays} inputMode="numeric" onChange={(e) => patch({ initialDueDays: e.target.value.replace(/\D/g, '') })} placeholder="—"
                    className={`${ctl} w-12 text-center tabular-nums ${!rule.recurring && !rule.initialDueDays.trim() ? 'border-red-300' : ''}`} />
                  <span className="text-gray-600">days after enrollment</span>
                </div>
                <div className="text-[11px] text-gray-400 mt-1">{rule.recurring ? 'Optional — the first order lands this many days after enrollment; the cadence takes over after that.' : 'Required — a one-time service has no cadence to schedule from.'}</div>
              </div>
            </div>

            {/* Is this recurring? — gates the cadence UI. */}
            <div className="mb-3">
              <label className={lbl}>Is This Recurring?</label>
              <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
                <button onClick={() => patch({ recurring: true, ...(rule.cadences.length === 0 ? { cadences: [newCadence([...Array(12).keys()])] } : {}) })} className={`px-4 py-1.5 rounded-md ${rule.recurring ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>Yes</button>
                <button onClick={() => patch({ recurring: false })} className={`px-4 py-1.5 rounded-md ${!rule.recurring ? 'bg-white text-ink shadow-sm' : 'text-gray-600'}`}>No</button>
              </div>
              <div className="text-[11px] text-gray-400 mt-1">{rule.recurring ? 'Recurs on the cadence below.' : 'One-time — a single service is created on enrollment.'}</div>
            </div>

            {rule.recurring && (
              <>
                <div className="space-y-3">
                  {rule.cadences.map((c) => (
                    <div key={c.id} className="relative border border-gray-200 rounded-xl p-3 pr-8 bg-gray-50">
                      {rule.cadences.length > 1 && (
                        <button onClick={() => patch({ cadences: rule.cadences.filter((x) => x.id !== c.id) })}
                          aria-label="Delete cadence" title="Delete cadence"
                          className="absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 text-lg leading-none">×</button>
                      )}
                      <div className="flex flex-nowrap items-center gap-1.5 mb-2">
                        <span className="text-[13px] text-gray-600 shrink-0">Every</span>
                        <input value={c.interval} inputMode="numeric" onChange={(e) => patchCadence(c.id, { interval: e.target.value.replace(/\D/g, '') })} className={`${ctl} w-11 shrink-0 text-center tabular-nums`} />
                        <select value={c.unit} onChange={(e) => patchCadence(c.id, { unit: e.target.value as Unit })} className={`${ctl} shrink-0 pr-6`} style={arrowStyle}>
                          <option value="days">days</option><option value="months">months</option>
                        </select>
                        {c.unit === 'days' ? (
                          <><span className="text-[13px] text-gray-600 shrink-0">on</span>
                          <select value={c.dow} onChange={(e) => patchCadence(c.id, { dow: Number(e.target.value) })} className={`${ctl} shrink-0 pr-6`} style={arrowStyle}><option value={-1}>any day</option>{DOW.map((d, di) => <option key={d} value={di}>{d}</option>)}</select></>
                        ) : (
                          <><span className="text-[13px] text-gray-600 shrink-0 whitespace-nowrap">on day</span>
                          <select value={c.dom} onChange={(e) => patchCadence(c.id, { dom: Number(e.target.value) })} className={`${ctl} shrink-0 pr-6`} style={arrowStyle}><option value={0}>any day</option>{Array.from({ length: 28 }, (_, di) => di + 1).map((d) => <option key={d} value={d}>{d}</option>)}</select></>
                        )}
                      </div>
                      {/* The due date IS the scheduled service date — no separate completion window. */}
                      <div className="text-[11px] text-gray-400 mb-2.5 leading-snug">
                        {c.unit === 'days'
                          ? (c.dow >= 0
                              ? `First order lands on the next ${DOW[c.dow]}; each next order is due one cadence (${c.interval || '—'} days) after the prior service is completed.`
                              : 'The first order seeds the rhythm; each next order is due one cadence after the prior service is completed.')
                          : `A fixed calendar date${c.dom > 0 ? ` (the ${c.dom}${c.dom === 1 ? 'st' : c.dom === 2 ? 'nd' : c.dom === 3 ? 'rd' : 'th'})` : ''} each ${c.interval && c.interval !== '1' ? `${c.interval} months` : 'month'} — best for contract billing.`}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {MONTHS.map((m, mi) => {
                          const on = c.months.includes(mi);
                          return <button key={m} onClick={() => toggleMonth(c.id, mi)} className={`text-[11.5px] font-heading font-semibold px-2.5 py-1 rounded-md border ${on ? 'bg-brand text-white border-brand' : 'bg-white text-gray-600 border-gray-300'}`}>{m}</button>;
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                {/* No-service block — added on demand via "+ No Service". */}
                {showSkip && (
                  <div className="mt-3 relative border border-dashed border-gray-300 rounded-xl p-3 pr-8 bg-white">
                    <button onClick={() => { setShowSkip(false); patch({ skipMonths: [] }); }} aria-label="Remove no-service block" title="Remove no-service block"
                      className="absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 text-lg leading-none">×</button>
                    <div className="text-[12px] font-semibold text-gray-600 mb-2">No Service — Skip These Months</div>
                    <div className="flex flex-wrap gap-1.5">
                      {MONTHS.map((m, mi) => {
                        const on = rule.skipMonths.includes(mi);
                        return <button key={m} onClick={() => toggleSkipMonth(mi)} className={`text-[11.5px] font-heading font-semibold px-2.5 py-1 rounded-md border ${on ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-600 border-gray-300'}`}>{m}</button>;
                      })}
                    </div>
                  </div>
                )}
                <div className="flex flex-wrap gap-2 mt-3">
                  <button onClick={() => patch({ cadences: [...rule.cadences, newCadence(missingMonths)] })} className="text-[12px] font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1 bg-white hover:border-brand/40">+ Cadence</button>
                  {!showSkip && <button onClick={() => setShowSkip(true)} className="text-[12px] font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1 bg-white hover:border-brand/40">+ No Service</button>}
                </div>
                <div className={`mt-3 text-[12.5px] font-semibold ${missingMonths.length ? 'text-red-600' : 'text-emerald-600'}`}>
                  {missingMonths.length ? `Not all months accounted for — missing: ${missingMonths.map((i) => MONTHS[i]).join(', ')}` : 'All 12 months accounted for ✓'}
                </div>
              </>
            )}
            </div>)}
          </section>

          {/* SECTION 3 — enrollment & stop */}
          <section className={sec}>
            <SecHead n={3} title="Enrollment & Stop" />
            {openSec[3] && (<div className="mt-3">
            <label className={lbl}>Enroll When</label>
            {/* Rule-level start date — the rule stays dormant (creates nothing) until this date. */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-[13px] text-gray-600">Starts on</span>
              <DatePicker value={rule.startDate} onChange={(v) => patch({ startDate: v })} placeholder="Immediately" className={`${ctl} flex items-center justify-between gap-2 min-w-[9rem]`} />
              <span className="text-[12px] text-gray-400">{rule.startDate ? '— dormant until this date.' : '— leave blank to begin now.'}</span>
            </div>
            <div className="space-y-2 mb-4">
              {rule.enrollCriteria.map((c, i) => (
                <div key={i}>
                  {i > 0 && (
                    <button type="button" onClick={() => patch({ enrollCombinator: rule.enrollCombinator === 'or' ? 'and' : 'or' })}
                      className="mb-1 text-[11px] font-bold uppercase tracking-wide text-brand border border-brand/40 rounded px-2 py-0.5 hover:bg-brand/5">
                      {rule.enrollCombinator === 'or' ? 'OR' : 'AND'}
                    </button>
                  )}
                  <div className="flex items-center gap-1.5">
                    <div className="basis-[34%] shrink min-w-0">
                      <ListPicker value={c.field} ariaLabel="Enrollment field" className={`${pick} w-full`}
                        options={FIELD_NAMES.map((f) => ({ value: f, label: f }))}
                        onChange={(v) => { const first = enrollValueOptsFor(v)[0]?.value; patchCrit(i, { field: v, op: opsFor(v)[0], vals: first ? [first] : [] }); }} />
                    </div>
                    <div className="basis-[26%] shrink min-w-0">
                      <ListPicker value={c.op} ariaLabel="Operator" className={`${pick} w-full`}
                        options={opsFor(c.field).map((o) => ({ value: o, label: o }))}
                        onChange={(v) => patchCrit(i, { op: v, ...(!isMultiOp(v) && c.vals.length > 1 ? { vals: c.vals.slice(0, 1) } : {}) })} />
                    </div>
                    <div className="flex-1 min-w-0">
                      {c.op === 'is known' ? (
                        <span className="text-[12px] text-gray-500">has any date</span>
                      ) : c.op === 'is greater than $0' ? (
                        <span className="text-[12px] text-gray-500">pool fee &gt; $0</span>
                      ) : isMultiOp(c.op) ? (
                        <MultiFilter label="Values" sheet options={enrollValueOptsFor(c.field)} selected={c.vals}
                          onChange={(next) => patchCrit(i, { vals: next })} className={`${pick} w-full`} />
                      ) : (
                        <ListPicker value={c.vals[0] || ''} ariaLabel="Value" className={`${pick} w-full`}
                          options={enrollValueOptsFor(c.field)} onChange={(v) => patchCrit(i, { vals: [v] })} />
                      )}
                    </div>
                    <button type="button" onClick={() => removeCrit(i)} aria-label="Remove criterion"
                      className="shrink-0 text-gray-400 hover:text-red-500 text-[18px] leading-none px-1">×</button>
                  </div>
                </div>
              ))}
              <button type="button" onClick={addCrit}
                className="text-[12px] font-semibold text-brand border border-brand/40 rounded-lg px-2.5 py-1 bg-white hover:bg-brand/5">+ Add criterion</button>
            </div>
            <label className="flex items-center gap-2 mb-1 cursor-pointer">
              <input type="checkbox" checked={rule.stopEnabled} onChange={(e) => patch({ stopEnabled: e.target.checked })} />
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Stop Criteria <span className="normal-case font-normal text-gray-400">(optional)</span></span>
            </label>
            {rule.stopEnabled && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-gray-600">Stop</span>
                  <ListPicker value={rule.stopMode} ariaLabel="Stop mode" className={pick}
                    options={[{ value: 'condition', label: 'when a field changes' }, { value: 'date', label: 'on a date' }, { value: 'count', label: 'after N services' }]}
                    onChange={(v) => patch({ stopMode: v as Rule['stopMode'] })} />
                </div>
                {rule.stopMode === 'condition' && (
                  <>
                    {rule.stopCriteria.map((c, i) => (
                      <div key={i}>
                        {i > 0 && (
                          <button type="button" onClick={() => patch({ stopCombinator: rule.stopCombinator === 'or' ? 'and' : 'or' })}
                            className="mb-1 text-[11px] font-bold uppercase tracking-wide text-brand border border-brand/40 rounded px-2 py-0.5 hover:bg-brand/5">
                            {rule.stopCombinator === 'or' ? 'OR' : 'AND'}
                          </button>
                        )}
                        <div className="flex items-center gap-1.5">
                          <div className="basis-[34%] shrink min-w-0">
                            <ListPicker value={c.field} ariaLabel="Stop field" className={`${pick} w-full`}
                              options={FIELD_NAMES.map((f) => ({ value: f, label: f }))}
                              onChange={(v) => { const first = valueOptsFor(v)[0]?.value; patchStopCrit(i, { field: v, op: opsFor(v)[0], vals: first ? [first] : [] }); }} />
                          </div>
                          <div className="basis-[26%] shrink min-w-0">
                            <ListPicker value={c.op} ariaLabel="Operator" className={`${pick} w-full`}
                              options={opsFor(c.field).map((o) => ({ value: o, label: o }))}
                              onChange={(v) => patchStopCrit(i, { op: v, ...(!isMultiOp(v) && c.vals.length > 1 ? { vals: c.vals.slice(0, 1) } : {}) })} />
                          </div>
                          <div className="flex-1 min-w-0">
                            {c.op === 'is known' ? (
                              <span className="text-[12px] text-gray-500">has any date</span>
                            ) : c.op === 'is greater than $0' ? (
                              <span className="text-[12px] text-gray-500">pool fee &gt; $0</span>
                            ) : isMultiOp(c.op) ? (
                              <MultiFilter label="Values" sheet options={valueOptsFor(c.field)} selected={c.vals}
                                onChange={(next) => patchStopCrit(i, { vals: next })} className={`${pick} w-full`} />
                            ) : (
                              <ListPicker value={c.vals[0] || ''} ariaLabel="Value" className={`${pick} w-full`}
                                options={valueOptsFor(c.field)} onChange={(v) => patchStopCrit(i, { vals: [v] })} />
                            )}
                          </div>
                          {rule.stopCriteria.length > 1 && (
                            <button type="button" onClick={() => removeStopCrit(i)} aria-label="Remove stop criterion"
                              className="shrink-0 text-gray-400 hover:text-red-500 text-[18px] leading-none px-1">×</button>
                          )}
                        </div>
                      </div>
                    ))}
                    <button type="button" onClick={addStopCrit}
                      className="text-[12px] font-semibold text-brand border border-brand/40 rounded-lg px-2.5 py-1 bg-white hover:bg-brand/5">+ Add criterion</button>
                  </>
                )}
                {rule.stopMode === 'date' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] text-gray-600">On</span>
                    <DatePicker value={rule.stopDate} onChange={(v) => patch({ stopDate: v })} placeholder="Pick a date" className={`${ctl} flex items-center justify-between gap-2 min-w-[9rem] ${!rule.stopDate ? 'border-red-300' : ''}`} />
                    <span className="text-[13px] text-gray-600">— cancels remaining open orders past this date.</span>
                  </div>
                )}
                {rule.stopMode === 'count' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] text-gray-600">After</span>
                    <input value={rule.stopCount} inputMode="numeric" onChange={(e) => patch({ stopCount: e.target.value.replace(/\D/g, '') })} placeholder="—"
                      className={`${ctl} w-16 text-center tabular-nums ${!rule.stopCount ? 'border-red-300' : ''}`} />
                    <span className="text-[13px] text-gray-600">services completed on this property.</span>
                  </div>
                )}
              </div>
            )}
            </div>)}
          </section>

          {/* save */}
          <div className="sticky bottom-0 bg-gray-50 pt-3 pb-1">
            {saveErrors.map((e, i) => (
              <div key={i} className="mb-2 text-[12.5px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">⚠ {e}</div>
            ))}
            <button onClick={saveRule} disabled={!canSave || savingRule} className={`w-full rounded-2xl py-3 font-heading font-bold text-sm ${canSave && !savingRule ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
              {savingRule ? 'Saving…' : canSave ? 'Save & Close' : 'Resolve the Issues Above to Save'}
            </button>
            {/* Live target count (from the coverage catalog — updates as the rule's
                scope changes) + a compact ad-hoc Generate (idempotent: only fills
                gaps, never duplicates what's already open or the nightly job made). */}
            {canGenerate && rule && (
              <>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <div className="text-[13px] text-ink">
                    {rule.recordId
                      ? (rule.scope === 'community' && rule.worktype === 'landscaping' && rule.subtype === 'cut')
                        ? <>Would create <span className="font-heading font-extrabold">1</span> Master Service{masterCoverage != null ? <> (for <span className="font-heading font-extrabold">{masterCoverage.toLocaleString()}</span> propert{masterCoverage === 1 ? 'y' : 'ies'})</> : ''}</>
                        : <>Would create <span className="font-heading font-extrabold">{wouldCreate == null ? '…' : wouldCreate.toLocaleString()}</span> work order{wouldCreate === 1 ? '' : 's'}</>
                      : <span className="text-gray-500">Save the rule to see how many it would create.</span>}
                    {genMsg && <span className="block text-[12px] font-heading font-semibold text-gray-600">{genMsg}</span>}
                  </div>
                  <button onClick={generateNow} disabled={genBusy || !rule.recordId}
                    title={rule.recordId ? '' : 'Save the rule first'}
                    className="shrink-0 rounded-xl px-3.5 py-2 text-[12px] font-heading font-bold border border-brand text-brand bg-white disabled:opacity-50">
                    {genBusy ? '…' : 'Generate now'}
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-gray-400">Generate makes only the missing ones — safe anytime; the nightly job fills the rest.</p>
              </>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
