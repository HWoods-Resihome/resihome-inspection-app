import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import { ListPicker } from '@/components/ListPicker';
import { MultiFilter } from '@/components/MultiFilter';
import { SaveFooter } from '@/components/SaveFooter';
import { mergeWorktypes, type CustomWorktypeDef } from '@/lib/services/worktypes';
import { SAMPLE_AI_CHECKS, newCheck, type AiCheck } from '@/lib/services/aiKnowledge';

// The Services AI knowledge now lives as the "Services" tab of the unified AI
// Knowledge page at /ai-knowledge — this route just redirects there. The
// component below is still exported and reused (embedded) by that page.
export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: { destination: '/ai-knowledge?tab=services', permanent: false },
});

const trig = 'w-full flex items-center justify-between gap-2 text-[13px] border border-gray-300 rounded-lg px-2.5 py-2 bg-white text-ink';
const miniLbl = 'block text-xs font-heading font-semibold text-gray-500 mb-1';

export default function ServicesAiKnowledge({ savedChecks, canSave, embedded, savedTaxonomy }: { savedChecks: AiCheck[] | null; canSave: boolean; embedded?: boolean; savedTaxonomy?: CustomWorktypeDef[] | null }) {
  // Built-in taxonomy merged with the admin's custom work types / subtypes.
  const defs = useMemo(() => mergeWorktypes(savedTaxonomy), [savedTaxonomy]);
  const subsOf = (wt: string) => defs.find((w) => w.id === wt)?.subtypes || [];
  const wtLabelOf = (wt: string) => defs.find((w) => w.id === wt)?.label || wt;
  const subLabelOf = (wt: string, st: string) => subsOf(wt).find((s) => s.id === st)?.label || st;
  const scopeLabel = (c: AiCheck) => `${c.worktype ? wtLabelOf(c.worktype) : 'All Work Types'} · ${c.subtype ? subLabelOf(c.worktype, c.subtype) : 'All Subtypes'}`;
  const wtOptions = useMemo(() => [{ value: 'all', label: 'All Work Types' }, ...defs.map((w) => ({ value: w.id, label: w.label }))], [defs]);
  const subOptions = (wt: string) => [{ value: 'all', label: 'All Subtypes' }, ...(wt ? subsOf(wt).map((s) => ({ value: s.id, label: s.label })) : [])];

  const [checks, setChecks] = useState<AiCheck[]>(() => (savedChecks && savedChecks.length ? savedChecks : [...SAMPLE_AI_CHECKS]));
  const [editId, setEditId] = useState<string | null>(null);
  const [wtFilter, setWtFilter] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [learning, setLearning] = useState(false);
  const [learnMsg, setLearnMsg] = useState('');
  // Add-panel local state (mirrors the Inspections "Add a rule" panel).
  const [ncText, setNcText] = useState('');
  const [ncWt, setNcWt] = useState('');
  const [ncSub, setNcSub] = useState('');

  const mutate = (fn: (cs: AiCheck[]) => AiCheck[]) => { setSaved(false); setChecks(fn); };
  const patch = (id: string, p: Partial<AiCheck>) => mutate((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  // Deleting an AI-learned (auto) check TOMBSTONES it (status: dismissed) so the
  // learning loop won't re-add it on the next "Learn now"; a human check is
  // removed outright.
  const del = (id: string) => {
    if (!confirm('Delete this check? The AI will stop using it.')) return;
    mutate((cs) => cs.flatMap((c) => {
      if (c.id !== id) return [c];
      return c.source === 'auto' ? [{ ...c, active: false, status: 'dismissed' as const }] : [];
    }));
    if (editId === id) setEditId(null);
  };
  const addCheck = () => {
    const text = ncText.trim();
    if (!text) return;
    const c: AiCheck = { ...newCheck(), check: text, worktype: ncWt, subtype: ncSub };
    mutate((cs) => [c, ...cs]);
    setNcText(''); setNcWt(''); setNcSub('');
  };
  const saveAll = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/services/ai-checks/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checks }) });
      if (r.ok) setSaved(true);
    } catch { /* keep local; retry */ }
    finally { setSaving(false); }
  };

  // Learn from reviewer decisions (approve/modify/reject + the reason a service
  // went to review). Merges ✨ AI-learned checks server-side and adopts the
  // returned merged array into local state so the footer Save preserves them.
  const learnNow = async () => {
    if (learning) return;
    setLearning(true); setLearnMsg('');
    try {
      const r = await fetch('/api/services/ai-learning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setLearnMsg(d.error || 'Learn failed.'); return; }
      if (Array.isArray(d.checks)) { setChecks(d.checks); setSaved(true); }
      setLearnMsg(d.candidates
        ? `Learned from ${d.samples} reviewed service${d.samples === 1 ? '' : 's'}: ${d.added} new, ${d.refreshed} updated.`
        : `No new patterns yet — reviewed ${d.samples} service${d.samples === 1 ? '' : 's'}.`);
    } catch { setLearnMsg('Couldn’t reach the server. Try again.'); }
    finally { setLearning(false); }
  };

  const visible = useMemo(() => checks.filter((c) =>
    c.status !== 'dismissed' && (wtFilter.length === 0 || wtFilter.includes(c.worktype || 'all'))), [checks, wtFilter]);

  return (
    <div className={embedded ? '' : 'min-h-screen bg-gray-50'}>
      {!embedded && (
      <header className="bg-brand text-white sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            Services
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-8 w-8 object-cover shrink-0" />
          <div className="font-heading font-extrabold">AI Knowledge</div>
        </div>
      </header>
      )}

      <main className={embedded ? '' : 'max-w-3xl mx-auto w-full px-4 py-4'}>
        <p className="text-[13px] text-gray-600 mb-4 leading-snug">
          On submit, a service enters <b className="text-ink">AI Processing</b>. The AI checks the evidence against these rules —
          all are equally important. If everything is clean it auto-moves to <b className="text-emerald-700">Completed</b>;
          any concern routes it to <b className="text-purple-700">Review</b> for a human.
        </p>

        {/* Learn from feedback — synthesize ✨ AI-learned checks from reviewer
            decisions (approve/modify/reject + the reason a service went to review). */}
        {canSave && (
          <div className="bg-violet-50 border border-violet-200 rounded-xl p-3 mb-5 flex items-center justify-between gap-3 flex-wrap">
            <div className="text-[13px] text-violet-900 min-w-0">
              <span className="font-heading font-semibold">Learn from feedback now</span>
              <span className="block text-violet-700/80 text-xs">Turn reviewer decisions (approve/modify/reject and why a service went to review) into ✨ AI-learned checks.</span>
              {learnMsg && <span className="block text-xs text-emerald-700 font-heading font-semibold mt-1">{learnMsg}</span>}
            </div>
            <button type="button" onClick={learnNow} disabled={learning}
              className="h-9 px-4 rounded-lg bg-violet-600 text-white font-heading font-bold text-sm hover:bg-violet-700 disabled:bg-gray-300 shrink-0">
              {learning ? 'Learning…' : 'Learn now'}
            </button>
          </div>
        )}

        {/* Add a check — mirrors the Inspections "Add a rule" panel. */}
        <div className="bg-white rounded-xl border border-gray-200 p-3 mb-5 shadow-sm">
          <label className={miniLbl}>Add a check</label>
          <textarea value={ncText} onChange={(e) => setNcText(e.target.value)} rows={2}
            placeholder="e.g. Back yard is clearly shown in the after photos…"
            className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm resize-y" />
          <div className="flex flex-wrap items-end gap-3 mt-2">
            <div className="w-40">
              <label className={miniLbl}>Work Type</label>
              <ListPicker value={ncWt || 'all'} options={wtOptions} ariaLabel="Work type" className={trig}
                onChange={(v) => { setNcWt(v === 'all' ? '' : v); setNcSub(''); }} />
            </div>
            <div className="w-40">
              <label className={miniLbl}>Subtype</label>
              <ListPicker value={ncSub || 'all'} disabled={!ncWt} options={subOptions(ncWt)} ariaLabel="Subtype"
                className={`${trig} ${!ncWt ? 'opacity-50' : ''}`} onChange={(v) => setNcSub(v === 'all' ? '' : v)} />
            </div>
            <button type="button" onClick={addCheck} disabled={!ncText.trim()}
              className="ml-auto h-9 px-4 rounded-lg bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
              Add check
            </button>
          </div>
        </div>

        {/* Work Type filter. */}
        <div className="flex items-center gap-2 mb-3">
          <div className="min-w-[160px]">
            <MultiFilter label="Work Type" selected={wtFilter} onChange={setWtFilter}
              className={`w-full truncate text-[12px] font-heading font-semibold pl-2.5 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${wtFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
              options={wtOptions} />
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="text-center text-gray-500 py-10 text-sm">No checks match this filter.</div>
        ) : (
          <ul className="space-y-2.5">
            {visible.map((c) => (
              <li key={c.id} className={`bg-white rounded-xl border border-gray-200 p-3 shadow-sm ${c.active ? '' : 'opacity-60'}`}>
                {editId === c.id ? (
                  <>
                    <textarea value={c.check} onChange={(e) => patch(c.id, { check: e.target.value })} rows={3}
                      placeholder="e.g. Back yard is clearly shown in the after photos…"
                      className="focus-brand w-full border border-gray-300 rounded-lg p-2.5 text-sm resize-y" />
                    <div className="flex flex-wrap items-end gap-3 mt-2">
                      <div className="w-40">
                        <label className={miniLbl}>Work Type</label>
                        <ListPicker value={c.worktype || 'all'} options={wtOptions} ariaLabel="Work type" className={trig}
                          onChange={(v) => patch(c.id, { worktype: v === 'all' ? '' : v, subtype: '' })} />
                      </div>
                      <div className="w-40">
                        <label className={miniLbl}>Subtype</label>
                        <ListPicker value={c.subtype || 'all'} disabled={!c.worktype} options={subOptions(c.worktype)} ariaLabel="Subtype"
                          className={`${trig} ${!c.worktype ? 'opacity-50' : ''}`} onChange={(v) => patch(c.id, { subtype: v === 'all' ? '' : v })} />
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 mt-2">
                      <button type="button" onClick={() => setEditId(null)} className="text-sm font-heading font-semibold text-gray-600 px-3 h-9">Cancel</button>
                      <button type="button" onClick={() => setEditId(null)} disabled={!c.check.trim()} className="h-9 px-4 rounded-lg bg-emerald-600 text-white font-heading font-bold text-sm disabled:bg-gray-300">Save</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mb-1.5 flex items-center gap-1.5 flex-wrap">
                      <span className="inline-flex items-center text-[10px] font-heading font-bold uppercase tracking-wide text-blue-700 bg-blue-100 border border-blue-200 rounded-full px-2 py-0.5">{scopeLabel(c)}</span>
                      {c.source === 'auto' && (
                        <>
                          <span className="inline-flex items-center gap-1 text-[10px] font-heading font-bold uppercase tracking-wide text-violet-700 bg-violet-100 border border-violet-200 rounded-full px-2 py-0.5">✨ AI-learned</span>
                          {c.meta?.samples != null && <span className="text-[10px] text-gray-400">from {c.meta.samples} review{c.meta.samples === 1 ? '' : 's'}</span>}
                        </>
                      )}
                    </div>
                    <p className="text-sm text-ink whitespace-pre-wrap">{c.check || <span className="text-gray-400">Empty check</span>}</p>
                    <div className="flex items-center justify-between gap-2 mt-2">
                      <button type="button" onClick={() => patch(c.id, { active: !c.active })}
                        className={`inline-flex items-center gap-1 text-xs font-heading font-semibold rounded-md px-2.5 py-1 border ${c.active ? 'text-emerald-700 border-emerald-300 bg-emerald-50' : 'text-gray-500 border-gray-300 bg-white'}`}>
                        {c.active ? 'On' : 'Off'}
                      </button>
                      <div className="flex items-center gap-2 shrink-0">
                        <button type="button" onClick={() => setEditId(c.id)}
                          className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md px-2.5 py-1">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                          Edit
                        </button>
                        <button type="button" onClick={() => del(c.id)}
                          className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md px-2.5 py-1">
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>
                          Delete
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {canSave && <SaveFooter label="Save Knowledge Base" onClick={saveAll} busy={saving} saved={saved} />}
      </main>
    </div>
  );
}
