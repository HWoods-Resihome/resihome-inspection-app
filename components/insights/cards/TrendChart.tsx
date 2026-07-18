/**
 * Completion-time trend — average turnaround (hours) over time, from
 * /api/insights/history. Drawn as a lightweight inline SVG line (aqua). Until
 * >=2 history days exist there's nothing honest to plot, so it shows a
 * "Collecting history" placeholder, NEVER a faked line.
 */
import { CardFrame, CardNote } from '../cardChrome';
import { trendSeries, fmtDuration, fmtNumber, completionTimeByRegion } from '@/lib/insightsMetrics';
import type { InsightsDailyRollup, InsightsRow } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>
);

const LINE = '#73E3DF';
const W = 480, H = 180, PADX = 8, PADY = 16;

export function TrendChart({ history, rows = [] }: { history: InsightsDailyRollup[]; rows?: InsightsRow[] }) {
  // Only days with a measurable average turnaround can be plotted honestly.
  const pts = trendSeries(history)
    .filter((p) => p.avgTurnaroundMs != null)
    .map((p) => ({ date: p.date, hours: (p.avgTurnaroundMs as number) / 3_600_000 }));
  const byRegion = completionTimeByRegion(rows);

  let path = '', area = '';
  if (pts.length >= 2) {
    const max = Math.max(...pts.map((p) => p.hours), 1);
    const min = Math.min(...pts.map((p) => p.hours), 0);
    const span = max - min || 1;
    const x = (i: number) => PADX + (i / (pts.length - 1)) * (W - PADX * 2);
    const y = (h: number) => PADY + (1 - (h - min) / span) * (H - PADY * 2);
    const coords = pts.map((p, i) => [x(i), y(p.hours)] as const);
    path = coords.map(([cx, cy], i) => `${i === 0 ? 'M' : 'L'}${cx.toFixed(1)},${cy.toFixed(1)}`).join(' ');
    area = `${path} L${coords[coords.length - 1][0].toFixed(1)},${H - PADY} L${coords[0][0].toFixed(1)},${H - PADY} Z`;
  }

  const last = pts[pts.length - 1];

  return (
    <CardFrame
      title="Completion-Time Trend" icon={ICON}
      subtitle={pts.length >= 2 ? `Latest avg ${fmtDuration((last.hours) * 3_600_000)}` : undefined}
    >
      {pts.length < 2 ? (
        <CardNote>Collecting history — the trend appears once at least two daily snapshots exist.</CardNote>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 180 }} preserveAspectRatio="none" role="img" aria-label="Average completion time trend">
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={LINE} stopOpacity="0.22" />
              <stop offset="100%" stopColor={LINE} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#trendFill)" />
          <path d={path} fill="none" stroke={LINE} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      )}

      {/* By-region breakdown of average completion time (current filter). */}
      <div className="mt-4 pt-3 border-t border-white/10">
        <div className="text-[11px] font-heading font-semibold uppercase tracking-wide text-[#a1a1aa] mb-1.5">By Region</div>
        {byRegion.length === 0 ? (
          <div className="text-[12px] text-[#71717a] py-1">No completed inspections in the current filter.</div>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[11px] font-heading font-semibold uppercase tracking-wide text-[#71717a]">
                <th className="py-1.5 pr-2">Region</th>
                <th className="py-1.5 px-2 text-right"># insp</th>
                <th className="py-1.5 pl-2 text-right">avg completion</th>
              </tr>
            </thead>
            <tbody>
              {byRegion.map((r) => (
                <tr key={r.region} className="border-t border-white/5">
                  <td className="py-1.5 pr-2 text-[#f4f4f5] truncate max-w-[180px]" title={r.region}>{r.region}</td>
                  <td className="py-1.5 px-2 text-right text-[#a1a1aa]">{fmtNumber(r.count)}</td>
                  <td className="py-1.5 pl-2 text-right text-[#f4f4f5] font-heading font-semibold">{fmtDuration(r.avgMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </CardFrame>
  );
}
