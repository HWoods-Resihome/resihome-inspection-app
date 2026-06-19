/**
 * Inspector performance table — keyed by inspectorEmail (lowercased), label =
 * the most-frequent name for that email. Columns: Inspector · # inspections ·
 * # incomplete · avg time-to-start · avg time-to-finish · avg photos · total
 * photos. Rows with no startedAt are excluded from the time-to-start average
 * upstream (see avgDuration), never counted as 0. Header is sticky so it stays
 * put while the body scrolls inside the card.
 */
import { CardFrame, CardNote } from '../cardChrome';
import { inspectorRoster, fmtDuration, fmtNumber } from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
);

export function InspectorRoster({ rows }: { rows: InsightsRow[] }) {
  const roster = inspectorRoster(rows);
  return (
    <CardFrame
      title="Inspector performance" icon={ICON}
      bodyClassName="px-0 pb-0 max-h-[320px] overflow-auto"
    >
      {roster.length === 0 ? (
        <CardNote>No inspectors in the current filter.</CardNote>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-[11px] font-heading font-semibold uppercase tracking-wide text-[#a1a1aa] sticky top-0 bg-[#232329]">
              <th className="py-2 pl-4 pr-2">Inspector</th>
              <th className="py-2 px-2 text-right" title="# inspections"># insp</th>
              <th className="py-2 px-2 text-right" title="Scheduled + in progress"># incmpl</th>
              <th className="py-2 px-2 text-right">avg start</th>
              <th className="py-2 px-2 text-right">avg finish</th>
              <th className="py-2 px-2 text-right">avg photos</th>
              <th className="py-2 pr-4 pl-2 text-right">total photos</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((r) => (
              <tr key={r.email} className="border-b border-white/5 hover:bg-white/[0.03]">
                <td className="py-1.5 pl-4 pr-2">
                  <div className="text-[#f4f4f5] truncate max-w-[160px]" title={`${r.label} · ${r.email}`}>{r.label}</div>
                </td>
                <td className="py-1.5 px-2 text-right text-[#f4f4f5]">{r.count}</td>
                <td className="py-1.5 px-2 text-right">
                  {r.incomplete > 0
                    ? <span className="inline-block rounded-full bg-[#ff0060]/15 text-[#ff0060] font-heading font-semibold text-xs px-2 py-0.5">{r.incomplete}</span>
                    : <span className="text-[#71717a]">0</span>}
                </td>
                <td className="py-1.5 px-2 text-right text-[#a1a1aa]">{fmtDuration(r.avgTimeToStartMs)}</td>
                <td className="py-1.5 px-2 text-right text-[#a1a1aa]">{fmtDuration(r.avgTimeToFinishMs)}</td>
                <td className="py-1.5 px-2 text-right text-[#a1a1aa]">{r.avgPhotos == null ? '—' : r.avgPhotos.toFixed(1)}</td>
                <td className="py-1.5 pr-4 pl-2 text-right text-[#a1a1aa]">{fmtNumber(r.totalPhotos)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </CardFrame>
  );
}
