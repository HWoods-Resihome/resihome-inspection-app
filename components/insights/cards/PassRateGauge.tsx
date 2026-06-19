/**
 * Pass-Rate gauge (recharts radial). Shows pass / (pass+fail) over the filtered,
 * verdict-bearing rows (1099/Vacancy/QC). No on-time gauge: "on time" has no
 * agreed SLA in the data model, so we omit it rather than invent a threshold.
 *
 * Aqua (#73E3DF) fills the gauge (= Pass in the palette); the remainder is grey.
 */
import { RadialBarChart, RadialBar, PolarAngleAxis, ResponsiveContainer } from 'recharts';
import { CardFrame, CardNote } from '../cardChrome';
import { type Kpis, fmtPct } from '@/lib/insightsMetrics';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 1 0 10 10" /><polyline points="12 12 16 8" /></svg>
);

export function PassRateGauge({ kpis, onRemove }: { kpis: Kpis; onRemove?: () => void }) {
  const pf = kpis.passFail;
  const rate = pf.rate; // 0..1 or null
  const pct = rate == null ? 0 : Math.round(rate * 100);
  const data = [{ name: 'pass', value: pct, fill: '#73E3DF' }];

  return (
    <CardFrame title="Pass rate gauge" icon={ICON} onRemove={onRemove}>
      {pf.total === 0 ? (
        <CardNote>No pass/fail verdicts in the current filter.</CardNote>
      ) : (
        <div className="h-full flex flex-col items-center justify-center relative">
          <div className="w-full h-full max-h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                innerRadius="72%" outerRadius="100%" data={data}
                startAngle={90} endAngle={-270}
              >
                <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                <RadialBar background={{ fill: '#eaeaea' }} dataKey="value" cornerRadius={8} angleAxisId={0} isAnimationActive={false} />
              </RadialBarChart>
            </ResponsiveContainer>
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <div className="font-heading font-extrabold text-3xl text-brand leading-none">{fmtPct(rate)}</div>
            <div className="text-[11px] text-gray-500 mt-1">{pf.pass} pass · {pf.fail} fail</div>
          </div>
        </div>
      )}
    </CardFrame>
  );
}
