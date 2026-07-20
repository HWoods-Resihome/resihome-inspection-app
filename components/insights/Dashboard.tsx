/**
 * components/insights/Dashboard.tsx — ResiWalk Insights dashboard (dark).
 *
 * Reads the pre-aggregated snapshot (/api/insights/snapshot) + banked history
 * (/api/insights/history) — NO live HubSpot calls. A FIXED, responsive CSS grid
 * (no drag canvas): a left filter rail + a main column of cards. Filters persist
 * to localStorage (per-device); all metrics come from lib/insightsMetrics
 * against the verified snapshot (no mocked values).
 *
 * Palette: page #0e0e11 · cards #18181c · secondary surface #232329 · borders
 * white/10 · pink #ff0060 emphasis · aqua #73E3DF pass / on-time.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FilterRail } from './FilterRail';
import { KpiTiles } from './cards/KpiTiles';
import { PassFailBars } from './cards/PassFailBars';
import { InspectorRoster } from './cards/InspectorRoster';
import { CompletedTable } from './cards/CompletedTable';
import { TrendChart } from './cards/TrendChart';
import { GrassFails } from './cards/GrassFails';
import { AiOverrides } from './cards/AiOverrides';
import { ScopeCost } from './cards/ScopeCost';
import { ScopeApprovals } from './cards/ScopeApprovals';
import { RateCardLines } from './cards/RateCardLines';
import { CardHost, CardSlot, CARD_CATALOG } from './cardHost';
import { BillingReport } from './BillingReport';
import {
  EMPTY_FILTERS, applyFilters, computeKpis, countActiveFilters, filterOverrides,
  type InsightsFilters,
} from '@/lib/insightsMetrics';
import type { InsightsRow, InsightsDailyRollup, AiOverrideRow } from '@/lib/insightsSnapshot';

const STORE_KEY = 'resiwalk_insights_v1';

interface Persisted { filters?: InsightsFilters; collapsedCards?: string[]; hiddenCards?: string[]; railOpen?: boolean; }

function loadPersisted(): Persisted {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function savePersisted(p: Persisted) {
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* quota/blocked — best-effort */ }
}

/** Responsive 2-up row: stacks on narrow screens, splits on wide (auto-fit). */
function TwoCol({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
      {children}
    </div>
  );
}

export function InsightsDashboard() {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<InsightsRow[]>([]);
  const [aiOverrides, setAiOverrides] = useState<AiOverrideRow[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [history, setHistory] = useState<InsightsDailyRollup[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const persisted = useMemo(loadPersisted, []);
  const [filters, setFilters] = useState<InsightsFilters>(persisted.filters || EMPTY_FILTERS);
  // Filter rail starts COLLAPSED (the user expands it to filter).
  const [railOpen, setRailOpen] = useState<boolean>(persisted.railOpen ?? false);
  // Collapsed cards (body hidden in place; header stays). Reads the legacy
  // `hiddenCards` key so previously-minimized cards migrate to collapsed.
  const [collapsedCards, setCollapsedCards] = useState<Set<string>>(() => new Set(persisted.collapsedCards || persisted.hiddenCards || []));

  const toggleCard = useCallback((id: string) => {
    setCollapsedCards((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);
  const allCollapsed = useMemo(() => CARD_CATALOG.every((c) => collapsedCards.has(c.id)), [collapsedCards]);
  const toggleAllCards = useCallback(() => {
    setCollapsedCards((prev) => {
      const everyCollapsed = CARD_CATALOG.every((c) => prev.has(c.id));
      return everyCollapsed ? new Set() : new Set(CARD_CATALOG.map((c) => c.id));
    });
  }, []);
  const cardHostValue = useMemo(() => ({ collapsed: collapsedCards, toggle: toggleCard }), [collapsedCards, toggleCard]);
  const activeFilters = countActiveFilters(filters);

  useEffect(() => { setMounted(true); }, []);

  const fetchData = useCallback(async () => {
    const [sRes, hRes] = await Promise.all([
      fetch('/api/insights/snapshot', { cache: 'no-store' }),
      fetch('/api/insights/history', { cache: 'no-store' }),
    ]);
    if (!sRes.ok) throw new Error(`snapshot ${sRes.status}`);
    const sJson = await sRes.json();
    const snap = sJson.snapshot;
    setRows(snap?.rows || []);
    setAiOverrides(snap?.aiOverrides || []);
    setAsOf(snap?.asOf || null);
    setTruncated(!!snap?.truncated);
    if (hRes.ok) { const h = await hRes.json(); setHistory(h.history || []); }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { await fetchData(); } catch (e: any) { if (!cancelled) setError(String(e?.message || e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [fetchData]);

  // Persist filters + view prefs (collapsed cards, rail open) whenever they change.
  useEffect(() => {
    savePersisted({ filters, collapsedCards: Array.from(collapsedCards), railOpen });
  }, [filters, collapsedCards, railOpen]);

  const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const filteredOverrides = useMemo(() => filterOverrides(aiOverrides, filters), [aiOverrides, filters]);
  const kpis = useMemo(() => computeKpis(filtered), [filtered]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetch('/api/insights/rebuild', { method: 'POST' });
      await fetchData();
    } catch { /* keep showing the last snapshot */ }
    finally { setRefreshing(false); }
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 items-start">
      {/* Left column: collapsible filter rail */}
      <div className="w-full lg:w-[200px] shrink-0 flex flex-col gap-3">
        {railOpen ? (
          <FilterRail
            rows={rows}
            filters={filters}
            onChange={setFilters}
            onReset={() => setFilters(EMPTY_FILTERS)}
            onCollapse={() => setRailOpen(false)}
          />
        ) : (
          <button
            type="button" onClick={() => setRailOpen(true)}
            className="w-full flex items-center justify-between gap-2 bg-[#18181c] rounded-xl border border-white/10 px-3.5 py-2.5 text-left hover:border-white/20"
          >
            <span className="flex items-center gap-2 font-heading font-bold text-[13px] text-[#f4f4f5]">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
              Filters{activeFilters ? <span className="text-[#ff0060]"> · {activeFilters}</span> : null}
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#71717a]"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        )}

      </div>

      {/* Main column */}
      <div className="flex-1 min-w-0 w-full">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="text-xs text-[#a1a1aa]">
            Updated every 30 min{asOf ? ` · as of ${new Date(asOf).toLocaleString()}` : ''}
          </div>
          <div className="flex items-center gap-3">
            {/* Collapse / expand ALL cards at once. */}
            <button type="button" onClick={toggleAllCards}
              title={allCollapsed ? 'Expand all cards' : 'Collapse all cards'}
              className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-[#a1a1aa] hover:text-[#f4f4f5] transition-colors">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${allCollapsed ? 'rotate-180' : ''}`}><polyline points="18 15 12 9 6 15" /></svg>
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
            <button type="button" onClick={refresh} disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-xs font-heading font-semibold text-white bg-[#ff0060] hover:bg-[#cc004d] disabled:opacity-50 rounded-lg px-3 py-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={refreshing ? 'animate-spin' : ''}><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {truncated && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-[#ff0060]/10 border border-[#ff0060]/40 text-sm text-[#ff0060] font-heading font-semibold">
            Snapshot truncated — counts may be incomplete. Notify ops to enable date-windowed aggregation.
          </div>
        )}

        {loading || !mounted ? (
          <div className="text-center py-24"><div className="inline-block w-9 h-9 border-4 border-[#ff0060] border-t-transparent rounded-full animate-spin" /></div>
        ) : error ? (
          <div className="px-3 py-2 rounded-lg bg-[#ff0060]/10 border border-[#ff0060]/40 text-sm text-[#ff0060]">Could not load Insights data: {error}</div>
        ) : (
          <CardHost value={cardHostValue}>
          <div className="flex flex-col gap-4">
            {/* (0) Billing export/report — filterable table + Excel + scheduling. */}
            <BillingReport object="inspections" />
            {/* (1) Compact KPI tiles (always shown — the at-a-glance headline) */}
            <KpiTiles kpis={kpis} />

            {/* (2) Pass/fail bars */}
            <TwoCol>
              <CardSlot id="passfail"><PassFailBars rows={filtered} /></CardSlot>
            </TwoCol>

            {/* (3) Inspector performance */}
            <CardSlot id="roster"><InspectorRoster rows={filtered} /></CardSlot>

            {/* (3b) Scope Rate Card cost + approvals */}
            <TwoCol>
              <CardSlot id="scope-cost"><ScopeCost rows={filtered} /></CardSlot>
              <CardSlot id="scope-approvals"><ScopeApprovals rows={filtered} /></CardSlot>
            </TwoCol>

            {/* (3c) Most-used rate card line items (all-time + last week) */}
            <CardSlot id="ratecard-lines"><RateCardLines rows={filtered} /></CardSlot>

            {/* (4) Completion-time trend + by-region table */}
            <CardSlot id="trend"><TrendChart history={history} rows={filtered} /></CardSlot>

            {/* (5) AI overrides — by account or category (toggle) */}
            <CardSlot id="overrides-ai"><AiOverrides overrides={filteredOverrides} /></CardSlot>

            {/* (5b) 1099 grass-condition fails */}
            <CardSlot id="grass"><GrassFails rows={filtered} /></CardSlot>

            {/* (6) Completed inspections (with CSV export) — last section */}
            <CardSlot id="completed"><CompletedTable rows={filtered} /></CardSlot>
          </div>
          </CardHost>
        )}
      </div>
    </div>
  );
}
