import Link from 'next/link';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppDialog } from '@/components/AppDialog';
import { useRouter } from 'next/router';
import type { InspectionSummary } from '@/lib/types';
import { InspectionCard } from '@/components/InspectionCard';
import { ListPicker } from '@/components/ListPicker';
import {
  loadCachedRateCard, saveCachedRateCard,
  loadCachedInspection, saveCachedInspection,
  loadCachedQuestions, saveCachedQuestions,
  loadCachedMe, saveCachedMe,
  saveCachedQcData,
} from '@/lib/offlineCache';
import { warmAi } from '@/lib/aiWarm';
import { templateLabel } from '@/lib/templateLabels';

interface MeUser { userId: string; email: string; name: string; }

type StatusFilter = 'all' | 'scheduled' | 'in_progress' | 'pending_approval' | 'completed';
type StatusCounts = { all: number; scheduled: number; in_progress: number; pending_approval: number; completed: number };

// The five sortable fields, in dropdown order. Value is what the server's
// ?sort= accepts; label is what the Sort menu shows.
type SortField = 'updated' | 'scheduled' | 'address' | 'inspector' | 'price';
const SORT_OPTIONS: { value: SortField; label: string }[] = [
  { value: 'updated', label: 'Updated' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'address', label: 'Address' },
  { value: 'inspector', label: 'Inspector' },
  { value: 'price', label: 'Client $' },
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
  // Sort field + direction. Default: most-recently-updated first. The server
  // accepts updated | scheduled | address | inspector | price.
  const [sortField, setSortField] = useState<SortField>(
    SORT_OPTIONS.some((o) => o.value === savedView.sortField) ? savedView.sortField : 'updated');
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

  // Warm the OFFLINE cache for the inspector's own upcoming work, so those
  // inspections open + are fully editable in a dead zone even if they were never
  // tapped while in service. Bounded to this user's actionable (Scheduled /
  // In Progress) inspections on the current page, online only, concurrency 2,
  // skipping anything already cached. Best-effort — never blocks the UI.
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (inspections.length === 0) return;
    // Warm the actionable (Scheduled / In Progress) inspections visible on this
    // page — that's the field work most likely to be opened in a dead zone. Not
    // filtered to the current user (an admin/dispatcher viewing the whole board
    // still gets the day's inspections cached). Bounded + skips already-cached.
    const actionable = inspections.filter((i) => {
      const s = (i.status || '').trim().toLowerCase();
      return s === 'scheduled' || s.includes('progress');
    });
    const todo = actionable.filter((i) => !loadCachedInspection(i.recordId)).slice(0, 15);
    if (todo.length === 0) return;
    let cancelled = false;
    const t = setTimeout(() => {
      let idx = 0;
      const worker = async () => {
        while (!cancelled && idx < todo.length) {
          const insp = todo[idx++];
          try {
            const r = await fetch(`/api/inspections/${insp.recordId}`, { cache: 'no-store' });
            if (r.ok) {
              const d = await r.json();
              if (d && !d.error) {
                saveCachedInspection(insp.recordId, d);
                const tmpl = d.inspection?.templateType;
                if (tmpl && tmpl !== 'pm_scope_rate_card' && tmpl !== 'pm_turn_reinspect_qc' && !loadCachedQuestions(tmpl)) {
                  try {
                    const qr = await fetch(`/api/questions?template=${encodeURIComponent(tmpl)}`, { cache: 'no-store' });
                    const qd = await qr.json();
                    if (qr.ok && Array.isArray(qd.questions)) saveCachedQuestions(tmpl, qd.questions);
                  } catch { /* best-effort */ }
                }
                // Turn Re-Inspect QC: also warm its before/after data so it opens offline.
                if (tmpl === 'pm_turn_reinspect_qc') {
                  try {
                    const qcr = await fetch(`/api/inspections/${insp.recordId}/qc-data`, { cache: 'no-store' });
                    const qcd = await qcr.json();
                    if (qcr.ok && qcd && !qcd.error) saveCachedQcData(insp.recordId, qcd);
                  } catch { /* best-effort */ }
                }
              }
            }
          } catch { /* best-effort */ }
          await new Promise((res) => setTimeout(res, 150)); // gentle on the API
        }
      };
      void Promise.all([worker(), worker()]); // concurrency 2
    }, 1200); // after the list + catalog warm settle
    return () => { cancelled = true; clearTimeout(t); };
  }, [inspections, me]);

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
    p.set('sort', sortField);
    p.set('dir', sortDir);
    p.set('page', String(pg));
    p.set('pageSize', String(pageSize));
    p.set('facets', '0');
    if (opts?.refresh) p.set('refresh', '1');
    return p;
  }, [search, statusFilter, inspectorFilter, templateFilter, sortField, sortDir, page, pageSize]);

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

  // Prefetch the OTHER status views (page 1) into the client cache in the
  // background, so the FIRST tap on any chip — including Completed — paints
  // instantly from cache instead of waiting on the network. Cheap: the status
  // counts are a shared server cache, and each list is one small page. Online
  // only; skips views already cached; re-runs when the non-status filters/sort
  // change (which is what invalidates those cached views).
  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const statuses: StatusFilter[] = ['all', 'scheduled', 'in_progress', 'pending_approval', 'completed'];
    const t = setTimeout(() => {
      for (const st of statuses) {
        if (st === statusFilter) continue; // current view is already loading
        const key = buildListParams({ status: st, page: 1 }).toString();
        if (lsRead(RESULTS_CACHE)[key]) continue; // already warm
        fetch(`/api/inspections?${key}`, { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => { if (d && !d.error) lsWrite(RESULTS_CACHE, key, { inspections: d.inspections || [], total: d.total, counts: d.counts }); })
          .catch(() => { /* prefetch is best-effort */ });
      }
    }, 500); // after the current view paints
    return () => clearTimeout(t);
  }, [buildListParams, statusFilter, search, sortField, sortDir, pageSize, inspectorFilter, templateFilter]);

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
          <div className="lz-head max-w-3xl mx-auto px-4 pt-4 pb-4">
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

            {/* Admin tools — collapsed under a single "Settings" gear. Visible to
                app admins (dynamic list, see /admin/admins). */}
            {isAdmin && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setSettingsOpen((o) => !o)}
                  aria-expanded={settingsOpen}
                  className="flex items-center gap-2 text-white/90 hover:text-white text-sm font-heading font-semibold"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                  <span>Settings</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${settingsOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
                </button>
                {settingsOpen && (
                  <div className="mt-2 ml-1 pl-3 border-l border-white/25 space-y-2.5">
                    <Link href="/ai-knowledge" className="flex items-center gap-2 text-white/90 hover:text-white text-sm font-heading font-semibold">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z" /><path d="M6 12v5c3 3 9 3 12 0v-5" /></svg>
                      AI Knowledge Base
                    </Link>
                    <Link href="/admin/forms" className="flex items-center gap-2 text-white/90 hover:text-white text-sm font-heading font-semibold">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></svg>
                      Form Builder
                    </Link>
                    <Link href="/admin/admins" className="flex items-center gap-2 text-white/90 hover:text-white text-sm font-heading font-semibold">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
                      Admins
                    </Link>
                  </div>
                )}
              </div>
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
