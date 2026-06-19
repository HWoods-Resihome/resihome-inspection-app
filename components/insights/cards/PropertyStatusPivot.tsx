/**
 * Inspections by Property Status — pivots the filtered inspections on each
 * property's CURRENT status (e.g. "Vacant - On Market"), so ops can confirm
 * inspectors / 1099 agents are inspecting the right properties at the right
 * time. Count bar per status, split completed (aqua) vs incomplete (pink).
 * All values from the snapshot's property-status enrichment — no mocks.
 */
import { CardFrame, CardNote } from '../cardChrome';
import { inspectionsByPropertyStatus, fmtNumber } from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
);

export function PropertyStatusPivot({ rows }: { rows: InsightsRow[] }) {
  const groups = inspectionsByPropertyStatus(rows);
  const max = Math.max(1, ...groups.map((g) => g.total));
  const haveStatus = rows.some((r) => r.propertyStatus);

  return (
    <CardFrame
      title="Inspections by property status" icon={ICON}
      subtitle="current status of the linked property"
      bodyClassName="max-h-[340px] overflow-auto"
    >
      {groups.length === 0 ? (
        <CardNote>No inspections in the current filter.</CardNote>
      ) : !haveStatus ? (
        <CardNote>Property status not available yet — it populates on the next snapshot rebuild.</CardNote>
      ) : (
        <>
          <div className="flex gap-3 text-[11px] text-[#a1a1aa] mb-3">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[#73E3DF]" />Completed</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[#ff0060]" />Incomplete</span>
          </div>
          <div className="flex flex-col gap-2.5">
            {groups.map((g) => (
              <div key={g.status} className="flex items-center gap-2.5">
                <span className="text-[12px] text-[#a1a1aa] w-[150px] shrink-0 truncate" title={g.status}>{g.status}</span>
                <div className="flex-1 h-3.5 rounded bg-[#232329] overflow-hidden flex" title={`${g.completed} completed · ${g.incomplete} incomplete · ${g.total} total`}>
                  <div style={{ width: `${(g.completed / max) * 100}%` }} className="bg-[#73E3DF]" />
                  <div style={{ width: `${(g.incomplete / max) * 100}%` }} className="bg-[#ff0060]" />
                </div>
                <span className="text-[12px] text-[#f4f4f5] w-10 text-right tabular-nums">{fmtNumber(g.total)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </CardFrame>
  );
}
