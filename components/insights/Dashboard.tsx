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
import { PassRateGauge } from './cards/PassRateGauge';
import { PropertyStatusPivot } from './cards/PropertyStatusPivot';
import { GrassFails } from './cards/GrassFails';
import { KbChanges } from './cards/KbChanges';
import { KbVelocity } from './cards/KbVelocity';
import { PreferenceMismatches } from './cards/PreferenceMismatches';
import { AiOverridesByInspector } from './cards/AiOverridesByInspector';
import { AiOverridesByCategory } from './cards/AiOverridesByCategory';
import { ScopeCost } from './cards/ScopeCost';
import { ScopeApprovals } from './cards/ScopeApprovals';
import { PropertyMap } from './cards/PropertyMap';
import { CardHost, CardSlot, CARD_CATALOG } from './cardHost';
import {
  EMPTY_FILTERS, applyFilters, computeKpis, countActiveFilters, filterOverrides,
  type InsightsFilters,
} from '@/lib/insightsMetrics';
import type { InsightsRow, InsightsDailyRollup, AiOverrideRow } from '@/lib/insightsSnapshot';

const STORE_KEY = 'resiwalk_insights_v1';

interface Persisted { filters?: InsightsFilters; hiddenCards?: string[]; railOpen?: boolean; }

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
  // Minimized cards (hidden from the canvas; restored from the dropdown below filters).
  const [hiddenCards, setHiddenCards] = useState<Set<string>>(() => new Set(persisted.hiddenCards || []));
  const [restoreOpen, setRestoreOpen] = useState(false);

  const minimizeCard = useCallback((id: string) => {
    setHiddenCards((prev) => { const n = new Set(prev); n.add(id); return n; });
  }, []);
  const restoreCard = useCallback((id: string) => {
    setHiddenCards((prev) => { const n = new Set(prev); n.delete(id); return n; });
  }, []);
  const cardHostValue = useMemo(() => ({ hidden: hiddenCards, minimize: minimizeCard }), [hiddenCards, minimizeCard]);
  const hiddenList = useMemo(() => CARD_CATALOG.filter((c) => hiddenCards.has(c.id)), [hiddenCards]);
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

  // Persist filters + view prefs (hidden cards, rail open) whenever they change.
  useEffect(() => {
    savePersisted({ filters, hiddenCards: Array.from(hiddenCards), railOpen });
  }, [filters, hiddenCards, railOpen]);

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
      {/* Left column: collapsible filter rail + minimized-cards restore dropdown */}
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

        {hiddenList.length > 0 && (
          <div className="bg-[#18181c] rounded-xl border border-white/10 overflow-hidden">
            <button
              type="button" onClick={() => setRestoreOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-left hover:bg-white/[0.03]"
            >
              <span className="font-heading font-bold text-[11px] uppercase tracking-wide text-[#a1a1aa]">
                Minimized<span className="text-[#ff0060] ml-1">· {hiddenList.length}</span>
              </span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`text-[#71717a] transition-transform ${restoreOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            {restoreOpen && (
              <div className="px-2 pb-2 flex flex-col gap-1">
                {hiddenList.map((c) => (
                  <button
                    key={c.id} type="button" onClick={() => restoreCard(c.id)}
                    className="w-full flex items-center gap-2 text-left text-[13px] text-[#f4f4f5] rounded-lg px-2 py-1.5 hover:bg-white/[0.06]"
                    title={`Restore “${c.title}”`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-[#ff0060] shrink-0"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                    <span className="truncate">{c.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main column */}
      <div className="flex-1 min-w-0 w-full">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="text-xs text-[#a1a1aa]">
            Updated every 30 min{asOf ? ` · as of ${new Date(asOf).toLocaleString()}` : ''}
          </div>
          <button type="button" onClick={refresh} disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-xs font-heading font-semibold text-white bg-[#ff0060] hover:bg-[#cc004d] disabled:opacity-50 rounded-lg px-3 py-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={refreshing ? 'animate-spin' : ''}><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
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
            {/* (1) Compact KPI tiles (always shown — the at-a-glance headline) */}
            <KpiTiles kpis={kpis} />

            {/* (2) Pass/fail bars + property-status pivot */}
            <TwoCol>
              <CardSlot id="passfail"><PassFailBars rows={filtered} /></CardSlot>
              <CardSlot id="propstatus"><PropertyStatusPivot rows={filtered} /></CardSlot>
            </TwoCol>

            {/* (3) Inspector performance + 1099 grass-condition fails */}
            <TwoCol>
              <CardSlot id="roster"><InspectorRoster rows={filtered} /></CardSlot>
              <CardSlot id="grass"><GrassFails rows={filtered} /></CardSlot>
            </TwoCol>
            <CardSlot id="completed"><CompletedTable rows={filtered} /></CardSlot>

            {/* (3b) Scope Rate Card cost + approvals */}
            <TwoCol>
              <CardSlot id="scope-cost"><ScopeCost rows={filtered} /></CardSlot>
              <CardSlot id="scope-approvals"><ScopeApprovals rows={filtered} /></CardSlot>
            </TwoCol>

            {/* (4) Completion-time trend + quality gauges */}
            <TwoCol>
              <CardSlot id="trend"><TrendChart history={history} /></CardSlot>
              <CardSlot id="gauges"><PassRateGauge kpis={kpis} /></CardSlot>
            </TwoCol>

            {/* (5) AI overrides — who overrides most + biggest training opportunities */}
            <TwoCol>
              <CardSlot id="overrides-inspector"><AiOverridesByInspector overrides={filteredOverrides} /></CardSlot>
              <CardSlot id="overrides-category"><AiOverridesByCategory overrides={filteredOverrides} /></CardSlot>
            </TwoCol>

            {/* (6) AI learning velocity + preference overrides (training signals) */}
            <TwoCol>
              <CardSlot id="velocity"><KbVelocity /></CardSlot>
              <CardSlot id="overrides"><PreferenceMismatches events={filteredOverrides} /></CardSlot>
            </TwoCol>

            {/* (7) AI Knowledge Base changes feed (full width) */}
            <CardSlot id="kb"><KbChanges /></CardSlot>

            {/* (8) Property / inspection map (full width) */}
            <CardSlot id="map"><PropertyMap rows={filtered} /></CardSlot>
          </div>
          </CardHost>
        )}
      </div>
    </div>
  );
}
