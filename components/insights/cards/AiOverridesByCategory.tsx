/**
 * AI overrides by category — where the AI is most often overridden (the biggest
 * training opportunity). Each bar is a catalog category; click to drill down to
 * the individual override events (inspector + suggestion + inspection link).
 * Respects the global rail filters. Data: snapshot.aiOverrides (code→category).
 */
import { CardFrame, CardNote } from '../cardChrome';
import { overridesByCategory, fmtNumber } from '@/lib/insightsMetrics';
import type { AiOverrideRow } from '@/lib/insightsSnapshot';
import { OverrideGroupList } from './overrideShared';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="8" /><rect x="12" y="5" width="3" height="13" /><rect x="17" y="13" width="3" height="5" /></svg>
);

export function AiOverridesByCategory({ overrides }: { overrides: AiOverrideRow[] }) {
  const groups = overridesByCategory(overrides);
  return (
    <CardFrame
      title="AI overrides by category" icon={ICON}
      subtitle="biggest training opportunities — click to drill down"
      headerRight={overrides.length ? <span className="text-[11px] text-[#71717a]">{fmtNumber(overrides.length)} overrides</span> : null}
      bodyClassName="p-0 max-h-[420px] overflow-auto"
    >
      {groups.length === 0
        ? <CardNote>No AI overrides in the current filter.</CardNote>
        : <OverrideGroupList groups={groups} showInspectorInRows />}
    </CardFrame>
  );
}
