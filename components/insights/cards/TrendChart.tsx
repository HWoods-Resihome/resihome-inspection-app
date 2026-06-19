/**
 * Trend card (recharts): completion VOLUME (bars/line, left axis) + AVG
 * TURNAROUND (line, right axis) over time, from /api/insights/history. Until
 * >=2 history days exist there's nothing honest to plot, so it shows a
 * "Collecting history — check back tomorrow" placeholder, NOT a faked line.
 *
 * Series colors follow the brand order: pink #ff0060 (volume) then aqua
 * #73E3DF (turnaround).
 */
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { CardFrame, CardNote } from '../cardChrome';
import { trendSeries, fmtDuration } from '@/lib/insightsMetrics';
import type { InsightsDailyRollup } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>
);

export function TrendChart({ history, onRemove }: { history: InsightsDailyRollup[]; onRemove?: () => void }) {
  const series = trendSeries(history).map((p) => ({
    date: p.date.slice(5), // MM-DD for the axis
    completed: p.completed,
    turnaroundHours: p.avgTurnaroundMs == null ? null : +(p.avgTurnaroundMs / 3_600_000).toFixed(1),
    _turnMs: p.avgTurnaroundMs,
  }));

  return (
    <CardFrame title="Completion trend" icon={ICON} onRemove={onRemove}>
      {series.length < 2 ? (
        <CardNote>Collecting history — check back tomorrow. Trend appears once at least two daily snapshots exist.</CardNote>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 4, left: -10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
            <YAxis yAxisId="left" tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} allowDecimals={false} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: '#888' }} tickLine={false} axisLine={false} />
            <Tooltip
              formatter={(value: any, name: any, item: any) => {
                if (name === 'Avg turnaround') {
                  return [fmtDuration(item?.payload?._turnMs ?? null), name];
                }
                return [value, name];
              }}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #eee' }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar yAxisId="left" dataKey="completed" name="Completed" fill="#ff0060" radius={[3, 3, 0, 0]} barSize={14} />
            <Line yAxisId="right" type="monotone" dataKey="turnaroundHours" name="Avg turnaround" stroke="#73E3DF" strokeWidth={2.5} dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </CardFrame>
  );
}
