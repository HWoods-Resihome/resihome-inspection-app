/**
 * Most-used Rate Card line items — a table keyed by line-item code (label from
 * the catalog). Usage is counted by occurrence across the filtered inspections:
 * "all-time" over every row, "last week" over rows dated in the last 7 days.
 * Sorted by all-time usage; header sticky while the body scrolls in the card.
 */
import { CardFrame, CardNote } from '../cardChrome';
import { rateCardLineUsage, fmtNumber } from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="16" y2="17" /></svg>
);

const MAX_ROWS = 15;

export function RateCardLines({ rows }: { rows: InsightsRow[] }) {
  const usage = rateCardLineUsage(rows);
  const shown = usage.slice(0, MAX_ROWS);
  return (
    <CardFrame
      title="Most-Used Rate Card Line Items"
      subtitle={usage.length ? `${usage.length} distinct line item${usage.length === 1 ? '' : 's'} used` : undefined}
      icon={ICON}
      bodyClassName="px-0 pb-0 max-h-[320px] overflow-auto"
    >
      {shown.length === 0 ? (
        <CardNote>No rate card line items in the current filter.</CardNote>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] font-heading font-semibold uppercase tracking-wide text-[#a1a1aa] sticky top-0 bg-[#232329]">
              <th className="py-2 pl-4 pr-2">Line item</th>
              <th className="py-2 px-2 text-right" title="Times used across all inspections in the current filter">all-time</th>
              <th className="py-2 pr-4 pl-2 text-right" title="Times used in the last 7 days">last week</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((u) => (
              <tr key={u.code} className="border-b border-white/5 hover:bg-white/[0.03]">
                <td className="py-1.5 pl-4 pr-2">
                  <div className="text-[#f4f4f5] truncate max-w-[220px]" title={`${u.label} · ${u.code}`}>{u.label}</div>
                  <div className="text-[10px] text-[#71717a] truncate">{u.code}</div>
                </td>
                <td className="py-1.5 px-2 text-right text-[#f4f4f5] font-heading font-semibold">{fmtNumber(u.allTime)}</td>
                <td className="py-1.5 pr-4 pl-2 text-right">
                  {u.lastWeek > 0
                    ? <span className="inline-block rounded-full bg-[#ff0060]/15 text-[#ff0060] font-heading font-semibold text-xs px-2 py-0.5">{u.lastWeek}</span>
                    : <span className="text-[#71717a]">0</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </CardFrame>
  );
}
