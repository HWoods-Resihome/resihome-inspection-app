/**
 * Shared UI for the AI-override cards: an expandable bar list where clicking a
 * group reveals the underlying events (inspector + the AI's suggestion + a
 * drill-down link to the inspection). Used by the by-inspector and by-category
 * cards, and by the preference-overrides drill-down. All data is real
 * (snapshot.aiOverrides, joined to the inspection) — every row links out.
 */
import { useState } from 'react';
import type { AiOverrideRow } from '@/lib/insightsSnapshot';
import type { OverrideGroup } from '@/lib/insightsMetrics';

/** Flat list of override events (newest first), each linking to its inspection. */
export function OverrideEvents({ rows, showInspector = true }: { rows: AiOverrideRow[]; showInspector?: boolean }) {
  return (
    <ul className="flex flex-col gap-1 pl-3 ml-2 my-2 border-l border-white/10">
      {rows.slice(0, 60).map((o, i) => {
        // code · category · line-item description — the code alone doesn't say what it was.
        const parts = [o.code || '—', o.category, o.codeLabel].filter(Boolean) as string[];
        const detail = parts.join(' · ');
        return (
          <li key={o.inspectionId + o.ts + i} className="text-[11px] text-[#a1a1aa] flex items-center gap-2">
            <span className="text-[#ff0060] font-heading font-semibold uppercase text-[10px] w-[52px] shrink-0">{o.decision}</span>
            <span className="truncate flex-1" title={[showInspector ? o.inspectorName : '', detail, o.query].filter(Boolean).join(' · ')}>
              {showInspector ? <span className="text-[#f4f4f5]">{o.inspectorName || o.inspectorEmail || '—'} · </span> : ''}
              {detail}{o.query ? ` · “${o.query}”` : ''}
            </span>
            <a href={`/inspection/${o.inspectionId}`} target="_blank" rel="noopener noreferrer"
              className="text-[#ff0060] hover:underline shrink-0 font-heading font-semibold">open ↗</a>
          </li>
        );
      })}
      {rows.length > 60 && <li className="text-[10px] text-[#71717a]">…and {rows.length - 60} more</li>}
    </ul>
  );
}

/** Expandable bar list over override groups (inspector or category). */
export function OverrideGroupList({ groups, showInspectorInRows = true }: { groups: OverrideGroup[]; showInspectorInRows?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const max = Math.max(1, ...groups.map((g) => g.count));
  return (
    <ul className="flex flex-col">
      {groups.map((g) => {
        const isOpen = open === g.key;
        return (
          <li key={g.key} className="border-b border-white/5 last:border-0">
            <button
              type="button" onClick={() => setOpen(isOpen ? null : g.key)}
              className="w-full flex items-center gap-2.5 py-2 px-4 text-left hover:bg-white/[0.03]"
              title="Show overrides"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`text-[#71717a] shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`}><polyline points="9 18 15 12 9 6" /></svg>
              <span className="text-[12px] text-[#f4f4f5] w-[150px] shrink-0 truncate" title={g.label}>{g.label}</span>
              <div className="flex-1 h-3 rounded bg-[#232329] overflow-hidden">
                <div className="h-full bg-[#ff0060]" style={{ width: `${(g.count / max) * 100}%` }} />
              </div>
              <span className="text-[12px] text-[#f4f4f5] w-8 text-right tabular-nums">{g.count}</span>
            </button>
            {isOpen && <div className="px-4 pb-1"><OverrideEvents rows={g.rows} showInspector={showInspectorInRows} /></div>}
          </li>
        );
      })}
    </ul>
  );
}
