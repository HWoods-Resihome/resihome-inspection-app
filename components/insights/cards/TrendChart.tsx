/**
 * Completion-time trend — average turnaround (hours) over time, from
 * /api/insights/history. Drawn as a lightweight inline SVG line (aqua). Until
 * >=2 history days exist there's nothing honest to plot, so it shows a
 * "Collecting history" placeholder, NEVER a faked line.
 */
import { CardFrame, CardNote } from '../cardChrome';
import { trendSeries, fmtDuration } from '@/lib/insightsMetrics';
import type { InsightsDailyRollup } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>
);

const LINE = '#73E3DF';
const W = 480, H = 180, PADX = 8, PADY = 16;

export function TrendChart({ history }: { history: InsightsDailyRollup[] }) {
  // Only days with a measurable average turnaround can be plotted honestly.
  const pts = trendSeries(history)
    .filter((p) => p.avgTurnaroundMs != null)
    .map((p) => ({ date: p.date, hours: (p.avgTurnaroundMs as number) / 3_600_000 }));

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
      title="Completion-time trend" icon={ICON}
      subtitle={pts.length >= 2 ? `latest avg ${fmtDuration((last.hours) * 3_600_000)}` : undefined}
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
    </CardFrame>
  );
}
