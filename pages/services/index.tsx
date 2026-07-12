import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { searchServiceWorkOrders } from '@/lib/hubspot';
import { MultiFilter } from '@/components/MultiFilter';
import { WORKTYPES, worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import {
  SAMPLE_SERVICES, SAMPLE_REGIONS, SAMPLE_STATUS_ORDER, REFERENCE_TODAY,
  SERVICE_STATUS_LABEL as STATUS_LABEL, SERVICE_STATUS_STYLE as STATUS_STYLE, serviceStatusText,
  type ServiceStatus, type SampleService,
} from '@/lib/services/sampleData';
import { SERVICE_VENDOR_NAMES } from '@/lib/services/vendors';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  const real = await searchServiceWorkOrders().catch(() => null);
  return {
    props: {
      userName: session?.name || session?.email || '',
      canCreate: isInternalEmail(session?.email),
      services: real ?? SAMPLE_SERVICES,
      live: !!real,
    },
  };
};


type SortField = 'due' | 'address' | 'worktype' | 'vendor' | 'status' | 'region' | 'community';
const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'due', label: 'Due date' }, { value: 'address', label: 'Address' },
  { value: 'worktype', label: 'Work type' }, { value: 'vendor', label: 'Vendor' },
  { value: 'region', label: 'Region' }, { value: 'community', label: 'Community' },
  { value: 'status', label: 'Status' },
];
const OPEN_STATUSES: ServiceStatus[] = ['estimated', 'assigned', 'submitted', 'review'];
const fmtDue = (iso: string) => {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? iso : `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(-2)}`;
};

export default function ServicesHome({ userName, canCreate, services, live }: { userName: string; canCreate: boolean; services: SampleService[]; live: boolean }) {
  const router = useRouter();
  // Admin "view as vendor" preview (?as=vendor): shows the external vendor
  // experience — no admin create/settings, and the vendor-visibility rule applies.
  const asVendor = router.query.as === 'vendor';
  const isAdmin = canCreate && !asVendor;
  const [status, setStatus] = useState<ServiceStatus | 'all'>('all');
  const [worktype, setWorktype] = useState<string[]>([]);
  const [vendor, setVendor] = useState<string[]>([]);
  const [region, setRegion] = useState<string[]>([]);
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
    return services.filter((s) =>
      (worktype.length === 0 || worktype.includes(s.worktype)) &&
      (vendor.length === 0 || vendor.includes(s.vendor || '—')) &&
      (region.length === 0 || region.includes(s.region)) &&
      (!q || `${s.address} ${s.locality} ${s.community || ''} ${s.vendor || ''} ${worktypeLabel(s.worktype)} ${subtypeLabel(s.worktype, s.subtype)} ${s.portfolio}`.toLowerCase().includes(q))
    );
  }, [worktype, vendor, region, search, services]);

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

  // Canceled is excluded from the counts and the list (matches inspections, which
  // hides cancelled records and doesn't count them).
  const counts = useMemo(() => {
    const active = scoped.filter((s) => s.status !== 'canceled');
    const c: Record<string, number> = { all: active.length };
    for (const st of SAMPLE_STATUS_ORDER) c[st] = active.filter((s) => s.status === st).length;
    return c;
  }, [scoped]);

  const rows = useMemo(() => {
    let list = scoped.filter((s) => s.status !== 'canceled');
    if (pastDueOnly) list = list.filter((s) => OPEN_STATUSES.includes(s.status) && s.dueDate < REFERENCE_TODAY);
    else if (status !== 'all') list = list.filter((s) => s.status === status);
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = (s: typeof list[number]) => ({
      due: s.dueDate, address: s.address.toLowerCase(), worktype: worktypeLabel(s.worktype),
      vendor: (s.vendor || '~').toLowerCase(), status: String(SAMPLE_STATUS_ORDER.indexOf(s.status)),
      region: s.region.toLowerCase(), community: (s.community || '~').toLowerCase(),
    }[sortField]);
    return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * dir);
  }, [scoped, status, pastDueOnly, sortField, sortDir]);

  const chip = (val: ServiceStatus | 'all', label: string) => (
    <button type="button" onClick={() => { setStatus(val); setPastDueOnly(false); }}
      className={`w-full text-center text-[11px] font-heading font-semibold px-2 py-1.5 rounded-full border transition whitespace-nowrap ${
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
                <h1 className="font-heading font-extrabold text-lg tracking-tight">Services</h1>
                {userName && <div className="text-xs text-white/80 truncate">Welcome, {userName}</div>}
              </div>
            </div>
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              <Link href="/services/calendar" aria-label="Calendar" title="Calendar &amp; map"
                className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
              </Link>
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
              {isAdmin && (
              <div className="relative">
                <button type="button" onClick={() => { setGearOpen((o) => !o); setMenuOpen(false); }} aria-label="Settings" aria-expanded={gearOpen}
                  className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                </button>
                {gearOpen && (<><div className="fixed inset-0 z-30" onClick={() => setGearOpen(false)} />
                  <div className="absolute right-0 mt-1 w-48 bg-white rounded-xl shadow-lg border border-gray-200 z-40 overflow-hidden text-ink">
                    <div className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-400">Admin</div>
                    <Link href="/services/rules" className="block px-4 py-2.5 text-sm hover:bg-gray-50">Rules Engine</Link>
                    <Link href="/services/forms" className="block px-4 py-2.5 text-sm hover:bg-gray-50">Form Builder</Link>
                    <Link href="/services/ai-knowledge" className="block px-4 py-2.5 text-sm hover:bg-gray-50">AI Knowledge</Link>
                    <Link href="/services?as=vendor" className="block px-4 py-2.5 text-sm hover:bg-gray-50 border-t border-gray-100">View as Vendor</Link>
                  </div></>)}
              </div>
              )}
            </div>
          </div>
          {/* New Service lives INSIDE the pink header (like "+ New Inspection"),
              so the banner extends down past it instead of ending at a white gap. */}
          {isAdmin && (
            <Link href="/services/new" className="mt-2.5 flex items-center gap-3 bg-pink-100 hover:bg-pink-200 rounded-xl px-4 py-2.5 transition active:scale-[0.99] shadow-md">
              <span className="w-9 h-9 bg-brand rounded-lg flex items-center justify-center shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-white"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </span>
              <span className="font-heading font-bold text-base text-brand">New Service</span>
            </Link>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto w-full px-4 py-3 flex-1">
        {asVendor && (
          <div className="mb-3 flex items-center justify-between gap-2 bg-purple-600 text-white rounded-xl px-3 py-2 text-[12px] font-heading font-semibold">
            <span>Viewing as Vendor — admin controls &amp; client pricing hidden.</span>
            <Link href="/services" className="underline shrink-0">Exit</Link>
          </div>
        )}
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
            <div className="grid grid-cols-3 gap-1.5">
              {chip('all', 'All')}{chip('estimated', 'Estimated')}{chip('assigned', 'Assigned')}{chip('submitted', 'Submitted')}{chip('review', 'Review')}{chip('completed', 'Completed')}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <div className="flex-1 min-w-0">
                <MultiFilter label="Type" selected={worktype} onChange={setWorktype} className={pickerCls(worktype.length > 0)}
                  options={WORKTYPES.map((w) => ({ value: w.id, label: w.label }))} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Vendor" selected={vendor} onChange={setVendor} className={pickerCls(vendor.length > 0)}
                  options={[...SERVICE_VENDOR_NAMES.map((v) => ({ value: v, label: v })), { value: '—', label: 'Unassigned' }]} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Region" selected={region} onChange={setRegion} className={pickerCls(region.length > 0)}
                  options={SAMPLE_REGIONS.map((r) => ({ value: r, label: r }))} />
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
            {(status !== 'all' || pastDueOnly || worktype.length > 0 || vendor.length > 0 || region.length > 0 || search) && (
              <div className="flex justify-end">
                <button type="button" onClick={() => { setStatus('all'); setPastDueOnly(false); setWorktype([]); setVendor([]); setRegion([]); setSearch(''); }}
                  className="text-[11px] font-heading font-semibold text-gray-500 hover:text-brand underline">Clear filters</button>
              </div>
            )}
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
              <Link key={s.id} href={`/services/${s.id}`} className="block bg-white border border-gray-200 rounded-xl px-3.5 py-2.5 hover:border-brand/40 active:scale-[0.998] transition">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="font-heading font-bold text-ink truncate">{s.address}</span>
                    <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${s.scope === 'community' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{s.scope === 'community' ? 'Community' : 'SFR'}</span>
                  </div>
                  <span className="shrink-0 inline-flex items-center gap-1">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-heading font-semibold border ${STATUS_STYLE[s.status]}`}>{serviceStatusText(s.status, isAdmin)}</span>
                    {isAdmin && s.status === 'submitted' && <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-heading font-semibold border bg-indigo-100 text-indigo-700 border-indigo-300">AI Processing</span>}
                  </span>
                </div>
                <div className="text-[12px] text-gray-500 truncate mt-0.5">{s.locality}{s.community ? ` · ${s.community}` : ''}</div>
                {/* Line 3: worktype · subtype (+ property status) with the vendor on the right. */}
                <div className="mt-1 flex items-center justify-between gap-2">
                  <div className="text-[12px] text-gray-600 flex flex-wrap gap-x-3 gap-y-0.5 min-w-0">
                    <span className="font-semibold text-ink">{worktypeLabel(s.worktype)} · {subtypeLabel(s.worktype, s.subtype)}</span>
                    {s.scope !== 'community' && s.propertyStatus && <span>{s.propertyStatus}</span>}
                  </div>
                  <span className="text-[12px] shrink-0 text-right">{s.vendor || <span className="text-brand font-semibold">Unassigned</span>}</span>
                </div>
                {/* Line 4: due date — always on its own line. */}
                <div className={`mt-0.5 text-[12px] ${overdue ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>Due {fmtDue(s.dueDate)}</div>
              </Link>
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
