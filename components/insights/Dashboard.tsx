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
import { CardFrame } from './cardChrome';
import {
  EMPTY_FILTERS, applyFilters, computeKpis,
  type InsightsFilters,
} from '@/lib/insightsMetrics';
import type { InsightsRow, InsightsDailyRollup } from '@/lib/insightsSnapshot';

const STORE_KEY = 'resiwalk_insights_v1';

interface Persisted { filters?: InsightsFilters; }

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

const MAP_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" /><line x1="8" y1="2" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="22" /></svg>
);

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

  // Persist filters whenever they change.
  useEffect(() => { savePersisted({ filters }); }, [filters]);

  const filtered = useMemo(() => applyFilters(rows, filters), [rows, filters]);
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
      {/* Left filter rail */}
      <div className="w-full lg:w-[200px] shrink-0">
        <FilterRail
          rows={rows}
          filters={filters}
          onChange={setFilters}
          onReset={() => setFilters(EMPTY_FILTERS)}
        />
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
          <div className="flex flex-col gap-4">
            {/* (1) Compact KPI tiles */}
            <KpiTiles kpis={kpis} />

            {/* (2) Pass/fail bars + property-status pivot */}
            <TwoCol>
              <PassFailBars rows={filtered} />
              <PropertyStatusPivot rows={filtered} />
            </TwoCol>

            {/* (3) Inspector performance + 1099 grass-condition fails */}
            <TwoCol>
              <InspectorRoster rows={filtered} />
              <GrassFails rows={filtered} />
            </TwoCol>
            <CompletedTable rows={filtered} />

            {/* (4) Completion-time trend + quality gauges */}
            <TwoCol>
              <TrendChart history={history} />
              <PassRateGauge kpis={kpis} />
            </TwoCol>

            {/* (5) AI learning velocity + preference overrides (training signals) */}
            <TwoCol>
              <KbVelocity />
              <PreferenceMismatches />
            </TwoCol>

            {/* (6) AI Knowledge Base changes feed (full width) */}
            <KbChanges />

            {/* (7) Property / inspection map — deferred */}
            <CardFrame title="Property / inspection map" icon={MAP_ICON} subtitle="Phase 4 · deferred">
              <div className="flex items-center justify-center text-center text-sm text-[#71717a] py-10 opacity-70">
                A geographic view of inspections lands in a later phase.
              </div>
            </CardFrame>
          </div>
        )}
      </div>
    </div>
  );
}
