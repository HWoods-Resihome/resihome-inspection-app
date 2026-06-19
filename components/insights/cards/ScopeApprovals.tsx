/**
 * Scope approvals — count + $ approved per reviewer (approved_by), flagging any
 * approval that exceeds that approver's NTE ceiling (set via the gear →
 * "Set Approver NTE"). Thresholds load from /api/insights/approver-nte and
 * refresh instantly when the panel saves (NTE_UPDATED_EVENT). Click an approver
 * to see their scopes; over-NTE ones are flagged. Respects the global rail
 * filters. Amounts are total_client_cost — no mocks.
 */
import { useEffect, useMemo, useState } from 'react';
import { CardFrame, CardNote } from '../cardChrome';
import { scopeApprovalsByApprover, fmtCurrency, fmtNumber } from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';
import { NTE_UPDATED_EVENT } from '../ApproverNteManager';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
);

export function ScopeApprovals({ rows }: { rows: InsightsRow[] }) {
  const [nte, setNte] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/insights/approver-nte', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && !d.error) setNte(d.thresholds || {}); })
      .catch(() => { /* leave thresholds empty — no flags */ });
    void load();
    const onUpdate = () => { void load(); };
    if (typeof window !== 'undefined') window.addEventListener(NTE_UPDATED_EVENT, onUpdate);
    return () => { cancelled = true; if (typeof window !== 'undefined') window.removeEventListener(NTE_UPDATED_EVENT, onUpdate); };
  }, []);

  const groups = useMemo(() => scopeApprovalsByApprover(rows, nte), [rows, nte]);
  const totalOver = groups.reduce((s, g) => s + g.overCount, 0);
  const maxTotal = Math.max(1, ...groups.map((g) => g.total));

  return (
    <CardFrame
      title="Scope approvals by reviewer" icon={ICON}
      subtitle="count + $ approved; flags over each approver’s NTE"
      headerRight={totalOver > 0
        ? <span className="inline-block rounded-full bg-[#ff0060]/15 text-[#ff0060] font-heading font-semibold text-xs px-2 py-0.5" title="Approvals over NTE">{totalOver} over NTE</span>
        : null}
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
                    <div className="text-[10px] text-[#71717a]">
                      {fmtNumber(g.count)} · {g.nte != null ? `NTE ${fmtCurrency(g.nte)}` : 'no NTE set'}
                    </div>
                  </div>
                  <div className="flex-1 h-3 rounded bg-[#232329] overflow-hidden"><div className="h-full bg-[#73E3DF]" style={{ width: `${(g.total / maxTotal) * 100}%` }} /></div>
                  {g.overCount > 0 && (
                    <span className="shrink-0 inline-block rounded bg-[#ff0060]/15 text-[#ff0060] font-heading font-semibold text-[10px] px-1.5 py-0.5" title="Approvals over NTE">{g.overCount}⚠</span>
                  )}
                  <span className="text-[12px] text-[#f4f4f5] w-16 text-right tabular-nums">{fmtCurrency(g.total)}</span>
                </button>
                {isOpen && (
                  <ul className="flex flex-col gap-1 pl-3 ml-2 my-2 border-l border-white/10">
                    {g.scopes.map((s) => (
                      <li key={s.recordId} className="text-[11px] flex items-center gap-2">
                        <span className={`w-14 text-right tabular-nums shrink-0 ${s.over ? 'text-[#ff0060] font-heading font-semibold' : 'text-[#f4f4f5]'}`}>{fmtCurrency(s.cost)}</span>
                        <span className="truncate flex-1 text-[#a1a1aa]" title={s.propertyAddress}>{s.over ? '⚠ ' : ''}{s.propertyAddress || '(no address)'}</span>
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
