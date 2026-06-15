import Link from 'next/link';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppDialog } from '@/components/AppDialog';
import { useRouter } from 'next/router';
import type { InspectionSummary } from '@/lib/types';
import { InspectionCard } from '@/components/InspectionCard';
import { ListPicker } from '@/components/ListPicker';
import { loadCachedRateCard, saveCachedRateCard } from '@/lib/offlineCache';
import { warmAi } from '@/lib/aiWarm';
import { templateLabel } from '@/lib/templateLabels';

interface MeUser { userId: string; email: string; name: string; }

type StatusFilter = 'all' | 'scheduled' | 'in_progress' | 'pending_approval' | 'completed';
type StatusCounts = { all: number; scheduled: number; in_progress: number; pending_approval: number; completed: number };

// Stale-while-revalidate caches (localStorage), so a slow cell connection shows
// the LAST results instantly instead of a blank "Loading…" while the network
// crawls. Best-effort: any storage error is swallowed.
const RESULTS_CACHE = 'resiwalk_home_results_v1';
const FACETS_CACHE = 'resiwalk_home_facets_v1';
function lsRead(store: string): Record<string, { d: any; at: number }> {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(window.localStorage.getItem(store) || '{}') || {}; } catch { return {}; }
}
function lsWrite(store: string, key: string, d: any, cap = 12): void {
  if (typeof window === 'undefined') return;
  try {
    const m = lsRead(store);
    m[key] = { d, at: Date.now() };
    const keep = Object.keys(m).sort((a, b) => m[b].at - m[a].at).slice(0, cap); // keep most-recent N queries
    const trimmed: Record<string, { d: any; at: number }> = {};
    for (const k of keep) trimmed[k] = m[k];
    window.localStorage.setItem(store, JSON.stringify(trimmed));
  } catch { /* storage full/blocked — caching is best-effort */ }
}

export default function Home() {
  const dialog = useAppDialog();
  const router = useRouter();
  const [me, setMe] = useState<MeUser | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const [inspections, setInspections] = useState<InspectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Server-computed metadata for the current query (so filtering/counting/paging
  // scale to 10,000+ inspections instead of being derived from a 500-row window).
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<StatusCounts>({ all: 0, scheduled: 0, in_progress: 0, pending_approval: 0, completed: 0 });
  const [facets, setFacets] = useState<{ inspectors: string[]; templates: string[] }>({ inspectors: [], templates: [] });

  // Restore the list view (filters/sort/search/paging) from the last time the
  // user was on this page, so backing out of an inspection lands them exactly
  // where they left off. Persisted to sessionStorage (per browsing session).
  const savedView = useMemo<Record<string, any>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(window.sessionStorage.getItem('resiwalk_home_view_v1') || '{}') || {}; }
    catch { return {}; }
  }, []);

  const [search, setSearch] = useState<string>(savedView.search ?? '');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(savedView.statusFilter ?? 'all');
  // Sort field + direction. Default: most-recently-updated first.
  const [sortField, setSortField] = useState<'updated' | 'scheduled'>(savedView.sortField ?? 'updated');
  // 'desc' = newest first (default), 'asc' = oldest first.
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>(savedView.sortDir ?? 'desc');
  // Filter by inspector name(s). Empty = no filter; multi-select supported.
  // Values are exact inspector_name strings the server matches on.
  const [inspectorFilter, setInspectorFilter] = useState<string[]>(
    () => (Array.isArray(savedView.inspectorFilter) ? savedView.inspectorFilter : []));
  // Filter by template internal name(s). Empty = no filter; multi-select supported.
  const [templateFilter, setTemplateFilter] = useState<string[]>(
    () => (Array.isArray(savedView.templateFilter) ? savedView.templateFilter : []));

  // Bulk-select mode + selection set + busy flag for the cancel action.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cancelBusy, setCancelBusy] = useState(false);

  // Pagination — show a page of cards at a time so the initial render stays
  // snappy even with hundreds of inspections. Default 20 per page; user can
  // bump to 50 / 100 and page forward/back.
  const [pageSize, setPageSize] = useState<number>(savedView.pageSize ?? 20);
  const [page, setPage] = useState<number>(savedView.page ?? 1);

  // Persist the view state on every change so it's restored on return.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem('resiwalk_home_view_v1', JSON.stringify({
        search, statusFilter, sortField, sortDir, inspectorFilter, templateFilter, pageSize, page,
      }));
    } catch { /* storage disabled — view just won't persist */ }
  }, [search, statusFilter, sortField, sortDir, inspectorFilter, templateFilter, pageSize, page]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => { if (data.authenticated) { setMe(data.user); setIsAdmin(!!data.isAdmin); } })
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

  // Pre-warm the AI assistants from the HOME screen — the first authenticated
  // page after login — so the heavy cold-start work (catalog embeddings, the
  // Voyage query path, and priming Anthropic's TLS + server-side prompt cache)
  // is already done by the time the inspector opens ANY inspection and taps the
  // mic or the AI camera. Previously this only kicked off once an inspection
  // loaded, so the very first AI interaction paid the full cold-start tax.
  // Fire-and-forget, online only; the per-inspection warm-ups remain as a
  // backstop in case the inspector lingers here past the cache TTL.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    // Stagger slightly so it doesn't contend with the initial inspections fetch
    // + catalog warm above for the first paint's bandwidth. warmAi() records the
    // session-level warm flag so the mic / AI-camera buttons enable INSTANTLY on
    // inspection open (no redundant warm-up round-trip there).
    const t = setTimeout(() => { void warmAi(); }, 400);
    return () => clearTimeout(t);
  }, []);

  // The list query for the current filter/sort/paging state. Facets (dropdown
  // options) are fetched SEPARATELY (facets=0 here) so the multi-page facet scan
  // never holds up the cards on a slow connection.
  const buildListParams = useCallback((opts?: { refresh?: boolean }) => {
    const p = new URLSearchParams();
    const term = search.trim();
    if (term) p.set('search', term);
    if (statusFilter !== 'all') p.set('status', statusFilter);
    for (const name of inspectorFilter) p.append('inspector', name);
    for (const t of templateFilter) p.append('template', t);
    p.set('sort', sortField);
    p.set('dir', sortDir);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    p.set('facets', '0');
    if (opts?.refresh) p.set('refresh', '1');
    return p;
  }, [search, statusFilter, inspectorFilter, templateFilter, sortField, sortDir, page, pageSize]);

  // Cache key = the query WITHOUT the volatile refresh flag.
  const listCacheKey = useMemo(() => buildListParams().toString(), [buildListParams]);

  const applyListData = useCallback((d: any) => {
    setInspections(d.inspections || []);
    setTotal(typeof d.total === 'number' ? d.total : (d.inspections || []).length);
    if (d.counts) setCounts(d.counts);
  }, []);

  // Revalidate the list+counts from the network and refresh the cache. On a
  // failure we KEEP whatever is on screen (the cached list) rather than blanking
  // it — only surface an error when there is nothing cached to show.
  const load = useCallback(async (opts?: { refresh?: boolean }) => {
    try {
      const r = await fetch(`/api/inspections?${buildListParams(opts).toString()}`, { cache: 'no-store' });
      const data = await r.json();
      if (data.error) {
        if (!lsRead(RESULTS_CACHE)[listCacheKey]) setError(data.error);
      } else {
        applyListData(data);
        lsWrite(RESULTS_CACHE, listCacheKey, { inspections: data.inspections || [], total: data.total, counts: data.counts });
        setError(null);
      }
    } catch (e: any) {
      if (!lsRead(RESULTS_CACHE)[listCacheKey]) setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [buildListParams, listCacheKey, applyListData]);

  // On any query change: paint cached results INSTANTLY (stale-while-revalidate),
  // then revalidate from the network (debounced). On a slow connection the last
  // list shows immediately instead of a blank screen; on first-ever load (no
  // cache) we fetch right away.
  useEffect(() => {
    const cached = lsRead(RESULTS_CACHE)[listCacheKey];
    if (cached?.d) { applyListData(cached.d); setLoading(false); } else { setLoading(true); }
    const t = setTimeout(() => { void load(); }, cached ? 300 : 0);
    return () => clearTimeout(t);
  }, [listCacheKey, load, applyListData]);

  // Honor the "just_*" query hint (fresh create) with a delayed re-fetch, since
  // HubSpot's search index can lag a beat behind a brand-new record.
  useEffect(() => {
    const url = typeof window !== 'undefined' ? window.location.search : '';
    if (!url.includes('just_')) return;
    const t = setTimeout(() => { void load({ refresh: true }); }, 1800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when the user returns to this tab (app switching, alt-tab). Goes
  // through the cache + server single-flight (NOT a forced refresh).
  useEffect(() => {
    function onFocus() { void load(); }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Filter dropdown options (facets) load SEPARATELY and never block the cards.
  // They're constrained by the other active filters, so the key tracks those.
  // Cached + stale-while-revalidate like the list, and fired slightly after it.
  const facetQuery = useMemo(() => {
    const p = new URLSearchParams();
    const term = search.trim();
    if (term) p.set('search', term);
    if (statusFilter !== 'all') p.set('status', statusFilter);
    for (const name of inspectorFilter) p.append('inspector', name);
    for (const t of templateFilter) p.append('template', t);
    p.set('only', 'facets');
    return p.toString();
  }, [search, statusFilter, inspectorFilter, templateFilter]);

  useEffect(() => {
    const cached = lsRead(FACETS_CACHE)[facetQuery];
    if (cached?.d) setFacets(cached.d);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/inspections?${facetQuery}`, { cache: 'no-store' });
        const d = await r.json();
        if (d?.facets) { setFacets(d.facets); lsWrite(FACETS_CACHE, facetQuery, d.facets); }
      } catch { /* keep cached options */ }
    }, 350);
    return () => clearTimeout(t);
  }, [facetQuery]);

  async function handleLogout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    router.replace('/login');
  }

  // Filtering, sorting, search, and the status counts are all evaluated
  // server-side now (see /api/inspections). The browser just renders the page
  // of results the server returned — `inspections` IS the current page.

  // Snap back to page 1 whenever the result set's shape changes (new filter,
  // search, sort, or page size) so the user isn't stranded past the last page.
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, inspectorFilter, templateFilter, sortField, sortDir, pageSize]);

  // Page math derives from the server's total match count for this query.
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const anyFilterActive = !!search.trim()
    || statusFilter !== 'all' || inspectorFilter.length > 0 || templateFilter.length > 0;

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
    () => inspections.filter(isSelectable),
    [inspections]
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
      await load({ refresh: true });
      setTimeout(() => { void load({ refresh: true }); }, 1200);
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

  // Inspector + template dropdown options come from the server-computed facets
  // (active users and the known template set) so they're complete regardless of
  // which page is loaded. The inspector filter value is the exact inspector_name
  // the server matches on (EQ), so value === label here.
  const inspectorOptions = useMemo(
    () => facets.inspectors.map((name) => ({ value: name, label: name })),
    [facets.inspectors]
  );
  const templateOptions = useMemo(
    () => facets.templates
      .map((value) => ({ value, label: templateLabel(value) || value }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [facets.templates]
  );

  // Trigger summaries for the multi-select dropdowns.
  const inspectorTriggerLabel = inspectorFilter.length === 0
    ? 'All Inspectors'
    : inspectorFilter.length === 1 ? inspectorFilter[0] : `${inspectorFilter.length} inspectors`;
  const templateTriggerLabel = templateFilter.length === 0
    ? 'All Templates'
    : templateFilter.length === 1 ? (templateLabel(templateFilter[0]) || templateFilter[0]) : `${templateFilter.length} templates`;


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

            {/* Admin tools — visible to app admins (dynamic list, see /admin/admins). */}
            {isAdmin && (
              <>
                <Link
                  href="/ai-knowledge"
                  className="mt-2 flex items-center gap-2 text-white/90 hover:text-white text-sm font-heading font-semibold"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>
                  AI Knowledge Base
                </Link>
                <Link
                  href="/admin/forms"
                  className="mt-2 flex items-center gap-2 text-white/90 hover:text-white text-sm font-heading font-semibold"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></svg>
                  Form Builder
                </Link>
                <Link
                  href="/admin/admins"
                  className="mt-2 flex items-center gap-2 text-white/90 hover:text-white text-sm font-heading font-semibold"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                  Admins
                </Link>
              </>
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
              <FilterChip className="flex-1" label={`Scheduled (${counts.scheduled})`} active={statusFilter === 'scheduled'} onClick={() => setStatusFilter(statusFilter === 'scheduled' ? 'all' : 'scheduled')} />
              <FilterChip className="flex-1" label={`In Progress (${counts.in_progress})`} active={statusFilter === 'in_progress'} onClick={() => setStatusFilter(statusFilter === 'in_progress' ? 'all' : 'in_progress')} />
            </div>
            <div className="flex gap-1.5">
              <FilterChip className="flex-1" label={`Pending Approval (${counts.pending_approval})`} active={statusFilter === 'pending_approval'} onClick={() => setStatusFilter(statusFilter === 'pending_approval' ? 'all' : 'pending_approval')} />
              <FilterChip className="flex-1" label={`Completed (${counts.completed})`} active={statusFilter === 'completed'} onClick={() => setStatusFilter(statusFilter === 'completed' ? 'all' : 'completed')} />
            </div>
          </div>

          {/* Filter controls: inspector | template | date sort — all on one row.
              The dropdowns shrink (truncating) so Updated + sort fit to their
              right without wrapping or horizontal-scrolling on mobile. */}
          <div className="flex items-center gap-2 mb-2 pb-1">
            {/* Inspector filter — tap to filter by one, press & hold for multi-select */}
            <div className="flex-1 min-w-0 max-w-[160px]">
              <ListPicker
                value={inspectorFilter[0] ?? 'all'}
                options={[{ value: 'all', label: 'All Inspectors' }, ...inspectorOptions]}
                onChange={() => { /* multi-mode uses onApply */ }}
                multiple
                selectedValues={inspectorFilter}
                onApply={setInspectorFilter}
                triggerLabel={inspectorTriggerLabel}
                ariaLabel="Filter by inspector"
                className={`w-full truncate text-xs font-heading font-semibold pl-2.5 pr-2 py-1.5 border rounded-md bg-white flex items-center justify-between ${
                  inspectorFilter.length > 0 ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'
                }`}
              />
            </div>

            {/* Template filter — tap to filter by one, press & hold for multi-select */}
            <div className="flex-1 min-w-0 max-w-[160px]">
              <ListPicker
                value={templateFilter[0] ?? 'all'}
                options={[{ value: 'all', label: 'All Templates' }, ...templateOptions]}
                onChange={() => { /* multi-mode uses onApply */ }}
                multiple
                selectedValues={templateFilter}
                onApply={setTemplateFilter}
                triggerLabel={templateTriggerLabel}
                ariaLabel="Filter by template"
                className={`w-full truncate text-xs font-heading font-semibold pl-2.5 pr-2 py-1.5 border rounded-md bg-white flex items-center justify-between ${
                  templateFilter.length > 0 ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'
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
            {(inspectorFilter.length > 0 || templateFilter.length > 0) && (
              <button
                type="button"
                onClick={() => { setInspectorFilter([]); setTemplateFilter([]); }}
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
                : total === 0
                ? `0 of ${counts.all} inspection${counts.all === 1 ? '' : 's'}`
                : `Showing ${pageStart + 1}–${Math.min(pageStart + pageSize, total)} of ${total}`}
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
          {!loading && !error && total === 0 && (
            <div className="text-center py-12">
              <div className="text-sm text-gray-500 mb-2">
                {anyFilterActive ? 'No matching inspections.' : 'No inspections yet.'}
              </div>
              {!anyFilterActive && (
                <div className="text-xs text-gray-400">
                  Tap &quot;+ New Inspection&quot; above to get started.
                </div>
              )}
            </div>
          )}
          {inspections.map((i) => (
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
        {!loading && !error && total > 0 && (
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
