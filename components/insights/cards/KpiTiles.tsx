/**
 * Compact KPI tiles row — small secondary-surface boxes (auto-fit, min 110px):
 * Completed · Pass rate · Avg completion · Incomplete · On-time · Photos.
 * 11px label, 24px number. Pass rate is pink (#ff0060) per the palette; the rest
 * use primary text. No sparklines here (those live in the trend card) — these
 * are the at-a-glance headline numbers from the filtered snapshot.
 */
import {
  type Kpis, fmtDuration, fmtPct, fmtNumber,
} from '@/lib/insightsMetrics';

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-[#232329] rounded-xl border border-white/10 px-3.5 py-3">
      <div className="text-[11px] font-heading font-semibold uppercase tracking-wide text-[#a1a1aa] truncate">{label}</div>
      <div className={`font-heading font-extrabold text-[24px] leading-tight mt-1 ${accent ? 'text-[#ff0060]' : 'text-[#f4f4f5]'}`}>
        {value}
      </div>
    </div>
  );
}

export function KpiTiles({ kpis }: { kpis: Kpis }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
      <Tile label="Completed" value={fmtNumber(kpis.completed)} />
      <Tile label="Pass rate" value={fmtPct(kpis.passRate)} accent />
      <Tile label="Avg completion" value={fmtDuration(kpis.avgCompletionMs)} />
      <Tile label="Incomplete" value={fmtNumber(kpis.incomplete)} />
      <Tile label="On-time (≤24h)" value={fmtPct(kpis.onTimeRate)} />
      <Tile label="Total photos" value={fmtNumber(kpis.totalPhotos)} />
    </div>
  );
}
