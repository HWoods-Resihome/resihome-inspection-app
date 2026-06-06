import Link from 'next/link';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppDialog } from '@/components/AppDialog';
import { useRouter } from 'next/router';
import type { InspectionSummary } from '@/lib/types';
import { InspectionCard } from '@/components/InspectionCard';
import { ListPicker } from '@/components/ListPicker';
import { loadCachedRateCard, saveCachedRateCard } from '@/lib/offlineCache';
import { isKnowledgeAdmin } from '@/lib/aiKnowledgeAccess';

interface MeUser { userId: string; email: string; name: string; }

type StatusFilter = 'all' | 'scheduled' | 'in_progress' | 'pending_approval' | 'completed';

export default function Home() {
  const dialog = useAppDialog();
  const router = useRouter();
  const [me, setMe] = useState<MeUser | null>(null);

  const [inspections, setInspections] = useState<InspectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Sort field + direction. Default: most-recently-updated first.
  const [sortField, setSortField] = useState<'updated' | 'scheduled'>('updated');
  // 'desc' = newest first (default), 'asc' = oldest first.
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  // Filter by inspector name. 'all' = no filter; otherwise match by name (case-insensitive).
  const [inspectorFilter, setInspectorFilter] = useState<string>('all');
  // Filter by template internal name. 'all' = no filter.
  const [templateFilter, setTemplateFilter] = useState<string>('all');

  // Bulk-select mode + selection set + busy flag for the cancel action.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cancelBusy, setCancelBusy] = useState(false);

  // Pagination — show a page of cards at a time so the initial render stays
  // snappy even with hundreds of inspections. Default 20 per page; user can
  // bump to 50 / 100 and page forward/back.
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState<number>(1);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => { if (data.authenticated) setMe(data.user); })
      .catch(() => {});
  }, []);

  // Warm the Rate Card catalog cache from the home screen while there's signal,
  // so the FIRST manual "add line item" search works instantly — even offline in
  // the field. Fire-and-forget; only when online and not already cached.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (loadCachedRateCard()) return; // already have it
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    Promise.all([
      fetch('/api/rate-card/catalog', { signal: ctrl.signal }).then((r) => r.json()),
      fetch('/api/rate-card/regions', { signal: ctrl.signal }).then((r) => r.json()),
    ])
      .then(([cat, reg]) => {
        if (Array.isArray(cat?.items) && cat.items.length) saveCachedRateCard(cat.items, reg?.regions || []);
      })
      .catch(() => { /* weak signal — RateCardForm will cache on first open instead */ })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, []);

  // Keep the latest search term in a ref so refetch-on-focus / post-action
  // reloads honor the active search instead of resetting to the default list.
  const searchRef = useRef('');
  searchRef.current = search;

  // Wrapped in useCallback so we can call it from multiple places. When a
  // search term is active, it's sent to the server so inspections beyond the
  // recent-500 window are reachable (address / name / inspector match).
  const fetchInspections = useCallback(async () => {
    try {
      const term = searchRef.current.trim();
      const qs = term ? `?search=${encodeURIComponent(term)}` : '';
      const r = await fetch(`/api/inspections${qs}`, { cache: 'no-store' });
      const data = await r.json();
      if (data.error) {
        setError(data.error);
      } else {
        setInspections(data.inspections || []);
        setError(null);
      }
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load AND honor the "just_*" query hints by doing a delayed second
  // fetch (HubSpot search index can lag for fresh creates).
  // This effect runs ONCE on mount. router.query is read directly inside without
  // a dependency to prevent re-running when the query changes.
  useEffect(() => {
    fetchInspections();
    // Check if we arrived with a "just_" hint indicating a fresh record was created
    const url = typeof window !== 'undefined' ? window.location.search : '';
    if (url.includes('just_')) {
      const t = setTimeout(fetchInspections, 1800);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when the user returns to this tab (mobile app switching, alt-tab on desktop)
  useEffect(() => {
    function onFocus() {
      fetchInspections();
    }
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [fetchInspections]);

  // Debounced server-side search: re-query when the term changes so older
  // inspections (past the recent-500 default) surface. Skips the initial mount
  // (the mount effect already loaded the default list).
  const didMountSearch = useRef(false);
  useEffect(() => {
    if (!didMountSearch.current) { didMountSearch.current = true; return; }
    const t = setTimeout(() => { setLoading(true); fetchInspections(); }, 400);
    return () => clearTimeout(t);
  }, [search, fetchInspections]);

  async function handleLogout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    router.replace('/login');
  }

  // Apply search + status + inspector + template filters to the inspection list
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const wantStatus = statusFilter;
    const wantInspector = inspectorFilter; // 'all' or lowercase inspector name
    const wantTemplate = templateFilter; // 'all' or template internal name
    return inspections.filter((i) => {
      // Cancelled inspections are hidden from the app entirely. They still
      // exist in HubSpot, but the field team doesn't need to see them here.
      const statusLower = (i.status || '').trim().toLowerCase();
      if (statusLower === 'cancelled' || statusLower === 'canceled') return false;

      // Search filter — match address, name, OR inspector so a server result
      // that matched by name/inspector isn't hidden by a narrower client filter.
      if (q) {
        const hay = `${i.propertyAddressSnapshot} ${i.inspectionName} ${i.inspectorName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // Status filter
      if (wantStatus !== 'all') {
        const s = statusLower;
        if (wantStatus === 'scheduled' && s !== 'scheduled') return false;
        if (wantStatus === 'in_progress' && !(s === 'in progress' || s === 'in-progress' || s === 'in_progress')) return false;
        if (wantStatus === 'pending_approval' && !(s === 'pending approval' || s === 'pending-approval' || s === 'pending_approval' || s === 'pendingapproval')) return false;
        if (wantStatus === 'completed' && !(s === 'completed' || s === 'complete' || s === 'submitted')) return false;
      }
      // Inspector filter (case-insensitive name match)
      if (wantInspector !== 'all') {
        if ((i.inspectorName || '').trim().toLowerCase() !== wantInspector) return false;
      }
      // Template filter (exact match on internal name)
      if (wantTemplate !== 'all') {
        if ((i.templateType || '') !== wantTemplate) return false;
      }
      return true;
    });
  }, [inspections, search, statusFilter, inspectorFilter, templateFilter]);

  // Apply sort. Priority: scheduled_date > completed_at > created_at.
  // Inspections with no date sort to the end (regardless of asc/desc).
  // HubSpot Date fields come back as epoch-ms strings; DateTime/ISO fields come
  // back as ISO 8601. Parse both forms.
  const sorted = useMemo(() => {
    const effective = (i: InspectionSummary): number | null => {
      // "Updated" sorts by last-edited (fallbacks keep older records ordered);
      // "Scheduled" keeps the prior scheduled-date behavior.
      const raw = sortField === 'updated'
        ? (i.updatedAt || i.completedAt || i.createdAt)
        : (i.scheduledDate || i.completedAt || i.createdAt);
      if (!raw) return null;
      if (/^\d+$/.test(raw)) {
        const n = Number(raw);
        return isNaN(n) ? null : n;
      }
      const t = Date.parse(raw);
      return isNaN(t) ? null : t;
    };
    const copy = [...filtered];
    copy.sort((a, b) => {
      const ta = effective(a);
      const tb = effective(b);
      // Missing dates always sort to the end
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return sortDir === 'desc' ? tb - ta : ta - tb;
    });
    return copy;
  }, [filtered, sortField, sortDir]);

  // Snap back to page 1 whenever the result set's shape changes (new filter,
  // search, sort, or page size) so the user isn't stranded on an empty page.
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, inspectorFilter, templateFilter, sortField, sortDir, pageSize]);

  // Page math. currentPage is clamped in case the list shrank beneath `page`.
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const paged = useMemo(
    () => sorted.slice(pageStart, pageStart + pageSize),
    [sorted, pageStart, pageSize]
  );

  // Count by status for filter chips. Cancelled inspections are excluded
  // from the app, so they don't count toward any chip (including "All").
  const counts = useMemo(() => {
    const c = { all: 0, scheduled: 0, in_progress: 0, pending_approval: 0, completed: 0 };
    for (const i of inspections) {
      const s = (i.status || '').trim().toLowerCase();
      if (s === 'cancelled' || s === 'canceled') continue; // hidden everywhere
      c.all++;
      if (s === 'scheduled') c.scheduled++;
      else if (s === 'in progress' || s === 'in-progress' || s === 'in_progress') c.in_progress++;
      else if (s === 'pending approval' || s === 'pending-approval' || s === 'pending_approval' || s === 'pendingapproval') c.pending_approval++;
      else if (s === 'completed' || s === 'complete' || s === 'submitted') c.completed++;
    }
    return c;
  }, [inspections]);

  // ---- Bulk-select helpers ----
  // A card is selectable for cancellation unless it's completed.
  function isSelectable(i: InspectionSummary): boolean {
    const s = (i.status || '').trim().toLowerCase();
    return !(s === 'completed' || s === 'complete' || s === 'submitted');
  }

  function toggleSelect(recordId: string) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(recordId)) next.delete(recordId); else next.add(recordId);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  // Press-and-hold a card to enter bulk-select with it pre-selected (only if
  // it's a cancellable inspection; completed ones still flip into select mode).
  function enterSelectWith(recordId: string) {
    const ins = inspections.find((x) => x.recordId === recordId);
    setSelectMode(true);
    setSelectedIds(ins && isSelectable(ins) ? new Set([recordId]) : new Set());
  }

  // Select / clear all currently-visible selectable inspections (current page).
  const selectableVisible = useMemo(
    () => paged.filter(isSelectable),
    [paged]
  );
  const allVisibleSelected = selectableVisible.length > 0
    && selectableVisible.every((i) => selectedIds.has(i.recordId));

  function toggleSelectAll() {
    setSelectedIds((cur) => {
      if (allVisibleSelected) {
        // Deselect the visible ones
        const next = new Set(cur);
        for (const i of selectableVisible) next.delete(i.recordId);
        return next;
      }
      const next = new Set(cur);
      for (const i of selectableVisible) next.add(i.recordId);
      return next;
    });
  }

  async function handleBulkCancel() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!(await dialog.confirm(`Move ${ids.length} inspection${ids.length === 1 ? '' : 's'} to Cancelled? This can't be undone from here.`, { confirmLabel: 'Move to Cancelled', cancelLabel: 'Keep' }))) return;
    setCancelBusy(true);
    try {
      const r = await fetch('/api/inspections/bulk-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
      exitSelectMode();
      // Refresh; HubSpot's index can lag so give it a beat.
      await fetchInspections();
      setTimeout(() => { fetchInspections(); }, 1200);
      const skippedCompleted = (data.skipped || []).filter((s: any) => s.reason === 'completed').length;
      if (skippedCompleted > 0) {
        void dialog.alert(`${data.cancelled.length} cancelled. ${skippedCompleted} completed inspection${skippedCompleted === 1 ? ' was' : 's were'} skipped (completed inspections can't be cancelled).`);
      }
    } catch (e: any) {
      void dialog.alert(`Could not cancel: ${e.message || e}`);
    } finally {
      setCancelBusy(false);
    }
  }

  // Derive inspector dropdown options from the loaded inspections.
  // Each option: { value: lowercase name (filter key), label: original-case display name, count }
  // Dedupes case-insensitively; uses the first variant seen for display.
  const inspectorOptions = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const i of inspections) {
      const raw = (i.inspectorName || '').trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      const existing = map.get(key);
      if (existing) existing.count++;
      else map.set(key, { label: raw, count: 1 });
    }
    return Array.from(map.entries())
      .map(([value, { label, count }]) => ({ value, label, count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [inspections]);

  // Derive template dropdown options. Templates are stable internal names, but
  // we'll only show those that appear in the loaded data so the filter is meaningful.
  const templateOptions = useMemo(() => {
    const map = new Map<string, number>();
    for (const i of inspections) {
      const t = (i.templateType || '').trim();
      if (!t) continue;
      map.set(t, (map.get(t) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([value, count]) => ({ value, label: prettyTemplateLabel(value), count }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [inspections]);

  return (
    <>
      <Head>
        <title>ResiHome Inspection</title>
      </Head>
      {/* On desktop the page becomes a fixed-height flex column: the header +
          filters are frozen at the top, only the card list scrolls, and the
          pagination bar is frozen at the bottom. On mobile it's normal document
          flow (everything scrolls together). */}
      <main className="frozen-shell min-h-screen bg-gray-50">
        {/* Frozen top region (large screens only): header + search + filters + bulk bar */}
        <div className="frozen-top">
        {/* Pink branded header */}
        <header className="bg-brand text-white">
          <div className="lz-head max-w-3xl mx-auto px-4 pt-4 pb-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="flex items-center gap-3 min-w-0">
                {/* App icon — white house + footprint on a brand-pink tile that
                    matches the header. Edge-to-edge (no rounding) so it reads as
                    part of the header rather than a separate chip. */}
                {/* Logo → home (already here; kept clickable for consistency). */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <Link href="/" aria-label="Home" className="shrink-0">
                  <img
                    src="/app-icon.svg"
                    alt="ResiWalk"
                    className="h-11 w-11 object-cover"
                  />
                </Link>
                <div className="min-w-0">
                  <h1 className="font-heading font-extrabold text-lg tracking-tight">
                    Field Inspections
                  </h1>
                  {me && (
                    <div className="text-xs text-white/80 truncate">Welcome, {me.name}</div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3 whitespace-nowrap">
                <GmailConnectChip />
                <button
                  onClick={handleLogout}
                  className="text-xs font-heading font-semibold text-white/90 hover:text-white"
                >
                  Sign Out
                </button>
              </div>
            </div>

            {/* + New Inspection button */}
            <Link
              href="/inspection/new"
              className="flex items-center gap-3 bg-pink-100 hover:bg-pink-200 rounded-xl px-4 py-3 transition active:scale-[0.99] shadow-md"
            >
              <div className="w-9 h-9 bg-brand rounded-lg flex items-center justify-center shrink-0">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-white">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
              <span className="font-heading font-bold text-base text-brand">New Inspection</span>
            </Link>

            {/* Admin: AI knowledge base (field-trained live-camera guidance).
                Curation is limited to the AI_KNOWLEDGE_ADMINS allowlist. */}
            {me && isKnowledgeAdmin(me.email) && (
              <Link
                href="/ai-knowledge"
                className="mt-2 flex items-center gap-2 text-white/90 hover:text-white text-sm font-heading font-semibold"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>
                AI Knowledge Base
              </Link>
            )}
          </div>
        </header>

        {/* Search + Filters */}
        <div className="lz-head max-w-3xl mx-auto px-4 pt-4 pb-2">
          <div className="relative mb-3">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                 className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search address, name, or inspector…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="focus-brand w-full pl-9 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg bg-white"
            />
          </div>

          {/* Status filter chips — two full-width rows; each chip stretches to
              fill its row so the section reads as a structured block (no
              horizontal scroll on mobile). */}
          <div className="space-y-1.5 mb-3">
            <div className="flex gap-1.5">
              <FilterChip className="flex-1" label={`All (${counts.all})`} active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
              <FilterChip className="flex-1" label={`Scheduled (${counts.scheduled})`} active={statusFilter === 'scheduled'} onClick={() => setStatusFilter('scheduled')} />
              <FilterChip className="flex-1" label={`In Progress (${counts.in_progress})`} active={statusFilter === 'in_progress'} onClick={() => setStatusFilter('in_progress')} />
            </div>
            <div className="flex gap-1.5">
              <FilterChip className="flex-1" label={`Pending Approval (${counts.pending_approval})`} active={statusFilter === 'pending_approval'} onClick={() => setStatusFilter('pending_approval')} />
              <FilterChip className="flex-1" label={`Completed (${counts.completed})`} active={statusFilter === 'completed'} onClick={() => setStatusFilter('completed')} />
            </div>
          </div>

          {/* Filter controls: inspector | template | date sort — all on one row.
              The dropdowns shrink (truncating) so Updated + sort fit to their
              right without wrapping or horizontal-scrolling on mobile. */}
          <div className="flex items-center gap-2 mb-2 pb-1">
            {/* Inspector filter — branded tap-to-select pop-up (no OS dropdown) */}
            <div className="flex-1 min-w-0 max-w-[160px]">
              <ListPicker
                value={inspectorFilter}
                options={[{ value: 'all', label: 'All Inspectors' }, ...inspectorOptions.map((o) => ({ value: o.value, label: o.label }))]}
                onChange={setInspectorFilter}
                ariaLabel="Filter by inspector"
                className={`w-full truncate text-xs font-heading font-semibold pl-2.5 pr-2 py-1.5 border rounded-md bg-white flex items-center justify-between ${
                  inspectorFilter !== 'all' ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'
                }`}
              />
            </div>

            {/* Template filter — branded tap-to-select pop-up (no OS dropdown) */}
            <div className="flex-1 min-w-0 max-w-[160px]">
              <ListPicker
                value={templateFilter}
                options={[{ value: 'all', label: 'All Templates' }, ...templateOptions.map((o) => ({ value: o.value, label: o.label }))]}
                onChange={setTemplateFilter}
                ariaLabel="Filter by template"
                className={`w-full truncate text-xs font-heading font-semibold pl-2.5 pr-2 py-1.5 border rounded-md bg-white flex items-center justify-between ${
                  templateFilter !== 'all' ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'
                }`}
              />
            </div>

            {/* Sort field toggle (Updated / Scheduled) */}
            <button
              type="button"
              onClick={() => setSortField(sortField === 'updated' ? 'scheduled' : 'updated')}
              className="shrink-0 inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 hover:text-brand px-2 py-1.5 border border-gray-300 rounded-md bg-white whitespace-nowrap"
              title="Switch between sorting by last-updated and scheduled date"
            >
              <span>{sortField === 'updated' ? 'Updated' : 'Scheduled'}</span>
            </button>

            {/* Sort direction toggle */}
            <button
              type="button"
              onClick={() => setSortDir(sortDir === 'desc' ? 'asc' : 'desc')}
              className="shrink-0 inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 hover:text-brand px-2 py-1.5 border border-gray-300 rounded-md bg-white whitespace-nowrap"
              title={sortDir === 'desc' ? 'Newest first. Tap for oldest first.' : 'Oldest first. Tap for newest first.'}
            >
              {sortDir === 'desc' ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              )}
            </button>

            {/* Clear-all link, only shown when any filter is active */}
            {(inspectorFilter !== 'all' || templateFilter !== 'all') && (
              <button
                type="button"
                onClick={() => { setInspectorFilter('all'); setTemplateFilter('all'); }}
                className="shrink-0 text-xs text-gray-500 hover:text-brand font-heading underline whitespace-nowrap"
                title="Clear inspector and template filters"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="text-xs text-gray-500 font-heading">
              {loading
                ? 'Loading...'
                : sorted.length === 0
                ? `0 of ${counts.all} inspection${counts.all === 1 ? '' : 's'}`
                : `Showing ${pageStart + 1}–${Math.min(pageStart + pageSize, sorted.length)} of ${sorted.length}`}
            </div>
            {!loading && !error && inspections.length > 0 && (
              selectMode ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="text-xs font-heading font-semibold text-gray-700 hover:text-gray-900 underline"
                  >
                    {allVisibleSelected ? 'Clear all' : 'Select all'}
                  </button>
                  <button
                    type="button"
                    onClick={exitSelectMode}
                    className="text-xs font-heading font-semibold text-gray-500 hover:text-gray-700"
                  >
                    Done
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setSelectMode(true)}
                  className="text-xs font-heading font-semibold text-brand hover:underline"
                >
                  Select
                </button>
              )
            )}
          </div>
        </div>

        {/* Bulk action bar (sticky) — only in select mode */}
        {selectMode && (
          <div className="sticky top-0 z-20 bg-white border-y border-gray-200 shadow-sm">
            <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
              <span className="text-sm font-heading font-semibold text-gray-700">
                {selectedIds.size} selected
              </span>
              <button
                type="button"
                onClick={handleBulkCancel}
                disabled={selectedIds.size === 0 || cancelBusy}
                className="text-sm font-heading font-semibold text-white bg-brand hover:bg-brand-dark rounded-lg px-4 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {cancelBusy ? 'Cancelling...' : 'Move to Cancelled'}
              </button>
            </div>
          </div>
        )}
        </div>{/* end frozen top region */}

        {/* Inspection list — the only scrolling region on large screens */}
        <div className="frozen-scroll">
        <div className="max-w-3xl mx-auto px-4 pb-12">
          {loading && (
            <div className="text-sm text-gray-500 text-center py-8">Loading inspections...</div>
          )}
          {error && !loading && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-3">
              Could not load inspections: {error}
            </div>
          )}
          {!loading && !error && sorted.length === 0 && (
            <div className="text-center py-12">
              <div className="text-sm text-gray-500 mb-2">
                {inspections.length === 0 ? 'No inspections yet.' : 'No matching inspections.'}
              </div>
              {inspections.length === 0 && (
                <div className="text-xs text-gray-400">
                  Tap &quot;+ New Inspection&quot; above to get started.
                </div>
              )}
            </div>
          )}
          {paged.map((i) => (
            <InspectionCard
              key={i.recordId}
              inspection={i}
              selectMode={selectMode}
              selected={selectedIds.has(i.recordId)}
              selectable={isSelectable(i)}
              onToggleSelect={toggleSelect}
              onLongPress={enterSelectWith}
            />
          ))}
        </div>
        </div>{/* end scrolling card region */}

        {/* Pagination bar — frozen at the bottom on desktop, in-flow on mobile.
            Per-page selector (20/50/100) + Back/Next. Hidden while loading,
            erroring, or when there are no results. */}
        {!loading && !error && sorted.length > 0 && (
          <div className="frozen-foot lz-foot bg-white border-t border-gray-200">
            <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-gray-500 font-heading whitespace-nowrap">Per page</span>
                <ListPicker
                  value={String(pageSize)}
                  options={[{ value: '20', label: '20' }, { value: '50', label: '50' }, { value: '100', label: '100' }]}
                  onChange={(v) => setPageSize(Number(v))}
                  ariaLabel="Inspections per page"
                  className="text-xs font-heading font-semibold pl-2.5 pr-2 py-1.5 border border-gray-300 rounded-md bg-white flex items-center gap-1 text-gray-700 hover:border-brand/50"
                />
              </div>
              <div className="flex items-center gap-2 sm:gap-3">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 hover:text-brand px-3 py-1.5 border border-gray-300 rounded-md bg-white disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                  Back
                </button>
                <span className="text-xs font-heading text-gray-600 whitespace-nowrap">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                  className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 hover:text-brand px-3 py-1.5 border border-gray-300 rounded-md bg-white disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  Next
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}

interface ChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
  className?: string;
}

function FilterChip({ label, active, onClick, className = '' }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[11px] font-heading font-semibold px-2 py-1 rounded-full border transition whitespace-nowrap text-center ${className} ${
        active
          ? 'bg-brand text-white border-brand'
          : 'bg-white text-ink border-gray-300 hover:border-brand/50'
      }`}
    >
      {label}
    </button>
  );
}

// Display label for a template internal name.
// "pm_scope_inspection" -> "Scope"
// "qc_new_construction_rrqc" -> "QC New Construction"
function prettyTemplateLabel(t: string): string {
  if (!t) return '';
  return t
    .replace(/^pm_/, '')
    .replace(/^qc_/, 'QC ')
    .replace(/_inspection$/, '')
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Small chip in the header showing Gmail connection status. Lets users
 * connect proactively (rather than only being prompted at finalize time) and
 * disconnect. Hidden entirely when the server isn't configured for Gmail
 * (no OAuth client), since there's nothing to connect to.
 */
function GmailConnectChip() {
  const [state, setState] = useState<{ configured: boolean; connected: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/gmail/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setState(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Surface OAuth round-trip results from the query string (set by the
  // callback) as a one-time toast-ish refresh of state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail_connected') === '1') {
      setState((s) => (s ? { ...s, connected: true } : s));
      params.delete('gmail_connected');
      const clean = window.location.pathname + (params.toString() ? `?${params}` : '');
      window.history.replaceState({}, '', clean);
    }
  }, []);

  if (!state || !state.configured) return null; // nothing to show if unconfigured

  if (state.connected) {
    return (
      <button
        onClick={async () => {
          await fetch('/api/auth/gmail/status', { method: 'DELETE' });
          setState((s) => (s ? { ...s, connected: false } : s));
        }}
        title="Gmail connected — click to disconnect"
        className="text-xs font-semibold text-white/90 hover:text-white flex items-center gap-1"
      >
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-300" />
        Gmail
      </button>
    );
  }

  return (
    <a
      href="/api/auth/gmail/connect"
      title="Connect your Gmail to send inspection emails"
      className="text-xs font-semibold bg-white/15 hover:bg-white/25 rounded px-2 py-1 flex items-center gap-1"
    >
      <span className="inline-block w-2 h-2 rounded-full bg-white/50" />
      Connect Gmail
    </a>
  );
}
