import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isInternalEmail } from '@/lib/userAccess';
import { ListPicker } from '@/components/ListPicker';
import { MultiFilter } from '@/components/MultiFilter';
import { hubspotToMs } from '@/lib/hubspotDate';
import type { InspectionSummary } from '@/lib/types';
import type { MapItem } from '@/components/ServicesMap';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  if (!session?.email) return { redirect: { destination: '/login', permanent: false } };
  return { props: { isInternal: isInternalEmail(session.email), myEmail: session.email, myName: session.name || '' } };
};

// Map is client-only (Leaflet touches window).
const ServicesMap = dynamic(() => import('@/components/ServicesMap'), {
  ssr: false,
  loading: () => <div className="w-full h-80 rounded-xl border border-gray-200 bg-gray-100 grid place-items-center text-sm text-gray-400">Loading map…</div>,
});

type View = 'month' | 'week' | 'day';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MON_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Open-status buckets shown on the calendar/map: Scheduled + In Progress only.
const STATUS_META: Record<string, { label: string; hex: string; chip: string }> = {
  scheduled: { label: 'Scheduled', hex: '#2563eb', chip: 'bg-blue-100 text-blue-800 border-blue-300' },
  in_progress: { label: 'In Progress', hex: '#d97706', chip: 'bg-amber-100 text-amber-800 border-amber-300' },
};
function statusKey(s?: string): 'scheduled' | 'in_progress' | 'pending_approval' | 'completed' | null {
  const x = (s || '').trim().toLowerCase();
  if (x === 'scheduled') return 'scheduled';
  if (x === 'in progress' || x === 'in-progress' || x === 'in_progress') return 'in_progress';
  if (x === 'pending approval' || x === 'pending-approval' || x === 'pending_approval' || x === 'pendingapproval') return 'pending_approval';
  if (x === 'completed' || x === 'complete' || x === 'submitted') return 'completed';
  return null; // cancelled / other
}

// Local-time date helpers.
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const toISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameYMD = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
// scheduledDate (raw HubSpot) → local YYYY-MM-DD (or null).
const schedDay = (v: string | null | undefined): string | null => { const ms = hubspotToMs(v); return ms == null ? null : toISO(new Date(ms)); };
// Format a raw template type ("pm_turn_reinspect_qc") into a readable name
// ("PM Turn Reinspect QC"): split on _/-/space, upper-case short tokens (acronyms).
const prettyType = (s?: string | null): string =>
  (s || '').split(/[_\-\s]+/).filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');

export default function InspectionsCalendar({ isInternal, myEmail, myName }: { isInternal: boolean; myEmail: string; myName: string }) {
  const [view, setView] = useState<View>('month');
  const [items, setItems] = useState<InspectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inspectorScope, setInspectorScope] = useState('all');   // internal only
  const [regionFilter, setRegionFilter] = useState<string[]>([]); // internal only
  const [typeFilter, setTypeFilter] = useState<string[]>([]);     // internal only
  const [statusFilter, setStatusFilter] = useState<string[]>([]); // from the clickable legend (everyone)
  const [coords, setCoords] = useState<Record<string, { lat: number; lng: number } | null>>({});
  const mine = (i: InspectionSummary) =>
    (!!i.inspectorEmail && i.inspectorEmail.toLowerCase() === myEmail.toLowerCase()) ||
    (!!myName && (i.inspectorName || '') === myName);

  const todayISO = toISO(new Date());
  const [cursorISO, setCursorISO] = useState(todayISO);
  const cursor = parse(cursorISO);
  const today = parse(todayISO);

  // Load open inspections once (client-side, same endpoint as the home list).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/inspections?pageSize=250&facets=0&sort=date&dir=desc', { cache: 'no-store' });
        const d = await r.json();
        if (cancelled) return;
        if (d.error) setError(d.error);
        else setItems(Array.isArray(d.inspections) ? d.inspections : []);
      } catch {
        if (!cancelled) setError('Couldn’t reach the server. Check your connection and try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Open = Scheduled + In Progress only, with a scheduled date. External users
  // see ONLY their own assignments; internal users see all and can filter by
  // region + inspector. Past-due applies to everyone.
  const scoped = useMemo(() => items.filter((i) => {
    const k = statusKey(i.status);
    if (k !== 'scheduled' && k !== 'in_progress') return false;
    if (statusFilter.length && !statusFilter.includes(k)) return false;   // clickable legend
    const day = schedDay(i.scheduledDate);
    if (!day) return false;
    if (!isInternal) { if (!mine(i)) return false; }
    else {
      if (inspectorScope !== 'all' && (i.inspectorName || '') !== inspectorScope) return false;
      if (regionFilter.length && !regionFilter.includes(i.regionSnapshot || '')) return false;
      if (typeFilter.length && !typeFilter.includes(i.templateType || '')) return false;
    }
    return true;
  }), [items, isInternal, inspectorScope, regionFilter, typeFilter, statusFilter]);

  // Filter option lists (internal only) — derived from the visible-to-me set.
  const forLists = useMemo(() => isInternal ? items : items.filter(mine), [items, isInternal]);
  const inspectors = useMemo(() => [...new Set(forLists.map((i) => i.inspectorName).filter(Boolean) as string[])].sort(), [forLists]);
  const regions = useMemo(() => [...new Set(forLists.map((i) => i.regionSnapshot).filter(Boolean) as string[])].sort(), [forLists]);
  const templates = useMemo(() => [...new Set(forLists.map((i) => i.templateType).filter(Boolean) as string[])].sort(), [forLists]);

  const range = useMemo(() => {
    if (view === 'day') return { start: cursor, end: cursor };
    if (view === 'week') { const s = addDays(cursor, -cursor.getDay()); return { start: s, end: addDays(s, 6) }; }
    const s = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    return { start: s, end: new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0) };
  }, [view, cursorISO]);

  const byDay = useMemo(() => {
    const m: Record<string, InspectionSummary[]> = {};
    for (const i of scoped) { const day = schedDay(i.scheduledDate)!; (m[day] ||= []).push(i); }
    return m;
  }, [scoped]);
  const visible = useMemo(() => scoped.filter((i) => {
    const d = parse(schedDay(i.scheduledDate)!); return d >= range.start && d <= range.end;
  }), [scoped, range]);

  // Geocode the visible inspections for the map (small concurrency; cached by id).
  useEffect(() => {
    const todo = visible.filter((i) => coords[i.recordId] === undefined && (i.propertyAddressSnapshot || i.propertyRecordId));
    if (!todo.length) return;
    let cancelled = false;
    (async () => {
      const CONC = 4;
      for (let x = 0; x < todo.length; x += CONC) {
        if (cancelled) return;
        await Promise.all(todo.slice(x, x + CONC).map(async (i) => {
          try {
            const p = new URLSearchParams();
            if (i.propertyAddressSnapshot) p.set('address', i.propertyAddressSnapshot);
            if (i.propertyRecordId) p.set('propertyId', i.propertyRecordId);
            const r = await fetch(`/api/geocode?${p.toString()}`, { cache: 'no-store' });
            const d = await r.json();
            const ok = d && typeof d.lat === 'number' && typeof d.lng === 'number';
            if (!cancelled) setCoords((c) => ({ ...c, [i.recordId]: ok ? { lat: d.lat, lng: d.lng } : null }));
          } catch { if (!cancelled) setCoords((c) => ({ ...c, [i.recordId]: null })); }
        }));
      }
    })();
    return () => { cancelled = true; };
  }, [visible]);

  const mapItems: MapItem[] = visible.flatMap((i) => {
    const c = coords[i.recordId];
    if (!c) return [];
    const k = statusKey(i.status);
    const meta = k ? STATUS_META[k] : undefined;
    return [{
      id: i.recordId, lat: c.lat, lng: c.lng, color: meta?.hex || '#ff0060',
      title: i.propertyAddressSnapshot || i.inspectionName || 'Inspection',
      vendor: i.inspectorName || 'Unassigned',
      subtitle: `${prettyType(i.templateType) || 'Inspection'} · ${meta?.label || i.status} · Sched ${(() => { const d = parse(schedDay(i.scheduledDate)!); return `${d.getMonth() + 1}/${d.getDate()}`; })()}`,
      href: `/inspection/${i.recordId}`,
    }];
  });
  const mappable = visible.filter((i) => i.propertyAddressSnapshot || i.propertyRecordId).length;

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

  const metaOf = (i: InspectionSummary) => { const k = statusKey(i.status); return k ? STATUS_META[k] : undefined; };
  const ChipLink = ({ i }: { i: InspectionSummary }) => (
    <Link href={`/inspection/${i.recordId}`} onClick={(e) => e.stopPropagation()}
      className={`block truncate rounded border px-1.5 py-0.5 text-[10.5px] font-semibold mb-0.5 ${metaOf(i)?.chip || 'bg-gray-100 text-gray-700 border-gray-300'}`}
      title={`${i.propertyAddressSnapshot || i.inspectionName} — ${prettyType(i.templateType)}`}>
      {i.propertyAddressSnapshot || i.inspectionName || 'Inspection'}
    </Link>
  );

  const monthCells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = addDays(first, -first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [cursorISO, view]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-brand text-white sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            Inspections
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-8 w-8 object-cover shrink-0" />
          <div className="font-heading font-extrabold">Calendar</div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto w-full px-4 py-3 space-y-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
            {(['month', 'week', 'day'] as View[]).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`px-3 py-1.5 rounded-md capitalize ${view === v ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>{v}</button>
            ))}
          </div>
        </div>

        {/* Filters. Internal: Type + Inspector + Region. External: their own
            assignments only (no filters). The status legend (below the map) is a
            clickable filter for everyone. */}
        {isInternal ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <MultiFilter label="Type" selected={typeFilter} onChange={setTypeFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2.5 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${typeFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={templates.map((t) => ({ value: t, label: prettyType(t) }))} />
            </div>
            <div className="flex-1 min-w-0">
              <ListPicker value={inspectorScope} onChange={setInspectorScope} ariaLabel="Inspector"
                className="w-full truncate text-[12px] font-heading font-semibold pl-2.5 pr-1 py-1.5 border border-gray-300 rounded-lg bg-white text-ink flex items-center justify-between"
                options={[{ value: 'all', label: 'All inspectors' }, ...inspectors.map((n) => ({ value: n, label: n }))]} />
            </div>
            <div className="flex-1 min-w-0">
              <MultiFilter label="Region" selected={regionFilter} onChange={setRegionFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2.5 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${regionFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={regions.map((r) => ({ value: r, label: r }))} />
            </div>
          </div>
        ) : (
          <div className="text-[12px] font-heading font-semibold text-gray-500">Your assigned inspections</div>
        )}

        <div className="flex items-center gap-2">
          <button onClick={() => step(-1)} aria-label="Previous" className="w-9 h-9 grid place-items-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
          <div className="font-heading font-extrabold text-ink text-[15px] flex-1 text-center">{label}</div>
          <button onClick={() => step(1)} aria-label="Next" className="w-9 h-9 grid place-items-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
          <button onClick={() => setCursorISO(todayISO)} className="text-[12px] font-heading font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-2 bg-white hover:border-brand/40">Today</button>
        </div>

        {loading && <div className="text-center text-gray-400 text-sm py-8">Loading inspections…</div>}
        {error && <div className="text-center text-red-600 text-sm py-4 bg-red-50 border border-red-200 rounded-lg">{error}</div>}

        {!loading && !error && (
          <>
            {view === 'month' && (
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="grid grid-cols-7 text-center text-[10px] font-bold uppercase tracking-wide text-gray-400 border-b border-gray-100">
                  {DOW.map((d) => <div key={d} className="py-1.5">{d}</div>)}
                </div>
                <div className="grid grid-cols-7">
                  {monthCells.map((d, idx) => {
                    const dayItems = byDay[toISO(d)] || [];
                    const inMonth = d.getMonth() === cursor.getMonth();
                    const isToday = sameYMD(d, today);
                    return (
                      <button key={idx} onClick={() => { setCursorISO(toISO(d)); setView('day'); }}
                        className={`min-h-[64px] border-b border-r border-gray-100 p-1 text-left align-top ${inMonth ? 'bg-white' : 'bg-gray-50'} hover:bg-brand/5`}>
                        <div className={`text-[11px] font-semibold mb-0.5 ${isToday ? 'text-white bg-brand rounded-full w-5 h-5 grid place-items-center' : inMonth ? 'text-ink' : 'text-gray-400'}`}>{d.getDate()}</div>
                        <div className="flex flex-wrap gap-0.5">
                          {dayItems.slice(0, 4).map((i) => <span key={i.recordId} className="w-2 h-2 rounded-full" style={{ background: metaOf(i)?.hex || '#9ca3af' }} title={i.propertyAddressSnapshot || ''} />)}
                          {dayItems.length > 4 && <span className="text-[9px] text-gray-400 font-semibold">+{dayItems.length - 4}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {view === 'week' && (
              <div className="grid grid-cols-4 gap-1.5">
                {Array.from({ length: 7 }, (_, i) => addDays(range.start, i)).map((d, idx) => {
                  const dayItems = byDay[toISO(d)] || [];
                  const isToday = sameYMD(d, today);
                  return (
                    <div key={idx} className="bg-white border border-gray-200 rounded-lg p-1 min-h-[120px]">
                      <div className="text-center mb-1">
                        <div className="text-[9px] uppercase text-gray-400 font-bold">{DOW[d.getDay()]}</div>
                        <div className={`text-[12px] font-bold ${isToday ? 'text-brand' : 'text-ink'}`}>{d.getDate()}</div>
                      </div>
                      {dayItems.map((i) => <ChipLink key={i.recordId} i={i} />)}
                    </div>
                  );
                })}
              </div>
            )}

            {view === 'day' && (
              <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                {visible.length === 0 && <div className="text-center text-gray-400 text-sm py-8">No inspections scheduled this day.</div>}
                {[...visible].sort((a, b) => (a.propertyAddressSnapshot || '').localeCompare(b.propertyAddressSnapshot || '')).map((i) => (
                  <Link key={i.recordId} href={`/inspection/${i.recordId}`} className="flex items-center gap-3 border border-gray-200 rounded-lg px-3 py-2 hover:border-brand/40">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: metaOf(i)?.hex || '#9ca3af' }} />
                    <div className="min-w-0 flex-1">
                      <div className="font-heading font-bold text-ink text-sm truncate">{i.propertyAddressSnapshot || i.inspectionName || 'Inspection'}</div>
                      <div className="text-[12px] text-gray-500 truncate">{prettyType(i.templateType) || 'Inspection'} · {metaOf(i)?.label || i.status}</div>
                    </div>
                    <span className="text-[12px] text-gray-500 shrink-0">{i.inspectorName || <span className="text-brand font-semibold">Unassigned</span>}</span>
                  </Link>
                ))}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 shrink-0">Map · {mapItems.length}/{mappable} mapped</label>
                {/* Clickable status legend = a status filter for the calendar + map. */}
                <div className="flex flex-wrap gap-1.5 justify-end">
                  {Object.entries(STATUS_META).map(([k, v]) => {
                    const on = statusFilter.length === 0 || statusFilter.includes(k);
                    return (
                      <button key={k} type="button" onClick={() => setStatusFilter((f) => f.includes(k) ? f.filter((x) => x !== k) : [...f, k])}
                        className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full border px-1.5 py-0.5 transition ${on ? 'border-gray-300 text-gray-600 bg-white' : 'border-gray-200 text-gray-300 bg-gray-50'}`}>
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: v.hex, opacity: on ? 1 : 0.35 }} />{v.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <ServicesMap items={mapItems} />
              {mappable > mapItems.length && <div className="text-[11px] text-gray-400 mt-1">Locating {mappable - mapItems.length} more address{mappable - mapItems.length === 1 ? '' : 'es'}… (some may lack a geocodable address).</div>}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
