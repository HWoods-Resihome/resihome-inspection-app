/**
 * Quality gauges — two horizontal bars over the filtered snapshot:
 *  - Pass rate (pink #ff0060): pass / (pass+fail) over verdict-bearing rows
 *    (1099/Vacancy/QC).
 *  - On-time ≤24h (aqua #73E3DF): share of completed inspections whose total
 *    turnaround ((approvedAt||completedAt) − scheduledDate) is at most 24h.
 * Both are real (from computeKpis); a metric with no measurable denominator
 * shows "—" rather than a faked bar.
 */
import { CardFrame } from '../cardChrome';
import { type Kpis, fmtPct } from '@/lib/insightsMetrics';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10" /><polyline points="12 12 16 8" /></svg>
);

function Gauge({ label, rate, color, note }: { label: string; rate: number | null; color: string; note: string }) {
  const pct = rate == null ? 0 : Math.round(rate * 100);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[13px] font-heading font-semibold text-[#f4f4f5]">{label}</span>
        <span className="font-heading font-extrabold text-xl" style={{ color }}>{fmtPct(rate)}</span>
      </div>
      <div className="h-2.5 w-full rounded-full bg-[#232329] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="text-[11px] text-[#71717a] mt-1.5">{note}</div>
    </div>
  );
}

export function PassRateGauge({ kpis }: { kpis: Kpis }) {
  const pf = kpis.passFail;
  return (
    <CardFrame title="Quality gauges" icon={ICON}>
      <div className="flex flex-col gap-5">
        <Gauge
          label="Pass rate" rate={pf.rate} color="#ff0060"
          note={pf.total ? `${pf.pass} pass · ${pf.fail} fail` : 'No pass/fail verdicts in the current filter.'}
        />
        {/* On-time = share of completed inspections turned around within 24h. */}
        <Gauge
          label="On-time (≤24h)" rate={kpis.onTimeRate} color="#73E3DF"
          note="Completed within 24h of the scheduled date."
        />
      </div>
    </CardFrame>
  );
}
