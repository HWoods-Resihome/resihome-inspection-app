import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { PageHeader } from '@/components/PageHeader';
import dynamic from 'next/dynamic';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { scopeServices } from '@/lib/services/scope';
import { resolveServiceViewerAsync, servicesViewerAllowed } from '@/lib/services/scopeServer';
import { searchServiceWorkOrders } from '@/lib/hubspot';
import { MultiFilter } from '@/components/MultiFilter';
import { WORKTYPES, worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { easternTodayISO, serviceStatusText, type ServiceRecord } from '@/lib/services/model';
import type { MapItem } from '@/components/ServicesMap';

// Map is client-only (Leaflet touches window).
const ServicesMap = dynamic(() => import('@/components/ServicesMap'), {
  ssr: false,
  loading: () => <div className="w-full h-80 rounded-xl border border-gray-200 bg-gray-100 grid place-items-center text-sm text-gray-400">Loading map…</div>,
});

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesViewerAllowed(session?.vendor ? session?.email : (session?.realEmail || session?.email)).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  // Resolve the viewer first so a vendor's fetch is scoped server-side to their own
  // orders (complete + isolated); admins fetch the all view.
  const viewer = await resolveServiceViewerAsync(session, ctx.req);
  const real = await searchServiceWorkOrders(viewer.canSeeAll ? {} : { vendorEmail: viewer.vendorEmail, vendorName: viewer.vendorName }).catch(() => null);
  const services = scopeServices(real ?? [], viewer);
  return { props: { canSeeAll: viewer.canSeeAll, services, live: !!real } };
};

type View = 'month' | 'week' | 'day';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Per-worktype colors (pin hex + chip classes).
const WT: Record<string, { hex: string; chip: string }> = {
  landscaping: { hex: '#16a34a', chip: 'bg-green-100 text-green-800 border-green-300' },
  cleaning: { hex: '#2563eb', chip: 'bg-blue-100 text-blue-800 border-blue-300' },
  pools: { hex: '#0891b2', chip: 'bg-cyan-100 text-cyan-800 border-cyan-300' },
  trash_removal: { hex: '#d97706', chip: 'bg-amber-100 text-amber-800 border-amber-300' },
  trip_fee: { hex: '#6b7280', chip: 'bg-gray-100 text-gray-700 border-gray-300' },
};
const wtOf = (w: string) => WT[w] || WT.trip_fee;

// Distinct green shades for per-vendor day-routes (base green, then teal / lime /
// emerald variants) so each vendor's completed route reads as its own color.
const VENDOR_GREENS = ['#16a34a', '#0d9488', '#65a30d', '#059669', '#15803d', '#0f766e', '#4d7c0f', '#047857'];
const timeFmt = (iso?: string) => { if (!iso) return ''; const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };

// Local-time date helpers (avoid TZ drift from ISO parsing).
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const toISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameYMD = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export default function ServicesCalendar({ canSeeAll, services, live }: { canSeeAll: boolean; services: ServiceRecord[]; live: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<View>('month');
  const [cursorISO, setCursorISO] = useState(easternTodayISO());
  const [regionFilter, setRegionFilter] = useState<string[]>([]);
  // Region filter options derived from the live services in view (was SAMPLE_REGIONS).
  const regionOptions = useMemo(() => Array.from(new Set(services.map((s) => s.region).filter(Boolean))).sort(), [services]);
  const [vendorFilter, setVendorFilter] = useState<string[]>([]);
  const [vendorNames, setVendorNames] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/services/vendors').then((r) => r.json()).then((d) => {
      if (alive && Array.isArray(d?.vendors)) setVendorNames(d.vendors.map((v: any) => String(v.name)).filter(Boolean));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Re-run gSSP when the tab regains focus / comes back online / becomes visible,
  // so returning to this calendar shows freshly-generated or updated services
  // without a manual refresh. Debounced to absorb rapid focus churn.
  useEffect(() => {
    let last = 0;
    const revalidate = () => {
      const now = Date.now();
      if (now - last < 3000) return;
      last = now;
      router.replace(router.asPath, undefined, { scroll: false }).catch(() => {});
    };
    const onVis = () => { if (document.visibilityState === 'visible') revalidate(); };
    window.addEventListener('focus', revalidate);
    window.addEventListener('online', revalidate);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('online', revalidate);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);   // last-14-day completed
  const [filtersOpen, setFiltersOpen] = useState(true);        // collapsible filter block
  // Persist the calendar's view + filters + day across navigation, so clicking
  // into a service and coming BACK returns you to the exact map/list you left
  // (not a reset page). sessionStorage survives back-navigation within the tab.
  const CAL_KEY = 'resiwalk.svc.cal';
  const hydrated = useRef(false);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(CAL_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.view === 'month' || s.view === 'week' || s.view === 'day') setView(s.view);
        if (typeof s.cursorISO === 'string') setCursorISO(s.cursorISO);
        if (Array.isArray(s.regionFilter)) setRegionFilter(s.regionFilter);
        if (Array.isArray(s.vendorFilter)) setVendorFilter(s.vendorFilter);
        if (Array.isArray(s.typeFilter)) setTypeFilter(s.typeFilter);
        if (typeof s.showCompleted === 'boolean') setShowCompleted(s.showCompleted);
        if (typeof s.filtersOpen === 'boolean') setFiltersOpen(s.filtersOpen);
      }
    } catch { /* ignore corrupt state */ }
    hydrated.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!hydrated.current) return;
    try { sessionStorage.setItem(CAL_KEY, JSON.stringify({ view, cursorISO, regionFilter, vendorFilter, typeFilter, showCompleted, filtersOpen })); } catch { /* quota/private */ }
  }, [view, cursorISO, regionFilter, vendorFilter, typeFilter, showCompleted, filtersOpen]);

  const cursor = parse(cursorISO);
  const today = parse(easternTodayISO());
  const COMPLETED_WINDOW_DAYS = 14;
  const cutoffISO = toISO(addDays(today, -COMPLETED_WINDOW_DAYS));

  // OPEN work always shows; Completed is opt-in (last 14 days, by due date). Canceled
  // never shows. Then narrow by vendor, worktype, and past-due. No result cap.
  const scoped = useMemo(() => services.filter((s) => {
    if (s.status === 'canceled') return false;
    if (s.status === 'completed' && !(showCompleted && s.dueDate >= cutoffISO)) return false;
    if (regionFilter.length && !regionFilter.includes(s.region)) return false;
    if (vendorFilter.length && !(s.vendor && vendorFilter.includes(s.vendor))) return false;
    if (typeFilter.length && !typeFilter.includes(s.worktype)) return false;
    return true;
  }), [services, regionFilter, vendorFilter, typeFilter, showCompleted, cutoffISO]);

  // Visible date range for the current view.
  const range = useMemo(() => {
    if (view === 'day') return { start: cursor, end: cursor };
    if (view === 'week') { const s = addDays(cursor, -cursor.getDay()); return { start: s, end: addDays(s, 6) }; }
    const s = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    return { start: s, end: new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0) };
  }, [view, cursorISO]);

  const inRange = (iso: string) => { const d = parse(iso); return d >= range.start && d <= addDays(range.end, 0); };
  const visible = useMemo(() => scoped.filter((s) => inRange(s.dueDate)), [scoped, range]);
  const byDay = useMemo(() => {
    const m: Record<string, ServiceRecord[]> = {};
    for (const s of scoped) (m[s.dueDate] ||= []).push(s);
    return m;
  }, [scoped]);

  // ── Day-view vendor routes (completed only) ──────────────────────────────
  // Completed services carry a real completion timestamp = true route order. In
  // the DAY view, number each vendor's completed stops 1,2,3… by completion time
  // (numbering restarts per vendor), give each vendor a distinct green, and trace
  // their stops in order. Week/month + open services are unchanged.
  const dayRoute = useMemo(() => {
    const order = new Map<string, number>();     // serviceId → stop #
    const color = new Map<string, string>();     // vendor → hex
    const counts = new Map<string, number>();    // vendor → stop count
    const vendors: string[] = [];
    if (view !== 'day') return { order, color, counts, vendors };
    const completed = visible.filter((s) => s.status === 'completed');
    const groups = new Map<string, ServiceRecord[]>();
    for (const s of completed) { const v = s.vendor || 'Unassigned'; if (!groups.has(v)) groups.set(v, []); groups.get(v)!.push(s); }
    const ms = (s: ServiceRecord) => (s.completedAt ? new Date(s.completedAt).getTime() : 0);
    Array.from(groups.keys()).sort().forEach((v, vi) => {
      const list = groups.get(v)!.slice().sort((a, b) => (ms(a) - ms(b)) || a.address.localeCompare(b.address));
      list.forEach((s, i) => order.set(s.id, i + 1));
      color.set(v, VENDOR_GREENS[vi % VENDOR_GREENS.length]);
      counts.set(v, list.length);
      vendors.push(v);
    });
    return { order, color, counts, vendors };
  }, [view, visible]);

  // Geocode visible services that don't already carry coordinates. Real Service
  // Work Orders rarely have latitude/longitude stamped (only the sample data
  // does), so without this the map has nothing to plot and shows no dots. Mirrors
  // the inspections calendar: small concurrency, cached per service id, and a
  // null cache entry marks a confirmed miss so we don't re-request it.
  const [coords, setCoords] = useState<Record<string, { lat: number; lng: number } | null>>({});
  const geoAddress = (s: ServiceRecord) => [s.address, s.locality].map((x) => (x || '').trim()).filter(Boolean).join(', ');
  useEffect(() => {
    const todo = visible.filter((s) =>
      !(Number.isFinite(s.lat) && Number.isFinite(s.lng)) && coords[s.id] === undefined && geoAddress(s).length >= 5);
    if (!todo.length) return;
    let cancelled = false;
    (async () => {
      const CONC = 4;
      for (let x = 0; x < todo.length; x += CONC) {
        if (cancelled) return;
        await Promise.all(todo.slice(x, x + CONC).map(async (s) => {
          try {
            const qp = new URLSearchParams();
            if (geoAddress(s)) qp.set('address', geoAddress(s));
            if (s.propertyId) qp.set('propertyId', s.propertyId);
            const r = await fetch(`/api/geocode?${qp.toString()}`, { cache: 'no-store' });
            const d = await r.json();
            const ok = d && typeof d.lat === 'number' && typeof d.lng === 'number';
            if (!cancelled) setCoords((c) => ({ ...c, [s.id]: ok ? { lat: d.lat, lng: d.lng } : null }));
          } catch { if (!cancelled) setCoords((c) => ({ ...c, [s.id]: null })); }
        }));
      }
    })();
    return () => { cancelled = true; };
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapItems: MapItem[] = visible.flatMap((s) => {
    // Prefer coordinates stamped on the record; otherwise use the geocoded fix.
    const c = (Number.isFinite(s.lat) && Number.isFinite(s.lng))
      ? { lat: s.lat as number, lng: s.lng as number }
      : coords[s.id];
    if (!c) return [];
    const d = parse(s.dueDate);
    const done = s.status === 'completed';
    const stopNum = view === 'day' && done ? dayRoute.order.get(s.id) : undefined;
    const vendor = s.vendor || 'Unassigned';
    const color = stopNum != null ? (dayRoute.color.get(vendor) || wtOf(s.worktype).hex) : wtOf(s.worktype).hex;
    const t = stopNum != null ? timeFmt(s.completedAt) : '';
    // Uses the shared ServicesMap API: subtitle + detail, and routeOrder/routeGroup
    // (day-view completed) which the map draws as numbered dots joined per vendor.
    return [{
      id: s.id, lat: c.lat, lng: c.lng, color,
      title: s.address, href: `/services/${s.id}`,
      subtitle: `${worktypeLabel(s.worktype)} · ${subtypeLabel(s.worktype, s.subtype)} · ${serviceStatusText(s.status, canSeeAll)}`,
      detail: [`${done ? 'Done' : 'Due'} ${d.getMonth() + 1}/${d.getDate()}`, t, vendor].filter(Boolean).join(' · '),
      ...(stopNum != null ? { routeOrder: stopNum, routeGroup: vendor } : {}),
    }];
  });

  const step = (dir: number) => {
    if (view === 'day') setCursorISO(toISO(addDays(cursor, dir)));
    else if (view === 'week') setCursorISO(toISO(addDays(cursor, dir * 7)));
    else setCursorISO(toISO(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1)));
  };
  const label = view === 'month'
    ? `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`
    : view === 'week'
      ? `${MON_ABBR[range.start.getMonth()]} ${range.start.getDate()} – ${MON_ABBR[range.end.getMonth()]} ${range.end.getDate()}`
      : `${DOW[cursor.getDay()]}, ${MON_ABBR[cursor.getMonth()]} ${cursor.getDate()}`;

  const ChipLink = ({ s, compact }: { s: ServiceRecord; compact?: boolean }) => (
    <Link href={`/services/${s.id}`} onClick={(e) => e.stopPropagation()}
      className={`block truncate rounded border px-1.5 py-0.5 text-[10.5px] font-semibold ${wtOf(s.worktype).chip} ${compact ? '' : 'mb-0.5'}`}
      title={`${s.address} — ${worktypeLabel(s.worktype)} · ${subtypeLabel(s.worktype, s.subtype)}`}>
      {s.address}
    </Link>
  );

  // ----- Month grid. Render only the weeks the month needs (usually 5, 6 only when
  // it truly spills over) so the map below gets more room. Tap a day → Day view. -----
  const monthCells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = addDays(first, -first.getDay());
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i));
  }, [cursorISO, view]);

  return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader title="Calendar" backHref="/services" maxW="max-w-3xl" />

      <main className="max-w-3xl mx-auto w-full px-4 py-3 space-y-3">
        {/* View toggle + collapsible Filters button */}
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
            {(['month', 'week', 'day'] as View[]).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`px-3 py-1.5 rounded-md capitalize ${view === v ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>{v}</button>
            ))}
          </div>
          <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-label="Filters"
            className="ml-auto shrink-0 inline-flex items-center gap-1.5 text-[12px] font-heading font-semibold px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:text-brand hover:border-brand/50 transition-colors">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
            Filters
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${filtersOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
          </button>
        </div>

        {/* Collapsible filters: Region + Type + Vendor + Completed + Clear on one row. */}
        {filtersOpen && (
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0">
              <MultiFilter label="Region" selected={regionFilter} onChange={setRegionFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${regionFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={regionOptions.map((r) => ({ value: r, label: r }))} />
            </div>
            <div className="flex-1 min-w-0">
              <MultiFilter label="Type" selected={typeFilter} onChange={setTypeFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${typeFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={WORKTYPES.map((w) => ({ value: w.id, label: w.label }))} />
            </div>
            <div className="flex-1 min-w-0">
              <MultiFilter label="Vendor" selected={vendorFilter} onChange={setVendorFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${vendorFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={vendorNames.map((v) => ({ value: v, label: v }))} />
            </div>
            <button type="button" onClick={() => setShowCompleted((v) => !v)} title="Show completed services from the last 14 days"
              className={`shrink-0 inline-flex items-center gap-1 text-[12px] font-heading font-semibold px-2 py-1.5 rounded-lg border transition ${showCompleted ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:border-green-400'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              Completed
            </button>
            {(regionFilter.length > 0 || typeFilter.length > 0 || vendorFilter.length > 0) && (
              <button type="button" onClick={() => { setRegionFilter([]); setTypeFilter([]); setVendorFilter([]); }}
                aria-label="Clear filters" title="Clear filters"
                className="shrink-0 w-8 h-8 grid place-items-center rounded-lg border border-gray-300 bg-white text-gray-500 hover:text-brand hover:border-brand/50 text-base leading-none">×</button>
            )}
          </div>
        )}

        {/* Period nav */}
        <div className="flex items-center gap-2">
          <button onClick={() => step(-1)} aria-label="Previous" className="w-9 h-9 grid place-items-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <div className="font-heading font-extrabold text-ink text-[15px] flex-1 text-center">{label}</div>
          <button onClick={() => step(1)} aria-label="Next" className="w-9 h-9 grid place-items-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
          <button onClick={() => setCursorISO(easternTodayISO())} className="text-[12px] font-heading font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-2 bg-white hover:border-brand/40">Today</button>
        </div>

        {/* ---- MONTH ---- */}
        {view === 'month' && (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="grid grid-cols-7 text-center text-[10px] font-bold uppercase tracking-wide text-gray-400 border-b border-gray-100">
              {DOW.map((d) => <div key={d} className="py-1.5">{d}</div>)}
            </div>
            <div className="grid grid-cols-7">
              {monthCells.map((d, i) => {
                const items = byDay[toISO(d)] || [];
                const inMonth = d.getMonth() === cursor.getMonth();
                const isToday = sameYMD(d, today);
                return (
                  <button key={i} onClick={() => { setCursorISO(toISO(d)); setView('day'); }}
                    className={`min-h-[64px] border-b border-r border-gray-100 p-1 text-left align-top ${inMonth ? 'bg-white' : 'bg-gray-50'} hover:bg-brand/5`}>
                    <div className={`text-[11px] font-semibold mb-0.5 ${isToday ? 'text-white bg-brand rounded-full w-5 h-5 grid place-items-center' : inMonth ? 'text-ink' : 'text-gray-400'}`}>{d.getDate()}</div>
                    <div className="flex gap-0.5">
                      {items.slice(0, 4).map((s) => <span key={s.id} className="w-2 h-2 rounded-full" style={{ background: wtOf(s.worktype).hex }} title={s.address} />)}
                    </div>
                    {items.length > 4 && <div className="text-[9px] text-gray-400 font-semibold leading-none mt-0.5">+{items.length - 4}</div>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ---- WEEK ---- (wraps 4 over 3 so day columns are wide enough to read addresses) */}
        {view === 'week' && (
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: 7 }, (_, i) => addDays(range.start, i)).map((d, i) => {
              const items = byDay[toISO(d)] || [];
              const isToday = sameYMD(d, today);
              return (
                <div key={i} className="bg-white border border-gray-200 rounded-lg p-1 min-h-[120px]">
                  <div className="text-center mb-1">
                    <div className="text-[9px] uppercase text-gray-400 font-bold">{DOW[d.getDay()]}</div>
                    <div className={`text-[12px] font-bold ${isToday ? 'text-brand' : 'text-ink'}`}>{d.getDate()}</div>
                  </div>
                  {items.map((s) => <ChipLink key={s.id} s={s} />)}
                </div>
              );
            })}
          </div>
        )}

        {/* ---- DAY ---- */}
        {view === 'day' && (
          <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
            {visible.length === 0 && <div className="text-center text-gray-400 text-sm py-8">No services scheduled this day.</div>}
            {/* Route legend — when 2+ vendors completed work this day, tie each color to
                its vendor. Two neatly stacked columns with the dots aligned. */}
            {dayRoute.vendors.length >= 2 && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 pb-2 border-b border-gray-100 mb-1">
                {dayRoute.vendors.map((v) => (
                  <div key={v} className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-600 min-w-0">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: dayRoute.color.get(v) }} />
                    <span className="truncate">{v}</span>
                    <span className="text-gray-400 shrink-0">· {dayRoute.counts.get(v)} stop{dayRoute.counts.get(v) === 1 ? '' : 's'}</span>
                  </div>
                ))}
              </div>
            )}
            {visible.sort((a, b) => a.address.localeCompare(b.address)).map((s) => {
              const stopNum = s.status === 'completed' ? dayRoute.order.get(s.id) : undefined;
              return (
                <Link key={s.id} href={`/services/${s.id}`} className="flex items-center gap-3 border border-gray-200 rounded-lg px-3 py-2 hover:border-brand/40">
                  {stopNum != null
                    ? <span className="w-5 h-5 rounded-full shrink-0 grid place-items-center text-[10px] font-bold text-white" style={{ background: dayRoute.color.get(s.vendor || 'Unassigned') }}>{stopNum}</span>
                    : <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: wtOf(s.worktype).hex }} />}
                  <div className="min-w-0 flex-1">
                    <div className="font-heading font-bold text-ink text-sm truncate">{s.address}</div>
                    <div className="text-[12px] text-gray-500 truncate">{worktypeLabel(s.worktype)} · {subtypeLabel(s.worktype, s.subtype)}{stopNum != null && timeFmt(s.completedAt) ? ` · ${timeFmt(s.completedAt)}` : ` · ${s.locality}`}</div>
                  </div>
                  <span className="text-[12px] text-gray-500 shrink-0">{s.vendor || <span className="text-brand font-semibold">Unassigned</span>}</span>
                </Link>
              );
            })}
          </div>
        )}

        {/* ---- MAP ---- */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 shrink-0">Map · {mapItems.length}/{visible.length} mapped</label>
            {/* Clickable legend = the worktype filter for the calendar + map. */}
            <div className="flex flex-wrap gap-1.5 justify-end">
              {Object.entries(WT).map(([k, v]) => {
                const on = typeFilter.length === 0 || typeFilter.includes(k);
                return (
                  <button key={k} type="button" onClick={() => setTypeFilter((f) => f.includes(k) ? f.filter((x) => x !== k) : [...f, k])}
                    className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full border px-1.5 py-0.5 transition ${on ? 'border-gray-300 text-gray-600 bg-white' : 'border-gray-200 text-gray-300 bg-gray-50'}`}>
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: v.hex, opacity: on ? 1 : 0.35 }} />{worktypeLabel(k)}
                  </button>
                );
              })}
            </div>
          </div>
          <ServicesMap items={mapItems} />
        </div>
      </main>
    </div>
  );
}
