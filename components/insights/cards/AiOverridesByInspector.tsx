/**
 * AI overrides by account — who overrides the AI's suggestions most, credited to
 * the user who actually made each edit (inspector OR approver). Each bar is one
 * account; click to drill down to the individual override events (decision + the
 * AI's suggestion + a link to the inspection). Respects the global rail filters.
 * Data: snapshot.aiOverrides (each event stamped with its acting user).
 */
import { CardFrame, CardNote } from '../cardChrome';
import { overridesByInspector, fmtNumber } from '@/lib/insightsMetrics';
import type { AiOverrideRow } from '@/lib/insightsSnapshot';
import { OverrideGroupList } from './overrideShared';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /></svg>
);

export function AiOverridesByInspector({ overrides }: { overrides: AiOverrideRow[] }) {
  const groups = overridesByInspector(overrides);
  return (
    <CardFrame
      title="AI overrides by account" icon={ICON}
      subtitle="who overrides the AI most (inspector or approver) — click to drill down"
      headerRight={overrides.length ? <span className="text-[11px] text-[#71717a]">{fmtNumber(overrides.length)} overrides</span> : null}
      bodyClassName="p-0 max-h-[420px] overflow-auto"
    >
      {groups.length === 0
        ? <CardNote>No AI overrides in the current filter.</CardNote>
        : <OverrideGroupList groups={groups} showInspectorInRows={false} />}
    </CardFrame>
  );
}
