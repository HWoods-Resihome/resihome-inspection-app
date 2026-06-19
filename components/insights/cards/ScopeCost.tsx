/**
 * Scope Rate Card cost — compare scoping across the team. Two modes:
 *   (A) Per inspector — avg total scope $ per inspector; click to see their
 *       scopes ($ + approver + link). Is one person/team scoping higher overall?
 *   (B) Per category — a 3-level drill-down: every category with its average,
 *       then the inspectors driving that average, then the inspections driving
 *       each inspector's number. Does someone scope cleaning/appliances higher?
 * Per-region comparison comes from the global rail (filter to a region).
 * All figures are real: total_client_cost + per-category sums of line clientCost
 * (snapshot scopeCategoryCosts); approver is approved_by. No mocks.
 */
import { useMemo, useState } from 'react';
import { CardFrame, CardNote } from '../cardChrome';
import { scopeTotals, scopeCostByInspector, scopeCategoryTree, fmtCurrency, fmtNumber } from '@/lib/insightsMetrics';
import type { InsightsRow } from '@/lib/insightsSnapshot';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
);

const Chevron = ({ open }: { open: boolean }) => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`text-[#71717a] shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}><polyline points="9 18 15 12 9 6" /></svg>
);

type Mode = 'inspector' | 'category';

function Toggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-white/10 text-[11px] font-heading font-semibold">
      {(['inspector', 'category'] as Mode[]).map((m) => (
        <button key={m} type="button" onClick={() => setMode(m)}
          className={`px-2.5 py-1 ${mode === m ? 'bg-[#ff0060] text-white' : 'text-[#a1a1aa] hover:text-[#f4f4f5]'}`}>
          {m === 'inspector' ? 'Per inspector' : 'Per category'}
        </button>
      ))}
    </div>
  );
}

export function ScopeCost({ rows }: { rows: InsightsRow[] }) {
  const [mode, setMode] = useState<Mode>('inspector');
  const [openEmail, setOpenEmail] = useState<string | null>(null);   // mode A
  const [openCat, setOpenCat] = useState<string | null>(null);       // mode B level 1
  const [openCatIns, setOpenCatIns] = useState<string | null>(null); // mode B level 2 (`${cat}|${email}`)

  const totals = useMemo(() => scopeTotals(rows), [rows]);
  const byInspector = useMemo(() => scopeCostByInspector(rows), [rows]);
  const catTree = useMemo(() => (mode === 'category' ? scopeCategoryTree(rows) : []), [rows, mode]);

  const maxA = Math.max(1, ...byInspector.map((g) => g.avg));
  const maxCat = Math.max(1, ...catTree.map((c) => c.avg));

  return (
    <CardFrame
      title="Scope cost by inspector" icon={ICON}
      subtitle={totals.count
        ? `${fmtNumber(totals.count)} scopes · ${fmtCurrency(totals.total)} total · ${fmtCurrency(totals.avg)} avg`
        : 'Scope Rate Card client cost'}
      headerRight={<Toggle mode={mode} setMode={setMode} />}
      bodyClassName="p-0"
    >
      {totals.count === 0 ? (
        <CardNote>No scopes with cost in the current filter.</CardNote>
      ) : mode === 'inspector' ? (
        <ul className="flex flex-col max-h-[360px] overflow-auto">
          {byInspector.map((g) => {
            const isOpen = openEmail === g.email;
            return (
              <li key={g.email} className="border-b border-white/5 last:border-0">
                <button type="button" onClick={() => setOpenEmail(isOpen ? null : g.email)}
                  className="w-full flex items-center gap-2.5 py-2 px-4 text-left hover:bg-white/[0.03]" title="Show scopes">
                  <Chevron open={isOpen} />
                  <span className="text-[12px] text-[#f4f4f5] w-[140px] shrink-0 truncate" title={g.label}>{g.label}</span>
                  <div className="flex-1 h-3 rounded bg-[#232329] overflow-hidden"><div className="h-full bg-[#ff0060]" style={{ width: `${(g.avg / maxA) * 100}%` }} /></div>
                  <span className="text-[12px] text-[#f4f4f5] w-16 text-right tabular-nums" title={`${g.count} scopes · ${fmtCurrency(g.total)} total`}>{fmtCurrency(g.avg)}</span>
                </button>
                {isOpen && (
                  <ul className="flex flex-col gap-1 pl-3 ml-2 my-2 border-l border-white/10">
                    {g.scopes.map((s) => (
                      <li key={s.recordId} className="text-[11px] text-[#a1a1aa] flex items-center gap-2">
                        <span className="w-14 text-right tabular-nums text-[#f4f4f5] shrink-0">{fmtCurrency(s.cost)}</span>
                        <span className="truncate flex-1" title={s.propertyAddress}>{s.propertyAddress || '(no address)'}{s.approverName ? ` · appr: ${s.approverName}` : ''}</span>
                        <a href={`/inspection/${s.recordId}`} target="_blank" rel="noopener noreferrer" className="text-[#ff0060] hover:underline shrink-0 font-heading font-semibold">open ↗</a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        /* Per category: Category → Inspector → Inspection */
        <ul className="flex flex-col max-h-[440px] overflow-auto">
          {catTree.map((c) => {
            const catOpen = openCat === c.category;
            return (
              <li key={c.category} className="border-b border-white/5 last:border-0">
                <button type="button" onClick={() => setOpenCat(catOpen ? null : c.category)}
                  className="w-full flex items-center gap-2.5 py-2 px-4 text-left hover:bg-white/[0.03]" title="Show inspectors">
                  <Chevron open={catOpen} />
                  <span className="text-[12px] text-[#f4f4f5] w-[150px] shrink-0 truncate" title={c.category}>{c.category}</span>
                  <div className="flex-1 h-3 rounded bg-[#232329] overflow-hidden"><div className="h-full bg-[#73E3DF]" style={{ width: `${(c.avg / maxCat) * 100}%` }} /></div>
                  <span className="text-[12px] text-[#f4f4f5] w-16 text-right tabular-nums" title={`${c.count} scopes · ${fmtCurrency(c.total)} total`}>{fmtCurrency(c.avg)}</span>
                </button>

                {catOpen && (
                  <ul className="flex flex-col pl-3 ml-3 my-1 border-l border-white/10">
                    {c.inspectors.map((ins) => {
                      const insKey = `${c.category}|${ins.email}`;
                      const insOpen = openCatIns === insKey;
                      const maxIns = Math.max(1, ...c.inspectors.map((x) => x.avg));
                      return (
                        <li key={insKey}>
                          <button type="button" onClick={() => setOpenCatIns(insOpen ? null : insKey)}
                            className="w-full flex items-center gap-2 py-1.5 px-2 text-left hover:bg-white/[0.03]" title="Show inspections">
                            <Chevron open={insOpen} />
                            <span className="text-[11px] text-[#e4e4e7] w-[130px] shrink-0 truncate" title={ins.label}>{ins.label}</span>
                            <div className="flex-1 h-2 rounded bg-[#232329] overflow-hidden"><div className="h-full bg-[#73E3DF]/70" style={{ width: `${(ins.avg / maxIns) * 100}%` }} /></div>
                            <span className="text-[11px] text-[#a1a1aa] w-14 text-right tabular-nums" title={`${ins.count} scopes · ${fmtCurrency(ins.total)} total`}>{fmtCurrency(ins.avg)}</span>
                          </button>
                          {insOpen && (
                            <ul className="flex flex-col gap-1 pl-3 ml-2 my-1.5 border-l border-white/10">
                              {ins.scopes.map((s) => (
                                <li key={s.recordId} className="text-[11px] text-[#a1a1aa] flex items-center gap-2">
                                  <span className="w-14 text-right tabular-nums text-[#f4f4f5] shrink-0">{fmtCurrency(s.cost)}</span>
                                  <span className="truncate flex-1" title={s.propertyAddress}>{s.propertyAddress || '(no address)'}{s.approverName ? ` · appr: ${s.approverName}` : ''}</span>
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
              </li>
            );
          })}
        </ul>
      )}
    </CardFrame>
  );
}
