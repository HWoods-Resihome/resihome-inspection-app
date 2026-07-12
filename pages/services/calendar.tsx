import { useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { isViewingAsVendor } from '@/lib/services/viewAs';
import { searchServiceWorkOrders } from '@/lib/hubspot';
import { MultiFilter } from '@/components/MultiFilter';
import { WORKTYPES, worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { SAMPLE_SERVICES, SAMPLE_REGIONS, REFERENCE_TODAY, serviceStatusText, type SampleService } from '@/lib/services/sampleData';
import { SERVICE_VENDOR_NAMES } from '@/lib/services/vendors';
import type { MapItem } from '@/components/ServicesMap';

// Map is client-only (Leaflet touches window).
const ServicesMap = dynamic(() => import('@/components/ServicesMap'), {
  ssr: false,
  loading: () => <div className="w-full h-80 rounded-xl border border-gray-200 bg-gray-100 grid place-items-center text-sm text-gray-400">Loading map…</div>,
});

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  const real = await searchServiceWorkOrders().catch(() => null);
  const canSeeAll = isInternalEmail(session?.email) && !isViewingAsVendor(ctx.req);
  return { props: { canSeeAll, services: real ?? SAMPLE_SERVICES, live: !!real } };
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

// Local-time date helpers (avoid TZ drift from ISO parsing).
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const toISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameYMD = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export default function ServicesCalendar({ canSeeAll, services, live }: { canSeeAll: boolean; services: SampleService[]; live: boolean }) {
  const [view, setView] = useState<View>('month');
  const [cursorISO, setCursorISO] = useState(REFERENCE_TODAY);
  const [regionFilter, setRegionFilter] = useState<string[]>([]);
  const [vendorFilter, setVendorFilter] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<string[]>([]);
  const [showCompleted, setShowCompleted] = useState(false);   // last-14-day completed
  const [filtersOpen, setFiltersOpen] = useState(true);        // collapsible filter block
  const cursor = parse(cursorISO);
  const today = parse(REFERENCE_TODAY);
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
    const m: Record<string, SampleService[]> = {};
    for (const s of scoped) (m[s.dueDate] ||= []).push(s);
    return m;
  }, [scoped]);

  const mapItems: MapItem[] = visible.flatMap((s) => {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return [];
    const d = parse(s.dueDate);
    const done = s.status === 'completed';
    return [{
      id: s.id, lat: s.lat as number, lng: s.lng as number, color: wtOf(s.worktype).hex,
      title: s.address, href: `/services/${s.id}`,
      // Row 2: worktype · subtype · status. Row 3: date · vendor.
      line2: `${worktypeLabel(s.worktype)} · ${subtypeLabel(s.worktype, s.subtype)} · ${serviceStatusText(s.status, canSeeAll)}`,
      line3: `${done ? 'Done' : 'Due'} ${d.getMonth() + 1}/${d.getDate()} · ${s.vendor || 'Unassigned'}`,
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

  const ChipLink = ({ s, compact }: { s: SampleService; compact?: boolean }) => (
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
      <header className="bg-brand text-white sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            Services
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-8 w-8 object-cover shrink-0" />
          <div className="font-heading font-extrabold">Calendar</div>
        </div>
      </header>

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
                options={SAMPLE_REGIONS.map((r) => ({ value: r, label: r }))} />
            </div>
            <div className="flex-1 min-w-0">
              <MultiFilter label="Type" selected={typeFilter} onChange={setTypeFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${typeFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={WORKTYPES.map((w) => ({ value: w.id, label: w.label }))} />
            </div>
            <div className="flex-1 min-w-0">
              <MultiFilter label="Vendor" selected={vendorFilter} onChange={setVendorFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${vendorFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={SERVICE_VENDOR_NAMES.map((v) => ({ value: v, label: v }))} />
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
          <button onClick={() => setCursorISO(REFERENCE_TODAY)} className="text-[12px] font-heading font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-2 bg-white hover:border-brand/40">Today</button>
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
            {visible.sort((a, b) => a.address.localeCompare(b.address)).map((s) => (
              <Link key={s.id} href={`/services/${s.id}`} className="flex items-center gap-3 border border-gray-200 rounded-lg px-3 py-2 hover:border-brand/40">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: wtOf(s.worktype).hex }} />
                <div className="min-w-0 flex-1">
                  <div className="font-heading font-bold text-ink text-sm truncate">{s.address}</div>
                  <div className="text-[12px] text-gray-500 truncate">{worktypeLabel(s.worktype)} · {subtypeLabel(s.worktype, s.subtype)} · {s.locality}</div>
                </div>
                <span className="text-[12px] text-gray-500 shrink-0">{s.vendor || <span className="text-brand font-semibold">Unassigned</span>}</span>
              </Link>
            ))}
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
