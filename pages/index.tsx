import Link from 'next/link';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppDialog } from '@/components/AppDialog';
import { useRouter } from 'next/router';
import type { InspectionSummary } from '@/lib/types';
import { InspectionCard } from '@/components/InspectionCard';
import { INSPECTION_NAV_KEY } from '@/components/InspectionPager';
import { ListPicker } from '@/components/ListPicker';
import {
  loadCachedRateCard, saveCachedRateCard,
  loadCachedMe, saveCachedMe,
} from '@/lib/offlineCache';
import { warmAi } from '@/lib/aiWarm';
import { templateLabel } from '@/lib/templateLabels';
import { openOAuthStartNative } from '@/lib/nativeBridge';

interface MeUser { userId: string; email: string; name: string; }

type StatusFilter = 'all' | 'scheduled' | 'in_progress' | 'pending_approval' | 'completed';
type StatusCounts = { all: number; scheduled: number; in_progress: number; pending_approval: number; completed: number };

// The five sortable fields, in dropdown order. Value is what the server's
// ?sort= accepts; label is what the Sort menu shows.
type SortField = 'date' | 'address' | 'inspector' | 'price' | 'property_status';
const SORT_OPTIONS: { value: SortField; label: string }[] = [
  // One combined date sort (last-updated, falling back to scheduled date).
  { value: 'date', label: 'Date' },
  { value: 'address', label: 'Address' },
  { value: 'inspector', label: 'Inspector' },
  { value: 'price', label: 'Client $' },
  { value: 'property_status', label: 'Property Status' },
];

function isCancelledStatus(s?: string): boolean {
  const x = (s || '').trim().toLowerCase();
  return x === 'cancelled' || x === 'canceled';
}
// Which status-chip bucket an inspection counts toward (null = cancelled/other).
function statusBucket(s?: string): keyof Omit<StatusCounts, 'all'> | null {
  const x = (s || '').trim().toLowerCase();
  if (x === 'scheduled') return 'scheduled';
  if (x === 'in progress' || x === 'in-progress' || x === 'in_progress') return 'in_progress';
  if (x === 'pending approval' || x === 'pending-approval' || x === 'pending_approval' || x === 'pendingapproval') return 'pending_approval';
  if (x === 'completed' || x === 'complete' || x === 'submitted') return 'completed';
  return null;
}

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
  // Admin "Settings" dropdown (Knowledge Base / Form Builder / Admins).
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [inspections, setInspections] = useState<InspectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Server-computed metadata for the current query (so filtering/counting/paging
  // scale to 10,000+ inspections instead of being derived from a 500-row window).
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<StatusCounts>({ all: 0, scheduled: 0, in_progress: 0, pending_approval: 0, completed: 0 });
  // Real-time cancel: ids cancelled this session (so a lagging server refetch
  // can't re-show them) + the optimistic counts/total to display until the
  // HubSpot search index catches up.
  const cancelledIdsRef = useRef<Set<string>>(new Set());
  const optimisticCountsRef = useRef<StatusCounts | null>(null);
  const optimisticTotalRef = useRef<number | null>(null);
  const [facets, setFacets] = useState<{ inspectors: string[]; templates: string[]; regions: string[] }>({ inspectors: [], templates: [], regions: [] });

  // Restore the list view (filters/sort/search/paging) from the last time the
  // user was on this page, so backing out of an inspection — OR leaving the app
  // entirely and coming back — lands them exactly where they left off, with all
  // filters and searches intact. Persisted to localStorage (survives the PWA
  // being backgrounded/killed and reopened; also covers plain-browser use).
  const savedView = useMemo<Record<string, any>>(() => {
    if (typeof window === 'undefined') return {};
    try { return JSON.parse(window.localStorage.getItem('resiwalk_home_view_v1') || '{}') || {}; }
    catch { return {}; }
  }, []);

  const [search, setSearch] = useState<string>(savedView.search ?? '');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(savedView.statusFilter ?? 'all');
  // Sort field + direction. Default: the combined Date sort, newest first. The
  // server accepts date | address | inspector | price | property_status (older
  // saved views of 'updated'/'scheduled' fall through to 'date').
  const [sortField, setSortField] = useState<SortField>(
    SORT_OPTIONS.some((o) => o.value === savedView.sortField) ? savedView.sortField : 'date');
  // "Sort" dropdown open state (single control replacing the old field + arrow).
  const [sortOpen, setSortOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  // 'desc' = newest first (default), 'asc' = oldest first.
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>(savedView.sortDir ?? 'desc');
  // Filter by inspector name(s). Empty = no filter; multi-select supported.
  // Values are exact inspector_name strings the server matches on.
  const [inspectorFilter, setInspectorFilter] = useState<string[]>(
    () => (Array.isArray(savedView.inspectorFilter) ? savedView.inspectorFilter : []));
  // Filter by template internal name(s). Empty = no filter; multi-select supported.
  const [templateFilter, setTemplateFilter] = useState<string[]>(
    () => (Array.isArray(savedView.templateFilter) ? savedView.templateFilter : []));
  // Filter by region(s). Empty = no filter; multi-select supported. Values are
  // exact region_snapshot strings the server matches on.
  const [regionFilter, setRegionFilter] = useState<string[]>(
    () => (Array.isArray(savedView.regionFilter) ? savedView.regionFilter : []));

  // Bulk-select mode + selection set + busy flag for the cancel action.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cancelBusy, setCancelBusy] = useState(false);

  // Pagination — show a page of cards at a time so the initial render stays
  // snappy even with hundreds of inspections. Default 20 per page; user can
  // bump to 50 / 100 and page forward/back.
  const [pageSize, setPageSize] = useState<number>(savedView.pageSize ?? 20);
  const [page, setPage] = useState<number>(savedView.page ?? 1);

  // Collapse the whole filter/sort block (status chips + inspector/template/
  // region/sort row) behind one chevron so the card list shows more at once.
  // Defaults to COLLAPSED; the choice persists with the rest of the view.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(savedView.filtersOpen ?? false);

  // Scroll-position restore: on large screens the list scrolls inside the
  // `.frozen-scroll` element; on short/landscape it's the window. We save BOTH
  // and restore BOTH (the inactive one is a harmless no-op) so backing out of an
  // inspection lands the user exactly where they were, not at the top.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollRestoredRef = useRef(false);
  const SCROLL_KEY = 'resiwalk_home_scroll_v1';

  // Persist the view state on every change so it's restored on return.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem('resiwalk_home_view_v1', JSON.stringify({
        search, statusFilter, sortField, sortDir, inspectorFilter, templateFilter, regionFilter, pageSize, page, filtersOpen,
      }));
    } catch { /* storage disabled — view just won't persist */ }
  }, [search, statusFilter, sortField, sortDir, inspectorFilter, templateFilter, regionFilter, pageSize, page, filtersOpen]);

  // Save the current scroll offset (throttled via rAF) on scroll, and right
  // before navigating away (routeChangeStart) so opening an inspection captures
  // the exact spot. Stored per-tab in sessionStorage.
  useEffect(() => {
    const save = () => {
      try {
        const el = scrollRef.current;
        window.sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
          el: el ? el.scrollTop : 0,
          win: window.scrollY || 0,
        }));
      } catch { /* storage disabled — scroll just won't persist */ }
    };
    let raf = 0;
    const onScroll = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; save(); }); };
    const el = scrollRef.current;
    el?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    router.events.on('routeChangeStart', save);
    return () => {
      el?.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
      router.events.off('routeChangeStart', save);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [router.events]);

  // Restore the saved scroll offset ONCE, after the cards have painted (the
  // cached list paints instantly, and InspectionCard has no images so card
  // height is stable — the offset lands accurately).
  useEffect(() => {
    if (scrollRestoredRef.current) return;
    if (loading || inspections.length === 0) return;
    scrollRestoredRef.current = true;
    let saved: { el?: number; win?: number } | null = null;
    try { saved = JSON.parse(window.sessionStorage.getItem(SCROLL_KEY) || 'null'); } catch { /* ignore */ }
    if (!saved) return;
    requestAnimationFrame(() => {
      if (scrollRef.current && saved!.el) scrollRef.current.scrollTop = saved!.el;
      if (saved!.win) window.scrollTo(0, saved!.win);
    });
  }, [loading, inspections.length]);

  useEffect(() => {
    // Hydrate from the last known signed-in user immediately so a dead-zone
    // open doesn't read as "signed out" while /api/auth/me is unreachable.
    const cachedMe = loadCachedMe<{ user: MeUser; isAdmin?: boolean }>();
    if (cachedMe?.user) { setMe(cachedMe.user); setIsAdmin(!!cachedMe.isAdmin); }
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        if (data.authenticated) {
          setMe(data.user); setIsAdmin(!!data.isAdmin);
          saveCachedMe({ user: data.user, isAdmin: !!data.isAdmin });
        }
      })
      .catch(() => { /* offline — keep the cached identity */ });
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

  // NOTE: a home-screen prefetch that warmed each inspection's full detail (+QC
  // data) for offline use was REMOVED — it fired dozens of heavy HubSpot calls
  // per home load and tripped HubSpot's account-wide rate limit (429s that even
  // failed the inspection list). Offline access instead relies on caching an
  // inspection the moment it's opened (see pages/inspection/[id]) — which is the
  // real field flow — without any background call storm.

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
  const buildListParams = useCallback((opts?: { refresh?: boolean; status?: StatusFilter; page?: number }) => {
    const st = opts?.status ?? statusFilter;
    const pg = opts?.page ?? page;
    const p = new URLSearchParams();
    const term = search.trim();
    if (term) p.set('search', term);
    if (st !== 'all') p.set('status', st);
    for (const name of inspectorFilter) p.append('inspector', name);
    for (const t of templateFilter) p.append('template', t);
    for (const r of regionFilter) p.append('region', r);
    p.set('sort', sortField);
    p.set('dir', sortDir);
    p.set('page', String(pg));
    p.set('pageSize', String(pageSize));
    p.set('facets', '0');
    if (opts?.refresh) p.set('refresh', '1');
    return p;
  }, [search, statusFilter, inspectorFilter, templateFilter, regionFilter, sortField, sortDir, page, pageSize]);

  // Cache key = the query WITHOUT the volatile refresh flag.
  const listCacheKey = useMemo(() => buildListParams().toString(), [buildListParams]);

  const applyListData = useCallback((d: any) => {
    const raw: InspectionSummary[] = d.inspections || [];
    const cancelledSet = cancelledIdsRef.current;
    // Defensive: never render a cancelled-status row OR a row we just cancelled
    // this session. HubSpot's search index lags a status write, so a refetch can
    // still return a just-cancelled inspection (its properties already say
    // "Cancelled" — that's the stale-index window) — drop it so it falls off now.
    const filtered = raw.filter((i) => !isCancelledStatus(i.status) && !cancelledSet.has(i.recordId));
    setInspections(filtered);
    // Stash the CURRENT visible order so the inspection page's prev/next pager can
    // step through exactly this filtered/sorted list.
    try { sessionStorage.setItem(INSPECTION_NAV_KEY, JSON.stringify(filtered.map((i) => i.recordId))); } catch { /* non-fatal */ }
    // While a cancel is still working through the index (the server keeps
    // returning a just-cancelled id), keep the optimistic counts/total we set at
    // cancel time. Once the server stops returning them, it has reindexed — adopt
    // its authoritative counts and clear the optimistic state.
    const pendingStillReturned = cancelledSet.size > 0 && raw.some((r) => cancelledSet.has(r.recordId));
    if (cancelledSet.size > 0 && pendingStillReturned) {
      if (optimisticCountsRef.current) setCounts(optimisticCountsRef.current);
      if (optimisticTotalRef.current != null) setTotal(optimisticTotalRef.current);
    } else {
      if (cancelledSet.size > 0) { cancelledSet.clear(); optimisticCountsRef.current = null; optimisticTotalRef.current = null; }
      setTotal(typeof d.total === 'number' ? d.total : raw.length);
      if (d.counts) setCounts(d.counts);
    }
  }, []);

  // Revalidate the list+counts from the network and refresh the cache. On a
  // failure we KEEP whatever is on screen (the cached list) rather than blanking
  // it — only surface an error when there is nothing cached to show. The very
  // first load on a fresh device has no cache, so a transient HubSpot blip (cold
  // serverless instance, rate-limit, or an open circuit breaker) would otherwise
  // greet a brand-new user with a red error. Retry a couple times with backoff
  // before surfacing it, so transient failures self-heal silently.
  const load = useCallback(async (opts?: { refresh?: boolean }) => {
    const hasCache = !!lsRead(RESULTS_CACHE)[listCacheKey];
    const maxAttempts = hasCache ? 1 : 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const r = await fetch(`/api/inspections?${buildListParams(opts).toString()}`, { cache: 'no-store' });
        const data = await r.json();
        if (!data.error) {
          applyListData(data);
          lsWrite(RESULTS_CACHE, listCacheKey, { inspections: data.inspections || [], total: data.total, counts: data.counts });
          setError(null);
          break;
        }
        // Server returned an error payload — retry while attempts remain.
        if (attempt >= maxAttempts) { if (!hasCache) setError(data.error); break; }
      } catch (e: any) {
        if (attempt >= maxAttempts) {
          if (!hasCache) setError('Couldn’t reach the server. Check your connection and try again.');
          break;
        }
      }
      await new Promise((res) => setTimeout(res, 700 * attempt));
    }
    setLoading(false);
  }, [buildListParams, listCacheKey, applyListData]);

  // On any query change: paint cached results INSTANTLY (stale-while-revalidate),
  // then revalidate from the network in the background. Switching status/filters
  // is therefore instant whenever that view is cached (which the prefetch below
  // keeps warm) — no forced refresh, no blank "Loading…", no full HubSpot
  // round-trip blocking the toggle. The cache is busted on mutations
  // (create/cancel) so a stale view can't linger after a real change.
  useEffect(() => {
    const cached = lsRead(RESULTS_CACHE)[listCacheKey];
    if (cached?.d) { applyListData(cached.d); setLoading(false); } else { setLoading(true); }
    // Revalidate quietly behind the cached paint; only the uncached first load
    // fetches immediately (and shows the spinner until it lands).
    const t = setTimeout(() => { void load(); }, cached ? 250 : 0);
    return () => clearTimeout(t);
  }, [listCacheKey, load, applyListData]);

  // NOTE: a background prefetch of the OTHER status views was REMOVED — it fired
  // ~4 extra inspection searches per home load on top of the list + 5 count
  // searches + facet scan, and under real multi-user load (and rapid reloads)
  // that tipped HubSpot's search API into 429 rate-limiting, which made the
  // list, saves, and submit all flaky. Status toggles still feel fast via the
  // client stale-while-revalidate cache + the warm 30s server cache.

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

  // Close the Sort dropdown on an outside click / Escape.
  useEffect(() => {
    if (!sortOpen) return;
    function onDown(e: MouseEvent) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) setSortOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setSortOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [sortOpen]);

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
    for (const r of regionFilter) p.append('region', r);
    p.set('only', 'facets');
    return p.toString();
  }, [search, statusFilter, inspectorFilter, templateFilter, regionFilter]);

  useEffect(() => {
    // Normalize: older cached facets (and any malformed payload) may lack a field
    // (e.g. `regions` after that filter shipped). Always coerce to the full shape
    // so `.map` can never hit undefined and crash the whole page.
    const norm = (f: any) => ({ inspectors: f?.inspectors || [], templates: f?.templates || [], regions: f?.regions || [] });
    const cached = lsRead(FACETS_CACHE)[facetQuery];
    if (cached?.d) setFacets(norm(cached.d));
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/inspections?${facetQuery}`, { cache: 'no-store' });
        const d = await r.json();
        if (d?.facets) { setFacets(norm(d.facets)); lsWrite(FACETS_CACHE, facetQuery, d.facets); }
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
  }, [search, statusFilter, inspectorFilter, templateFilter, regionFilter, sortField, sortDir, pageSize]);

  // Page math derives from the server's total match count for this query.
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const anyFilterActive = !!search.trim()
    || statusFilter !== 'all' || inspectorFilter.length > 0 || templateFilter.length > 0 || regionFilter.length > 0;

  // ---- Bulk-select helpers ----
  // A card is selectable for cancellation unless it's completed — but admins
  // may cancel completed inspections too (server-enforced in bulk-cancel).
  function isSelectable(i: InspectionSummary): boolean {
    if (isAdmin) return true;
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
      // Optimistic, REAL-TIME fall-off: drop the cancelled inspections from the
      // list and decrement the chip counts + total NOW, instead of waiting for
      // HubSpot's search index to reindex (which lags a few seconds and would
      // otherwise keep them visible with stale counts).
      const cancelledIds: string[] = Array.isArray(data.cancelled) ? data.cancelled : ids;
      const removed = inspections.filter((i) => cancelledIds.includes(i.recordId));
      if (cancelledIds.length) {
        const nextCounts: StatusCounts = { ...counts };
        for (const i of removed) {
          nextCounts.all = Math.max(0, nextCounts.all - 1);
          const b = statusBucket(i.status);
          if (b) nextCounts[b] = Math.max(0, nextCounts[b] - 1);
        }
        for (const cid of cancelledIds) cancelledIdsRef.current.add(cid);
        optimisticCountsRef.current = nextCounts;
        optimisticTotalRef.current = Math.max(0, total - removed.length);
        setCounts(nextCounts);
        setTotal((t) => Math.max(0, t - removed.length));
        setInspections((prev) => prev.filter((i) => !cancelledIds.includes(i.recordId)));
      }
      // Reconcile against the server (it serves authoritative counts once the
      // index catches up; until then applyListData keeps the optimistic numbers).
      await load({ refresh: true });
      setTimeout(() => { void load({ refresh: true }); }, 1500);
      setTimeout(() => { void load({ refresh: true }); }, 5000);
      const skips = (data.skipped || []) as Array<{ reason: string }>;
      const skippedCompleted = skips.filter((s) => s.reason === 'completed').length;
      // External (1099) users can only cancel inspections they own; selecting
      // someone else's 1099 returns 'not allowed' so it stays in the list.
      const skippedNotAllowed = skips.filter((s) => s.reason === 'not allowed').length;
      const parts: string[] = [];
      if (skippedCompleted > 0) parts.push(`${skippedCompleted} completed inspection${skippedCompleted === 1 ? ' was' : 's were'} skipped (completed inspections can't be cancelled)`);
      if (skippedNotAllowed > 0) parts.push(`${skippedNotAllowed} ${skippedNotAllowed === 1 ? 'was' : 'were'} skipped (you can only cancel inspections assigned to you)`);
      if (parts.length) {
        void dialog.alert(`${data.cancelled.length} cancelled. ${parts.join('. ')}.`);
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
    () => (facets.inspectors || []).map((name) => ({ value: name, label: name })),
    [facets.inspectors]
  );
  const templateOptions = useMemo(
    () => (facets.templates || [])
      .map((value) => ({ value, label: templateLabel(value) || value }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [facets.templates]
  );
  // Region options come from the server-computed facets (distinct region_snapshot
  // values matching the other active filters). Value === label (server matches EQ).
  const regionOptions = useMemo(
    () => (facets.regions || []).map((value) => ({ value, label: value })),
    [facets.regions]
  );

  // Trigger summaries for the multi-select dropdowns.
  const inspectorTriggerLabel = inspectorFilter.length === 0
    ? 'Inspectors'
    : inspectorFilter.length === 1 ? inspectorFilter[0] : `${inspectorFilter.length} inspectors`;
  const templateTriggerLabel = templateFilter.length === 0
    ? 'Templates'
    : templateFilter.length === 1 ? (templateLabel(templateFilter[0]) || templateFilter[0]) : `${templateFilter.length} templates`;
  const regionTriggerLabel = regionFilter.length === 0
    ? 'Regions'
    : regionFilter.length === 1 ? regionFilter[0] : `${regionFilter.length} regions`;


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
        {/* Pink branded header — ALWAYS pinned to the top so it never scrolls
            away (sticky on phones; on large screens it's a non-scrolling flex
            child of the frozen shell, where sticky is a harmless no-op). This
            header is in NORMAL flow, so the status bar is already cleared by the
            native shell's contentInset (app) or Safari's chrome (browser) — the
            full env(safe-area-inset-top) on top of that just doubled the gap and
            left a big pink band. Cap it to a small buffer so the header pushes to
            the top like Android (0 there); a hair of inset still guards a
            standalone PWA. */}
        <header
          className="bg-brand text-white sticky top-0 z-30 shrink-0"
          style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}
        >
          <div className="lz-head max-w-3xl mx-auto px-4 pt-2 pb-2.5">
            <div className="flex items-center justify-between gap-3 mb-2.5">
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
                    // If the icon ever fails to load (e.g. not yet cached offline
                    // right after a deploy), hide the broken-image glyph rather
                    // than show a torn icon in the header.
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
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
                {/* Settings — a single gear shown to EVERY user. Account actions
                    (Gmail connect/disconnect, Sign Out) live in the popover for
                    all users; the admin tools only render for admins. Keeps the
                    pink header compact (one control instead of a row of links). */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setSettingsOpen((o) => !o)}
                    aria-expanded={settingsOpen}
                    aria-label="Settings"
                    title="Settings"
                    className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-white/90 hover:text-white hover:bg-white/15 transition-colors"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                  </button>
                  {settingsOpen && (
                    <>
                      <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setSettingsOpen(false)} />
                      <div className="absolute right-0 mt-1.5 z-50 w-56 rounded-xl border border-gray-200 bg-white shadow-lg ring-1 ring-black/5 overflow-hidden py-1">
                        {/* Gmail connect/disconnect — only when the server is
                            configured for Gmail (component returns null otherwise). */}
                        <GmailMenuItem email={me?.email} onClose={() => setSettingsOpen(false)} />
                        {/* Admin tools — admins only. */}
                        {isAdmin && (
                          <>
                            <Link href="/insights" onClick={() => setSettingsOpen(false)} className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
                              Insights
                            </Link>
                            <Link href="/ai-knowledge" onClick={() => setSettingsOpen(false)} className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>
                              AI Knowledge Base
                            </Link>
                            <Link href="/admin/forms" onClick={() => setSettingsOpen(false)} className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></svg>
                              Form Builder
                            </Link>
                            <Link href="/admin/admins" onClick={() => setSettingsOpen(false)} className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                              Admins
                            </Link>
                            <Link href="/admin/regenerate-pdfs" onClick={() => setSettingsOpen(false)} className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
                              Regenerate PDFs
                            </Link>
                          </>
                        )}
                        {/* Sign Out — last, divided from the rest. */}
                        <button
                          type="button"
                          onClick={() => { setSettingsOpen(false); void handleLogout(); }}
                          className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors border-t border-gray-100"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
                          Sign Out
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* + New Inspection button */}
            <Link
              href="/inspection/new"
              className="flex items-center gap-3 bg-pink-100 hover:bg-pink-200 rounded-xl px-4 py-2.5 transition active:scale-[0.99] shadow-md"
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
          </div>
        </header>

        {/* Frozen top region (large screens only): search + filters + bulk bar */}
        <div className="frozen-top">
        {/* Search + Filters */}
        <div className="lz-head max-w-3xl mx-auto px-4 pt-4 pb-2">
          {/* Search bar + a chevron toggle that collapses/expands the entire
              filter block below it (status chips + inspector/template/region/
              sort row) in unison, so the list can show more cards at once. */}
          <div className="flex items-center gap-2 mb-3">
            <div className="relative flex-1 min-w-0">
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
                className="focus-brand w-full pl-9 pr-9 py-2.5 text-sm border border-gray-300 rounded-lg bg-white"
              />
              {/* Clear search — right-aligned; wipes the term and returns the full
                  unfiltered list. Only shown when there's something to clear. */}
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  title="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-brand p-0.5"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              )}
            </div>
            {/* Collapse/expand the filter block. A pink dot flags active filters
                while the block is hidden so the user knows the list is filtered. */}
            <button
              type="button"
              onClick={() => setFiltersOpen((o) => !o)}
              aria-expanded={filtersOpen}
              aria-label={filtersOpen ? 'Hide filters' : 'Show filters'}
              title={filtersOpen ? 'Hide filters' : 'Show filters'}
              className="relative shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50 transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
              {!filtersOpen && anyFilterActive && (
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-brand ring-2 ring-white" />
              )}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`ml-0.5 transition-transform ${filtersOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
            </button>
          </div>

          {filtersOpen && (
          <>
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
                className={`w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between ${
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
                className={`w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between ${
                  templateFilter.length > 0 ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'
                }`}
              />
            </div>

            {/* Region filter — tap to filter by one, press & hold for multi-select */}
            <div className="flex-1 min-w-0 max-w-[160px]">
              <ListPicker
                value={regionFilter[0] ?? 'all'}
                options={[{ value: 'all', label: 'All Regions' }, ...regionOptions]}
                onChange={() => { /* multi-mode uses onApply */ }}
                multiple
                selectedValues={regionFilter}
                onApply={setRegionFilter}
                triggerLabel={regionTriggerLabel}
                ariaLabel="Filter by region"
                className={`w-full truncate text-[11px] font-heading font-semibold pl-2 pr-1 py-1.5 border rounded-md bg-white flex items-center justify-between ${
                  regionFilter.length > 0 ? 'border-brand text-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'
                }`}
              />
            </div>

            {/* Sort dropdown — one control for all five fields. Tap to open;
                tap a field to sort by it; tap the ACTIVE field again to flip
                ascending/descending (the arrow next to it shows the direction). */}
            <div className="relative shrink-0" ref={sortMenuRef}>
              <button
                type="button"
                onClick={() => setSortOpen((o) => !o)}
                aria-expanded={sortOpen}
                className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 hover:text-brand px-2.5 py-1.5 border border-gray-300 rounded-md bg-white whitespace-nowrap"
                title="Choose how to sort. Tap the selected field again to reverse the order."
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6" /><line x1="7" y1="12" x2="17" y2="12" /><line x1="10" y1="18" x2="14" y2="18" /></svg>
                <span>Sort</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${sortOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
              </button>
              {sortOpen && (
                <div className="absolute right-0 z-30 mt-1 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                  {SORT_OPTIONS.map((opt) => {
                    const active = sortField === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          // First tap selects the field; tapping the ACTIVE field
                          // again flips the direction.
                          if (active) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
                          else setSortField(opt.value);
                        }}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs font-heading font-semibold text-left ${
                          active ? 'text-brand bg-pink-50' : 'text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        <span>{opt.label}</span>
                        {active && (
                          sortDir === 'desc' ? (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></svg>
                          ) : (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
                          )
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Clear-all link, only shown when any filter is active */}
            {(inspectorFilter.length > 0 || templateFilter.length > 0 || regionFilter.length > 0) && (
              <button
                type="button"
                onClick={() => { setInspectorFilter([]); setTemplateFilter([]); setRegionFilter([]); }}
                className="shrink-0 text-xs text-gray-500 hover:text-brand font-heading underline whitespace-nowrap"
                title="Clear inspector, template, and region filters"
              >
                Clear
              </button>
            )}
          </div>
          </>
          )}

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
        <div className="frozen-scroll" ref={scrollRef}>
        <div className="max-w-3xl mx-auto px-4 pb-12">
          {loading && (
            <div className="text-sm text-gray-500 text-center py-8">Loading inspections...</div>
          )}
          {error && !loading && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-3">
              {error}
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
          <div
            className="frozen-foot bg-white border-t border-gray-200"
            // In normal flow, the home indicator is already cleared by the native
            // shell's contentInset (app) / Safari's chrome (browser), so lz-foot's
            // full env(safe-area-inset-bottom) just doubled it into a big white
            // gap. Cap it to a small buffer (a hair left to guard a standalone PWA).
            style={{ paddingBottom: 'min(env(safe-area-inset-bottom), 0.5rem)' }}
          >
            <div className="max-w-3xl mx-auto px-4 py-1.5 flex items-center justify-between gap-3">
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
 * Settings-menu row showing Gmail connection status. Lets users connect
 * proactively (rather than only being prompted at finalize time) and
 * disconnect. Hidden entirely when the server isn't configured for Gmail
 * (no OAuth client), since there's nothing to connect to.
 */
function GmailMenuItem({ email, onClose }: { email?: string; onClose: () => void }) {
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

  // Envelope icon — matches the gray-400 line-icon style of the admin rows.
  const mailIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></svg>
  );

  if (state.connected) {
    return (
      <button
        type="button"
        onClick={async () => {
          await fetch('/api/auth/gmail/status', { method: 'DELETE' });
          setState((s) => (s ? { ...s, connected: false } : s));
        }}
        title="Gmail connected — click to disconnect"
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
      >
        {mailIcon}
        <span className="flex-1 text-left">Gmail</span>
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
          Connected
        </span>
      </button>
    );
  }

  return (
    <a
      href="/api/auth/gmail/connect"
      title="Connect your Gmail to send inspection emails"
      onClick={async (e) => {
        // In the native (Capacitor) shell the in-webview /api/auth/gmail/connect
        // can't complete: Google blocks OAuth in the webview, and the gmail
        // cookie would land in the system browser's jar (not the webview's). So
        // re-run the Google login in the SYSTEM browser tagged client=native —
        // it forces the Gmail consent (the browser has no gmail cookie) and
        // returns the refresh token to the webview via the resiwalk:// deep link
        // + /api/auth/exchange. No-op in a normal browser (helper returns false),
        // so web keeps using the standard connect flow via the href.
        if (!email) { onClose(); return; } // no email yet → let the href handle it
        e.preventDefault();
        const startUrl = `/api/auth/google-login?email=${encodeURIComponent(email)}&reconnect=1`;
        onClose();
        if (await openOAuthStartNative(startUrl)) return;
        window.location.href = '/api/auth/gmail/connect';
      }}
      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
    >
      {mailIcon}
      <span className="flex-1 text-left">Connect Gmail</span>
    </a>
  );
}
