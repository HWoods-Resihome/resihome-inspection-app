/**
 * Quality gauges — two half-moon (semicircle) gauges over the filtered snapshot:
 *  - Pass rate (pink #ff0060): pass / (pass+fail) over verdict-bearing rows
 *    (1099/Vacancy/QC).
 *  - On-time ≤24h (aqua #73E3DF): share of completed inspections whose total
 *    turnaround ((approvedAt||completedAt) − scheduledDate) is at most 24h.
 * Both are real (from computeKpis); a metric with no measurable denominator
 * shows "—" with an empty gauge rather than a faked fill.
 */
import { CardFrame } from '../cardChrome';
import { type Kpis, fmtPct } from '@/lib/insightsMetrics';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10" /><polyline points="12 12 16 8" /></svg>
);

// Semicircle geometry: upper half-circle, center (100,100), radius 80.
const R = 80;
const ARC = Math.PI * R;                 // length of the half-circle arc
const ARC_PATH = `M 20 100 A ${R} ${R} 0 0 1 180 100`;

function HalfMoon({ label, rate, color, note }: { label: string; rate: number | null; color: string; note: string }) {
  const has = rate != null;
  const pct = has ? Math.max(0, Math.min(1, rate as number)) : 0;
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-full max-w-[180px]">
        <svg viewBox="0 0 200 116" className="w-full" role="img" aria-label={`${label} ${fmtPct(rate)}`}>
          {/* track */}
          <path d={ARC_PATH} fill="none" stroke="#232329" strokeWidth="16" strokeLinecap="round" />
          {/* value */}
          {has && (
            <path
              d={ARC_PATH} fill="none" stroke={color} strokeWidth="16" strokeLinecap="round"
              strokeDasharray={`${ARC} ${ARC}`} strokeDashoffset={ARC * (1 - pct)}
            />
          )}
          {/* endpoint labels */}
          <text x="20" y="114" textAnchor="middle" className="fill-[#71717a]" fontSize="10">0%</text>
          <text x="180" y="114" textAnchor="middle" className="fill-[#71717a]" fontSize="10">100%</text>
        </svg>
        {/* center value */}
        <div className="absolute inset-x-0 bottom-[14px] flex flex-col items-center">
          <span className="font-heading font-extrabold text-[26px] leading-none" style={{ color: has ? color : '#71717a' }}>
            {fmtPct(rate)}
          </span>
        </div>
      </div>
      <div className="text-[13px] font-heading font-semibold text-[#f4f4f5] mt-1">{label}</div>
      <div className="text-[11px] text-[#71717a] mt-0.5 text-center">{note}</div>
    </div>
  );
}

export function PassRateGauge({ kpis }: { kpis: Kpis }) {
  const pf = kpis.passFail;
  return (
    <CardFrame title="Quality gauges" icon={ICON}>
      <div className="grid grid-cols-2 gap-4">
        <HalfMoon
          label="Pass rate" rate={pf.rate} color="#ff0060"
          note={pf.total ? `${pf.pass} pass · ${pf.fail} fail` : 'No verdicts in filter'}
        />
        <HalfMoon
          label="On-time (≤24h)" rate={kpis.onTimeRate} color="#73E3DF"
          note="Within 24h of scheduled"
        />
      </div>
    </CardFrame>
  );
}
