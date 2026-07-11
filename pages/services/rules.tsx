import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { WORKTYPES, worktypeLabel, subtypeLabel, descriptionFor, subtypesFor, defaultRateFor, type Worktype } from '@/lib/services/worktypes';
import { PriceField } from '@/components/PriceField';
import { MultiFilter } from '@/components/MultiFilter';
import { SAMPLE_PROPERTIES, SAMPLE_REGIONS, SAMPLE_SERVICES, SAMPLE_VENDORS } from '@/lib/services/sampleData';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};

// Sample reference data (real lists come from Property / Community in a later step).
// Portfolio counts are derived from the sample properties so the drill-down list,
// the region counts, and "Properties Covered" all agree.
const PORTFOLIOS: Record<string, number> = SAMPLE_PROPERTIES.reduce((m, p) => { m[p.portfolio] = (m[p.portfolio] || 0) + 1; return m; }, {} as Record<string, number>);
const COMMUNITIES: Record<string, number> = { 'Woodbine Crossing': 96, 'River Glen': 124, 'Camden Pointe': 88, 'Harlow Trace': 78, 'Stonecreek': 142, 'Maple Run': 64 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Current OPEN service volume per vendor — the basis for the equal-volume
// rotation shown next to each company in the vendor picker.
const OPEN_SERVICE_STATUSES = ['estimated', 'assigned', 'submitted', 'review'];
const VENDOR_OPEN: Record<string, number> = SAMPLE_SERVICES.reduce((m, s) => {
  if (s.vendor && OPEN_SERVICE_STATUSES.includes(s.status)) m[s.vendor] = (m[s.vendor] || 0) + 1;
  return m;
}, {} as Record<string, number>);
const DEFAULT_MARKUP = '20';   // default markup % on all services
// First subtype's default rate for a worktype (used to prefill vendor cost).
const firstSubtype = (wt: Worktype): string => subtypesFor(wt)[0]?.id || '';
const baseRate = (wt: Worktype, sub: string): string => { const r = defaultRateFor(wt, sub); return r != null ? String(r) : ''; };
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Curated Property (and associated-Deal) fields for enrollment / stop criteria,
// each with its own value options so the value picker "flows" from the chosen
// field. (Sample list for now; expands as we wire the real Property + Deal objects.)
const PROPERTY_FIELDS: { field: string; options: string[] }[] = [
  { field: 'Property Status', options: ['Vacant', 'Pending MOI/Rekey', 'Occupied', 'Under Turnkey', 'Eviction'] },
  { field: 'Home Type', options: ['Single-Family', 'Townhome', 'Condo', 'Duplex'] },
  { field: 'Recurring Services', options: ['Enrolled', 'Paused', 'Not Enrolled'] },
  { field: 'Has Pool', options: ['Yes', 'No'] },
  { field: 'Occupancy', options: ['Vacant', 'Occupied'] },
  // Associated leasing-pipeline Deal stage — powers event-triggered, run-once
  // dispatches like move-in cleans (enroll on the transition INTO a stage).
  { field: 'Deal Stage', options: ['Application', 'Approved', 'Lease Signed', 'Move-In Scheduled', 'Moved In', 'Leased'] },
];
const FIELD_NAMES = PROPERTY_FIELDS.map((f) => f.field);
const optsFor = (field: string) => PROPERTY_FIELDS.find((f) => f.field === field)?.options ?? [];
const OPS = ['is', 'is any of', 'is not', 'changes to'];

// Rules-list sort (mirrors the Services home sort: tap a field, re-tap to flip).
type RuleSortField = 'name' | 'coverage' | 'worktype' | 'region' | 'community';
const RULE_SORT: { value: RuleSortField; label: string }[] = [
  { value: 'name', label: 'Name' }, { value: 'coverage', label: 'Coverage' }, { value: 'worktype', label: 'Work Type' },
  { value: 'region', label: 'Region' }, { value: 'community', label: 'Community' },
];

type Unit = 'days' | 'weeks' | 'months';
// interval is a STRING so it can be cleared/retyped; dow -1 and dom 0 mean "Any day".
interface Cadence { id: number; unit: Unit; interval: string; dow: number; dom: number; months: number[]; }
interface Rule {
  id: number; name: string; active: boolean; worktype: Worktype; subtype: string;
  petStations: boolean;                     // community only: capture dedicated pet-station before/after
  scope: 'property' | 'community'; portfolios: string[]; communities: string[];
  regions: string[];                        // property scope: dependent region filter (empty = all)
  propsMode: 'all' | 'list';                // 'all' = every applicable property incl. future adds; 'list' = a fixed subset
  includedProps: string[];                  // property scope, 'list' mode only: the specific property ids included
  vendorCost: string; markupPct: string;   // strings so decimals can be typed freely
  vendors: string[];                        // assigned company/companies (1 = always; many = equal-volume rotation)
  description: string;                      // scope-of-work language (defaults from the worktype; editable)
  recurring: boolean;                       // false = one-time (no cadence); true = recurring (cadences required)
  cadences: Cadence[];
  initialDueDays: string;                   // optional: first order due N days after enrollment (blank = standard cadence)
  skipMonths: number[];                     // months explicitly set to NO service
  enrollField: string; enrollOp: string; enrollVal: string;
  stopEnabled: boolean;
  stopMode: 'condition' | 'date' | 'count';  // how enrollment stops
  stopField: string; stopOp: string; stopVal: string;   // stopMode 'condition'
  stopDate: string;                          // stopMode 'date'  (YYYY-MM-DD)
  stopCount: string;                         // stopMode 'count' (services completed)
}

let _cid = 100;
const newCadence = (months: number[] = []): Cadence => ({ id: ++_cid, unit: 'weeks', interval: '2', dow: -1, dom: 0, months });

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
    portfolios: ['Amherst Sunbelt'], communities: [], regions: [], propsMode: 'all', includedProps: [], vendorCost: '45', markupPct: '20', vendors: ['GreenBlade Lawn Co.'], description: descriptionFor('landscaping', 'cut'),
    recurring: true,
    cadences: [
      { id: 11, unit: 'weeks', interval: '2', dow: 3, dom: 1, months: [2, 3, 4, 5, 6, 7, 8, 9] },
      { id: 12, unit: 'months', interval: '1', dow: 0, dom: 15, months: [10, 11] },
    ],
    initialDueDays: '5', skipMonths: [0, 1],
    enrollField: 'Property Status', enrollOp: 'is', enrollVal: 'Vacant',
    stopEnabled: true, stopMode: 'condition', stopField: 'Property Status', stopOp: 'changes to', stopVal: 'Occupied', stopDate: '', stopCount: '',
  },
  {
    id: 2, name: 'ATL Community Grass', active: true, worktype: 'landscaping', subtype: 'cut', petStations: true, scope: 'community',
    portfolios: [], communities: ['Woodbine Crossing', 'River Glen'], regions: [], propsMode: 'all', includedProps: [], vendorCost: '45', markupPct: '20', vendors: ['GreenBlade Lawn Co.', 'Peachtree Grounds'], description: descriptionFor('landscaping', 'cut'),
    recurring: true,
    cadences: [{ id: 21, unit: 'weeks', interval: '1', dow: 1, dom: 1, months: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }],
    initialDueDays: '5', skipMonths: [],
    enrollField: 'Property Status', enrollOp: 'is', enrollVal: 'Vacant',
    stopEnabled: false, stopMode: 'condition', stopField: 'Property Status', stopOp: 'changes to', stopVal: 'Occupied', stopDate: '', stopCount: '',
  },
  {
    // Event-triggered, run-once dispatch: a move-in clean created when the
    // associated leasing Deal reaches "Move-In Scheduled". Non-recurring.
    id: 3, name: 'ATL Move-In Cleans', active: true, worktype: 'cleaning', subtype: 'move_in_clean', petStations: false, scope: 'property',
    portfolios: ['Progress'], communities: [], regions: [], propsMode: 'all', includedProps: [], vendorCost: '75', markupPct: '20', vendors: ['Peachtree Grounds'], description: descriptionFor('cleaning', 'move_in_clean'),
    recurring: false,
    cadences: [],
    initialDueDays: '2', skipMonths: [],
    enrollField: 'Deal Stage', enrollOp: 'changes to', enrollVal: 'Move-In Scheduled',
    stopEnabled: false, stopMode: 'condition', stopField: 'Property Status', stopOp: 'changes to', stopVal: 'Occupied', stopDate: '', stopCount: '',
  },
];

export default function RulesEngine() {
  const [rules, setRules] = useState<Rule[]>(SEED);
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

  const toggleSec = (n: 1 | 2 | 3) => setOpenSec((s) => ({ ...s, [n]: !s[n] }));
  const openRule = (id: number) => {
    setOpenId(id); setOpenSec({ 1: true, 2: true, 3: true }); setPropsOpen(false); setPropSearch('');
    setShowSkip((rules.find((r) => r.id === id)?.skipMonths.length ?? 0) > 0);
  };
  const closeRule = () => setOpenId(null);

  const patch = (p: Partial<Rule>) => setRules((rs) => rs.map((r) => (r.id === openId ? { ...r, ...p } : r)));
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
  const propsInPortfolios = SAMPLE_PROPERTIES.filter((p) => rule.portfolios.includes(p.portfolio));
  const regionOptions = [...new Set(propsInPortfolios.map((p) => p.region))].sort()
    .map((r) => ({ key: r, count: propsInPortfolios.filter((p) => p.region === r).length }));
  const applicableProps = propsInPortfolios.filter((p) => rule.regions.length === 0 || rule.regions.includes(p.region));
  const visibleProps = applicableProps.filter((p) => !propSearch.trim() || `${p.address} ${p.region}`.toLowerCase().includes(propSearch.trim().toLowerCase()));
  const isPropOn = (id: string) => rule.propsMode === 'all' || rule.includedProps.includes(id);
  // Current included id set: everything applicable in 'all' mode, else the fixed list.
  const effectiveIncluded = () => new Set(rule.propsMode === 'all' ? applicableProps.map((p) => p.id) : rule.includedProps);
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
    setRules((rs) => [...rs, { ...SEED[0], id, name: 'New rule', portfolios: [], communities: [], regions: [], propsMode: 'all', includedProps: [], subtype: 'cut', petStations: false, vendorCost: baseRate('landscaping', 'cut'), markupPct: DEFAULT_MARKUP, vendors: [], description: descriptionFor('landscaping', 'cut'), recurring: true, cadences: [newCadence([...Array(12).keys()])], initialDueDays: '', skipMonths: [], enrollVal: '' }]);
    openRule(id);
  };
  const duplicateRule = () => {
    const id = (rules.length ? Math.max(...rules.map((r) => r.id)) : 0) + 1;
    setRules((rs) => [...rs, { ...rule, id, name: `${rule.name} (copy)`, cadences: rule.cadences.map((c) => ({ ...c, id: ++_cid })) }]);
    openRule(id);
  };
  const deleteRule = (id: number) => {
    setRules((rs) => rs.filter((r) => r.id !== id));
    if (id === openId) closeRule();
  };

  const countFor = (r: Rule) => {
    if (r.scope === 'community') return r.communities.reduce((n, k) => n + (COMMUNITIES[k] || 0), 0);
    const inPf = SAMPLE_PROPERTIES.filter((p) => r.portfolios.includes(p.portfolio));
    const appl = inPf.filter((p) => r.regions.length === 0 || r.regions.includes(p.region));
    return r.propsMode === 'all' ? appl.length : appl.filter((p) => r.includedProps.includes(p.id)).length;
  };
  // Regions a rule covers (property scope only): its explicit list, else every
  // region present in its selected portfolios. Drives the list Region filter.
  const regionsOf = (r: Rule): string[] => {
    if (r.scope !== 'property') return [];
    if (r.regions.length) return r.regions;
    return [...new Set(SAMPLE_PROPERTIES.filter((p) => r.portfolios.includes(p.portfolio)).map((p) => p.region))];
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
      name: r.name.toLowerCase(), coverage: countFor(r), worktype: worktypeLabel(r.worktype),
      region: (regionsOf(r)[0] || '~').toLowerCase(), community: (r.communities[0] || '~').toLowerCase(),
    }[sortField]);
    return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * dir);
  }, [rules, search, fWork, fSub, fRegion, fCommunity, sortField, sortDir]);

  // Subtype filter options: the union of subtypes across the chosen work types
  // (or every subtype when no work type is selected).
  const subFilterOptions = (fWork.length === 0 ? WORKTYPES : WORKTYPES.filter((w) => fWork.includes(w.id)))
    .flatMap((w) => w.subtypes.map((s) => [s.id, s.label] as const));
  const subFilterUnique = [...new Map(subFilterOptions).entries()].map(([value, label]) => ({ value, label }));

  const coveredCount = useMemo(() => (rule ? countFor(rule) : 0), [rule]);

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
    if (overlap) saveErrors.push(`Overlaps “${overlap.rule.name}” on: ${overlap.shared.join(', ')}. A property can only belong to one rule per work type + subtype (here: ${worktypeLabel(rule.worktype)} · ${subtypeLabel(rule.worktype, rule.subtype)}).`);
    if (rule.recurring && missingMonths.length) saveErrors.push(`Every month must be tied to a cadence or set to no service. Missing: ${missingMonths.map((i) => MONTHS[i]).join(', ')}.`);
    if (!rule.recurring && !rule.initialDueDays.trim()) saveErrors.push('Set the first order due (days after enrollment) — a one-time service has no cadence to schedule from.');
    if (rule.vendors.length === 0) saveErrors.push('Assign at least one vendor.');
    if (!rule.enrollVal.trim()) saveErrors.push('Set an enrollment trigger.');
    if (rule.stopEnabled && rule.stopMode === 'date' && !rule.stopDate) saveErrors.push('Set a stop date.');
    if (rule.stopEnabled && rule.stopMode === 'count' && (!rule.stopCount || Number(rule.stopCount) < 1)) saveErrors.push('Set the number of services before stopping.');
  }
  const canSave = saveErrors.length === 0;

  const sec = 'bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm';
  const lbl = 'block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1';
  const ctl = 'text-[13px] px-2.5 py-1.5 border border-gray-300 rounded-lg bg-white text-ink';
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
      <header className="bg-brand text-white sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
            Services
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-8 w-8 object-cover shrink-0" />
          <div className="font-heading font-extrabold">Rules Engine</div>
          <span className="text-[9px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.5 rounded">Admin · Sample</span>
        </div>
      </header>

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
                  options={WORKTYPES.map((w) => ({ value: w.id, label: w.label }))} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Sub" selected={fSub} onChange={setFSub} className={pickerCls(fSub.length > 0)} options={subFilterUnique} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Region" selected={fRegion} onChange={setFRegion} className={pickerCls(fRegion.length > 0)}
                  options={SAMPLE_REGIONS.map((r) => ({ value: r, label: r }))} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Com" selected={fCommunity} onChange={setFCommunity} className={pickerCls(fCommunity.length > 0)}
                  options={Object.keys(COMMUNITIES).map((c) => ({ value: c, label: c }))} />
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
                      {r.name} <span className="text-brand font-extrabold whitespace-nowrap">({countFor(r).toLocaleString()})</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.scope === 'community' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{r.scope === 'community' ? 'Community' : 'SFR'}</span>
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{worktypeLabel(r.worktype)} · {subtypeLabel(r.worktype, r.subtype)}</span>
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
              <div className="text-xl font-heading font-extrabold text-ink tabular-nums leading-none">{coveredCount.toLocaleString()}</div>
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
              <div>
                <label className={lbl}>Work Type</label>
                <select value={rule.worktype} onChange={(e) => { const wt = e.target.value as Worktype; const sub = firstSubtype(wt); patch({ worktype: wt, subtype: sub, vendorCost: baseRate(wt, sub), description: descriptionFor(wt, sub) }); }} className={ctl}>
                  {WORKTYPES.filter((w) => w.scopes.includes(rule.scope)).map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                </select>
              </div>
              <div>
                <label className={lbl}>Subtype</label>
                <select value={rule.subtype} onChange={(e) => patch({ subtype: e.target.value, vendorCost: baseRate(rule.worktype, e.target.value), description: descriptionFor(rule.worktype, e.target.value) })} className={ctl}>
                  {subtypesFor(rule.worktype).map((st) => <option key={st.id} value={st.id}>{st.label}</option>)}
                </select>
              </div>
              <div>
                <label className={lbl}>Coverage</label>
                <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
                  <button onClick={() => patch({ scope: 'property' })} className={`px-3 py-1.5 rounded-md ${rule.scope === 'property' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600'}`}>Property</button>
                  <button onClick={() => patch({ scope: 'community' })} className={`px-3 py-1.5 rounded-md ${rule.scope === 'community' ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-600'}`}>Community</button>
                </div>
              </div>
            </div>
            {rule.scope === 'community' && (
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
              <textarea value={rule.description} onChange={(e) => patch({ description: e.target.value })} rows={3}
                className="w-full text-[13px] border border-gray-300 rounded-lg px-3 py-2 bg-white text-ink focus:outline-none focus:border-brand" />
            </div>
            <label className={lbl}>{rule.scope === 'property' ? 'Portfolios' : 'Communities'}</label>
            <CoveragePicker
              noun={rule.scope === 'property' ? 'portfolios' : 'communities'}
              options={Object.entries(rule.scope === 'property' ? PORTFOLIOS : COMMUNITIES).map(([key, count]) => ({ key, count }))}
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
                    <span className="text-brand font-bold">{coveredCount.toLocaleString()} <span className="text-gray-500 font-semibold">included</span></span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 transition-transform ${propsOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
                  </button>
                  {propsOpen && (
                    <div className="border-t border-gray-100">
                      <div className="p-2 border-b border-gray-100">
                        <input value={propSearch} onChange={(e) => setPropSearch(e.target.value)} placeholder="Search properties…"
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
                              <span className="flex-1 truncate text-ink">{p.address}</span>
                              <span className="text-[11px] text-gray-400 shrink-0">{p.region.replace('GA: ', '')}</span>
                            </button>
                          );
                        })}
                        {visibleProps.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-gray-400">{applicableProps.length === 0 ? 'No properties for these portfolios/regions.' : 'No properties match your search.'}</div>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label className={lbl}>Cost Detail</label>
              <div className="flex flex-nowrap items-end justify-center gap-4 sm:justify-start">
                <PriceField label="Vendor Cost" adorn="$" colClass="shrink-0 w-24" value={rule.vendorCost} onChange={(v) => patch({ vendorCost: v })} />
                <PriceField label="Markup %" adorn="%" side="right" colClass="shrink-0 w-24" value={rule.markupPct} onChange={(v) => patch({ markupPct: v })} />
                <PriceField label="Client Cost" adorn="$" highlight readOnly colClass="shrink-0 w-24" value={clientCost.toFixed(2)} />
              </div>
            </div>

            {/* Vendor Assignment — one or more companies; count = current open volume. */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label className={lbl}>Vendor Assignment</label>
              <CoveragePicker noun="vendors" options={SAMPLE_VENDORS.map((v) => ({ key: v, count: VENDOR_OPEN[v] || 0 }))} selected={rule.vendors} onToggle={toggleVendor} onSetMany={setManyVendors} />
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
                <div className="text-[11px] text-gray-400 mt-1">{rule.recurring ? 'Optional · blank = due on the enrollment date.' : 'Required — a one-time service has no cadence to schedule from.'}</div>
              </div>
            </div>

            {/* Is this recurring? — gates the cadence UI. */}
            <div className="mb-3">
              <label className={lbl}>Is This Recurring?</label>
              <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
                <button onClick={() => patch({ recurring: true })} className={`px-4 py-1.5 rounded-md ${rule.recurring ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>Yes</button>
                <button onClick={() => patch({ recurring: false })} className={`px-4 py-1.5 rounded-md ${!rule.recurring ? 'bg-white text-ink shadow-sm' : 'text-gray-600'}`}>No</button>
              </div>
              <div className="text-[11px] text-gray-400 mt-1">{rule.recurring ? 'Recurs on the cadence below.' : 'One-time — a single service is created on enrollment.'}</div>
            </div>

            {rule.recurring ? (
              <>
                <div className="space-y-3">
                  {rule.cadences.map((c) => (
                    <div key={c.id} className="relative border border-gray-200 rounded-xl p-3 pr-8 bg-gray-50">
                      {rule.cadences.length > 1 && (
                        <button onClick={() => patch({ cadences: rule.cadences.filter((x) => x.id !== c.id) })}
                          aria-label="Delete cadence" title="Delete cadence"
                          className="absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 text-lg leading-none">×</button>
                      )}
                      <div className="flex flex-nowrap items-center gap-1.5 mb-2.5">
                        <span className="text-[13px] text-gray-600 shrink-0">Every</span>
                        <input value={c.interval} onChange={(e) => patchCadence(c.id, { interval: e.target.value.replace(/\D/g, '') })} className={`${ctl} w-11 shrink-0 text-center tabular-nums`} />
                        <select value={c.unit} onChange={(e) => patchCadence(c.id, { unit: e.target.value as Unit })} className={`${ctl} shrink-0 pr-6`} style={arrowStyle}>
                          <option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option>
                        </select>
                        {c.unit === 'weeks' && (
                          <><span className="text-[13px] text-gray-600 shrink-0">on</span>
                          <select value={c.dow} onChange={(e) => patchCadence(c.id, { dow: Number(e.target.value) })} className={`${ctl} shrink-0 pr-6`} style={arrowStyle}><option value={-1}>Any day</option>{DOW.map((d, di) => <option key={d} value={di}>{d}</option>)}</select></>
                        )}
                        {c.unit === 'months' && (
                          <><span className="text-[13px] text-gray-600 shrink-0 whitespace-nowrap">on day</span>
                          <select value={c.dom} onChange={(e) => patchCadence(c.id, { dom: Number(e.target.value) })} className={`${ctl} shrink-0 pr-6`} style={arrowStyle}><option value={0}>Any day</option>{Array.from({ length: 28 }, (_, di) => di + 1).map((d) => <option key={d} value={d}>{d}</option>)}</select></>
                        )}
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
            ) : (
              <p className="text-[13px] text-gray-500">One-time service — no recurring cadence. A single work order is created when the enrollment criteria is met.</p>
            )}
            </div>)}
          </section>

          {/* SECTION 3 — enrollment & stop */}
          <section className={sec}>
            <SecHead n={3} title="Enrollment & Stop" />
            {openSec[3] && (<div className="mt-3">
            <label className={lbl}>Enroll (Create Services) When</label>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <select value={rule.enrollField} onChange={(e) => patch({ enrollField: e.target.value, enrollVal: optsFor(e.target.value)[0] || '' })} className={ctl}>{FIELD_NAMES.map((f) => <option key={f}>{f}</option>)}</select>
              <select value={rule.enrollOp} onChange={(e) => patch({ enrollOp: e.target.value })} className={ctl}>{OPS.map((o) => <option key={o}>{o}</option>)}</select>
              <select value={rule.enrollVal} onChange={(e) => patch({ enrollVal: e.target.value })} className={`${ctl} flex-1 min-w-[140px]`}>{optsFor(rule.enrollField).map((o) => <option key={o}>{o}</option>)}</select>
            </div>
            {rule.enrollField === 'Deal Stage' && (
              <div className="mb-4 -mt-1 text-[11px] text-gray-500 bg-brand/5 border border-brand/20 rounded-lg px-3 py-2 leading-relaxed">
                <b className="text-ink">Deal-stage trigger.</b> Fires on the <b>transition into</b> the stage (an edge, not a standing state), and is de-duplicated on the associated deal — so exactly one service is created per lease.{!rule.recurring ? ' With “Is this recurring?” = No, it never recreates, even if the service is completed before the property flips to occupied.' : ' Tip: set “Is this recurring?” = No for a true one-time move-in dispatch.'}
              </div>
            )}
            <label className="flex items-center gap-2 mb-2 cursor-pointer">
              <input type="checkbox" checked={rule.stopEnabled} onChange={(e) => patch({ stopEnabled: e.target.checked, ...(e.target.checked && !rule.stopVal ? { stopVal: optsFor(rule.stopField)[0] || '' } : {}) })} />
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Stop Criteria <span className="normal-case font-normal text-gray-400">(optional)</span></span>
            </label>
            {rule.stopEnabled && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] text-gray-600">Stop</span>
                  <select value={rule.stopMode} onChange={(e) => patch({ stopMode: e.target.value as Rule['stopMode'] })} className={ctl}>
                    <option value="condition">when a field changes</option>
                    <option value="date">on a date</option>
                    <option value="count">after N services</option>
                  </select>
                </div>
                {rule.stopMode === 'condition' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <select value={rule.stopField} onChange={(e) => patch({ stopField: e.target.value, stopVal: optsFor(e.target.value)[0] || '' })} className={ctl}>{FIELD_NAMES.map((f) => <option key={f}>{f}</option>)}</select>
                    <select value={rule.stopOp} onChange={(e) => patch({ stopOp: e.target.value })} className={ctl}>{OPS.map((o) => <option key={o}>{o}</option>)}</select>
                    <select value={rule.stopVal} onChange={(e) => patch({ stopVal: e.target.value })} className={`${ctl} flex-1 min-w-[140px]`}>{optsFor(rule.stopField).map((o) => <option key={o}>{o}</option>)}</select>
                  </div>
                )}
                {rule.stopMode === 'date' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] text-gray-600">On</span>
                    <input type="date" value={rule.stopDate} onChange={(e) => patch({ stopDate: e.target.value })} className={`${ctl} ${!rule.stopDate ? 'border-red-300' : ''}`} />
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
            <button onClick={() => { if (canSave) closeRule(); }} disabled={!canSave} className={`w-full rounded-2xl py-3 font-heading font-bold text-sm ${canSave ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
              {canSave ? 'Save & Close' : 'Resolve the Issues Above to Save'}
            </button>
          </div>
        </main>
      )}
    </div>
  );
}
