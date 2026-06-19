/**
 * "AI learning velocity" — how fast the Knowledge Base is growing and how well
 * the AI-learned auto-rules are holding up. Built from the same /api/insights/
 * kb-changes data as the feed card (shared via useKbChanges — one network read).
 *
 * Top: three headline stats (new entries in 30d, AI-learned in 30d, overall
 * auto-rule acceptance rate from the loop's accept/reject evidence). Bottom:
 * weekly new-entry bars for the last 12 weeks, AI-learned (pink) stacked over
 * everything else (gray) so the learning cadence reads at a glance.
 */
import { useMemo } from 'react';
import { CardFrame, CardNote } from '../cardChrome';
import { useKbChanges, type KbEntry } from '../useKbChanges';
import { fmtPct, fmtNumber } from '@/lib/insightsMetrics';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>
);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKS = 12;

interface Velocity {
  new30: number;
  auto30: number;
  acceptRate: number | null;   // accepts / (accepts + rejects) across auto entries
  acceptN: number;             // total decisions behind the rate
  weeks: { start: number; auto: number; other: number; total: number }[];
}

function computeVelocity(entries: KbEntry[]): Velocity {
  const now = Date.now();
  const since30 = now - 30 * DAY_MS;
  let new30 = 0, auto30 = 0, accepts = 0, rejects = 0;
  for (const e of entries) {
    if (e.createdAt >= since30) { new30++; if (e.source === 'auto') auto30++; }
    if (e.source === 'auto') { accepts += e.accepts ?? 0; rejects += e.rejects ?? 0; }
  }
  // Week buckets: oldest → newest, anchored to the start of the current week window.
  const startOfThisWeek = now - (WEEKS - 1) * WEEK_MS;
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({
    start: startOfThisWeek + i * WEEK_MS, auto: 0, other: 0, total: 0,
  }));
  for (const e of entries) {
    const idx = Math.floor((e.createdAt - startOfThisWeek) / WEEK_MS);
    if (idx < 0 || idx >= WEEKS) continue;
    const w = weeks[idx];
    if (e.source === 'auto') w.auto++; else w.other++;
    w.total++;
  }
  const acceptN = accepts + rejects;
  return { new30, auto30, acceptRate: acceptN ? accepts / acceptN : null, acceptN, weeks };
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-[#232329] rounded-xl border border-white/10 px-3 py-2.5">
      <div className="text-[11px] font-heading font-semibold tracking-wide text-[#a1a1aa] truncate">{label}</div>
      <div className={`font-heading font-extrabold text-[22px] leading-tight mt-0.5 ${accent ? 'text-[#ff0060]' : 'text-[#f4f4f5]'}`}>{value}</div>
    </div>
  );
}

export function KbVelocity() {
  const { data, error } = useKbChanges();
  const v = useMemo(() => (data ? computeVelocity(data.entries) : null), [data]);
  const maxWeek = v ? Math.max(1, ...v.weeks.map((w) => w.total)) : 1;

  return (
    <CardFrame
      title="AI learning velocity" icon={ICON}
      subtitle="Knowledge Base growth + auto-rule acceptance"
    >
      {error ? (
        <CardNote>Could not load learning velocity: {error}</CardNote>
      ) : !v ? (
        <CardNote>Loading…</CardNote>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2.5 mb-4">
            <Stat label="New (30d)" value={fmtNumber(v.new30)} />
            <Stat label="AI-Learned (30d)" value={fmtNumber(v.auto30)} accent />
            <Stat
              label="Auto Accept Rate"
              value={v.acceptRate == null ? '—' : fmtPct(v.acceptRate)}
            />
          </div>

          <div className="flex items-center gap-3 text-[11px] text-[#a1a1aa] mb-2">
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[#ff0060]" />AI-learned</span>
            <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[#52525b]" />Human / example</span>
            <span className="ml-auto">last {WEEKS} weeks</span>
          </div>
          <div className="flex items-end gap-1.5 h-[120px]">
            {v.weeks.map((w) => {
              const h = (w.total / maxWeek) * 100;
              const autoFrac = w.total ? w.auto / w.total : 0;
              const label = new Date(w.start).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
              return (
                <div key={w.start} className="flex-1 flex flex-col items-center gap-1 min-w-0" title={`Week of ${label}: ${w.total} new (${w.auto} AI-learned)`}>
                  <div className="w-full flex flex-col justify-end" style={{ height: '100px' }}>
                    {w.total > 0 && (
                      <div className="w-full rounded-t overflow-hidden flex flex-col" style={{ height: `${Math.max(h, 4)}%` }}>
                        <div className="bg-[#ff0060]" style={{ height: `${autoFrac * 100}%` }} />
                        <div className="bg-[#52525b] flex-1" />
                      </div>
                    )}
                  </div>
                  <span className="text-[9px] text-[#71717a] truncate w-full text-center">{label}</span>
                </div>
              );
            })}
          </div>
          {v.acceptN > 0 && (
            <div className="text-[11px] text-[#71717a] mt-3">
              Acceptance across {fmtNumber(v.acceptN)} auto-rule decision{v.acceptN === 1 ? '' : 's'}.
            </div>
          )}
        </>
      )}
    </CardFrame>
  );
}
