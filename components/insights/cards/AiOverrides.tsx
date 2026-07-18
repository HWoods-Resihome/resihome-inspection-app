/**
 * AI Overrides — where the AI's suggestions get overridden, with a toggle (like
 * Scope Cost's) between two lenses:
 *   - Account: who overrides the AI most (inspector OR approver who made the edit)
 *   - Category: which catalog category is overridden most (training opportunity)
 * Each row drills down to the individual override events. Respects the global
 * rail filters. Data: snapshot.aiOverrides.
 */
import { useMemo, useState } from 'react';
import { CardFrame, CardNote } from '../cardChrome';
import { overridesByInspector, overridesByCategory, fmtNumber } from '@/lib/insightsMetrics';
import type { AiOverrideRow } from '@/lib/insightsSnapshot';
import { OverrideGroupList } from './overrideShared';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v1a3 3 0 0 0-3 3 3 3 0 0 0-1 5.83V17a3 3 0 0 0 3 3h.17A3 3 0 0 0 12 22a3 3 0 0 0 2.83-2H15a3 3 0 0 0 3-3v-2.17A3 3 0 0 0 17 6a3 3 0 0 0-3-3 3 3 0 0 0-2-1z" /></svg>
);

type Mode = 'account' | 'category';

function Toggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div className="flex rounded-lg overflow-hidden border border-white/10 text-[11px] font-heading font-semibold">
      {(['account', 'category'] as Mode[]).map((m) => (
        <button key={m} type="button" onClick={() => setMode(m)}
          className={`px-2.5 py-1 ${mode === m ? 'bg-[#ff0060] text-white' : 'text-[#a1a1aa] hover:text-[#f4f4f5]'}`}>
          {m === 'account' ? 'By Account' : 'By Category'}
        </button>
      ))}
    </div>
  );
}

export function AiOverrides({ overrides }: { overrides: AiOverrideRow[] }) {
  const [mode, setMode] = useState<Mode>('account');
  const groups = useMemo(
    () => (mode === 'account' ? overridesByInspector(overrides) : overridesByCategory(overrides)),
    [mode, overrides],
  );
  return (
    <CardFrame
      title="AI Overrides" icon={ICON}
      subtitle={mode === 'account'
        ? 'Who overrides the AI most (inspector or approver) — click to drill down'
        : 'Biggest training opportunities by category — click to drill down'}
      headerRight={<Toggle mode={mode} setMode={setMode} />}
      bodyClassName="p-0 max-h-[420px] overflow-auto"
    >
      {groups.length === 0
        ? <CardNote>No AI overrides in the current filter.</CardNote>
        : <OverrideGroupList groups={groups} showInspectorInRows={mode === 'category'} />}
    </CardFrame>
  );
}
