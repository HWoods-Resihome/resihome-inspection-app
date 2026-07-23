import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isInternalEmail } from '@/lib/userAccess';
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

// Status buckets shown on the calendar/map. Open = Scheduled + In Progress;
// Completed is opt-in (internal "Show Completed" toggle, last 2 weeks).
const STATUS_META: Record<string, { label: string; hex: string; chip: string }> = {
  scheduled: { label: 'Scheduled', hex: '#2563eb', chip: 'bg-blue-100 text-blue-800 border-blue-300' },
  in_progress: { label: 'In Progress', hex: '#d97706', chip: 'bg-amber-100 text-amber-800 border-amber-300' },
  completed: { label: 'Completed', hex: '#16a34a', chip: 'bg-green-100 text-green-800 border-green-300' },
};
const COMPLETED_WINDOW_DAYS = 14;
// Where we stash the calendar's view/filters/date/scroll so clicking into an
// inspection and coming back lands you right where you left (per browser tab).
const CAL_STATE_KEY = 'resiwalk:calendar:state:v1';
// Distinct green/teal/lime shades used in the DAY view to color each inspector's
// completed route (dots, connecting line, and the list badge). Index 0 is the
// base "Completed" green, so a single-inspector day looks unchanged.
const ROUTE_GREENS = ['#16a34a', '#0d9488', '#65a30d', '#047857', '#4d7c0f', '#0e7490', '#15803d', '#84cc16'];
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
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [inspectorFilter, setInspectorFilter] = useState<string[]>([]); // internal only (multi)
  const [regionFilter, setRegionFilter] = useState<string[]>([]); // internal only
  const [typeFilter, setTypeFilter] = useState<string[]>([]);     // internal only
  const [statusFilter, setStatusFilter] = useState<string[]>([]); // from the clickable legend (everyone)
  const [showCompleted, setShowCompleted] = useState(false);      // last-2-weeks completed (all users; external sees only their own)
  const [filtersOpen, setFiltersOpen] = useState(true);           // collapsible filter block (internal)
  const [coords, setCoords] = useState<Record<string, { lat: number; lng: number } | null>>({});
  const mine = (i: InspectionSummary) =>
    (!!i.inspectorEmail && i.inspectorEmail.toLowerCase() === myEmail.toLowerCase()) ||
    (!!myName && (i.inspectorName || '') === myName);

  const todayISO = toISO(new Date());
  const [cursorISO, setCursorISO] = useState(todayISO);
  const cursor = parse(cursorISO);
  const today = parse(todayISO);

  const router = useRouter();
  const pendingScrollRef = useRef<number | null>(null);

  // Restore the last view/filters/date/scroll on mount (once) so returning from
  // an inspection doesn't reset the page — you can click in and out freely.
  // Done in an effect (not a useState initializer) to avoid an SSR/hydration
  // mismatch; the brief default flash is hidden by the initial loading state.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(CAL_STATE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.view === 'month' || s.view === 'week' || s.view === 'day') setView(s.view);
      if (typeof s.cursorISO === 'string') setCursorISO(s.cursorISO);
      if (Array.isArray(s.inspectorFilter)) setInspectorFilter(s.inspectorFilter);
      if (Array.isArray(s.regionFilter)) setRegionFilter(s.regionFilter);
      if (Array.isArray(s.typeFilter)) setTypeFilter(s.typeFilter);
      if (Array.isArray(s.statusFilter)) setStatusFilter(s.statusFilter);
      if (typeof s.showCompleted === 'boolean') setShowCompleted(s.showCompleted);
      if (typeof s.filtersOpen === 'boolean') setFiltersOpen(s.filtersOpen);
      if (typeof s.scrollY === 'number') pendingScrollRef.current = s.scrollY;
    } catch { /* ignore malformed/absent state */ }
  }, []);

  // Save everything the instant we navigate away (e.g. into an inspection), so
  // the snapshot — including the exact scroll position — is accurate at exit.
  useEffect(() => {
    const save = () => {
      try {
        sessionStorage.setItem(CAL_STATE_KEY, JSON.stringify({
          view, cursorISO, inspectorFilter, regionFilter, typeFilter, statusFilter,
          showCompleted, filtersOpen, scrollY: window.scrollY,
        }));
      } catch { /* storage full / unavailable — non-fatal */ }
    };
    router.events.on('routeChangeStart', save);
    window.addEventListener('pagehide', save);
    return () => { router.events.off('routeChangeStart', save); window.removeEventListener('pagehide', save); };
  }, [router.events, view, cursorISO, inspectorFilter, regionFilter, typeFilter, statusFilter, showCompleted, filtersOpen]);

  // Once data has loaded and the view has rendered, jump back to the saved
  // scroll position. Retry a couple of times so the async map/list layout has
  // settled before we scroll.
  useEffect(() => {
    if (loading || pendingScrollRef.current == null) return;
    const y = pendingScrollRef.current;
    pendingScrollRef.current = null;
    const tries = [0, 120, 320];
    const timers = tries.map((t) => setTimeout(() => window.scrollTo(0, y), t));
    return () => timers.forEach(clearTimeout);
  }, [loading]);

  // Load inspections once (client-side, same endpoint as the home list). The
  // server caps pageSize at 100, so a single newest-first "all statuses" page
  // fills up with upcoming/recent rows and only reaches back a few days — hiding
  // older COMPLETED work. Fetch completed on its OWN page (a dedicated 100-row
  // budget, newest first) so it reaches back the full 2-week window, then merge
  // + dedupe with the general page. The completed page is internal-only (the
  // "Show Completed" toggle is too).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const byId = new Map<string, InspectionSummary>();
        // General page: open + recent across all statuses (newest first).
        const gen = await fetch('/api/inspections?pageSize=100&facets=0&sort=date&dir=desc', { cache: 'no-store' }).then((r) => r.json());
        if (cancelled) return;
        if (gen?.error && !Array.isArray(gen?.inspections)) { setError(gen.error); return; }
        for (const i of (Array.isArray(gen?.inspections) ? gen.inspections : [])) byId.set(i.recordId, i);

        // Completed page-through (ALL users — external gets only their own
        // completed, scoped server-side + by mine() below): the server caps a
        // page at 100, and a busy 2-week window can hold more than that — so walk
        // ALL pages (newest first) until we cross the window boundary, rather than
        // truncating at 100. Ordered by last_edited_at, which is always >= an
        // inspection's completed/submitted date, so once a page's oldest row
        // predates the window no later page can contain an in-window completion.
        {
          const windowStartMs = Date.now() - COMPLETED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
          const MAX_PAGES = 40; // safety bound (~4000 completed)
          for (let page = 1; page <= MAX_PAGES; page++) {
            const d = await fetch(`/api/inspections?status=completed&pageSize=100&facets=0&sort=date&dir=desc&page=${page}`, { cache: 'no-store' }).then((r) => r.json());
            if (cancelled) return;
            const rows: InspectionSummary[] = Array.isArray(d?.inspections) ? d.inspections : [];
            for (const i of rows) byId.set(i.recordId, i);
            const crossedWindow = rows.some((i) => { const ms = hubspotToMs(i.updatedAt); return ms != null && ms < windowStartMs; });
            if (rows.length < 100 || crossedWindow) break; // last page, or reached older-than-window
          }
        }
        if (cancelled) return;
        setItems(Array.from(byId.values()));
      } catch {
        if (!cancelled) setError('Couldn’t reach the server. Check your connection and try again.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isInternal, refreshKey]);

  // Silently refetch when the tab regains focus / comes back online / becomes
  // visible, so returning to the calendar reflects newly-completed or rescheduled
  // inspections without a manual refresh. Bumping refreshKey re-runs the loader
  // above; loading is already false so there's no spinner flash. Debounced.
  useEffect(() => {
    let last = 0;
    const revalidate = () => {
      const now = Date.now();
      if (now - last < 3000) return;
      last = now;
      setRefreshKey((k) => k + 1);
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
  }, []);

  // Open = Scheduled + In Progress only, with a scheduled date. External users
  // see ONLY their own assignments; internal users see all and can filter by
  // region + inspector. Past-due applies to everyone.
  const completedSinceISO = toISO(addDays(today, -COMPLETED_WINDOW_DAYS));
  // The timestamp (ms) an inspection lands on: completed → when it went to PENDING
  // APPROVAL (submittedAt), falling back to the completed date; open → scheduled date.
  // (Handles rate-card/scope inspections, which carry a submitted date, uniformly.)
  const whenMs = (i: InspectionSummary): number | null =>
    statusKey(i.status) === 'completed' ? hubspotToMs(i.submittedAt || i.completedAt) : hubspotToMs(i.scheduledDate);
  const dayOf = (i: InspectionSummary): string | null => { const ms = whenMs(i); return ms == null ? null : toISO(new Date(ms)); };
  // H:MM AM/PM — only for COMPLETED (they have a real submitted timestamp). Open
  // inspections have no meaningful appointment time, so they show none.
  const timeLabel = (i: InspectionSummary): string | null => {
    if (statusKey(i.status) !== 'completed') return null;
    const ms = whenMs(i); if (ms == null) return null;
    const d = new Date(ms);
    const ap = d.getHours() >= 12 ? 'PM' : 'AM';
    const h = d.getHours() % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
  };
  // Overall pass/fail for a COMPLETED inspection: QC re-inspects carry qcVerdict;
  // 1099 / Vacancy carry inspectionResult. null when not completed or not scored.
  const resultOf = (i: InspectionSummary): 'pass' | 'fail' | null => {
    if (statusKey(i.status) !== 'completed') return null;
    return i.qcVerdict || i.inspectionResult || null;
  };
  // Day/week ordering: completed first (by time, the route order), then open (by address).
  const dayOrder = (a: InspectionSummary, b: InspectionSummary) => {
    const ca = statusKey(a.status) === 'completed', cb = statusKey(b.status) === 'completed';
    if (ca !== cb) return ca ? -1 : 1;
    if (ca && cb) return (whenMs(a) ?? Infinity) - (whenMs(b) ?? Infinity);
    return (a.propertyAddressSnapshot || '').localeCompare(b.propertyAddressSnapshot || '');
  };

  // Base set the filters operate over: OPEN (scheduled/in_progress) always, plus
  // COMPLETED from the last 2 weeks when the toggle is on. Scoped to the viewer.
  const openBase = useMemo(() => items.filter((i) => {
    const k = statusKey(i.status);
    const day = dayOf(i);
    if (!day) return false;
    if (k === 'scheduled' || k === 'in_progress') { /* open — always eligible */ }
    else if (k === 'completed' && showCompleted && day >= completedSinceISO) { /* recent completed */ }
    else return false;
    return isInternal || mine(i);
  }), [items, isInternal, showCompleted, completedSinceISO]);

  // Per-facet predicates (each option list applies the OTHER facets, not itself).
  const kOf = (i: InspectionSummary) => statusKey(i.status) || '';
  const passStatus = (i: InspectionSummary) => statusFilter.length === 0 || statusFilter.includes(kOf(i));
  const passType = (i: InspectionSummary) => typeFilter.length === 0 || typeFilter.includes(i.templateType || '');
  const passRegion = (i: InspectionSummary) => regionFilter.length === 0 || regionFilter.includes(i.regionSnapshot || '');
  const passInspector = (i: InspectionSummary) => inspectorFilter.length === 0 || inspectorFilter.includes(i.inspectorName || '');

  const scoped = useMemo(() => openBase.filter((i) => passStatus(i) && passType(i) && passRegion(i) && passInspector(i)),
    [openBase, statusFilter, typeFilter, regionFilter, inspectorFilter]);

  // Dynamic, interdependent option lists (faceted): each reflects what's OPEN given
  // the OTHER active filters, plus any already-selected value so it can be cleared.
  const uniq = (a: (string | null | undefined)[]) => [...new Set(a.filter(Boolean) as string[])].sort();
  const inspectors = useMemo(() => uniq([...openBase.filter((i) => passStatus(i) && passType(i) && passRegion(i)).map((i) => i.inspectorName), ...inspectorFilter]),
    [openBase, statusFilter, typeFilter, regionFilter, inspectorFilter]);
  const regions = useMemo(() => uniq([...openBase.filter((i) => passStatus(i) && passType(i) && passInspector(i)).map((i) => i.regionSnapshot), ...regionFilter]),
    [openBase, statusFilter, typeFilter, inspectorFilter, regionFilter]);
  const templates = useMemo(() => uniq([...openBase.filter((i) => passStatus(i) && passRegion(i) && passInspector(i)).map((i) => i.templateType), ...typeFilter]),
    [openBase, statusFilter, regionFilter, inspectorFilter, typeFilter]);

  const range = useMemo(() => {
    if (view === 'day') return { start: cursor, end: cursor };
    if (view === 'week') { const s = addDays(cursor, -cursor.getDay()); return { start: s, end: addDays(s, 6) }; }
    const s = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    return { start: s, end: new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0) };
  }, [view, cursorISO]);

  const byDay = useMemo(() => {
    const m: Record<string, InspectionSummary[]> = {};
    for (const i of scoped) { const day = dayOf(i)!; (m[day] ||= []).push(i); }
    // Completed (by time) first, then open (by address) — see dayOrder.
    for (const arr of Object.values(m)) arr.sort(dayOrder);
    return m;
  }, [scoped]);
  const visible = useMemo(() => scoped.filter((i) => {
    const d = parse(dayOf(i)!); return d >= range.start && d <= range.end;
  }), [scoped, range]);

  // DAY-VIEW ROUTES: number each inspector's COMPLETED visits in the order they
  // did them (by completion time) and give each inspector a distinct green. The
  // numbering restarts per inspector, so with several inspectors multiple dots
  // can be "1" (each route starts somewhere). Only meaningful in the day view.
  const dayRoutes = useMemo(() => {
    const order: Record<string, number> = {};
    const color: Record<string, string> = {};
    const legend: { inspector: string; color: string; count: number }[] = [];
    if (view !== 'day') return { order, color, legend };
    const completed = visible.filter((i) => statusKey(i.status) === 'completed');
    const byInspector: Record<string, InspectionSummary[]> = {};
    for (const i of completed) { (byInspector[i.inspectorName || 'Unassigned'] ||= []).push(i); }
    Object.keys(byInspector).sort().forEach((name, idx) => {
      const c = ROUTE_GREENS[idx % ROUTE_GREENS.length];
      const arr = byInspector[name].sort((a, b) => (whenMs(a) ?? Infinity) - (whenMs(b) ?? Infinity));
      arr.forEach((i, n) => { order[i.recordId] = n + 1; color[i.recordId] = c; });
      legend.push({ inspector: name, color: c, count: arr.length });
    });
    return { order, color, legend };
  }, [view, visible]);

  // Geocode the visible inspections for the map (small concurrency; cached by id).
  // Skip ones that already carry coordinates stamped at creation — only older
  // records without them need a live geocode.
  useEffect(() => {
    const todo = visible.filter((i) =>
      !(Number.isFinite(i.lat) && Number.isFinite(i.lng))
      && coords[i.recordId] === undefined && (i.propertyAddressSnapshot || i.propertyRecordId));
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
    // Prefer coordinates stamped at creation; otherwise the live-geocoded fix.
    const c = (Number.isFinite(i.lat) && Number.isFinite(i.lng))
      ? { lat: i.lat as number, lng: i.lng as number }
      : coords[i.recordId];
    if (!c) return [];
    const k = statusKey(i.status);
    const meta = k ? STATUS_META[k] : undefined;
    const d = parse(dayOf(i)!);
    const datePart = `${k === 'completed' ? 'Done' : 'Sched'} ${d.getMonth() + 1}/${d.getDate()}`;
    const t = timeLabel(i);                       // "3:45 PM" for completed; null otherwise
    const dateTime = t ? `${datePart} · ${t}` : datePart;
    const routeOrder = dayRoutes.order[i.recordId];   // per-inspector visit # (day view, completed)
    const routeColor = dayRoutes.color[i.recordId];
    return [{
      id: i.recordId, lat: c.lat, lng: c.lng, color: routeColor || meta?.hex || '#ff0060',
      title: i.propertyAddressSnapshot || i.inspectionName || 'Inspection',
      // Route number + inspector "group" so the map can label the dot and draw a
      // dashed line joining that inspector's stops in order.
      routeOrder,
      routeGroup: routeOrder ? (i.inspectorName || 'Unassigned') : undefined,
      // Row 2: template · status.  Row 3: date · time · inspector.
      subtitle: `${prettyType(i.templateType) || 'Inspection'} · ${meta?.label || i.status}`,
      detail: `${dateTime} · ${i.inspectorName || 'Unassigned'}`,
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
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);   // 5 for most months, 6 only when needed
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i));
  }, [cursorISO, view]);

  return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader title="Calendar" backHref="/" maxW="max-w-3xl" />

      <main className="max-w-3xl mx-auto w-full px-4 py-3 space-y-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[13px] font-heading font-semibold">
            {(['month', 'week', 'day'] as View[]).map((v) => (
              <button key={v} onClick={() => setView(v)} className={`px-3 py-1.5 rounded-md capitalize ${view === v ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>{v}</button>
            ))}
          </div>
          {isInternal && (
            <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-label="Filters"
              className="ml-auto shrink-0 inline-flex items-center gap-1.5 text-[12px] font-heading font-semibold px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:text-brand hover:border-brand/50 transition-colors">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
              Filters
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${filtersOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          )}
        </div>

        {/* Collapsible filter block (internal): Region + Inspectors + Template +
            Show Completed + Clear, all on one row. External: their own assignments
            only. The status legend (below the map) is a clickable filter for everyone. */}
        {isInternal && filtersOpen && (
          <div className="flex items-center gap-1.5">
            <div className="flex-1 min-w-0">
              <MultiFilter label="Region" selected={regionFilter} onChange={setRegionFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${regionFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={regions.map((r) => ({ value: r, label: r }))} />
            </div>
            <div className="flex-1 min-w-0">
              <MultiFilter label="Inspectors" selected={inspectorFilter} onChange={setInspectorFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${inspectorFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={inspectors.map((n) => ({ value: n, label: n }))} />
            </div>
            <div className="flex-1 min-w-0">
              <MultiFilter label="Template" selected={typeFilter} onChange={setTypeFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${typeFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={templates.map((t) => ({ value: t, label: prettyType(t) }))} />
            </div>
            <button type="button" onClick={() => setShowCompleted((v) => !v)} title="Show completed inspections (last 2 weeks), placed by submitted date"
              className={`shrink-0 inline-flex items-center gap-1 text-[12px] font-heading font-semibold px-2 py-1.5 rounded-lg border transition ${showCompleted ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:border-green-400'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              Completed
            </button>
            {(regionFilter.length > 0 || inspectorFilter.length > 0 || typeFilter.length > 0 || statusFilter.length > 0) && (
              <button type="button" onClick={() => { setRegionFilter([]); setInspectorFilter([]); setTypeFilter([]); setStatusFilter([]); }}
                aria-label="Clear filters" title="Clear filters"
                className="shrink-0 w-8 h-8 grid place-items-center rounded-lg border border-gray-300 bg-white text-gray-500 hover:text-brand hover:border-brand/50 text-base leading-none">×</button>
            )}
          </div>
        )}
        {!isInternal && (
          <div className="flex items-center gap-2">
            <div className="text-[12px] font-heading font-semibold text-gray-500">Your assigned inspections</div>
            {/* External users get a standalone Completed toggle — shows THEIR own
                completed inspections (last 2 weeks) on the calendar + map. */}
            <button type="button" onClick={() => setShowCompleted((v) => !v)} title="Show your completed inspections (last 2 weeks)"
              className={`ml-auto shrink-0 inline-flex items-center gap-1 text-[12px] font-heading font-semibold px-2 py-1.5 rounded-lg border transition ${showCompleted ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-700 border-gray-300 hover:border-green-400'}`}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              Completed
            </button>
          </div>
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
                        className={`min-h-[64px] border-b border-r border-gray-100 p-1 text-left flex flex-col ${inMonth ? 'bg-white' : 'bg-gray-50'} hover:bg-brand/5`}>
                        {/* Fixed-height number row (flex-col top-anchors it) so the
                            date sits in the SAME spot in every cell — a button
                            vertically centers its content by default, which pushed
                            the date up in cells with more dots / a "+N" and down in
                            lighter cells. Today's circle is the same 5×5 as the row,
                            so it doesn't shift the date either. */}
                        <div className="h-5 flex items-center mb-0.5">
                          <span className={`text-[11px] font-semibold leading-none ${isToday ? 'text-white bg-brand rounded-full w-5 h-5 grid place-items-center' : inMonth ? 'text-ink' : 'text-gray-400'}`}>{d.getDate()}</span>
                        </div>
                        <div className="flex gap-0.5 flex-wrap">
                          {dayItems.slice(0, 4).map((i) => <span key={i.recordId} className="w-2 h-2 rounded-full" style={{ background: metaOf(i)?.hex || '#9ca3af' }} title={i.propertyAddressSnapshot || ''} />)}
                        </div>
                        {dayItems.length > 4 && <div className="text-[9px] text-gray-400 font-semibold leading-none mt-0.5">+{dayItems.length - 4}</div>}
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
                      {/* Clickable day header — dives into that day (list + map),
                          like tapping a cell in month view. The inspection chips
                          below stay their own links. */}
                      <button type="button" onClick={() => { setCursorISO(toISO(d)); setView('day'); }}
                        title="Open this day"
                        className="w-full text-center mb-1 rounded-md py-0.5 hover:bg-brand/5 cursor-pointer">
                        <div className="text-[9px] uppercase text-gray-400 font-bold">{DOW[d.getDay()]}</div>
                        <div className={`text-[12px] font-bold ${isToday ? 'text-brand' : 'text-ink'}`}>{d.getDate()}</div>
                      </button>
                      {dayItems.map((i) => <ChipLink key={i.recordId} i={i} />)}
                    </div>
                  );
                })}
              </div>
            )}

            {view === 'day' && (
              <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
                {visible.length === 0 && <div className="text-center text-gray-400 text-sm py-8">No inspections this day.</div>}
                {/* Route legend — one chip per inspector with completed stops today,
                    matching the numbered dots/line on the map. Only when 2+ routes. */}
                {dayRoutes.legend.length > 1 && (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 px-0.5 pb-1">
                    {dayRoutes.legend.map((r) => (
                      <span key={r.inspector} className="flex items-center gap-1.5 text-[11px] text-gray-600 min-w-0">
                        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: r.color }} />
                        <span className="font-semibold truncate">{r.inspector}</span>
                        <span className="text-gray-400 shrink-0">· {r.count} stop{r.count === 1 ? '' : 's'}</span>
                      </span>
                    ))}
                  </div>
                )}
                {[...visible].sort(dayOrder).map((i) => {
                  const routeOrder = dayRoutes.order[i.recordId];
                  const routeColor = dayRoutes.color[i.recordId];
                  return (
                  <Link key={i.recordId} href={`/inspection/${i.recordId}`} className="flex items-center gap-2.5 border border-gray-200 rounded-lg px-3 py-2 hover:border-brand/40">
                    <span className="w-16 shrink-0 text-right text-[11.5px] font-semibold text-gray-500 tabular-nums">{timeLabel(i) || ''}</span>
                    {routeOrder ? (
                      <span className="w-5 h-5 shrink-0 rounded-full grid place-items-center text-[10px] font-bold text-white tabular-nums" style={{ background: routeColor }}>{routeOrder}</span>
                    ) : (
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: metaOf(i)?.hex || '#9ca3af' }} />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-heading font-bold text-ink text-sm truncate flex items-center gap-1.5">
                        <span className="truncate">{i.propertyAddressSnapshot || i.inspectionName || 'Inspection'}</span>
                        {(() => {
                          const r = resultOf(i);
                          return r ? (
                            <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold border ${r === 'pass' ? 'bg-green-100 text-green-800 border-green-300' : 'bg-brand/10 text-brand border-brand/30'}`}>
                              {r === 'pass' ? 'PASS' : 'FAIL'}
                            </span>
                          ) : null;
                        })()}
                      </div>
                      <div className="text-[12px] text-gray-500 truncate">{prettyType(i.templateType) || 'Inspection'} · {metaOf(i)?.label || i.status}</div>
                    </div>
                    <span className="text-[12px] text-gray-500 shrink-0">{i.inspectorName || <span className="text-brand font-semibold">Unassigned</span>}</span>
                  </Link>
                  );
                })}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 shrink-0">Map · {mapItems.length}/{mappable} mapped</label>
                {/* Clickable status legend = a status filter for the calendar + map. */}
                <div className="flex flex-wrap gap-1.5 justify-end">
                  {(['scheduled', 'in_progress', ...(showCompleted ? ['completed'] : [])]).map((k) => {
                    const v = STATUS_META[k];
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
