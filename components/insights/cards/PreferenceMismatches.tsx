/**
 * "Preference overrides" — the line-item categories where inspectors consistently
 * make a DIFFERENT choice than the AI's default suggestion, learned by the loop
 * (source 'auto'). Each is a repeated divergence worth training on:
 *   - Avoid (pink): the AI suggested it but inspectors keep REJECTING it.
 *   - Prefer (aqua): inspectors keep CHOOSING it for similar call-outs.
 * Sorted by decision volume (strongest/most-repeated signal first), with a
 * visual accept/reject split. All from /api/insights/kb-changes — no mocks.
 */
import { useMemo } from 'react';
import { CardFrame, CardNote } from '../cardChrome';
import { useKbChanges, type KbEntry } from '../useKbChanges';
import { fmtNumber } from '@/lib/insightsMetrics';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>
);

interface Override {
  id: string;
  code: string | null;
  text: string;
  accepts: number;
  rejects: number;
  decisions: number;
  dir: 'avoid' | 'prefer';
}

function buildOverrides(entries: KbEntry[]): Override[] {
  return entries
    .filter((e) => e.source === 'auto')
    .map((e) => {
      const accepts = e.accepts ?? 0;
      const rejects = e.rejects ?? 0;
      const decisions = e.samples ?? accepts + rejects;
      return { id: e.id, code: e.code, text: e.text, accepts, rejects, decisions, dir: (rejects > accepts ? 'avoid' : 'prefer') as 'avoid' | 'prefer' };
    })
    .filter((o) => o.decisions > 0)
    .sort((a, b) => b.decisions - a.decisions);
}

function Row({ o }: { o: Override }) {
  const total = Math.max(1, o.accepts + o.rejects);
  const acceptPct = (o.accepts / total) * 100;
  const rejectPct = (o.rejects / total) * 100;
  const isAvoid = o.dir === 'avoid';
  return (
    <li className="px-4 py-2.5 hover:bg-white/[0.03]">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`inline-block rounded font-heading font-bold text-[10px] uppercase tracking-wide px-1.5 py-0.5 ${isAvoid ? 'bg-[#ff0060]/15 text-[#ff0060]' : 'bg-[#73E3DF]/15 text-[#73E3DF]'}`}>
          {isAvoid ? 'Avoid' : 'Prefer'}
        </span>
        {o.code && <span className="text-[11px] font-mono text-[#a1a1aa]">{o.code}</span>}
        <span className="text-[11px] text-[#71717a] ml-auto shrink-0">{fmtNumber(o.decisions)} decision{o.decisions === 1 ? '' : 's'}</span>
      </div>
      <div className="text-[12px] text-[#f4f4f5] leading-snug mb-1.5">{o.text}</div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-[#232329] overflow-hidden flex" title={`${o.accepts} chosen · ${o.rejects} rejected`}>
          <div className="bg-[#73E3DF]" style={{ width: `${acceptPct}%` }} />
          <div className="bg-[#ff0060]" style={{ width: `${rejectPct}%` }} />
        </div>
        <span className="text-[11px] text-[#71717a] shrink-0 tabular-nums">{o.accepts}✓ / {o.rejects}✗</span>
      </div>
    </li>
  );
}

export function PreferenceMismatches() {
  const { data, error } = useKbChanges();
  const overrides = useMemo(() => (data ? buildOverrides(data.entries) : null), [data]);
  const avoidCount = overrides ? overrides.filter((o) => o.dir === 'avoid').length : 0;

  return (
    <CardFrame
      title="Inspector preference overrides" icon={ICON}
      subtitle="learned repeats to train on — where choices differ from the default"
      headerRight={avoidCount > 0
        ? <span className="inline-block rounded-full bg-[#ff0060]/15 text-[#ff0060] font-heading font-semibold text-xs px-2 py-0.5" title="Categories inspectors keep rejecting">{avoidCount} to review</span>
        : null}
      bodyClassName="p-0 max-h-[420px] overflow-auto"
    >
      {error ? (
        <CardNote>Could not load preference data: {error}</CardNote>
      ) : overrides === null ? (
        <CardNote>Loading…</CardNote>
      ) : overrides.length === 0 ? (
        <CardNote>No learned preference overrides yet.</CardNote>
      ) : (
        <ul className="divide-y divide-white/5">
          {overrides.map((o) => <Row key={o.id} o={o} />)}
        </ul>
      )}
    </CardFrame>
  );
}
