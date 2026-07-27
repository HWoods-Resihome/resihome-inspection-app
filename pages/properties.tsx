/**
 * Admin Properties — a searchable/filterable list of every property. Admin-only
 * (gated in getServerSideProps + the backing API routes). Search by address/ZIP,
 * filter by Region (a field, server-side) and Community (the associated community
 * object's name, enriched onto each row). Each property card lazily loads its
 * recent activity as it scrolls
 * into view (last inspection / last service / last grass-cut chips), and expands
 * to show the full recent inspections + services, each linking to its record.
 *
 * Scale note: the Property object holds 15k+ records, so the list is search/region
 * driven — an initial page is rendered on open (SSR) and "Load more" pages the
 * rest; a search or region filter re-queries the server rather than filtering a
 * full client-side pull (which HubSpot search caps at 10k).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GetServerSideProps, NextApiRequest } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { servicesEnabled } from '@/lib/servicesAccess';
import { searchPropertiesAdmin, fetchRegionEnumOptions } from '@/lib/hubspot';
import type { AdminPropertyRow } from '@/lib/types';
import { MultiFilter } from '@/components/MultiFilter';
import { SettingsMenu } from '@/components/SettingsMenu';
import { SERVICE_STATUS_STYLE, serviceStatusText, type ServiceStatus } from '@/lib/services/model';

interface InspRow { id: string; label: string; status: string; date: string | null; inspectorName: string }
interface SvcRow { id: string; label: string; status: string; isGrassCut: boolean; completedAt: string | null; dueDate: string | null; vendor: string; date: string | null }
interface Activity { inspections: InspRow[]; services: SvcRow[] }

interface Props {
  initialProperties: AdminPropertyRow[];
  initialAfter: string | null;
  regionOptions: string[];
  userName: string;
  canServices: boolean;
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return { redirect: { destination: '/app', permanent: false } };
  }
  const [page, regions, canServices] = await Promise.all([
    searchPropertiesAdmin({ limit: 30 }).catch(() => ({ properties: [] as AdminPropertyRow[], after: undefined })),
    fetchRegionEnumOptions().catch(() => null),
    servicesEnabled(session.email).catch(() => false),
  ]);
  return {
    props: {
      // Strip undefined-valued keys so Next can serialize the props.
      initialProperties: JSON.parse(JSON.stringify(page.properties)),
      initialAfter: page.after || null,
      regionOptions: regions || [],
      userName: session.name || '',
      canServices,
    },
  };
};

// ── Lazy per-property activity: fetched once when a card first scrolls into view,
// cached module-wide so re-mounts (filter changes, scroll) never refetch. ──
const activityCache = new Map<string, Activity>();
const activityInflight = new Map<string, Promise<Activity>>();
async function loadActivity(id: string): Promise<Activity> {
  const cached = activityCache.get(id);
  if (cached) return cached;
  const inflight = activityInflight.get(id);
  if (inflight) return inflight;
  const pr = fetch(`/api/properties/${encodeURIComponent(id)}/activity`)
    .then((r) => (r.ok ? r.json() : { inspections: [], services: [] }))
    .then((d) => {
      const a: Activity = { inspections: d.inspections || [], services: d.services || [] };
      activityCache.set(id, a); activityInflight.delete(id); return a;
    })
    .catch(() => { activityInflight.delete(id); return { inspections: [], services: [] } as Activity; });
  activityInflight.set(id, pr);
  return pr;
}

const toMs = (v: string | null): number => {
  if (!v) return 0;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
};
const maxDate = (vals: (string | null)[]): string | null => {
  let best = -1; let bestS: string | null = null;
  for (const v of vals) { const t = toMs(v); if (t > best) { best = t; bestS = v; } }
  return bestS;
};
const fmtDate = (v: string | null): string => {
  if (!v) return '—';
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${Number(m[2])}-${Number(m[3])}-${m[1].slice(2)}`;
  const d = /^\d{10,}$/.test(s) ? new Date(Number(s)) : new Date(s);
  return isNaN(+d) ? '—' : `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
};
const sortByDateDesc = <T extends { date: string | null }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => toMs(b.date) - toMs(a.date));

function StatusChip({ text, cls }: { text: string; cls: string }) {
  return <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${cls}`}>{text}</span>;
}
const INSP_CHIP = 'bg-slate-100 text-slate-700 border-slate-300';

function ActivitySummaryChips({ activity }: { activity: Activity | null }) {
  if (!activity) return <span className="text-[11px] text-gray-300">loading…</span>;
  const lastInsp = maxDate(activity.inspections.map((i) => i.date));
  const lastSvc = maxDate(activity.services.filter((s) => s.completedAt).map((s) => s.completedAt));
  const lastGc = maxDate(activity.services.filter((s) => s.isGrassCut && s.completedAt).map((s) => s.completedAt));
  const chip = (label: string, v: string | null) => (
    <span className="text-[11px] text-gray-500 whitespace-nowrap">{label} <b className="text-ink tabular-nums">{fmtDate(v)}</b></span>
  );
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 justify-end">
      {chip('Insp', lastInsp)}
      {chip('Svc', lastSvc)}
      {chip('GC', lastGc)}
    </div>
  );
}

function PropertyCard({ p, expanded, onToggle }: { p: AdminPropertyRow; expanded: boolean; onToggle: () => void }) {
  const [activity, setActivity] = useState<Activity | null>(() => activityCache.get(p.recordId) || null);
  const ref = useRef<HTMLDivElement>(null);

  // Lazy-load activity when the card first appears (or immediately if expanded).
  useEffect(() => {
    if (activity) return;
    if (expanded) { loadActivity(p.recordId).then(setActivity); return; }
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { loadActivity(p.recordId).then(setActivity); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); loadActivity(p.recordId).then(setActivity); }
    }, { rootMargin: '250px' });
    io.observe(el);
    return () => io.disconnect();
  }, [p.recordId, activity, expanded]);

  const inspections = useMemo(() => sortByDateDesc(activity?.inspections || []), [activity]);
  const services = useMemo(() => sortByDateDesc(activity?.services || []), [activity]);
  const lastInsp = maxDate(inspections.map((i) => i.date));
  const lastSvc = maxDate(services.filter((s) => s.completedAt).map((s) => s.completedAt));
  const lastGc = maxDate(services.filter((s) => s.isGrassCut && s.completedAt).map((s) => s.completedAt));

  return (
    <div ref={ref} className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
      <button type="button" onClick={onToggle} aria-expanded={expanded}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-heading font-bold text-ink truncate">{p.address || p.name}</div>
          <div className="text-[12px] text-gray-500 truncate">
            {[p.region, p.status].filter(Boolean).join(' · ') || '—'}
            {p.community ? <span className="text-gray-400"> · {p.community}</span> : null}
          </div>
        </div>
        <div className="hidden sm:block shrink-0"><ActivitySummaryChips activity={activity} /></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {/* Compact chips on small screens (hidden in the header row above). */}
      <div className="sm:hidden px-4 -mt-1 pb-2"><ActivitySummaryChips activity={activity} /></div>

      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3 space-y-4 bg-gray-50/40">
          {/* Recent inspections */}
          <section>
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Recent inspections</div>
              <div className="text-[11px] text-gray-500">Last <b className="text-ink tabular-nums">{fmtDate(lastInsp)}</b></div>
            </div>
            {!activity ? (
              <div className="text-[12px] text-gray-400">Loading…</div>
            ) : inspections.length === 0 ? (
              <div className="text-[12px] text-gray-400">No inspections on this property.</div>
            ) : (
              <div className="space-y-1.5">
                {inspections.map((i) => (
                  <Link key={i.id} href={`/inspection/${encodeURIComponent(i.id)}`}
                    className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 hover:border-brand/50 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-ink truncate">{i.label}</div>
                      {i.inspectorName && <div className="text-[11px] text-gray-400 truncate">{i.inspectorName}</div>}
                    </div>
                    {i.status && <StatusChip text={i.status} cls={INSP_CHIP} />}
                    <div className="text-[12px] text-gray-500 tabular-nums w-16 text-right shrink-0">{fmtDate(i.date)}</div>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {/* Recent services */}
          <section>
            <div className="flex items-baseline justify-between gap-2 mb-1.5">
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Recent services</div>
              <div className="text-[11px] text-gray-500">Last <b className="text-ink tabular-nums">{fmtDate(lastSvc)}</b> · GC <b className="text-ink tabular-nums">{fmtDate(lastGc)}</b></div>
            </div>
            {!activity ? (
              <div className="text-[12px] text-gray-400">Loading…</div>
            ) : services.length === 0 ? (
              <div className="text-[12px] text-gray-400">No services on this property.</div>
            ) : (
              <div className="space-y-1.5">
                {services.map((s) => {
                  const cls = SERVICE_STATUS_STYLE[(s.status || 'assigned') as ServiceStatus] || INSP_CHIP;
                  return (
                    <Link key={s.id} href={`/services/${encodeURIComponent(s.id)}`}
                      className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 hover:border-brand/50 transition-colors">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold text-ink truncate">{s.label}</div>
                        {s.vendor && <div className="text-[11px] text-gray-400 truncate">{s.vendor}</div>}
                      </div>
                      {s.status && <StatusChip text={serviceStatusText((s.status || 'assigned') as ServiceStatus, true)} cls={cls} />}
                      <div className="text-[12px] text-gray-500 tabular-nums w-16 text-right shrink-0">{fmtDate(s.completedAt || s.dueDate || s.date)}</div>
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default function PropertiesPage({ initialProperties, initialAfter, regionOptions, userName, canServices }: Props) {
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState<string[]>([]);
  const [community, setCommunity] = useState<string[]>([]);
  const [properties, setProperties] = useState<AdminPropertyRow[]>(initialProperties);
  const [after, setAfter] = useState<string | null>(initialAfter);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const firstRun = useRef(true);

  const runQuery = useCallback(async (opts: { search: string; regions: string[]; after?: string | null; append?: boolean }) => {
    const qs = new URLSearchParams();
    if (opts.search) qs.set('search', opts.search);
    if (opts.regions.length) qs.set('regions', opts.regions.join(','));
    if (opts.after) qs.set('after', opts.after);
    qs.set('limit', '30');
    const setL = opts.append ? setLoadingMore : setLoading;
    setL(true); setError('');
    try {
      const r = await fetch(`/api/properties/list?${qs.toString()}`);
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not load properties.'); return; }
      setProperties((prev) => (opts.append ? [...prev, ...d.properties] : d.properties));
      setAfter(d.after || null);
    } catch { setError('Couldn’t reach the server. Try again.'); }
    finally { setL(false); }
  }, []);

  // Re-query the server when the search term or region set changes (debounced).
  // Skip the first run — SSR already provided the initial page.
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const h = setTimeout(() => runQuery({ search: search.trim(), regions: region }), 300);
    return () => clearTimeout(h);
  }, [search, region, runQuery]);

  // Region options: the property `region` enum when available, else faceted from
  // whatever's loaded. Community options come from the loaded rows' enriched names.
  const regionOpts = useMemo(() => {
    if (regionOptions.length) return regionOptions;
    return Array.from(new Set(properties.map((p) => p.region).filter(Boolean) as string[])).sort();
  }, [regionOptions, properties]);
  const communityOptions = useMemo(() =>
    Array.from(new Set(properties.map((p) => p.community).filter(Boolean) as string[])).sort()
  , [properties]);

  // Community narrows the loaded set client-side (Region + search are applied
  // server-side above); its options come from the associated community names
  // enriched onto the loaded rows.
  const visible = useMemo(() => properties.filter((p) =>
    community.length === 0 || community.includes(p.community || '')
  ), [properties, community]);

  const anyFilter = !!search.trim() || region.length > 0 || community.length > 0;
  const anyFacetActive = region.length > 0 || community.length > 0;
  const clearAll = () => { setSearch(''); setRegion([]); setCommunity([]); };
  const toggle = (id: string) => setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pickerCls = (active: boolean) => `text-[13px] rounded-lg border px-3 py-2 ${active ? 'border-brand text-brand bg-brand/5' : 'border-gray-300 text-gray-700 bg-white'}`;

  return (
    <>
      <Head><title>Properties · ResiWALK</title></Head>
      <div className="min-h-screen bg-gray-50">
        {/* Pink branded header — mirrors the Inspections masthead: logo + title on
            the left, app switcher + settings gear on the right. */}
        <header className="bg-brand text-white sticky top-0 z-30" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
          <div className="max-w-3xl mx-auto px-4 pt-2 pb-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <Link href="/app" aria-label="Home" className="shrink-0">
                  <img src="/app-icon.svg" alt="ResiWalk" className="h-11 w-11 object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                </Link>
                <div className="min-w-0">
                  <h1 className="font-heading font-extrabold text-lg tracking-tight">Properties</h1>
                  {userName && <div className="text-xs text-white/80 truncate">Welcome, {userName}</div>}
                </div>
              </div>
              <div className="flex items-center gap-3 whitespace-nowrap">
                {/* App switcher — Inspections / Services / Properties (current). */}
                <details className="relative group">
                  <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer inline-flex items-center justify-center w-8 h-8 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors" aria-label="Switch app">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="4" y1="8" x2="20" y2="8" /><line x1="4" y1="16" x2="20" y2="16" /></svg>
                  </summary>
                  <div className="absolute right-0 mt-1 w-44 bg-white rounded-xl shadow-lg border border-gray-200 z-40 overflow-hidden text-ink">
                    <Link href="/app" className="block px-4 py-2.5 text-sm hover:bg-gray-50">Inspections</Link>
                    {canServices && <Link href="/services" className="block px-4 py-2.5 text-sm hover:bg-gray-50">Services</Link>}
                    <div className="px-4 py-2.5 text-sm font-semibold text-brand bg-brand/5">Properties ✓</div>
                  </div>
                </details>
                <SettingsMenu isAdmin />
              </div>
            </div>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-4 py-4 space-y-3">
          {/* Search + a Filters toggle that collapses/expands the Region/Community
              row (a pink dot flags active filters while it's hidden). */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search address or ZIP…"
                className={`w-full pl-3 ${search ? 'pr-14' : 'pr-9'} py-2.5 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:border-brand`} />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search"
                  className="absolute right-9 top-1/2 -translate-y-1/2 text-gray-400 hover:text-brand p-0.5">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                </button>
              )}
            </div>
            <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen}
              aria-label={filtersOpen ? 'Hide filters' : 'Show filters'}
              className="relative shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50 transition-colors">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
              {!filtersOpen && anyFacetActive && <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-brand ring-2 ring-white" />}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`ml-0.5 transition-transform ${filtersOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          </div>

          {/* Region + Community on one row; Clear pushed to the right. */}
          {filtersOpen && (
            <div className="flex items-center gap-2">
              <MultiFilter label="Region" selected={region} onChange={setRegion} className={pickerCls(region.length > 0)}
                options={regionOpts.map((r) => ({ value: r, label: r }))} sheet selectAll />
              {communityOptions.length > 0 && (
                <MultiFilter label="Community" selected={community} onChange={setCommunity} className={pickerCls(community.length > 0)}
                  options={communityOptions.map((c) => ({ value: c, label: c }))} sheet selectAll />
              )}
              {anyFilter && (
                <button type="button" onClick={clearAll} className="ml-auto shrink-0 text-[13px] text-gray-500 hover:text-brand underline px-1 py-2">Clear</button>
              )}
            </div>
          )}

          {error && <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          {/* List */}
          {loading ? (
            <div className="text-center text-sm text-gray-400 py-10">Loading properties…</div>
          ) : visible.length === 0 ? (
            <div className="text-center text-sm text-gray-400 py-10">
              {anyFilter ? 'No properties match these filters.' : 'No properties found.'}
            </div>
          ) : (
            <div className="space-y-2">
              {visible.map((p) => (
                <PropertyCard key={p.recordId} p={p} expanded={expanded.has(p.recordId)} onToggle={() => toggle(p.recordId)} />
              ))}
            </div>
          )}

          {/* Load more — the server has another page. The client Community facet
              filters what's already loaded, so paging pulls more to filter. */}
          {!loading && after && (
            <div className="text-center pt-1">
              <button type="button" disabled={loadingMore}
                onClick={() => runQuery({ search: search.trim(), regions: region, after, append: true })}
                className="text-sm font-heading font-bold rounded-xl px-5 py-2.5 bg-white border border-gray-300 text-ink hover:border-brand/50 disabled:opacity-50">
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
