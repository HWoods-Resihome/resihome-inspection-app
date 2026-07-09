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
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FIELDS = ['Property Status', 'Home Type', 'Recurring Services', 'Occupancy'];
const OPS = ['is', 'is any of', 'is not', 'changes to'];

type Unit = 'days' | 'weeks' | 'months';
interface Cadence { id: number; unit: Unit; interval: number; dow: number; dom: number; months: number[]; }
interface Rule {
  id: number; name: string; active: boolean; worktype: Worktype;
  scope: 'property' | 'community'; portfolios: string[]; communities: string[];
  vendorCost: number; markupPct: number;
  cadences: Cadence[];
  enrollField: string; enrollOp: string; enrollVal: string;
  stopEnabled: boolean; stopField: string; stopOp: string; stopVal: string;
}

let _cid = 100;
const newCadence = (months: number[] = []): Cadence => ({ id: ++_cid, unit: 'weeks', interval: 2, dow: 0, dom: 1, months });

const SEED: Rule[] = [
  {
    id: 1, name: 'Amherst — Grass Cut', active: true, worktype: 'grass_cut', scope: 'property',
    portfolios: ['Amherst Sunbelt'], communities: [], vendorCost: 42, markupPct: 35,
    cadences: [
      { id: 11, unit: 'weeks', interval: 2, dow: 3, dom: 1, months: [2, 3, 4, 5, 6, 7, 8, 9] },
      { id: 12, unit: 'months', interval: 1, dow: 0, dom: 15, months: [0, 1, 10, 11] },
    ],
    enrollField: 'Property Status', enrollOp: 'is any of', enrollVal: 'Vacant, Pending MOI',
    stopEnabled: true, stopField: 'Property Status', stopOp: 'changes to', stopVal: 'Occupied / Leased',
  },
  {
    id: 2, name: 'Atlanta Communities — Grass', active: true, worktype: 'grass_cut', scope: 'community',
    portfolios: [], communities: ['Woodbine Crossing', 'River Glen'], vendorCost: 40, markupPct: 30,
    cadences: [{ id: 21, unit: 'weeks', interval: 1, dow: 1, dom: 1, months: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }],
    enrollField: 'Occupancy', enrollOp: 'is', enrollVal: 'Active community contract',
    stopEnabled: false, stopField: 'Property Status', stopOp: 'changes to', stopVal: '',
  },
];

export default function RulesEngine() {
  const [rules, setRules] = useState<Rule[]>(SEED);
  const [selId, setSelId] = useState(1);
  const [gearOpen, setGearOpen] = useState(false);
  const rule = rules.find((r) => r.id === selId) || rules[0];

  const patch = (p: Partial<Rule>) => setRules((rs) => rs.map((r) => (r.id === selId ? { ...r, ...p } : r)));
  const patchCadence = (cid: number, p: Partial<Cadence>) =>
    patch({ cadences: rule.cadences.map((c) => (c.id === cid ? { ...c, ...p } : c)) });
  const toggleMonth = (cid: number, m: number) =>
    patch({ cadences: rule.cadences.map((c) => c.id === cid
      ? { ...c, months: c.months.includes(m) ? c.months.filter((x) => x !== m) : [...c.months, m] }
      : { ...c, months: c.months.filter((x) => x !== m) }) }); // a month belongs to ONE cadence
  const toggleCoverage = (key: string) => {
    if (rule.scope === 'property') patch({ portfolios: rule.portfolios.includes(key) ? rule.portfolios.filter((x) => x !== key) : [...rule.portfolios, key] });
    else patch({ communities: rule.communities.includes(key) ? rule.communities.filter((x) => x !== key) : [...rule.communities, key] });
  };

  const addRule = () => {
    const id = Math.max(...rules.map((r) => r.id)) + 1;
    setRules((rs) => [...rs, { ...SEED[0], id, name: 'New rule', portfolios: [], communities: [], cadences: [newCadence([...Array(12).keys()])], enrollVal: '' }]);
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

  const coveredCount = useMemo(() => {
    const src = rule.scope === 'property' ? PORTFOLIOS : COMMUNITIES;
    const keys = rule.scope === 'property' ? rule.portfolios : rule.communities;
    return keys.reduce((n, k) => n + (src[k] || 0), 0);
  }, [rule]);

  const coveredMonths = useMemo(() => new Set(rule.cadences.flatMap((c) => c.months)), [rule]);
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

  const clientCost = (rule.vendorCost * (1 + rule.markupPct / 100));
  const saveErrors: string[] = [];
  if (overlap) saveErrors.push(`Overlaps “${overlap.rule.name}” on: ${overlap.shared.join(', ')}. A property can only belong to one rule per worktype.`);
  if (missingMonths.length) saveErrors.push(`Every month must be tied to a cadence. Missing: ${missingMonths.map((i) => MONTHS[i]).join(', ')}.`);
  if (!rule.enrollVal.trim()) saveErrors.push('Set an enrollment trigger.');
  const canSave = saveErrors.length === 0;

  const sec = 'bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm';
  const lbl = 'block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1';
  const ctl = 'text-[13px] px-2.5 py-1.5 border border-gray-300 rounded-lg bg-white text-ink';
  const chip = (on: boolean) => `text-[12.5px] font-heading font-semibold px-3 py-1.5 rounded-full border ${on ? 'bg-brand/10 text-brand border-brand/40' : 'bg-white text-gray-600 border-gray-300 hover:border-brand/40'}`;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-brand text-white sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/services" className="text-white/90 hover:text-white text-sm shrink-0">← Services</Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-8 w-8 object-cover shrink-0" />
          <div className="font-heading font-extrabold">Rules Engine</div>
          <span className="text-[9px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.5 rounded">Admin · Sample</span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[250px_minmax(0,1fr)] gap-4 p-4">
        {/* rule list */}
        <aside className="space-y-2">
          <button onClick={addRule} className="w-full text-brand bg-brand/5 border border-dashed border-brand/40 rounded-xl py-2 text-[13px] font-heading font-bold">+ New rule</button>
          {rules.map((r) => (
            <div key={r.id} className={`bg-white border rounded-xl p-3 cursor-pointer ${r.id === selId ? 'border-brand ring-1 ring-brand' : 'border-gray-200 hover:border-gray-300'} ${r.active ? '' : 'opacity-60'}`} onClick={() => setSelId(r.id)}>
              <div className="flex items-center gap-2">
                <div className="font-heading font-bold text-[13px] text-ink flex-1 truncate">{r.name}</div>
                <button onClick={(e) => { e.stopPropagation(); setRules((rs) => rs.map((x) => x.id === r.id ? { ...x, active: !x.active } : x)); }}
                  title={r.active ? 'Active — click to pause' : 'Inactive — click to activate'}
                  className={`relative w-8 h-4.5 rounded-full transition ${r.active ? 'bg-brand' : 'bg-gray-300'}`} style={{ height: 18, width: 32 }}>
                  <span className="absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition" style={{ transform: r.active ? 'translateX(14px)' : 'none' }} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${r.scope === 'community' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{r.scope === 'community' ? 'Community' : 'SFR'}</span>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{worktypeLabel(r.worktype)}</span>
                {!r.active && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">Paused</span>}
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
          <div className="flex items-center gap-3">
            <input value={rule.name} onChange={(e) => patch({ name: e.target.value })}
              className="font-heading font-extrabold text-xl text-ink bg-transparent border-b-2 border-dashed border-gray-300 focus:border-brand focus:outline-none flex-1 min-w-0" />
            <div className="text-right shrink-0">
              <div className="text-2xl font-heading font-extrabold text-ink tabular-nums leading-none">{coveredCount.toLocaleString()}</div>
              <div className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">properties covered</div>
            </div>
          </div>

          {/* SECTION 1 — scope & pricing */}
          <section className={sec}>
            <h3 className="font-heading font-bold text-[15px] text-ink mb-3"><span className="text-brand">1.</span> Work type, coverage &amp; pricing</h3>
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div>
                <label className={lbl}>Work type</label>
                <select value={rule.worktype} onChange={(e) => patch({ worktype: e.target.value as Worktype })} className={ctl}>
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
            <div className="flex flex-wrap gap-2 mb-4">
              {Object.entries(rule.scope === 'property' ? PORTFOLIOS : COMMUNITIES).map(([k, homes]) => {
                const on = (rule.scope === 'property' ? rule.portfolios : rule.communities).includes(k);
                return <button key={k} onClick={() => toggleCoverage(k)} className={chip(on)}>{k} <span className={`text-[11px] tabular-nums ${on ? 'text-brand' : 'text-gray-400'}`}>{homes}</span></button>;
              })}
            </div>
            <div className="flex flex-wrap items-end gap-4 border-t border-gray-100 pt-4">
              <div><label className={lbl}>Vendor cost</label><div className="flex items-center"><span className="text-gray-400 mr-1">$</span><input value={rule.vendorCost} onChange={(e) => patch({ vendorCost: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} className={`${ctl} w-24 tabular-nums`} /></div></div>
              <div><label className={lbl}>Markup %</label><div className="flex items-center"><input value={rule.markupPct} onChange={(e) => patch({ markupPct: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })} className={`${ctl} w-20 tabular-nums`} /><span className="text-gray-400 ml-1">%</span></div></div>
              <div><label className={lbl}>Client cost</label><div className="text-lg font-extrabold tabular-nums text-emerald-700 px-2.5 py-1.5 border border-emerald-300 bg-emerald-50 rounded-lg">${clientCost.toFixed(2)}</div></div>
            </div>
          </section>

          {/* SECTION 2 — cadence */}
          <section className={sec}>
            <h3 className="font-heading font-bold text-[15px] text-ink"><span className="text-brand">2.</span> Cadence</h3>
            <p className="text-[12px] text-gray-500 mb-3">Recurs relative to the last completed service. Assign <b>every month</b> to a cadence — different months can use different intervals.</p>
            <div className="space-y-3">
              {rule.cadences.map((c, i) => (
                <div key={c.id} className="border border-gray-200 rounded-xl p-3 bg-gray-50">
                  <div className="flex flex-wrap items-center gap-2 mb-2.5">
                    <span className="text-[13px] text-gray-600">Every</span>
                    <input value={c.interval} onChange={(e) => patchCadence(c.id, { interval: Number(e.target.value.replace(/\D/g, '')) || 1 })} className={`${ctl} w-14 tabular-nums`} />
                    <select value={c.unit} onChange={(e) => patchCadence(c.id, { unit: e.target.value as Unit })} className={ctl}>
                      <option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option>
                    </select>
                    {c.unit === 'weeks' && (
                      <><span className="text-[13px] text-gray-600">on</span>
                      <select value={c.dow} onChange={(e) => patchCadence(c.id, { dow: Number(e.target.value) })} className={ctl}>{DOW.map((d, di) => <option key={d} value={di}>{d}</option>)}</select></>
                    )}
                    {c.unit === 'months' && (
                      <><span className="text-[13px] text-gray-600">on day</span>
                      <select value={c.dom} onChange={(e) => patchCadence(c.id, { dom: Number(e.target.value) })} className={ctl}>{Array.from({ length: 28 }, (_, di) => di + 1).map((d) => <option key={d} value={d}>{d}</option>)}</select></>
                    )}
                    {rule.cadences.length > 1 && <button onClick={() => patch({ cadences: rule.cadences.filter((x) => x.id !== c.id) })} className="ml-auto text-gray-400 hover:text-red-600 text-sm">Remove</button>}
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
            <button onClick={() => patch({ cadences: [...rule.cadences, newCadence(missingMonths)] })} className="mt-3 text-[12px] font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1 bg-white hover:border-brand/40">+ Add cadence</button>
            <div className={`mt-3 text-[12.5px] font-semibold ${missingMonths.length ? 'text-red-600' : 'text-emerald-600'}`}>
              {missingMonths.length ? `Not all months covered — missing: ${missingMonths.map((i) => MONTHS[i]).join(', ')}` : 'All 12 months covered ✓'}
            </div>
          </section>

          {/* SECTION 3 — enrollment & stop */}
          <section className={sec}>
            <h3 className="font-heading font-bold text-[15px] text-ink"><span className="text-brand">3.</span> Enrollment &amp; stop</h3>
            <p className="text-[12px] text-gray-500 mb-3">Enrollment creates the first service; each service auto-recreates when the last is submitted, until the (optional) stop criteria is met. Vendor assignment is handled separately in Vendor Management.</p>
            <label className={lbl}>Enroll (create services) when</label>
            <div className="flex flex-wrap items-center gap-2 mb-4">
              <select value={rule.enrollField} onChange={(e) => patch({ enrollField: e.target.value })} className={ctl}>{FIELDS.map((f) => <option key={f}>{f}</option>)}</select>
              <select value={rule.enrollOp} onChange={(e) => patch({ enrollOp: e.target.value })} className={ctl}>{OPS.map((o) => <option key={o}>{o}</option>)}</select>
              <input value={rule.enrollVal} onChange={(e) => patch({ enrollVal: e.target.value })} placeholder="value" className={`${ctl} flex-1 min-w-[140px]`} />
            </div>
            <label className="flex items-center gap-2 text-[13px] font-semibold text-ink mb-2">
              <input type="checkbox" checked={rule.stopEnabled} onChange={(e) => patch({ stopEnabled: e.target.checked })} /> Add stop criteria (optional)
            </label>
            {rule.stopEnabled && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] text-gray-600">Stop when</span>
                <select value={rule.stopField} onChange={(e) => patch({ stopField: e.target.value })} className={ctl}>{FIELDS.map((f) => <option key={f}>{f}</option>)}</select>
                <select value={rule.stopOp} onChange={(e) => patch({ stopOp: e.target.value })} className={ctl}>{OPS.map((o) => <option key={o}>{o}</option>)}</select>
                <input value={rule.stopVal} onChange={(e) => patch({ stopVal: e.target.value })} placeholder="value" className={`${ctl} flex-1 min-w-[140px]`} />
              </div>
            )}
          </section>

          {/* save */}
          <div className="sticky bottom-0 bg-gray-50 pt-3 pb-1">
            {saveErrors.map((e, i) => (
              <div key={i} className="mb-2 text-[12.5px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">⚠ {e}</div>
            ))}
            <button disabled={!canSave} className={`w-full rounded-2xl py-3 font-heading font-bold text-sm ${canSave ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
              {canSave ? 'Save & activate' : 'Resolve the above to save'}
            </button>
          </div>
        </main>
      </div>
    </div>
  );
}
