/**
 * Scope approvals — count + $ approved per reviewer (approved_by). Click an
 * approver to see their approved scopes. Respects the global rail filters.
 * Amounts are total_client_cost — no mocks.
 *
 * (Per-approver NTE flagging was removed — approval routing + ceilings now live
 * in Admin → Approval Routing under the home page.)
 */
import { useMemo, useState } from 'react';
import { CardFrame, CardNote } from '../cardChrome';
import { scopeApprovalsByApprover, fmtCurrency, fmtNumber } from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
);

export function ScopeApprovals({ rows }: { rows: InsightsRow[] }) {
  const [open, setOpen] = useState<string | null>(null);

  const groups = useMemo(() => scopeApprovalsByApprover(rows), [rows]);
  const maxTotal = Math.max(1, ...groups.map((g) => g.total));

  return (
    <CardFrame
      title="Scope approvals by reviewer" icon={ICON}
      subtitle="count + $ approved per reviewer"
      bodyClassName="p-0 max-h-[420px] overflow-auto"
    >
      {groups.length === 0 ? (
        <CardNote>No approved scopes in the current filter.</CardNote>
      ) : (
        <ul className="flex flex-col">
          {groups.map((g) => {
            const isOpen = open === g.approver;
            return (
              <li key={g.approver} className="border-b border-white/5 last:border-0">
                <button type="button" onClick={() => setOpen(isOpen ? null : g.approver)}
                  className="w-full flex items-center gap-2.5 py-2 px-4 text-left hover:bg-white/[0.03]" title="Show approved scopes">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`text-[#71717a] shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}><polyline points="9 18 15 12 9 6" /></svg>
                  <div className="w-[150px] shrink-0 min-w-0">
                    <div className="text-[12px] text-[#f4f4f5] truncate" title={g.approver}>{g.approver}</div>
                    <div className="text-[10px] text-[#71717a]">{fmtNumber(g.count)} approved</div>
                  </div>
                  <div className="flex-1 h-3 rounded bg-[#232329] overflow-hidden"><div className="h-full bg-[#73E3DF]" style={{ width: `${(g.total / maxTotal) * 100}%` }} /></div>
                  <span className="text-[12px] text-[#f4f4f5] w-16 text-right tabular-nums">{fmtCurrency(g.total)}</span>
                </button>
                {isOpen && (
                  <ul className="flex flex-col gap-1 pl-3 ml-2 my-2 border-l border-white/10">
                    {g.scopes.map((s) => (
                      <li key={s.recordId} className="text-[11px] flex items-center gap-2">
                        <span className="w-14 text-right tabular-nums shrink-0 text-[#f4f4f5]">{fmtCurrency(s.cost)}</span>
                        <span className="truncate flex-1 text-[#a1a1aa]" title={s.propertyAddress}>{s.propertyAddress || '(no address)'}</span>
                        <a href={`/inspection/${s.recordId}`} target="_blank" rel="noopener noreferrer" className="text-[#ff0060] hover:underline shrink-0 font-heading font-semibold">open ↗</a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </CardFrame>
  );
}
