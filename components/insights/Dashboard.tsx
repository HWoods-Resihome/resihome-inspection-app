/**
 * components/insights/Dashboard.tsx — ResiWalk Insights dashboard (Phase 2b).
 *
 * Reads the pre-aggregated snapshot (/api/insights/snapshot) + banked history
 * (/api/insights/history) — NO live HubSpot calls. Global filters + a
 * draggable/resizable react-grid-layout canvas; filters + layout + removed cards
 * persist to localStorage (per-device). All metrics come from lib/insightsMetrics
 * against the verified snapshot (no mocked values). Brand #ff0060 / Raleway via
 * the shared CardFrame + cards.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Responsive as RGLResponsive, WidthProvider as RGLWidthProvider } from 'react-grid-layout';
import { FilterRail } from './FilterRail';
import { KpiTiles } from './cards/KpiTiles';
import { PassFailBars } from './cards/PassFailBars';
import { InspectorRoster } from './cards/InspectorRoster';
import { CompletedTable } from './cards/CompletedTable';
import { TrendChart } from './cards/TrendChart';
import { PassRateGauge } from './cards/PassRateGauge';
import { DRAG_HANDLE_CLASS } from './cardChrome';
import {
  EMPTY_FILTERS, applyFilters, computeKpis,
  type InsightsFilters,
} from '@/lib/insightsMetrics';
import type { InsightsRow, InsightsDailyRollup } from '@/lib/insightsSnapshot';

// react-grid-layout ships CommonJS-namespace (export =) types that don't expose
// Responsive/WidthProvider cleanly as members. They exist on the runtime export,
// so access them via an `any` cast and use our own minimal layout types (all we
// need). ResponsiveGrid is the WidthProvider-wrapped Responsive grid.
interface RGLItem { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number; }
type RGLLayout = RGLItem[];
type RGLLayouts = { [breakpoint: string]: RGLLayout };
const ResponsiveGrid: any = (RGLWidthProvider as any)(RGLResponsive as any);
const STORE_KEY = 'resiwalk_insights_v1';

type CardId = 'kpis' | 'passfail' | 'gauge' | 'roster' | 'trend' | 'completed';
const ALL_CARDS: CardId[] = ['kpis', 'passfail', 'gauge', 'roster', 'trend', 'completed'];

// Default lg layout (12-col). Other breakpoints reflow from this.
const DEFAULT_LG: RGLLayout = [
  { i: 'kpis',      x: 0, y: 0,  w: 12, h: 2, minW: 4, minH: 2 },
  { i: 'passfail',  x: 0, y: 2,  w: 7,  h: 5, minW: 4, minH: 3 },
  { i: 'gauge',     x: 7, y: 2,  w: 5,  h: 5, minW: 3, minH: 3 },
  { i: 'roster',    x: 0, y: 7,  w: 7,  h: 6, minW: 4, minH: 4 },
  { i: 'trend',     x: 7, y: 7,  w: 5,  h: 6, minW: 3, minH: 4 },
  { i: 'completed', x: 0, y: 13, w: 12, h: 7, minW: 5, minH: 4 },
];
const CARD_TITLES: Record<CardId, string> = {
  kpis: 'KPIs', passfail: 'Pass / Fail', gauge: 'Pass Rate', roster: 'Inspector Performance',
  trend: 'Trends', completed: 'Completed Inspections',
};

interface Persisted { filters?: InsightsFilters; layouts?: RGLLayouts; removed?: CardId[]; }

function loadPersisted(): Persisted {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}
function savePersisted(p: Persisted) {
  try { window.localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* quota/blocked — best-effort */ }
}

export function InsightsDashboard() {
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<InsightsRow[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [history, setHistory] = useState<InsightsDailyRollup[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const persisted = useMemo(loadPersisted, []);
  const [filters, setFilters] = useState<InsightsFilters>(persisted.filters || EMPTY_FILTERS);
  const [layouts, setLayouts] = useState<RGLLayouts>(persisted.layouts || { lg: DEFAULT_LG });
  const [removed, setRemoved] = useState<CardId[]>(persisted.removed || []);

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

  // Persist filters/layout/removed whenever they change.
  useEffect(() => { savePersisted({ filters, layouts, removed }); }, [filters, layouts, removed]);

  const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const kpis = useMemo(() => computeKpis(filtered), [filtered]);

  const removeCard = (id: CardId) => setRemoved((r) => (r.includes(id) ? r : [...r, id]));
  const resetLayout = () => { setLayouts({ lg: DEFAULT_LG }); setRemoved([]); };
  const visible = ALL_CARDS.filter((c) => !removed.includes(c));

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetch('/api/insights/rebuild', { method: 'POST' });
      await fetchData();
    } catch { /* keep showing the last snapshot */ }
    finally { setRefreshing(false); }
  }

  const renderCard = (id: CardId) => {
    const onRemove = () => removeCard(id);
    switch (id) {
      case 'kpis':      return <KpiTiles kpis={kpis} history={history} onRemove={onRemove} />;
      case 'passfail':  return <PassFailBars rows={filtered} onRemove={onRemove} />;
      case 'gauge':     return <PassRateGauge kpis={kpis} onRemove={onRemove} />;
      case 'roster':    return <InspectorRoster rows={filtered} onRemove={onRemove} />;
      case 'trend':     return <TrendChart history={history} onRemove={onRemove} />;
      case 'completed': return <CompletedTable rows={filtered} onRemove={onRemove} />;
    }
  };

  return (
    <div className="flex gap-5 items-start">
      {/* Left filter rail */}
      <div className="w-64 shrink-0 sticky top-4">
        <FilterRail
          rows={rows}
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters(EMPTY_FILTERS)}
        />
      </div>

      {/* Main canvas */}
      <div className="flex-1 min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="text-xs text-gray-500">
            Updated every 30 min{asOf ? ` · as of ${new Date(asOf).toLocaleString()}` : ''}
          </div>
          <div className="flex items-center gap-2">
            {removed.length > 0 && (
              <button type="button" onClick={resetLayout}
                className="text-xs font-heading font-semibold text-gray-600 hover:text-ink border border-gray-200 rounded-lg px-3 py-1.5 bg-white">
                Reset layout
              </button>
            )}
            <button type="button" onClick={refresh} disabled={refreshing}
              className="inline-flex items-center gap-1.5 text-xs font-heading font-semibold text-white bg-brand hover:bg-brand-dark disabled:bg-gray-300 rounded-lg px-3 py-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={refreshing ? 'animate-spin' : ''}><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {truncated && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800 font-heading font-semibold">
            Snapshot truncated — counts may be incomplete. Notify ops to enable date-windowed aggregation.
          </div>
        )}

        {loading ? (
          <div className="text-center py-24"><div className="inline-block w-9 h-9 border-4 border-brand border-t-transparent rounded-full animate-spin" /></div>
        ) : error ? (
          <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">Could not load Insights data: {error}</div>
        ) : !mounted ? null : visible.length === 0 ? (
          <div className="text-center py-24 text-sm text-gray-400">
            All cards removed. <button type="button" onClick={resetLayout} className="text-brand underline">Reset layout</button>
          </div>
        ) : (
          <ResponsiveGrid
            className="layout"
            layouts={layouts}
            breakpoints={{ lg: 1100, md: 800, sm: 0 }}
            cols={{ lg: 12, md: 8, sm: 4 }}
            rowHeight={64}
            margin={[16, 16]}
            draggableHandle={`.${DRAG_HANDLE_CLASS}`}
            onLayoutChange={(_cur: RGLLayout, all: RGLLayouts) => setLayouts(all)}
          >
            {visible.map((id) => (
              <div key={id} data-grid={DEFAULT_LG.find((l) => l.i === id)} title={CARD_TITLES[id]}>
                {renderCard(id)}
              </div>
            ))}
          </ResponsiveGrid>
        )}
      </div>
    </div>
  );
}
