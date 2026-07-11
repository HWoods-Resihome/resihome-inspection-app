import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { ListPicker } from '@/components/ListPicker';
import { MultiFilter } from '@/components/MultiFilter';
import { WORKTYPES, subtypesFor, worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import { SAMPLE_AI_CHECKS, newCheck, type AiCheck } from '@/lib/services/aiKnowledge';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};

const lbl = 'block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1';
const trig = 'w-full flex items-center justify-between gap-2 text-[13px] border border-gray-300 rounded-lg px-2.5 py-2 bg-white text-ink';
const scopeLabel = (c: AiCheck) =>
  `${c.worktype ? worktypeLabel(c.worktype) : 'All Work Types'} · ${c.subtype ? subtypeLabel(c.worktype, c.subtype) : 'All Subtypes'}`;

export default function ServicesAiKnowledge() {
  const [checks, setChecks] = useState<AiCheck[]>(() => [...SAMPLE_AI_CHECKS]);
  const [editId, setEditId] = useState<string | null>(null);
  const [wtFilter, setWtFilter] = useState<string[]>([]);

  const patch = (id: string, p: Partial<AiCheck>) => setChecks((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const del = (id: string) => { setChecks((cs) => cs.filter((c) => c.id !== id)); if (editId === id) setEditId(null); };
  const add = () => { const c = newCheck(); setChecks((cs) => [c, ...cs]); setEditId(c.id); };

  const visible = useMemo(() => checks.filter((c) =>
    wtFilter.length === 0 || wtFilter.includes(c.worktype || 'all')), [checks, wtFilter]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-brand text-white sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            Services
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-8 w-8 object-cover shrink-0" />
          <div className="font-heading font-extrabold">AI Knowledge</div>
          <span className="text-[9px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.5 rounded">Admin · Sample</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto w-full px-4 py-4 space-y-4">
        <section className="bg-white border border-gray-200 rounded-2xl p-4">
          <p className="text-[13px] text-gray-600">
            On submit, a service enters <b className="text-ink">AI Processing</b>. The AI checks the evidence against these rules —
            all are equally important. If everything is clean it auto-moves to <b className="text-emerald-700">Completed</b>;
            any concern routes it to <b className="text-purple-700">Review</b> for a human.
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <div className="flex-1 min-w-[140px]">
              <MultiFilter label="Work Type" selected={wtFilter} onChange={setWtFilter}
                className={`w-full truncate text-[12px] font-heading font-semibold pl-2.5 pr-1 py-1.5 border rounded-lg bg-white flex items-center justify-between ${wtFilter.length ? 'border-brand text-brand' : 'border-gray-300 text-gray-700'}`}
                options={[{ value: 'all', label: 'All Work Types' }, ...WORKTYPES.map((w) => ({ value: w.id, label: w.label }))]} />
            </div>
            <button onClick={add} className="shrink-0 bg-brand text-white font-heading font-bold text-sm rounded-xl px-4 py-2">+ Add Check</button>
          </div>
        </section>

        <div className="space-y-3">
          {visible.map((c) => (
            editId === c.id
              ? <CheckEditor key={c.id} c={c} onPatch={(p) => patch(c.id, p)} onClose={() => setEditId(null)} onDelete={() => del(c.id)} />
              : (
                <section key={c.id} className={`bg-white border border-gray-200 rounded-2xl p-4 ${c.active ? '' : 'opacity-60'}`}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1"><span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">{scopeLabel(c)}</span></div>
                      <div className="text-[13px] text-ink">{c.check || <span className="text-gray-400">Empty check</span>}</div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => patch(c.id, { active: !c.active })}
                        className={`text-[12px] font-heading font-semibold px-2.5 py-1.5 rounded-lg border ${c.active ? 'text-emerald-700 border-emerald-300 bg-emerald-50' : 'text-gray-500 border-gray-300 bg-white'}`}>{c.active ? 'On' : 'Off'}</button>
                      <button onClick={() => setEditId(c.id)} className="text-[12px] font-heading font-semibold px-2.5 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:border-brand/50">Edit</button>
                      <button onClick={() => del(c.id)} className="text-[12px] font-heading font-semibold px-2.5 py-1.5 rounded-lg border border-red-200 bg-white text-red-600 hover:bg-red-50">Delete</button>
                    </div>
                  </div>
                </section>
              )
          ))}
          {visible.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-10 border border-dashed border-gray-300 rounded-2xl">No checks match this filter.</div>
          )}
        </div>

        <div className="sticky bottom-0 bg-gray-50 pt-2 pb-2">
          <button className="w-full rounded-2xl py-3 font-heading font-bold text-sm bg-brand text-white">Save Knowledge Base</button>
          <div className="text-center text-[11px] text-gray-400 mt-1.5">Preview — nothing saved. Step 2 persists these and feeds them into the AI review.</div>
        </div>
      </main>
    </div>
  );
}

function CheckEditor({ c, onPatch, onClose, onDelete }: {
  c: AiCheck; onPatch: (p: Partial<AiCheck>) => void; onClose: () => void; onDelete: () => void;
}) {
  return (
    <section className="bg-pink-50 border border-brand/40 rounded-2xl p-4 space-y-3">
      <div>
        <label className={lbl}>Check — what the AI must verify</label>
        <textarea value={c.check} onChange={(e) => onPatch({ check: e.target.value })} rows={2} placeholder="e.g. Back yard is clearly shown in the after photos…"
          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-ink focus:outline-none focus:border-brand" />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-44">
          <label className={lbl}>Work Type</label>
          <ListPicker value={c.worktype || 'all'} options={[{ value: 'all', label: 'All Work Types' }, ...WORKTYPES.map((w) => ({ value: w.id, label: w.label }))]} ariaLabel="Work type" className={trig}
            onChange={(v) => onPatch({ worktype: v === 'all' ? '' : v, subtype: '' })} />
        </div>
        <div className="w-44">
          <label className={lbl}>Subtype</label>
          <ListPicker value={c.subtype || 'all'} disabled={!c.worktype}
            options={[{ value: 'all', label: 'All Subtypes' }, ...(c.worktype ? subtypesFor(c.worktype).map((s) => ({ value: s.id, label: s.label })) : [])]}
            ariaLabel="Subtype" className={`${trig} ${!c.worktype ? 'opacity-50' : ''}`}
            onChange={(v) => onPatch({ subtype: v === 'all' ? '' : v })} />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onDelete} className="mr-auto text-[12px] font-heading font-semibold text-red-600 hover:underline">Delete</button>
        <button onClick={onClose} className="text-sm font-heading font-semibold text-gray-600 px-4 py-2">Cancel</button>
        <button onClick={onClose} className="text-sm font-heading font-bold text-white bg-brand rounded-lg px-5 py-2">Save</button>
      </div>
    </section>
  );
}
