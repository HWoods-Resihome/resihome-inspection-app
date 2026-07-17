import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { SERVICE_NAV_KEY } from '@/components/ServicePager';
import { useRouter } from 'next/router';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isInternalEmail } from '@/lib/userAccess';
import { searchServiceWorkOrders } from '@/lib/hubspot';
import { MultiFilter } from '@/components/MultiFilter';
import { ListPicker } from '@/components/ListPicker';
import { SettingsMenu } from '@/components/SettingsMenu';
import { PullToRefresh } from '@/components/PullToRefresh';
import { AiSparkle } from '@/components/AiSparkle';
import { WORKTYPES, worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import {
  SERVICE_STATUS_ORDER, easternTodayISO,
  SERVICE_STATUS_LABEL as STATUS_LABEL, SERVICE_STATUS_STYLE as STATUS_STYLE, serviceStatusText, fmtMDY,
  type ServiceStatus, type ServiceRecord,
} from '@/lib/services/model';
import { setViewAsVendor } from '@/lib/services/viewAs';
import { scopeServices } from '@/lib/services/scope';
import { resolveServiceViewerAsync, servicesViewerAllowed } from '@/lib/services/scopeServer';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  // App admins OR an approved vendor company (scoped to their own work orders).
  const ok = await servicesViewerAllowed(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  // Resolve the viewer FIRST so a vendor's fetch is scoped server-side to their
  // own orders — they always get their complete set (never truncated by a global
  // window) and never receive another vendor's data. Admins fetch the all view.
  const viewer = await resolveServiceViewerAsync(session, ctx.req);
  const real = await searchServiceWorkOrders(viewer.canSeeAll ? {} : { vendorEmail: viewer.vendorEmail }).catch(() => null);
  // Per-property billing lines split from a community grass-cut master roll UP
  // into the master — hide the children from the operational list (the master
  // drill-down and the billing view surface them). See RECURRING_SERVICES_PLAN.md.
  const operational = (real ?? []).filter((s) => !s.masterServiceId);
  // scopeServices stays as a safety net (covers legacy rows matched by name).
  const services = scopeServices(operational, viewer);
  const asVendor = !viewer.canSeeAll || ctx.query.as === 'vendor';
  return {
    props: {
      userName: session?.name || session?.email || '',
      // A vendor login is NEVER an internal creator, even on an internal-domain
      // email — the session's vendor flag is authoritative.
      canCreate: isInternalEmail(session?.email) && !session?.vendor,
      isVendor: !!session?.vendor,
      services,
      live: !!real,
      asVendor,
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

// Service card with press-and-hold to cancel (internal only, live records) —
// mirrors the inspection card's long-press. A ~500ms hold prompts to cancel; a
// normal tap opens the service. The click after a long-press is swallowed.
function ServiceCard({ s, overdue, isAdmin, selectMode, selectable, selected, onToggleSelect, onLongPress }: {
  s: ServiceRecord; overdue: boolean; isAdmin: boolean;
  selectMode?: boolean; selectable?: boolean; selected?: boolean; onToggleSelect?: (id: string) => void; onLongPress?: (id: string, selectable: boolean) => void;
}) {
  const lpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lpFired = useRef(false);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const clearLp = () => { if (lpTimer.current) { clearTimeout(lpTimer.current); lpTimer.current = null; } };
  const onPointerDown = (e: React.PointerEvent) => {
    // Long-press enters multi-select (pre-selecting this card when selectable).
    // Disabled once already in select mode (taps toggle instead).
    if (!isAdmin || selectMode) return;
    lpFired.current = false;
    lpStart.current = { x: e.clientX, y: e.clientY };
    clearLp();
    lpTimer.current = setTimeout(() => { lpFired.current = true; onLongPress?.(s.id, !!selectable); }, 500);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!lpTimer.current || !lpStart.current) return;
    if (Math.abs(e.clientX - lpStart.current.x) > 10 || Math.abs(e.clientY - lpStart.current.y) > 10) clearLp();
  };
  const selCls = selectMode ? (!selectable ? 'opacity-50 border-gray-200' : selected ? 'border-brand ring-1 ring-brand' : 'border-gray-200') : 'border-gray-200 hover:border-brand/40 hover:shadow-md';
  // Bottom-left date cell: "Estimate <date>" while estimating, else "Due <date>"
  // (turns red once past due) — mirrors the inspection card's date.
  const dateText = s.status === 'estimated'
    ? `Estimate${(s.estimatedAt || s.dueDate) ? ` ${fmtMDY(s.estimatedAt || s.dueDate)}` : ''}`
    : `Due ${fmtMDY(s.dueDate)}`;
  // Locality line: a community's title is already its name, so show just the
  // locality; a property appends a distinct community tag.
  const localityLine = s.scope === 'community'
    ? (s.locality || '')
    : `${s.locality}${s.community && s.community !== s.address ? ` · ${s.community}` : ''}`;
  return (
    <Link href={`/services/${s.id}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={clearLp} onPointerCancel={clearLp}
      onClick={(e) => {
        if (selectMode) { e.preventDefault(); e.stopPropagation(); if (selectable) onToggleSelect?.(s.id); return; }
        if (lpFired.current) { e.preventDefault(); e.stopPropagation(); lpFired.current = false; }
      }}
      onContextMenu={(e) => { if (isAdmin) e.preventDefault(); }}
      className={`block select-none bg-white border rounded-xl p-4 shadow-sm active:scale-[0.995] transition ${selCls}`}
      style={{ WebkitTouchCallout: 'none' }}>
      <div className="flex items-start gap-3">
        {selectMode && (
          <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-md border-2 grid place-items-center ${!selectable ? 'border-gray-200 bg-gray-100' : selected ? 'bg-brand border-brand text-white' : 'border-gray-300 bg-white'}`}>
            {selectable && selected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {/* Header: pink work-type kicker · address (+ scope chip) · status pill —
              matches the Field Inspections card. */}
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-heading font-bold uppercase tracking-wide text-brand mb-1 truncate">
                {worktypeLabel(s.worktype)} · {subtypeLabel(s.worktype, s.subtype)}
              </p>
              <h3 className="font-bold text-[15px] text-ink break-words leading-snug">
                <span className="align-middle">{s.address}</span>
                <span className={`ml-2 align-middle inline-block text-[10px] font-heading font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${s.scope === 'community' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{s.scope === 'community' ? 'Community' : 'SFR'}</span>
              </h3>
              {localityLine && (
                <p className="text-[13px] text-gray-500 break-words leading-snug mt-0.5">{localityLine}</p>
              )}
            </div>
            <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-heading font-semibold border ${STATUS_STYLE[s.status]}`}>
              {serviceStatusText(s.status, isAdmin)}
              {isAdmin && s.status === 'submitted' && <AiSparkle className="w-3 h-3" />}
            </span>
          </div>
          {/* Meta row: date (left) · property status (center, muted) · vendor
              (right) — three EQUAL cells so the center sits at the true middle. */}
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span className={`flex-1 min-w-0 truncate whitespace-nowrap ${overdue ? 'text-red-600 font-semibold' : ''}`}>{dateText}</span>
            <span className="flex-1 min-w-0 truncate text-center text-gray-400">{s.scope !== 'community' ? (s.propertyStatus || '') : ''}</span>
            <span className="flex-1 min-w-0 truncate text-right">{s.vendor || <span className="text-brand font-semibold">Unassigned</span>}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function ServicesHome({ userName, canCreate, services, live, asVendor, isVendor }: { userName: string; canCreate: boolean; services: ServiceRecord[]; live: boolean; asVendor: boolean; isVendor: boolean }) {
  const router = useRouter();
  // "View as Vendor" preview (cookie-persisted, whole-app): shows the external
  // vendor experience — no admin create/settings, and the vendor-visibility rule
  // applies. Entering/exiting sets the cookie then reloads so SSR re-runs.
  const isAdmin = canCreate && !asVendor;
  // Exiting the vendor preview lives on the in-page banner (below). Entering it
  // is now offered through the shared "View as User / Vendor" picker in the gear.
  const exitVendorView = () => { setViewAsVendor(false); window.location.href = '/services'; };
  // Past-due is measured against the REAL today for live data (the sample preview
  // keeps its fixed reference date). Strict "<" so a service due TODAY is still
  // on-time — it only goes red once at least a day past due.
  const todayISO = useMemo(() => easternTodayISO(), []);
  // Region filter options derived from the live services (was SAMPLE_REGIONS).
  const regionOptions = useMemo(() => Array.from(new Set(services.map((s) => s.region).filter(Boolean))).sort(), [services]);
  // 'all' = everything (incl. completed); 'all_open' = everything except completed.
  // Tapping the All chip cycles between the two.
  // Vendors land on all OPEN services sorted by status (Assigned first); everyone
  // else defaults to everything sorted by due date.
  const [status, setStatus] = useState<ServiceStatus | 'all' | 'all_open'>(isVendor ? 'all_open' : 'all');
  const [worktype, setWorktype] = useState<string[]>([]);
  const [vendor, setVendor] = useState<string[]>([]);
  const [region, setRegion] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [pastDueOnly, setPastDueOnly] = useState(false);
  const [sortField, setSortField] = useState<SortField>(isVendor ? 'status' : 'due');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Press-and-hold a card (internal + live) → enter multi-select, exactly like the
  // inspection home. In select mode an action bar offers Move to Cancelled and
  // Reassign Vendor over the whole selection. Canceled cards are optimistically
  // hidden. Selectable = any open (non-terminal) service.
  const [cancelledIds, setCancelledIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [actionBusy, setActionBusy] = useState(false);
  // Inline result banner for bulk actions (cancel / reassign).
  const [actionMsg, setActionMsg] = useState<{ status: 'done' | 'error'; msg: string } | null>(null);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [vendorNames, setVendorNames] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/services/vendors').then((r) => r.json()).then((d) => {
      if (alive && Array.isArray(d?.vendors)) setVendorNames(d.vendors.map((v: any) => String(v.name)).filter(Boolean));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const [reassignVendor, setReassignVendor] = useState('');
  const canSelect = isAdmin && live;
  const isSelectable = (s: ServiceRecord) => canSelect && !['completed', 'canceled'].includes(s.status);
  const toggleSelect = (id: string) => setSelectedIds((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const exitSelect = () => { setSelectMode(false); setSelectedIds(new Set()); setReassignOpen(false); };
  const enterSelectWith = (id: string, selectable: boolean) => { if (!canSelect) return; try { navigator.vibrate?.(15); } catch { /* n/a */ } setSelectMode(true); setSelectedIds(selectable ? new Set([id]) : new Set()); };

  const handleBulkCancel = async () => {
    if (!selectedIds.size || actionBusy) return;
    if (typeof window !== 'undefined' && !window.confirm(`Move ${selectedIds.size} service${selectedIds.size > 1 ? 's' : ''} to Canceled?`)) return;
    setActionBusy(true); setActionMsg(null);
    const ids = Array.from(selectedIds);
    try {
      const r = await fetch('/api/services/bulk-cancel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
      });
      const d = await r.json();
      if (!r.ok) { setActionMsg({ status: 'error', msg: `Cancel — ${d.error || 'failed.'}` }); return; }
      setCancelledIds((p) => { const n = new Set(p); for (const x of ids) n.add(x); return n; });
      const parts = [`${d.canceled} canceled`]; if (d.skipped) parts.push(`${d.skipped} skipped`); if (d.failed) parts.push(`${d.failed} failed`);
      setActionMsg({ status: d.failed ? 'error' : 'done', msg: `Cancel — ${parts.join(' · ')}` });
      exitSelect();
      router.replace(router.asPath, undefined, { scroll: false }).catch(() => {});
    } catch { setActionMsg({ status: 'error', msg: 'Cancel — couldn’t reach the server. Try again.' }); }
    finally { setActionBusy(false); }
  };

  const applyReassign = async () => {
    if (!selectedIds.size || !reassignVendor || actionBusy) return;
    setActionBusy(true); setActionMsg(null);
    try {
      const r = await fetch('/api/services/bulk-reassign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds), vendorName: reassignVendor }),
      });
      const d = await r.json();
      if (!r.ok) { setActionMsg({ status: 'error', msg: `Reassign — ${d.error || 'failed.'}` }); return; }
      const parts = [`${d.reassigned} reassigned to ${d.vendorName}`]; if (d.skipped) parts.push(`${d.skipped} skipped`); if (d.failed) parts.push(`${d.failed} failed`);
      setActionMsg({ status: d.failed ? 'error' : 'done', msg: `Reassign — ${parts.join(' · ')}` });
      exitSelect();
      router.replace(router.asPath, undefined, { scroll: false }).catch(() => {});
    } catch { setActionMsg({ status: 'error', msg: 'Reassign — couldn’t reach the server. Try again.' }); }
    finally { setActionBusy(false); }
  };

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
      pastDue: open.filter((s) => !!s.dueDate && s.dueDate < todayISO).length,
      onTimePct: done.length ? Math.round((onTime.length / done.length) * 100) : null,
    };
  }, [scoped]);

  // Canceled is excluded from the counts and the list (matches inspections, which
  // hides cancelled records and doesn't count them).
  const counts = useMemo(() => {
    const active = scoped.filter((s) => s.status !== 'canceled');
    const c: Record<string, number> = { all: active.length, all_open: active.filter((s) => OPEN_STATUSES.includes(s.status)).length };
    for (const st of SERVICE_STATUS_ORDER) c[st] = active.filter((s) => s.status === st).length;
    return c;
  }, [scoped]);

  const rows = useMemo(() => {
    let list = scoped.filter((s) => s.status !== 'canceled');
    if (pastDueOnly) list = list.filter((s) => OPEN_STATUSES.includes(s.status) && !!s.dueDate && s.dueDate < todayISO);
    else if (status === 'all_open') list = list.filter((s) => OPEN_STATUSES.includes(s.status));
    else if (status !== 'all') list = list.filter((s) => s.status === status);
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = (s: typeof list[number]) => ({
      due: s.dueDate, address: s.address.toLowerCase(), worktype: worktypeLabel(s.worktype),
      vendor: (s.vendor || '~').toLowerCase(), status: (STATUS_LABEL[s.status] || String(s.status)).toLowerCase(),
      region: s.region.toLowerCase(), community: (s.community || '~').toLowerCase(),
    }[sortField]);
    return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * dir);
  }, [scoped, status, pastDueOnly, sortField, sortDir]);

  const visibleRows = useMemo(() => rows.filter((s) => !cancelledIds.has(s.id)), [rows, cancelledIds]);

  // Publish the CURRENT visible order so the record's ‹ | › pager steps through
  // exactly this filtered/sorted list (mirrors the inspections nav list).
  useEffect(() => {
    try { sessionStorage.setItem(SERVICE_NAV_KEY, JSON.stringify(visibleRows.map((s) => s.id))); } catch { /* non-fatal */ }
  }, [visibleRows]);

  // Client-side pagination (mirrors the inspection home): choose how many to view
  // per page + step pages. Reset to page 1 whenever the filtered set changes.
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [status, pastDueOnly, worktype, vendor, region, search, sortField, sortDir, pageSize]);
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pagedRows = visibleRows.slice(pageStart, pageStart + pageSize);

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
      <PullToRefresh onRefresh={async () => { await router.replace(router.asPath, undefined, { scroll: false }).catch(() => {}); }} />
      {/* Pink header — mirrors the inspections home. */}
      <header className="bg-brand text-white sticky top-0 z-30 shrink-0" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
        <div className="max-w-3xl mx-auto px-4 pt-2 pb-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Link href="/services" aria-label="Services home" className="shrink-0"><img src="/app-icon.svg" alt="ResiWalk" className="h-11 w-11 object-cover" /></Link>
              <div className="min-w-0">
                <h1 className="font-heading font-extrabold text-lg tracking-tight">Services</h1>
                {userName && <div className="text-xs text-white/80 truncate">Welcome, {userName}</div>}
              </div>
            </div>
            <div className="flex items-center gap-1.5 whitespace-nowrap">
              {/* Calendar/map — available to everyone (vendors see their own
                  services on it). The Inspections↔Services switcher stays internal
                  only, since a vendor is services-only. */}
              <Link href="/services/calendar" aria-label="Calendar" title="Calendar &amp; map"
                className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
              </Link>
              {!isVendor && (
                <div className="relative">
                  <button type="button" onClick={() => setMenuOpen((o) => !o)} aria-label="Switch app" aria-expanded={menuOpen}
                    className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="4" y1="8" x2="20" y2="8" /><line x1="4" y1="16" x2="20" y2="16" /></svg>
                  </button>
                  {menuOpen && (<><div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                    <div className="absolute right-0 mt-1 w-44 bg-white rounded-xl shadow-lg border border-gray-200 z-40 overflow-hidden text-ink">
                      <Link href="/" className="block px-4 py-2.5 text-sm hover:bg-gray-50">Inspections</Link>
                      <div className="px-4 py-2.5 text-sm font-semibold text-brand bg-brand/5">Services ✓</div>
                    </div></>)}
                </div>
              )}
              {/* Settings gear. Vendors get a limited menu (Notification Settings +
                  Sign Out); internal users get the full shared menu. */}
              <SettingsMenu isAdmin={isAdmin} isVendor={isVendor} onOpen={() => setMenuOpen(false)} />
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
        {asVendor && !isVendor && (
          <div className="mb-3 flex items-center justify-between gap-2 bg-purple-600 text-white rounded-xl px-3 py-2 text-[12px] font-heading font-semibold">
            <span>Viewing as Vendor — admin controls &amp; client pricing hidden.</span>
            <button type="button" onClick={exitVendorView} className="underline shrink-0">Exit</button>
          </div>
        )}
        {actionMsg && (
          <div className={`mb-3 flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-[12px] font-heading font-semibold border ${
            actionMsg.status === 'error' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}>
            <span className="truncate">{actionMsg.msg}</span>
            <button type="button" onClick={() => setActionMsg(null)} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100">✕</button>
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
              <button type="button" onClick={() => { setPastDueOnly(false); setStatus((s) => (s === 'all' ? 'all_open' : 'all')); }}
                title="Tap again to toggle All ↔ All Open (hide completed)"
                className={`w-full text-center text-[11px] font-heading font-semibold px-2 py-1.5 rounded-full border transition whitespace-nowrap ${
                  (status === 'all' || status === 'all_open') && !pastDueOnly ? 'bg-brand text-white border-brand' : 'bg-white text-ink border-gray-300 hover:border-brand/50'}`}>
                {status === 'all_open' ? `All Open (${counts.all_open})` : `All (${counts.all})`}
              </button>
              {chip('estimated', 'Estimate')}{chip('assigned', 'Assigned')}{chip('submitted', 'Submitted')}{chip('review', 'Review')}{chip('completed', 'Completed')}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <div className="flex-1 min-w-0">
                <MultiFilter label="Type" selected={worktype} onChange={setWorktype} className={pickerCls(worktype.length > 0)}
                  options={WORKTYPES.map((w) => ({ value: w.id, label: w.label }))} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Vendor" selected={vendor} onChange={setVendor} className={pickerCls(vendor.length > 0)}
                  options={[...vendorNames.map((v) => ({ value: v, label: v })), { value: '—', label: 'Unassigned' }]} />
              </div>
              <div className="flex-1 min-w-0">
                <MultiFilter label="Region" selected={region} onChange={setRegion} className={pickerCls(region.length > 0)}
                  options={regionOptions.map((r) => ({ value: r, label: r }))} />
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

        {/* Select-mode action bar (press-and-hold a card, or gear → Select Services).
            Acts on the whole selection: Reassign Vendor (opens a picker) or Move to
            Cancelled. Reassign only touches Assigned services; the rest are skipped. */}
        {selectMode && (
          <div className="mb-3 bg-white border-2 border-brand rounded-xl px-3 py-2.5 shadow-md sticky top-2 z-20">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-heading font-bold text-ink">{selectedIds.size} selected</span>
              <div className="flex-1" />
              <button type="button" onClick={exitSelect} className="text-[12px] font-heading font-semibold text-gray-500 hover:text-brand underline">Done</button>
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button type="button" disabled={!selectedIds.size || actionBusy} onClick={() => { setReassignVendor(vendorNames[0] || ''); setReassignOpen(true); }}
                className="flex-1 rounded-lg px-3 py-2 text-sm font-heading font-bold bg-brand text-white disabled:opacity-50">Reassign Vendor</button>
              <button type="button" disabled={!selectedIds.size || actionBusy} onClick={handleBulkCancel}
                className="flex-1 rounded-lg px-3 py-2 text-sm font-heading font-bold bg-white text-red-600 border border-red-300 disabled:opacity-50">{actionBusy ? '…' : 'Move to Cancelled'}</button>
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5">Tap services to select. Reassign applies to <b>Assigned</b> services in the selection; others are skipped.</p>
          </div>
        )}

        <div className="space-y-3">
          {pagedRows.map((s) => (
            <ServiceCard key={s.id} s={s} overdue={OPEN_STATUSES.includes(s.status) && !!s.dueDate && s.dueDate < todayISO}
              isAdmin={isAdmin}
              selectMode={selectMode} selectable={isSelectable(s)} selected={selectedIds.has(s.id)} onToggleSelect={toggleSelect} onLongPress={enterSelectWith} />
          ))}
          {visibleRows.length === 0 && (
            <div className="text-center text-gray-500 text-sm py-12 border border-dashed border-gray-300 rounded-xl">No services match these filters.</div>
          )}
        </div>

        {/* Bottom pagination — mirrors the inspection home (per-page + Back/Next). */}
        {visibleRows.length > 0 && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-gray-500 font-heading whitespace-nowrap">Per page</span>
              <ListPicker value={String(pageSize)}
                options={[{ value: '20', label: '20' }, { value: '50', label: '50' }, { value: '100', label: '100' }]}
                onChange={(v) => setPageSize(Number(v))} ariaLabel="Services per page"
                className="text-xs font-heading font-semibold pl-2.5 pr-2 py-1.5 border border-gray-300 rounded-md bg-white flex items-center gap-1 text-gray-700 hover:border-brand/50" />
            </div>
            <div className="flex items-center gap-2 sm:gap-3">
              <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}
                className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 hover:text-brand px-3 py-1.5 border border-gray-300 rounded-md bg-white disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                Back
              </button>
              <span className="text-xs font-heading text-gray-600 whitespace-nowrap">Page {currentPage} of {totalPages}</span>
              <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}
                className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 hover:text-brand px-3 py-1.5 border border-gray-300 rounded-md bg-white disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                Next
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Reassign Vendor popup (select mode). */}
      {reassignOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setReassignOpen(false)}>
          <div className="bg-white w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="font-heading font-bold text-[15px] text-ink">Reassign Vendor</div>
            <p className="text-[13px] text-gray-500 -mt-1">Assign the <b className="text-ink">{selectedIds.size}</b> selected service{selectedIds.size > 1 ? 's' : ''} to a vendor. Only services in <b>Assigned</b> status are reassigned.</p>
            <div className="space-y-1.5">
              {vendorNames.map((name) => (
                <button key={name} type="button" onClick={() => setReassignVendor(name)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm font-heading font-semibold ${reassignVendor === name ? 'bg-brand/5 border-brand text-brand' : 'bg-white border-gray-300 text-gray-700 hover:border-brand/50'}`}>
                  {name}
                </button>
              ))}
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setReassignOpen(false)} className="px-4 py-2.5 rounded-xl text-sm font-heading font-semibold bg-white text-gray-600 border border-gray-300">Cancel</button>
              <button type="button" disabled={actionBusy || !reassignVendor} onClick={applyReassign}
                className="flex-1 rounded-xl py-2.5 font-heading font-bold text-sm bg-brand text-white disabled:opacity-50">{actionBusy ? '…' : 'Submit'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
