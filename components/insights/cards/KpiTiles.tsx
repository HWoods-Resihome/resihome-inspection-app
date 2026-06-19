/**
 * KPI tiles card: Inspections Completed · Pass Rate % · Avg Completion Time ·
 * # Incomplete. Each tile is a big number; if >=2 days of history exist it adds
 * a sparkline + "vs previous period" delta, ELSE shows a small "collecting
 * history" hint (NEVER a faked sparkline).
 *
 * Brand: the headline numbers use text-brand (pink) for KPI emphasis.
 */
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { CardFrame } from '../cardChrome';
import {
  type Kpis, type Delta, fmtDuration, fmtPct, fmtNumber,
  periodDelta, sparkValues, rollupPassRate,
} from '@/lib/insightsMetrics';
import type { InsightsDailyRollup } from '@/lib/insightsSnapshot';

type TileKind = 'completed' | 'passRate' | 'avgCompletion' | 'incomplete';

const TILE_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
);

function Sparkline({ values }: { values: number[] }) {
  const data = values.map((v, i) => ({ i, v }));
  return (
    <div className="h-9 w-full mt-1">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Line type="monotone" dataKey="v" stroke="#ff0060" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function DeltaBadge({ delta, invert }: { delta: Delta; invert?: boolean }) {
  // invert: for metrics where DOWN is good (e.g. completion time, incomplete).
  const up = delta.diff > 0;
  const flat = delta.diff === 0;
  const good = flat ? null : invert ? !up : up;
  const color = good == null ? 'text-gray-400' : good ? 'text-emerald-600' : 'text-rose-600';
  const arrow = flat ? '→' : up ? '↑' : '↓';
  const pct = delta.pct == null ? '' : ` ${Math.abs(delta.pct * 100).toFixed(0)}%`;
  return (
    <span className={`text-[11px] font-heading font-semibold ${color}`} title="vs previous period">
      {arrow}{pct} vs prev
    </span>
  );
}

function Tile({
  label, value, spark, delta, invert,
}: {
  label: string; value: string; spark: number[]; delta: Delta | null; invert?: boolean;
}) {
  const haveHistory = spark.length >= 2;
  return (
    <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3 flex flex-col">
      <div className="text-[11px] font-heading font-semibold uppercase tracking-wide text-gray-500 truncate">{label}</div>
      <div className="font-heading font-extrabold text-2xl text-brand leading-tight mt-0.5">{value}</div>
      {haveHistory ? (
        <>
          <Sparkline values={spark} />
          {delta && <DeltaBadge delta={delta} invert={invert} />}
        </>
      ) : (
        <div className="text-[11px] text-gray-400 mt-2">Collecting history…</div>
      )}
    </div>
  );
}

export function KpiTiles({
  kpis, history, onRemove,
}: {
  kpis: Kpis; history: InsightsDailyRollup[]; onRemove?: () => void;
}) {
  // Sparklines/deltas come ONLY from banked history (the snapshot is a single
  // point in time). The filtered KPI value is the headline; history is global.
  const completedSpark = sparkValues(history, (h) => h.completed);
  const passSpark = sparkValues(history, rollupPassRate);
  const turnSpark = sparkValues(history, (h) => h.avgTurnaroundMs);
  const incompleteSpark = sparkValues(history, (h) =>
    (h.byStatus.scheduled || 0) + (h.byStatus.in_progress || 0));

  return (
    <CardFrame title="Key metrics" icon={TILE_ICON} onRemove={onRemove}>
      <div className="grid grid-cols-2 gap-3 h-full">
        <Tile
          label="Inspections Completed" value={fmtNumber(kpis.completed)}
          spark={completedSpark} delta={periodDelta(history, (h) => h.completed)}
        />
        <Tile
          label="Pass Rate" value={fmtPct(kpis.passRate)}
          spark={passSpark} delta={periodDelta(history, rollupPassRate)}
        />
        <Tile
          label="Avg Completion Time" value={fmtDuration(kpis.avgCompletionMs)}
          spark={turnSpark} delta={periodDelta(history, (h) => h.avgTurnaroundMs)} invert
        />
        <Tile
          label="# Incomplete" value={fmtNumber(kpis.incomplete)}
          spark={incompleteSpark}
          delta={periodDelta(history, (h) => (h.byStatus.scheduled || 0) + (h.byStatus.in_progress || 0))}
          invert
        />
      </div>
    </CardFrame>
  );
}
