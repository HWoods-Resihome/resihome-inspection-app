/**
 * Pass / fail by group (horizontal bars), grouped by a toggle: Inspector | Type
 * | Region. Pass = aqua (#73E3DF), Fail = #B4B2A9. Only 1099/Vacancy/QC rows
 * carry a verdict (see rowVerdict) — Scope and others are excluded.
 */
import { useState } from 'react';
import { templateLabel } from '@/lib/templateLabels';
import { CardFrame, CardNote } from '../cardChrome';
import { type GroupBy, passFailByGroup, fmtPct } from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

const PASS = '#73E3DF';
const FAIL = '#B4B2A9';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="15" y2="12" /><line x1="3" y1="18" x2="10" y2="18" /></svg>
);

const GROUPS: { key: GroupBy; label: string }[] = [
  { key: 'inspector', label: 'Inspector' },
  { key: 'type', label: 'Type' },
  { key: 'region', label: 'Region' },
];

export function PassFailBars({ rows }: { rows: InsightsRow[] }) {
  const [by, setBy] = useState<GroupBy>('inspector');
  const data = passFailByGroup(rows, by);

  const toggle = (
    <div className="flex rounded-lg border border-white/10 overflow-hidden text-[11px]">
      {GROUPS.map((g) => (
        <button
          key={g.key} type="button" onClick={() => setBy(g.key)}
          className={`px-2 py-1 font-heading font-semibold ${by === g.key ? 'bg-[#ff0060] text-white' : 'bg-[#232329] text-[#a1a1aa] hover:text-[#f4f4f5]'}`}
        >
          {g.label}
        </button>
      ))}
    </div>
  );

  return (
    <CardFrame
      title="Pass / Fail" icon={ICON} headerRight={toggle}
      bodyClassName="p-4 max-h-[320px] overflow-auto"
    >
      {data.length === 0 ? (
        <CardNote>No pass/fail verdicts in the current filter (1099, Vacancy, and QC only).</CardNote>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-4 text-[11px] text-[#a1a1aa] mb-1">
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: PASS }} /> Pass</span>
            <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: FAIL }} /> Fail</span>
          </div>
          {data.map((g) => {
            const passPct = g.total ? (g.pass / g.total) * 100 : 0;
            const failPct = g.total ? (g.fail / g.total) * 100 : 0;
            const label = by === 'type' ? templateLabel(g.label) : g.label;
            return (
              <div key={g.key}>
                <div className="flex items-center justify-between text-xs mb-0.5">
                  <span className="text-[#f4f4f5] truncate min-w-0 pr-2" title={label}>{label}</span>
                  <span className="text-[#71717a] shrink-0">{fmtPct(g.total ? g.pass / g.total : null)} · {g.total}</span>
                </div>
                <div className="flex h-4 w-full rounded overflow-hidden bg-[#232329]" title={`${g.pass} pass / ${g.fail} fail`}>
                  {g.pass > 0 && <div style={{ width: `${passPct}%`, background: PASS }} />}
                  {g.fail > 0 && <div style={{ width: `${failPct}%`, background: FAIL }} />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </CardFrame>
  );
}
