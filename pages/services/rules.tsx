import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { WORKTYPES, worktypeLabel, type Worktype } from '@/lib/services/worktypes';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};

// Sample reference data (real lists come from Property / Community in a later step).
const PORTFOLIOS: Record<string, number> = { 'Amherst Sunbelt': 612, 'Tricon GA': 418, 'Progress': 174, 'Invitation Homes': 903, 'FirstKey': 551, 'VineBrook': 288 };
const COMMUNITIES: Record<string, number> = { 'Woodbine Crossing': 96, 'River Glen': 124, 'Camden Pointe': 88, 'Harlow Trace': 78, 'Stonecreek': 142, 'Maple Run': 64 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Default per-worktype vendor pricing (property coverage). Grass shows its base
// tier; higher grass tiers ($60 6–12in, $90 >12in) are promoted at completion.
const WORKTYPE_BASE: Partial<Record<Worktype, number>> = { grass_cut: 45, pool_service: 100, house_cleaning: 75 };
const DEFAULT_MARKUP = '20';   // default markup % on all services
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
// Curated Property-object fields for enrollment / stop criteria, each with its own
// value options so the value picker "flows" from the chosen field. (Short list for
// now; expands as we wire real Property properties.)
const PROPERTY_FIELDS: { field: string; options: string[] }[] = [
  { field: 'Property Status', options: ['Vacant', 'Pending MOI/Rekey', 'Occupied', 'Under Turnkey', 'Eviction'] },
  { field: 'Home Type', options: ['Single-Family', 'Townhome', 'Condo', 'Duplex'] },
  { field: 'Recurring Services', options: ['Enrolled', 'Paused', 'Not Enrolled'] },
  { field: 'Has Pool', options: ['Yes', 'No'] },
  { field: 'Occupancy', options: ['Vacant', 'Occupied'] },
];
const FIELD_NAMES = PROPERTY_FIELDS.map((f) => f.field);
const optsFor = (field: string) => PROPERTY_FIELDS.find((f) => f.field === field)?.options ?? [];
const OPS = ['is', 'is any of', 'is not', 'changes to'];

type Unit = 'days' | 'weeks' | 'months';
interface Cadence { id: number; unit: Unit; interval: number; dow: number; dom: number; months: number[]; }
interface Rule {
  id: number; name: string; active: boolean; worktype: Worktype;
  scope: 'property' | 'community'; portfolios: string[]; communities: string[];
  vendorCost: string; markupPct: string;   // strings so decimals can be typed freely
  cadences: Cadence[];
  initialDueDays: string;                   // optional: first order due N days after enrollment (blank = standard cadence)
  skipMonths: number[];                     // months explicitly set to NO service
  enrollField: string; enrollOp: string; enrollVal: string;
  stopEnabled: boolean; stopField: string; stopOp: string; stopVal: string;
}
// Keep digits + one dot + up to 2 decimals as the user types.
const sanitizeNum = (v: string): string => {
  const parts = v.replace(/[^\d.]/g, '').split('.');
  const int = parts.shift() ?? '';
  return parts.length ? `${int}.${parts.join('').slice(0, 2)}` : int;
};

let _cid = 100;
const newCadence = (months: number[] = []): Cadence => ({ id: ++_cid, unit: 'weeks', interval: 2, dow: 0, dom: 1, months });

// Searchable, multi-select, scrollable dropdown for portfolio/community coverage.
function CoveragePicker({ noun, options, selected, onToggle }: {
  noun: string; options: { key: string; count: number }[]; selected: string[]; onToggle: (k: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const filtered = options.filter((o) => o.key.toLowerCase().includes(q.trim().toLowerCase()));
  const summary = selected.length === 0 ? `Select ${noun}…` : selected.length === 1 ? selected[0] : `${selected.length} ${noun} selected`;
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
    id: 1, name: 'Amherst Grass Cut', active: true, worktype: 'grass_cut', scope: 'property',
    portfolios: ['Amherst Sunbelt'], communities: [], vendorCost: '45', markupPct: '20',
    cadences: [
      { id: 11, unit: 'weeks', interval: 2, dow: 3, dom: 1, months: [2, 3, 4, 5, 6, 7, 8, 9] },
      { id: 12, unit: 'months', interval: 1, dow: 0, dom: 15, months: [10, 11] },
    ],
    initialDueDays: '3', skipMonths: [0, 1],
    enrollField: 'Property Status', enrollOp: 'is', enrollVal: 'Vacant',
    stopEnabled: true, stopField: 'Property Status', stopOp: 'changes to', stopVal: 'Occupied',
  },
  {
    id: 2, name: 'ATL Community Grass', active: true, worktype: 'grass_cut', scope: 'community',
    portfolios: [], communities: ['Woodbine Crossing', 'River Glen'], vendorCost: '45', markupPct: '20',
    cadences: [{ id: 21, unit: 'weeks', interval: 1, dow: 1, dom: 1, months: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }],
    initialDueDays: '', skipMonths: [],
    enrollField: 'Property Status', enrollOp: 'is', enrollVal: 'Vacant',
    stopEnabled: false, stopField: 'Property Status', stopOp: 'changes to', stopVal: 'Occupied',
  },
];

export default function RulesEngine() {
  const [rules, setRules] = useState<Rule[]>(SEED);
  const [selId, setSelId] = useState(1);
  const rule = rules.find((r) => r.id === selId) || rules[0];

  const patch = (p: Partial<Rule>) => setRules((rs) => rs.map((r) => (r.id === selId ? { ...r, ...p } : r)));
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

  const addRule = () => {
    const id = Math.max(...rules.map((r) => r.id)) + 1;
    setRules((rs) => [...rs, { ...SEED[0], id, name: 'New rule', portfolios: [], communities: [], vendorCost: String(WORKTYPE_BASE.grass_cut), markupPct: DEFAULT_MARKUP, cadences: [newCadence([...Array(12).keys()])], initialDueDays: '', skipMonths: [], enrollVal: '' }]);
    setSelId(id);
  };
  const duplicateRule = () => {
    const id = Math.max(...rules.map((r) => r.id)) + 1;
    setRules((rs) => [...rs, { ...rule, id, name: `${rule.name} (copy)`, cadences: rule.cadences.map((c) => ({ ...c, id: ++_cid })) }]);
    setSelId(id);
  };
  const deleteRule = (id: number) => {
    setRules((rs) => rs.filter((r) => r.id !== id));
    if (id === selId) { const rest = rules.filter((r) => r.id !== id); if (rest[0]) setSelId(rest[0].id); }
  };

  const countFor = (r: Rule) => {
    const src = r.scope === 'property' ? PORTFOLIOS : COMMUNITIES;
    return (r.scope === 'property' ? r.portfolios : r.communities).reduce((n, k) => n + (src[k] || 0), 0);
  };
  const coveredCount = useMemo(() => countFor(rule), [rule]);

  // A month is "accounted for" if it's in a cadence OR explicitly set to no service.
  const coveredMonths = useMemo(() => new Set([...rule.cadences.flatMap((c) => c.months), ...rule.skipMonths]), [rule]);
  const missingMonths = MONTHS.map((_, i) => i).filter((i) => !coveredMonths.has(i));

  // One property → one rule per worktype: block save if this rule shares any
  // portfolio/community with ANOTHER active rule of the same worktype.
  const overlap = useMemo(() => {
    for (const other of rules) {
      if (other.id === rule.id || !other.active || other.worktype !== rule.worktype || other.scope !== rule.scope) continue;
      const a = new Set(rule.scope === 'property' ? rule.portfolios : rule.communities);
      const shared = (other.scope === 'property' ? other.portfolios : other.communities).filter((k) => a.has(k));
      if (shared.length) return { rule: other, shared };
    }
    return null;
  }, [rules, rule]);

  const clientCost = (parseFloat(rule.vendorCost || '0') * (1 + parseFloat(rule.markupPct || '0') / 100));
  const saveErrors: string[] = [];
  if (overlap) saveErrors.push(`Overlaps “${overlap.rule.name}” on: ${overlap.shared.join(', ')}. A property can only belong to one rule per worktype.`);
  if (missingMonths.length) saveErrors.push(`Every month must be tied to a cadence or set to no service. Missing: ${missingMonths.map((i) => MONTHS[i]).join(', ')}.`);
  if (!rule.enrollVal.trim()) saveErrors.push('Set an enrollment trigger.');
  const canSave = saveErrors.length === 0;

  const sec = 'bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm';
  const lbl = 'block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1';
  const ctl = 'text-[13px] px-2.5 py-1.5 border border-gray-300 rounded-lg bg-white text-ink';
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
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
            Services
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-8 w-8 object-cover shrink-0" />
          <div className="font-heading font-extrabold">Rules Engine</div>
          <span className="text-[9px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.5 rounded">Admin · Sample</span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)] gap-4 p-4">
        {/* rule list */}
        <aside className="space-y-2">
          <button onClick={addRule} className="w-full text-brand bg-brand/5 border border-dashed border-brand/40 rounded-xl py-2 text-[13px] font-heading font-bold">+ New Rule</button>
          {rules.map((r) => (
            <div key={r.id} className={`bg-white border rounded-xl p-3 cursor-pointer ${r.id === selId ? 'border-brand ring-1 ring-brand' : 'border-gray-200 hover:border-gray-300'} ${r.active ? '' : 'opacity-60'}`} onClick={() => setSelId(r.id)}>
              <div className="font-heading font-bold text-[12.5px] text-ink leading-tight">
                {r.name} <span className="text-brand font-extrabold whitespace-nowrap">({countFor(r).toLocaleString()})</span>
              </div>
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.scope === 'community' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{r.scope === 'community' ? 'Community' : 'SFR'}</span>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{worktypeLabel(r.worktype)}</span>
                {!r.active && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Paused</span>}
                <button onClick={(e) => { e.stopPropagation(); setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, active: !x.active } : x)); }}
                  title={r.active ? 'Active — click to pause' : 'Inactive — click to activate'}
                  className={`ml-auto relative rounded-full transition shrink-0 ${r.active ? 'bg-brand' : 'bg-gray-300'}`} style={{ height: 18, width: 32 }}>
                  <span className="absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition" style={{ transform: r.active ? 'translateX(14px)' : 'none' }} />
                </button>
              </div>
              {r.id === selId && (
                <div className="flex gap-3 mt-2 text-[11px] font-semibold">
                  <button onClick={(e) => { e.stopPropagation(); duplicateRule(); }} className="text-gray-500 hover:text-brand">Duplicate</button>
                  <button onClick={(e) => { e.stopPropagation(); deleteRule(r.id); }} className="text-gray-500 hover:text-red-600">Delete</button>
                </div>
              )}
            </div>
          ))}
        </aside>

        {/* editor */}
        <main className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="flex-1 min-w-0">
              <label className={lbl}>Rule Name</label>
              <input value={rule.name} onChange={(e) => patch({ name: e.target.value })} placeholder="Name this rule"
                className="w-full font-heading font-extrabold text-xl text-ink bg-white border border-gray-300 rounded-lg px-3 py-1.5 focus:border-brand focus:outline-none" />
            </div>
            <div className="text-right shrink-0">
              <div className="text-2xl font-heading font-extrabold text-ink tabular-nums leading-none">{coveredCount.toLocaleString()}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Properties Covered</div>
            </div>
          </div>

          {/* SECTION 1 — scope & pricing */}
          <section className={sec}>
            <h3 className="font-heading font-bold text-[15px] text-ink mb-3"><span className="text-brand">1.</span> Work Type, Coverage &amp; Pricing</h3>
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div>
                <label className={lbl}>Work Type</label>
                <select value={rule.worktype} onChange={(e) => { const wt = e.target.value as Worktype; patch({ worktype: wt, vendorCost: WORKTYPE_BASE[wt] != null ? String(WORKTYPE_BASE[wt]) : rule.vendorCost }); }} className={ctl}>
                  {WORKTYPES.filter((w) => w.scopes.includes(rule.scope)).map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
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
            <label className={lbl}>{rule.scope === 'property' ? 'Portfolios' : 'Communities'}</label>
            <CoveragePicker
              noun={rule.scope === 'property' ? 'portfolios' : 'communities'}
              options={Object.entries(rule.scope === 'property' ? PORTFOLIOS : COMMUNITIES).map(([key, count]) => ({ key, count }))}
              selected={rule.scope === 'property' ? rule.portfolios : rule.communities}
              onToggle={toggleCoverage}
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
            {(rule.scope === 'property' ? rule.portfolios : rule.communities).length === 0 && <div className="mb-4" />}
            <div className="flex flex-nowrap items-end gap-4 border-t border-gray-100 pt-4">
              <div className="flex flex-col shrink-0"><label className={lbl}>Vendor Cost</label><div className="flex items-center"><span className="text-gray-400 mr-1">$</span><input value={rule.vendorCost} inputMode="decimal" onChange={(e) => patch({ vendorCost: sanitizeNum(e.target.value) })} className={`${ctl} w-20 text-center tabular-nums`} /></div></div>
              <div className="flex flex-col shrink-0"><label className={lbl}>Markup %</label><div className="flex items-center"><input value={rule.markupPct} inputMode="decimal" onChange={(e) => patch({ markupPct: sanitizeNum(e.target.value) })} className={`${ctl} w-20 text-center tabular-nums`} /><span className="text-gray-400 ml-1">%</span></div></div>
              <div className="flex flex-col shrink-0"><label className={lbl}>Client Cost</label><div className="flex items-center"><span className="text-gray-400 mr-1">$</span><div className="text-[13px] font-bold tabular-nums text-emerald-700 px-2.5 py-1.5 border border-emerald-300 bg-emerald-50 rounded-lg w-20 text-center">{clientCost.toFixed(2)}</div></div></div>
            </div>
          </section>

          {/* SECTION 2 — cadence */}
          <section className={sec}>
            <h3 className="font-heading font-bold text-[15px] text-ink"><span className="text-brand">2.</span> Cadence</h3>
            <p className="text-[12px] text-gray-500 mb-3">Recurs relative to the last completed service. Assign <b>every month</b> to a cadence — different months can use different intervals.</p>
            <div className="mb-3 flex flex-wrap items-center gap-2 bg-brand/5 border border-brand/20 rounded-xl p-3">
              <span className="text-[13px] font-semibold text-ink">First order after enrollment — due within</span>
              <input value={rule.initialDueDays} inputMode="numeric" onChange={(e) => patch({ initialDueDays: e.target.value.replace(/\D/g, '') })} placeholder="—" className={`${ctl} w-14 text-center tabular-nums`} />
              <span className="text-[13px] text-gray-600">days <span className="text-gray-400">(optional — blank uses the standard cadence)</span></span>
            </div>
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
                    <input value={c.interval} onChange={(e) => patchCadence(c.id, { interval: Number(e.target.value.replace(/\D/g, '')) || 1 })} className={`${ctl} w-11 shrink-0 text-center tabular-nums`} />
                    <select value={c.unit} onChange={(e) => patchCadence(c.id, { unit: e.target.value as Unit })} className={`${ctl} shrink-0 pr-6`} style={arrowStyle}>
                      <option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option>
                    </select>
                    {c.unit === 'weeks' && (
                      <><span className="text-[13px] text-gray-600 shrink-0">on</span>
                      <select value={c.dow} onChange={(e) => patchCadence(c.id, { dow: Number(e.target.value) })} className={`${ctl} shrink-0 pr-6`} style={arrowStyle}>{DOW.map((d, di) => <option key={d} value={di}>{d}</option>)}</select></>
                    )}
                    {c.unit === 'months' && (
                      <><span className="text-[13px] text-gray-600 shrink-0 whitespace-nowrap">on day</span>
                      <select value={c.dom} onChange={(e) => patchCadence(c.id, { dom: Number(e.target.value) })} className={`${ctl} shrink-0 pr-6`} style={arrowStyle}>{Array.from({ length: 28 }, (_, di) => di + 1).map((d) => <option key={d} value={d}>{d}</option>)}</select></>
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
            {/* No-service months — a month set here gets NO cuts and still counts
                toward the "every month accounted for" rule. */}
            <div className="mt-3 border border-dashed border-gray-300 rounded-xl p-3 bg-white">
              <div className="text-[12px] font-semibold text-gray-600 mb-2">No Service — Skip These Months</div>
              <div className="flex flex-wrap gap-1.5">
                {MONTHS.map((m, mi) => {
                  const on = rule.skipMonths.includes(mi);
                  return <button key={m} onClick={() => toggleSkipMonth(mi)} className={`text-[11.5px] font-heading font-semibold px-2.5 py-1 rounded-md border ${on ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-600 border-gray-300'}`}>{m}</button>;
                })}
              </div>
            </div>
            <button onClick={() => patch({ cadences: [...rule.cadences, newCadence(missingMonths)] })} className="mt-3 text-[12px] font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1 bg-white hover:border-brand/40">+ Add Cadence</button>
            <div className={`mt-3 text-[12.5px] font-semibold ${missingMonths.length ? 'text-red-600' : 'text-emerald-600'}`}>
              {missingMonths.length ? `Not all months accounted for — missing: ${missingMonths.map((i) => MONTHS[i]).join(', ')}` : 'All 12 months accounted for ✓'}
            </div>
          </section>

          {/* SECTION 3 — enrollment & stop */}
          <section className={sec}>
            <h3 className="font-heading font-bold text-[15px] text-ink"><span className="text-brand">3.</span> Enrollment &amp; Stop</h3>
            <p className="text-[12px] text-gray-500 mb-3">Enrollment creates the first service; each service auto-recreates when the last is submitted, until the (optional) stop criteria is met. Vendor assignment is handled separately in Vendor Management.</p>
            <label className={lbl}>Enroll (Create Services) When</label>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <select value={rule.enrollField} onChange={(e) => patch({ enrollField: e.target.value, enrollVal: optsFor(e.target.value)[0] || '' })} className={ctl}>{FIELD_NAMES.map((f) => <option key={f}>{f}</option>)}</select>
              <select value={rule.enrollOp} onChange={(e) => patch({ enrollOp: e.target.value })} className={ctl}>{OPS.map((o) => <option key={o}>{o}</option>)}</select>
              <select value={rule.enrollVal} onChange={(e) => patch({ enrollVal: e.target.value })} className={`${ctl} flex-1 min-w-[140px]`}>{optsFor(rule.enrollField).map((o) => <option key={o}>{o}</option>)}</select>
            </div>
            <label className="flex items-center gap-2 text-[13px] font-semibold text-ink mb-2">
              <input type="checkbox" checked={rule.stopEnabled} onChange={(e) => patch({ stopEnabled: e.target.checked, ...(e.target.checked && !rule.stopVal ? { stopVal: optsFor(rule.stopField)[0] || '' } : {}) })} /> Add Stop Criteria (Optional)
            </label>
            {rule.stopEnabled && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-gray-600">Stop When</span>
                <select value={rule.stopField} onChange={(e) => patch({ stopField: e.target.value, stopVal: optsFor(e.target.value)[0] || '' })} className={ctl}>{FIELD_NAMES.map((f) => <option key={f}>{f}</option>)}</select>
                <select value={rule.stopOp} onChange={(e) => patch({ stopOp: e.target.value })} className={ctl}>{OPS.map((o) => <option key={o}>{o}</option>)}</select>
                <select value={rule.stopVal} onChange={(e) => patch({ stopVal: e.target.value })} className={`${ctl} flex-1 min-w-[140px]`}>{optsFor(rule.stopField).map((o) => <option key={o}>{o}</option>)}</select>
              </div>
            )}
          </section>

          {/* save */}
          <div className="sticky bottom-0 bg-gray-50 pt-3 pb-1">
            {saveErrors.map((e, i) => (
              <div key={i} className="mb-2 text-[12.5px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">⚠ {e}</div>
            ))}
            <button disabled={!canSave} className={`w-full rounded-2xl py-3 font-heading font-bold text-sm ${canSave ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
              {canSave ? 'Save & Activate' : 'Resolve the Issues Above to Save'}
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
