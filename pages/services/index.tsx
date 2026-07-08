import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { ListPicker } from '@/components/ListPicker';
import { WORKTYPES, worktypeLabel } from '@/lib/services/worktypes';
import {
  SAMPLE_SERVICES, SAMPLE_VENDORS, SAMPLE_REGIONS, SAMPLE_STATUS_ORDER, REFERENCE_TODAY,
  type ServiceStatus,
} from '@/lib/services/sampleData';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  return { props: { userName: session?.name || session?.email || '' } };
};

const STATUS_LABEL: Record<ServiceStatus, string> = {
  scheduled: 'Scheduled', dispatched: 'Dispatched', in_progress: 'In Progress',
  submitted: 'Submitted', completed: 'Completed', cancelled: 'Cancelled',
};
const STATUS_STYLE: Record<ServiceStatus, string> = {
  scheduled: 'bg-gray-100 text-gray-700 border-gray-300',
  dispatched: 'bg-sky-100 text-sky-800 border-sky-300',
  in_progress: 'bg-amber-100 text-amber-800 border-amber-300',
  submitted: 'bg-purple-100 text-purple-800 border-purple-300',
  completed: 'bg-green-100 text-green-800 border-green-300',
  cancelled: 'bg-gray-100 text-gray-500 border-gray-300 line-through',
};

type SortField = 'due' | 'address' | 'worktype' | 'vendor' | 'status';
const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'due', label: 'Due date' }, { value: 'address', label: 'Address' },
  { value: 'worktype', label: 'Service type' }, { value: 'vendor', label: 'Vendor' },
  { value: 'status', label: 'Status' },
];
const OPEN_STATUSES: ServiceStatus[] = ['scheduled', 'dispatched', 'in_progress', 'submitted'];
const fmtDue = (iso: string) => {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? iso : `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(-2)}`;
};

export default function ServicesHome({ userName }: { userName: string }) {
  const [status, setStatus] = useState<ServiceStatus | 'all'>('all');
  const [worktype, setWorktype] = useState('all');
  const [vendor, setVendor] = useState('all');
  const [region, setRegion] = useState('all');
  const [search, setSearch] = useState('');
  const [pastDueOnly, setPastDueOnly] = useState(false);
  const [sortField, setSortField] = useState<SortField>('due');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [gearOpen, setGearOpen] = useState(false);

  // Scope (type/vendor/region/search) drives the summary bubbles; the status chip
  // + Past-Due toggle then drill the list within that scope.
  const scoped = useMemo(() => {
    const q = search.trim().toLowerCase();
    return SAMPLE_SERVICES.filter((s) =>
      (worktype === 'all' || s.worktype === worktype) &&
      (vendor === 'all' || (s.vendor || '—') === vendor) &&
      (region === 'all' || s.region === region) &&
      (!q || `${s.address} ${s.locality} ${s.community || ''} ${s.vendor || ''} ${worktypeLabel(s.worktype)} ${s.portfolio}`.toLowerCase().includes(q))
    );
  }, [worktype, vendor, region, search]);

  const summary = useMemo(() => {
    const open = scoped.filter((s) => OPEN_STATUSES.includes(s.status));
    const done = scoped.filter((s) => s.status === 'completed');
    const onTime = done.filter((s) => s.onTime);
    return {
      open: open.length,
      pastDue: open.filter((s) => s.dueDate < REFERENCE_TODAY).length,
      onTimePct: done.length ? Math.round((onTime.length / done.length) * 100) : null,
    };
  }, [scoped]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: scoped.filter((s) => s.status !== 'cancelled').length };
    for (const st of SAMPLE_STATUS_ORDER) c[st] = scoped.filter((s) => s.status === st).length;
    return c;
  }, [scoped]);

  const rows = useMemo(() => {
    let list = scoped.filter((s) => s.status !== 'cancelled');
    if (pastDueOnly) list = list.filter((s) => OPEN_STATUSES.includes(s.status) && s.dueDate < REFERENCE_TODAY);
    else if (status !== 'all') list = list.filter((s) => s.status === status);
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = (s: typeof list[number]) => ({
      due: s.dueDate, address: s.address.toLowerCase(), worktype: worktypeLabel(s.worktype),
      vendor: (s.vendor || '~').toLowerCase(), status: String(SAMPLE_STATUS_ORDER.indexOf(s.status)),
    }[sortField]);
    return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * dir);
  }, [scoped, status, pastDueOnly, sortField, sortDir]);

  const chip = (val: ServiceStatus | 'all', label: string) => (
    <button type="button" onClick={() => { setStatus(val); setPastDueOnly(false); }}
      className={`flex-1 text-[11px] font-heading font-semibold px-2 py-1.5 rounded-full border transition whitespace-nowrap ${
        status === val && !pastDueOnly ? 'bg-brand text-white border-brand' : 'bg-white text-ink border-gray-300 hover:border-brand/50'}`}>
      {label}{val === 'all' ? ` (${counts.all})` : counts[val] ? ` (${counts[val]})` : ''}
    </button>
  );
  const pickerCls = (active: boolean) =>
    `w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between ${
      active ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`;
  const bubbleActiveRing = 'ring-2 ring-brand ring-offset-1';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Pink header — mirrors the inspections home. */}
      <header className="bg-brand text-white sticky top-0 z-30 shrink-0" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
        <div className="max-w-3xl mx-auto px-4 pt-2 pb-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Link href="/" aria-label="Home" className="shrink-0"><img src="/app-icon.svg" alt="ResiWalk" className="h-11 w-11 object-cover" /></Link>
              <div className="min-w-0">
                <h1 className="font-heading font-extrabold text-lg tracking-tight flex items-center gap-2">
                  Services<span className="text-[9px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.5 rounded">Sample</span>
                </h1>
                {userName && <div className="text-xs text-white/80 truncate">Welcome, {userName}</div>}
              </div>
            </div>
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <div className="relative">
                <button type="button" onClick={() => { setMenuOpen((o) => !o); setGearOpen(false); }} aria-label="Switch app" aria-expanded={menuOpen}
                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="4" y1="8" x2="20" y2="8" /><line x1="4" y1="16" x2="20" y2="16" /></svg>
                </button>
                {menuOpen && (<><div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 mt-1 w-44 bg-white rounded-xl shadow-lg border border-gray-200 z-40 overflow-hidden text-ink">
                    <Link href="/" className="block px-4 py-2.5 text-sm hover:bg-gray-50">Inspections</Link>
                    <div className="px-4 py-2.5 text-sm font-semibold text-brand bg-brand/5">Services ✓</div>
                  </div></>)}
              </div>
              <div className="relative">
                <button type="button" onClick={() => { setGearOpen((o) => !o); setMenuOpen(false); }} aria-label="Settings" aria-expanded={gearOpen}
                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                </button>
                {gearOpen && (<><div className="fixed inset-0 z-30" onClick={() => setGearOpen(false)} />
                  <div className="absolute right-0 mt-1 w-48 bg-white rounded-xl shadow-lg border border-gray-200 z-40 overflow-hidden text-ink">
                    <div className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Admin</div>
                    <Link href="/services/rules" className="block px-4 py-2.5 text-sm hover:bg-gray-50">Rules Engine</Link>
                  </div></>)}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto w-full px-4 py-3 flex-1">
        {/* Summary bubbles — dynamic; Past Due is a clickable filter. */}
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-center">
            <div className="text-2xl font-heading font-extrabold text-ink tabular-nums leading-none">{summary.open}</div>
            <div className="text-[10.5px] text-gray-500 mt-1 font-semibold uppercase tracking-wide">Total Open</div>
          </div>
          <button type="button" onClick={() => setPastDueOnly((v) => !v)}
            title="Show only open work orders that are past due"
            className={`bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-center transition ${pastDueOnly ? bubbleActiveRing : 'hover:border-brand/40'}`}>
            <div className={`text-2xl font-heading font-extrabold tabular-nums leading-none ${summary.pastDue > 0 ? 'text-red-600' : 'text-ink'}`}>{summary.pastDue}</div>
            <div className="text-[10.5px] text-gray-500 mt-1 font-semibold uppercase tracking-wide">Past Due</div>
          </button>
          <div className="bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-center">
            <div className="text-2xl font-heading font-extrabold text-emerald-600 tabular-nums leading-none">{summary.onTimePct == null ? '—' : `${summary.onTimePct}%`}</div>
            <div className="text-[10.5px] text-gray-500 mt-1 font-semibold uppercase tracking-wide">On-Time · 30d</div>
          </div>
        </div>

        {/* Search + filter toggle — mirrors inspections. */}
        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1 min-w-0">
            <input type="text" placeholder="Search address, community, or vendor…" value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-lg pl-3 pr-9 py-2.5 bg-white focus:outline-none focus:border-brand" />
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          </div>
          <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-label="Filters"
            className="shrink-0 inline-flex items-center justify-center gap-1 w-14 h-11 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${filtersOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
          </button>
        </div>

        {/* Collapsible: status chips + one-line Type/Vendor/Region + Sort (no h-scroll). */}
        {filtersOpen && (
          <div className="space-y-1.5 mb-3">
            <div className="flex gap-1.5">{chip('all', 'All')}{chip('scheduled', 'Scheduled')}{chip('dispatched', 'Dispatched')}</div>
            <div className="flex gap-1.5">{chip('in_progress', 'In Progress')}{chip('submitted', 'Submitted')}{chip('completed', 'Completed')}</div>
            <div className="flex items-center gap-2 pt-1">
              <div className="flex-1 min-w-0">
                <ListPicker value={worktype} onChange={setWorktype} ariaLabel="Filter by service type" className={pickerCls(worktype !== 'all')}
                  options={[{ value: 'all', label: 'Type' }, ...WORKTYPES.map((w) => ({ value: w.id, label: w.label }))]} />
              </div>
              <div className="flex-1 min-w-0">
                <ListPicker value={vendor} onChange={setVendor} ariaLabel="Filter by vendor" className={pickerCls(vendor !== 'all')}
                  options={[{ value: 'all', label: 'Vendor' }, ...SAMPLE_VENDORS.map((v) => ({ value: v, label: v })), { value: '—', label: 'Unassigned' }]} />
              </div>
              <div className="flex-1 min-w-0">
                <ListPicker value={region} onChange={setRegion} ariaLabel="Filter by region" className={pickerCls(region !== 'all')}
                  options={[{ value: 'all', label: 'Region' }, ...SAMPLE_REGIONS.map((r) => ({ value: r, label: r }))]} />
              </div>
              {/* Sort — identical to inspections: tap a field to sort; tap the active field again to flip direction. */}
              <div className="relative shrink-0">
                <button type="button" onClick={() => setSortOpen((o) => !o)} aria-expanded={sortOpen}
                  className="inline-flex items-center gap-1 text-[11px] font-heading font-semibold text-gray-700 hover:text-brand px-2 py-1.5 border border-gray-300 rounded-md bg-white"
                  title="Choose how to sort. Tap the selected field again to reverse the order.">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6" /><line x1="7" y1="12" x2="17" y2="12" /><line x1="10" y1="18" x2="14" y2="18" /></svg>
                  <span>Sort</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${sortOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
                </button>
                {sortOpen && (<><div className="fixed inset-0 z-30" onClick={() => setSortOpen(false)} />
                  <div className="absolute right-0 z-40 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                    {SORT_OPTIONS.map((opt) => {
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
          </div>
        )}

        {pastDueOnly && (
          <div className="mb-2 text-[12px] text-red-600 font-semibold flex items-center gap-2">
            Showing past-due open work orders
            <button onClick={() => setPastDueOnly(false)} className="text-gray-500 underline font-normal">clear</button>
          </div>
        )}

        <div className="space-y-2">
          {rows.map((s) => {
            const overdue = OPEN_STATUSES.includes(s.status) && s.dueDate < REFERENCE_TODAY;
            return (
              <div key={s.id} className="block bg-white border border-gray-200 rounded-xl px-4 py-3 hover:border-brand/40 transition-colors">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-heading font-bold text-ink truncate">{s.address}</span>
                      <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${s.scope === 'community' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{s.scope === 'community' ? 'Community' : 'SFR'}</span>
                    </div>
                    <div className="text-[12px] text-gray-500 truncate">{s.locality}{s.community ? ` · ${s.community}` : ''}</div>
                    <div className="text-[12px] text-gray-600 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span className="font-semibold text-ink">{worktypeLabel(s.worktype)}</span>
                      <span>{s.vendor || <span className="text-brand font-semibold">Unassigned</span>}</span>
                      <span className={overdue ? 'text-red-600 font-semibold' : ''}>Due {fmtDue(s.dueDate)}{overdue ? ' · Past due' : ''}</span>
                      <span className="text-gray-400">{s.region}</span>
                    </div>
                  </div>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-heading font-semibold border shrink-0 ${STATUS_STYLE[s.status]}`}>{STATUS_LABEL[s.status]}</span>
                </div>
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="text-center text-gray-500 text-sm py-12 border border-dashed border-gray-300 rounded-xl">No services match these filters.</div>
          )}
        </div>
      </main>
    </div>
  );
}
