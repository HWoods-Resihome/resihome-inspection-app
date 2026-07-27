/**
 * Admin Properties — a searchable/filterable list of every property. Admin-only
 * (gated in getServerSideProps + the backing API routes). Search by address/ZIP,
 * filter by Region (server-side) and Community/Subdivision (faceted from the
 * loaded rows). Each property card lazily loads its recent activity as it scrolls
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
import { searchPropertiesAdmin, fetchRegionEnumOptions } from '@/lib/hubspot';
import type { AdminPropertyRow } from '@/lib/types';
import { MultiFilter } from '@/components/MultiFilter';
import { SERVICE_STATUS_STYLE, serviceStatusText, type ServiceStatus } from '@/lib/services/model';

interface InspRow { id: string; label: string; status: string; date: string | null; inspectorName: string }
interface SvcRow { id: string; label: string; status: string; isGrassCut: boolean; completedAt: string | null; dueDate: string | null; vendor: string; date: string | null }
interface Activity { inspections: InspRow[]; services: SvcRow[] }

interface Props {
  initialProperties: AdminPropertyRow[];
  initialAfter: string | null;
  regionOptions: string[];
}

export const getServerSideProps: GetServerSideProps<Props> = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  if (!session?.email || !(await isAppAdmin(session.email).catch(() => false))) {
    return { redirect: { destination: '/app', permanent: false } };
  }
  const [page, regions] = await Promise.all([
    searchPropertiesAdmin({ limit: 30 }).catch(() => ({ properties: [] as AdminPropertyRow[], after: undefined })),
    fetchRegionEnumOptions().catch(() => null),
  ]);
  return {
    props: {
      // Strip undefined-valued keys so Next can serialize the props.
      initialProperties: JSON.parse(JSON.stringify(page.properties)),
      initialAfter: page.after || null,
      regionOptions: regions || [],
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

export default function PropertiesPage({ initialProperties, initialAfter, regionOptions }: Props) {
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState<string[]>([]);
  const [community, setCommunity] = useState<string[]>([]);
  const [subdivision, setSubdivision] = useState<string[]>([]);
  const [properties, setProperties] = useState<AdminPropertyRow[]>(initialProperties);
  const [after, setAfter] = useState<string | null>(initialAfter);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
  // whatever's loaded. Community/Subdivision are always faceted from loaded rows.
  const regionOpts = useMemo(() => {
    if (regionOptions.length) return regionOptions;
    return Array.from(new Set(properties.map((p) => p.region).filter(Boolean) as string[])).sort();
  }, [regionOptions, properties]);
  const facets = useMemo(() => {
    const comm = new Set<string>(); const sub = new Set<string>();
    for (const p of properties) {
      if (p.community && (subdivision.length === 0 || subdivision.includes(p.subdivision || ''))) comm.add(p.community);
      if (p.subdivision && (community.length === 0 || community.includes(p.community || ''))) sub.add(p.subdivision);
    }
    return { communityOptions: Array.from(comm).sort(), subdivisionOptions: Array.from(sub).sort() };
  }, [properties, community, subdivision]);

  // Community/Subdivision narrow the loaded set client-side (Region + search are
  // applied server-side above).
  const visible = useMemo(() => properties.filter((p) =>
    (community.length === 0 || community.includes(p.community || '')) &&
    (subdivision.length === 0 || subdivision.includes(p.subdivision || ''))
  ), [properties, community, subdivision]);

  const anyFilter = !!search.trim() || region.length > 0 || community.length > 0 || subdivision.length > 0;
  const clearAll = () => { setSearch(''); setRegion([]); setCommunity([]); setSubdivision([]); };
  const toggle = (id: string) => setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const pickerCls = (active: boolean) => `text-[13px] rounded-lg border px-3 py-2 ${active ? 'border-brand text-brand bg-brand/5' : 'border-gray-300 text-gray-700 bg-white'}`;

  return (
    <>
      <Head><title>Properties · ResiWALK</title></Head>
      <div className="min-h-screen bg-gray-50">
        <header className="bg-ink text-white">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
            <Link href="/app" aria-label="Back" className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-white/90 hover:text-white hover:bg-white/15">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </Link>
            <h1 className="font-heading font-extrabold text-lg">Properties</h1>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-4 py-4 space-y-3">
          {/* Search */}
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            </span>
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search address or ZIP…"
              className="w-full text-sm border border-gray-300 rounded-xl pl-10 pr-3 py-2.5 bg-white focus:outline-none focus:border-brand" />
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <MultiFilter label="Region" selected={region} onChange={setRegion} className={pickerCls(region.length > 0)}
              options={regionOpts.map((r) => ({ value: r, label: r }))} sheet selectAll />
            {facets.communityOptions.length > 0 && (
              <MultiFilter label="Community" selected={community} onChange={setCommunity} className={pickerCls(community.length > 0)}
                options={facets.communityOptions.map((c) => ({ value: c, label: c }))} sheet selectAll />
            )}
            {facets.subdivisionOptions.length > 0 && (
              <MultiFilter label="Subdivision" selected={subdivision} onChange={setSubdivision} className={pickerCls(subdivision.length > 0)}
                options={facets.subdivisionOptions.map((s) => ({ value: s, label: s }))} sheet selectAll />
            )}
            {anyFilter && (
              <button type="button" onClick={clearAll} className="text-[13px] text-gray-500 underline px-2 py-2">Clear filters</button>
            )}
          </div>

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

          {/* Load more — the server has another page. Client Community/Subdivision
              facets filter what's already loaded, so paging pulls more to filter. */}
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
