/**
 * "AI Knowledge Base changes" card — a read-only, newest-first feed of the live
 * KB (worked examples, human rules, AI-learned auto rules) from
 * /api/insights/kb-changes. Mirrors the /ai-knowledge list, but NO edit/delete
 * here. Scrollable inside the card.
 */
import { useEffect, useState } from 'react';
import { CardFrame, CardNote } from '../cardChrome';

const ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
);

interface KbEntry {
  id: string;
  text: string;
  kind: 'rule' | 'example';
  source: 'inspector' | 'admin' | 'auto';
  expected: string | null;
  addedByName: string | null;
  createdAt: number;
  updatedAt: number | null;
  samples: number | null;
  accepts: number | null;
  rejects: number | null;
  code: string | null;
}
interface KbCounts { total: number; auto: number; examples: number; }

function fmtDate(ms: number): string {
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
}

/** Badge identifying the entry kind/source, per the brief. */
function Badge({ entry }: { entry: KbEntry }) {
  let label: string, cls: string;
  if (entry.kind === 'example') { label = 'WORKED EXAMPLE'; cls = 'bg-[#73E3DF]/15 text-[#73E3DF]'; }
  else if (entry.source === 'auto') { label = 'AI-LEARNED'; cls = 'bg-[#ff0060]/15 text-[#ff0060]'; }
  else if (entry.source === 'admin') { label = 'ADMIN RULE'; cls = 'bg-white/10 text-[#f4f4f5]'; }
  else { label = 'INSPECTOR'; cls = 'bg-white/5 text-[#a1a1aa]'; }
  return (
    <span className={`inline-block rounded-full font-heading font-bold text-[10px] uppercase tracking-wide px-2 py-0.5 ${cls}`}>
      {label}
    </span>
  );
}

export function KbChanges() {
  const [entries, setEntries] = useState<KbEntry[] | null>(null);
  const [counts, setCounts] = useState<KbCounts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/insights/kb-changes', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) { setError(d.error); return; }
        setEntries(d.entries || []);
        setCounts(d.counts || null);
      })
      .catch((e) => { if (!cancelled) setError(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, []);

  const subtitle = counts
    ? `${counts.auto} AI-learned · ${counts.examples} examples · ${counts.total} total`
    : undefined;

  return (
    <CardFrame
      title="AI Knowledge Base changes" subtitle={subtitle} icon={ICON}
      bodyClassName="p-4 max-h-[420px] overflow-auto"
    >
      {error ? (
        <CardNote>Could not load knowledge base changes: {error}</CardNote>
      ) : entries === null ? (
        <CardNote>Loading…</CardNote>
      ) : entries.length === 0 ? (
        <CardNote>No knowledge base entries yet.</CardNote>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {entries.map((e) => (
            <li key={e.id} className="rounded-xl border border-white/10 bg-[#232329] p-3">
              <div className="flex items-center gap-2 mb-1.5">
                <Badge entry={e} />
                {e.source === 'auto' && e.samples != null && (
                  <span className="text-[11px] text-[#71717a]">
                    from {e.samples} decision{e.samples === 1 ? '' : 's'}
                    {(e.accepts != null || e.rejects != null) && (
                      <> ({e.accepts ?? 0}✓ / {e.rejects ?? 0}✗)</>
                    )}
                  </span>
                )}
              </div>
              <div className="text-sm text-[#f4f4f5] leading-snug">{e.text}</div>
              {e.kind === 'example' && e.expected && (
                <div className="text-[13px] text-[#73E3DF] mt-1">Correct action: {e.expected}</div>
              )}
              <div className="text-[11px] text-[#71717a] mt-2">
                {e.addedByName || e.source} · {fmtDate(e.updatedAt || e.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  );
}
