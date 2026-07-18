/**
 * 1099 Grass Condition — Fails. Lists the 1099 leasing-agent inspections whose
 * "Grass Condition" answer failed (app answerTone rule: Fail / Poor / Deficient),
 * with the photos the agent attached so ops can eyeball the yard. Respects the
 * global rail filters (it receives the already-filtered rows). All data comes
 * from the snapshot's per-1099 answer capture — no mocks.
 */
import { CardFrame, CardNote } from '../cardChrome';
import { grassConditionFails, fmtDate } from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22V11" /><path d="M12 11c0-3 2-5 5-5 0 3-2 5-5 5z" /><path d="M12 14c0-3-2-5-5-5 0 3 2 5 5 5z" /></svg>
);

function PhotoStrip({ urls }: { urls: string[] }) {
  if (urls.length === 0) return <span className="text-[11px] text-[#71717a]">No photos</span>;
  return (
    <div className="flex gap-1.5 flex-wrap">
      {urls.map((u, i) => (
        <a key={u + i} href={u} target="_blank" rel="noopener noreferrer" title="Open photo" className="block">
          <img
            src={u} alt={`Grass photo ${i + 1}`} loading="lazy"
            className="w-12 h-12 rounded object-cover border border-white/10 hover:border-[#ff0060] transition-colors"
          />
        </a>
      ))}
    </div>
  );
}

export function GrassFails({ rows }: { rows: InsightsRow[] }) {
  const fails = grassConditionFails(rows);
  return (
    <CardFrame
      title="1099 Grass Condition Fails" icon={ICON}
      subtitle="Leasing-agent inspections where the lawn failed"
      headerRight={fails.length > 0
        ? <span className="inline-block rounded-full bg-[#ff0060]/15 text-[#ff0060] font-heading font-semibold text-xs px-2 py-0.5">{fails.length}</span>
        : null}
      bodyClassName="p-0 max-h-[420px] overflow-auto"
    >
      {fails.length === 0 ? (
        <CardNote>No grass-condition fails in the current filter.</CardNote>
      ) : (
        <ul className="divide-y divide-white/5">
          {fails.map((r) => (
            <li key={r.recordId} className="px-4 py-3 hover:bg-white/[0.03]">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <div className="text-[13px] text-[#f4f4f5] truncate" title={r.propertyAddress}>{r.propertyAddress || '(no address)'}</div>
                  <div className="text-[11px] text-[#a1a1aa] truncate">
                    {r.inspectorName || r.inspectorEmail || '—'} · {fmtDate(r.completedAt || r.scheduledDate)}
                  </div>
                </div>
                <span className="shrink-0 inline-block rounded bg-[#ff0060]/15 text-[#ff0060] font-heading font-semibold text-[11px] px-2 py-0.5" title="Grass Condition answer">
                  {r.grassCondition || 'Fail'}
                </span>
              </div>
              <PhotoStrip urls={r.grassPhotos || []} />
              {r.reportUrl && (
                <a href={r.reportUrl} target="_blank" rel="noopener noreferrer" className="inline-block mt-2 text-[11px] font-heading font-semibold text-[#ff0060] hover:underline">
                  Open report ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  );
}
