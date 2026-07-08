import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { WORKTYPES } from '@/lib/services/worktypes';

// Admin-only, flag-gated (see /services). Non-admins / production are bounced.
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};

// Sample reference data (real lists come from Property/Community in a later step).
const PORTFOLIOS = [
  { name: 'Amherst Sunbelt', homes: 612 }, { name: 'Tricon GA', homes: 418 },
  { name: 'Progress', homes: 174 }, { name: 'Invitation Homes', homes: 903 },
  { name: 'FirstKey', homes: 551 }, { name: 'VineBrook', homes: 288 },
];
const COMMUNITIES = [
  { name: 'Woodbine Crossing', homes: 96 }, { name: 'River Glen', homes: 124 },
  { name: 'Camden Pointe', homes: 88 }, { name: 'Harlow Trace', homes: 78 },
  { name: 'Stonecreek', homes: 142 }, { name: 'Maple Run', homes: 64 },
];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function Chip({ on, label, count, onClick }: { on: boolean; label: string; count: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-2 text-[12.5px] font-heading font-semibold px-3 py-1.5 rounded-full border transition ${
        on ? 'bg-brand/10 text-brand border-brand/40' : 'bg-white text-gray-600 border-gray-300 hover:border-brand/40'}`}>
      {label}<span className={`text-[11px] tabular-nums ${on ? 'text-brand' : 'text-gray-400'}`}>{count}</span>
    </button>
  );
}
function Card({ n, title, sub, children, accent }: { n: string; title: string; sub?: string; children: React.ReactNode; accent?: string }) {
  return (
    <section className={`bg-white border border-gray-200 rounded-2xl p-4 sm:p-5 shadow-sm ${accent || ''}`}>
      <h3 className="flex items-center gap-2 font-heading font-bold text-[15px] text-ink">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-brand/10 text-brand text-[11px] font-extrabold">{n}</span>
        {title}
      </h3>
      {sub && <p className="text-[12px] text-gray-500 mt-1 mb-3">{sub}</p>}
      <div className={sub ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

export default function RulesEngine() {
  const [scope, setScope] = useState<'sfr' | 'community'>('sfr');
  const [pfSel, setPfSel] = useState<Set<string>>(new Set(['Amherst Sunbelt', 'Tricon GA', 'Progress']));
  const [commSel, setCommSel] = useState<Set<string>>(new Set(['Woodbine Crossing', 'River Glen', 'Camden Pointe', 'Harlow Trace']));
  const [repeatDays, setRepeatDays] = useState('14');
  const [conds, setConds] = useState([{ field: 'Status', op: 'is any of', val: 'Vacant, Pending MOI' }]);
  const [stops, setStops] = useState([{ field: 'Status', op: 'changes to', val: 'Occupied / Leased' }]);
  const [showConds, setShowConds] = useState(false);

  const impact = useMemo(() => {
    if (scope === 'sfr') return PORTFOLIOS.filter((p) => pfSel.has(p.name)).reduce((n, p) => n + p.homes, 0);
    return COMMUNITIES.filter((c) => commSel.has(c.name)).reduce((n, c) => n + c.homes, 0);
  }, [scope, pfSel, commSel]);
  const dueDays = Number(repeatDays) || 14;

  const toggle = (set: Set<string>, val: string, upd: (s: Set<string>) => void) => {
    const next = new Set(set); next.has(val) ? next.delete(val) : next.add(val); upd(next);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/services" className="text-gray-500 hover:text-brand text-sm shrink-0" aria-label="Back to Services">← Services</Link>
          <img src="/favicon.svg" alt="ResiWalk" className="h-7 w-7 object-contain shrink-0" />
          <div className="font-heading font-extrabold text-ink">Rules Engine</div>
          <span className="text-[9px] font-bold uppercase tracking-wider text-white bg-gray-700 px-1.5 py-0.5 rounded">Admin</span>
          <span className="text-[9px] font-bold uppercase tracking-wider text-white bg-purple-600 px-1.5 py-0.5 rounded">Sample</span>
        </div>
      </header>

      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)_300px] gap-4 p-4">
        {/* rule list */}
        <aside className="space-y-2">
          <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1">Rules</div>
          <button className="w-full text-brand bg-brand/5 border border-dashed border-brand/40 rounded-xl py-2 text-[13px] font-heading font-bold">+ New rule</button>
          <div className="bg-white border-2 border-brand rounded-xl p-3">
            <div className="font-heading font-bold text-[13px] text-ink">Vacant Turn — Grass Cut</div>
            <div className="flex gap-1.5 mt-1.5"><span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">SFR</span><span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">Grass Cut</span></div>
            <div className="text-[11px] text-gray-500 mt-1.5">3 portfolios · <b className="text-ink">1,204</b> homes</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-3 opacity-90">
            <div className="font-heading font-bold text-[13px] text-ink">Atlanta Communities — Grass</div>
            <div className="flex gap-1.5 mt-1.5"><span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">Community</span><span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">Grass Cut</span></div>
            <div className="text-[11px] text-gray-500 mt-1.5">4 communities · <b className="text-ink">386</b> homes</div>
          </div>
        </aside>

        {/* editor */}
        <main className="space-y-4">
          <div>
            <h1 className="font-heading font-extrabold text-2xl text-ink">Vacant Turn — Grass Cut</h1>
            <p className="text-gray-500 text-[13px] mt-0.5">Recurring grass cuts on vacant SFR turns across the Sunbelt portfolios.</p>
          </div>

          <Card n="1" title="What & where" sub="Pick the worktype, then target by portfolio (SFR) or community. Lists come from your Property / Community records.">
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
                <button onClick={() => setScope('sfr')} className={`px-3 py-1.5 rounded-md ${scope === 'sfr' ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-600'}`}>SFR (Property)</button>
                <button onClick={() => setScope('community')} className={`px-3 py-1.5 rounded-md ${scope === 'community' ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-600'}`}>Community</button>
              </div>
              <select className="text-[13px] font-heading font-semibold px-2.5 py-1.5 border border-gray-300 rounded-lg bg-white text-ink">
                {WORKTYPES.filter((w) => w.scopes.includes(scope === 'sfr' ? 'property' : 'community')).map((w) => <option key={w.id}>{w.label}</option>)}
              </select>
            </div>

            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">
              {scope === 'sfr' ? 'Portfolios — unique list from Properties' : 'Communities — unique names from Community object'}
            </div>
            <div className="flex flex-wrap gap-2">
              {scope === 'sfr'
                ? PORTFOLIOS.map((p) => <Chip key={p.name} on={pfSel.has(p.name)} label={p.name} count={p.homes} onClick={() => toggle(pfSel, p.name, setPfSel)} />)
                : COMMUNITIES.map((c) => <Chip key={c.name} on={commSel.has(c.name)} label={c.name} count={c.homes} onClick={() => toggle(commSel, c.name, setCommSel)} />)}
            </div>
            <div className="mt-3 text-[13px] flex items-center gap-2">
              <span>📍 Selected <b>{scope === 'sfr' ? pfSel.size : commSel.size} {scope === 'sfr' ? 'portfolios' : 'communities'}</b> →</span>
              <span className="text-brand font-extrabold tabular-nums">{impact.toLocaleString()} properties</span>
            </div>

            <button onClick={() => setShowConds((v) => !v)} className="mt-4 w-full text-left text-[12.5px] font-heading font-semibold text-gray-600 border border-dashed border-gray-300 rounded-xl px-3 py-2.5 hover:border-brand/40">
              {showConds ? '▾' : '▸'} Advanced conditions (optional — narrow by any Property / Community field)
            </button>
            {showConds && (
              <div className="mt-2 border border-gray-200 rounded-xl p-3 bg-gray-50">
                {conds.map((c, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Property</span>
                    <span className="text-[12.5px] font-semibold bg-white border border-gray-300 rounded px-2 py-1">{c.field}</span>
                    <span className="text-[12px] italic text-gray-500">{c.op}</span>
                    <span className="text-[11.5px] font-semibold bg-brand/10 text-brand rounded-full px-2 py-0.5">{c.val}</span>
                    <button onClick={() => setConds(conds.filter((_, j) => j !== i))} className="ml-auto text-gray-400 hover:text-red-500">×</button>
                  </div>
                ))}
                <button onClick={() => setConds([...conds, { field: 'Home type', op: 'is', val: 'Single-Family' }])} className="mt-2 text-[12px] font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1 bg-white hover:border-brand/40">+ Condition</button>
              </div>
            )}
          </Card>

          <Card n="2" title="Cadence" sub="Recurs relative to the last completed cut per home — not a fixed calendar date. Set any interval.">
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Repeat every</div>
                <div className="flex items-center gap-2">
                  <input value={repeatDays} onChange={(e) => setRepeatDays(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
                    className="w-16 text-[13px] tabular-nums px-2 py-1.5 border border-gray-300 rounded-lg bg-white text-ink" />
                  <span className="text-[13px] text-gray-500">days from last completed cut</span>
                </div>
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Active months</div>
                <div className="flex items-center gap-2">
                  <select defaultValue="March" className="text-[13px] px-2 py-1.5 border border-gray-300 rounded-lg bg-white text-ink">{MONTHS.map((m) => <option key={m}>{m}</option>)}</select>
                  <span className="text-gray-400">→</span>
                  <select defaultValue="October" className="text-[13px] px-2 py-1.5 border border-gray-300 rounded-lg bg-white text-ink">{MONTHS.map((m) => <option key={m}>{m}</option>)}</select>
                </div>
              </div>
            </div>
            <div className="mt-3 text-[12.5px] text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
              📅 Each work order issues with a <b className="text-ink">due date = issue date + {dueDays} days</b>. Outside the active months the home is skipped.
            </div>
          </Card>

          <Card n="3" title="Stop conditions" sub="When any becomes true for a home, stop scheduling it and auto-cancel its open (not-yet-done) work orders." accent="border-l-4 border-l-red-400">
            {stops.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">Property</span>
                <span className="text-[12.5px] font-semibold bg-white border border-gray-300 rounded px-2 py-1">{c.field}</span>
                <span className="text-[12px] italic text-gray-500">{c.op}</span>
                <span className="text-[11.5px] font-semibold bg-red-100 text-red-700 rounded-full px-2 py-0.5">{c.val}</span>
                <button onClick={() => setStops(stops.filter((_, j) => j !== i))} className="ml-auto text-gray-400 hover:text-red-500">×</button>
              </div>
            ))}
            <button onClick={() => setStops([...stops, { field: 'Recurring services', op: 'is', val: 'Paused' }])} className="mt-2 text-[12px] font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1 bg-white hover:border-red-300">+ Stop condition</button>
          </Card>

          <Card n="4" title="Assignment" sub="Auto-assigns from each vendor's coverage (set in Vendors) + capacity + on-time %. Override to pin or restrict.">
            {[
              { r: 1, name: 'GreenBlade Lawn Co.', meta: 'covers Fulton · cap 120/wk · 98% on-time', load: 62, top: true },
              { r: 2, name: 'Peachtree Grounds', meta: 'Fulton, DeKalb · cap 80/wk · 91% on-time', load: 88, top: false },
              { r: 3, name: 'Metro Cut LLC', meta: 'Cobb, Fulton · cap 150/wk · 84% on-time', load: 40, top: false },
            ].map((v) => (
              <div key={v.r} className="flex items-center gap-3 border border-gray-200 rounded-xl px-3 py-2 bg-gray-50 mb-1.5">
                <span className={`w-5 h-5 rounded-md grid place-items-center text-[11px] font-extrabold ${v.top ? 'bg-brand text-white' : 'bg-gray-200 text-gray-600'}`}>{v.r}</span>
                <div className="flex-1 min-w-0"><div className="font-heading font-bold text-[13px] text-ink">{v.name}</div><div className="text-[11px] text-gray-500">{v.meta}</div></div>
                <div className="w-16 h-1.5 rounded-full bg-gray-200 overflow-hidden"><div className={`h-full ${v.load > 80 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${v.load}%` }} /></div>
              </div>
            ))}
          </Card>

          <Card n="5" title="Pricing — vendor & client" sub="Vendor amount from the worktype default or the assigned vendor's rate. Client = vendor × the portfolio's markup % for this worktype (Rate Book).">
            <div className="flex flex-wrap items-center gap-3">
              <div className="border border-blue-300 rounded-xl px-4 py-2"><div className="text-[10px] font-bold uppercase text-gray-400">Vendor amount</div><div className="text-lg font-extrabold tabular-nums text-blue-700">$42.00</div></div>
              <span className="text-gray-400 font-bold">×</span>
              <div className="border border-gray-200 rounded-xl px-4 py-2"><div className="text-[10px] font-bold uppercase text-gray-400">Markup · Amherst</div><div className="text-lg font-extrabold tabular-nums text-brand">+35%</div></div>
              <span className="text-gray-400 font-bold">=</span>
              <div className="border border-emerald-300 bg-emerald-50 rounded-xl px-4 py-2"><div className="text-[10px] font-bold uppercase text-gray-400">Client amount</div><div className="text-lg font-extrabold tabular-nums text-emerald-700">$56.70</div></div>
            </div>
          </Card>
        </main>

        {/* impact */}
        <aside className="space-y-3">
          <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400">Live impact</div>
          <div className="bg-white border border-gray-200 rounded-2xl p-4">
            <div className="text-4xl font-extrabold tabular-nums text-ink leading-none">{impact.toLocaleString()}</div>
            <div className="text-[12px] text-gray-500 mt-1">homes matched</div>
            <div className="grid grid-cols-3 gap-2 mt-4 text-center">
              <div className="border border-gray-200 rounded-lg py-2"><div className="font-extrabold tabular-nums">6</div><div className="text-[10px] uppercase text-gray-400">vendors</div></div>
              <div className="border border-gray-200 rounded-lg py-2"><div className="font-extrabold tabular-nums">86</div><div className="text-[10px] uppercase text-gray-400">/ night</div></div>
              <div className="border border-gray-200 rounded-lg py-2"><div className="font-extrabold tabular-nums">35%</div><div className="text-[10px] uppercase text-gray-400">markup</div></div>
            </div>
          </div>
          <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 text-[12.5px]">
            <b>⚠ Overlaps “All Portfolios — Grass (base)”</b> on {impact.toLocaleString()} homes. This rule targets specific portfolios, so it's more specific and wins them; the base rule covers the rest. Nothing double-generated.
          </div>
          <div className="bg-gray-50 border border-gray-200 text-gray-600 rounded-xl p-3 text-[12.5px]">
            <b className="text-ink">↻ Dry run:</b> tonight → <b className="text-ink tabular-nums">86</b> work orders (homes past {dueDays} days since last cut), <b className="text-ink">6</b> vendors assigned, <b className="text-ink">0</b> duplicates.
          </div>
          <div className="flex gap-2">
            <button className="flex-1 border border-gray-300 bg-white rounded-xl py-2.5 font-heading font-bold text-[13px] text-ink">Simulate</button>
            <button className="flex-1 bg-brand text-white rounded-xl py-2.5 font-heading font-bold text-[13px]">Save &amp; activate</button>
          </div>
        </aside>
      </div>
    </div>
  );
}
