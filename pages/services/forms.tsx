import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { ListPicker } from '@/components/ListPicker';
import { WORKTYPES, subtypesFor, worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import {
  ANSWER_TYPES, SAMPLE_FORMS, formKey, newQuestion, type ServiceQuestion, type AnswerType,
} from '@/lib/services/serviceForms';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  return { props: {} };
};

export default function FormBuilder() {
  const [forms, setForms] = useState<Record<string, ServiceQuestion[]>>(() => ({ ...SAMPLE_FORMS }));
  const [worktype, setWorktype] = useState('landscaping');
  const [subtype, setSubtype] = useState('cut');
  const key = formKey(worktype, subtype);
  const questions = forms[key] || [];

  const setQuestions = (next: ServiceQuestion[]) => setForms((f) => ({ ...f, [key]: next }));
  const patchQ = (id: string, p: Partial<ServiceQuestion>) => setQuestions(questions.map((q) => (q.id === id ? { ...q, ...p } : q)));
  const addQ = () => setQuestions([...questions, newQuestion()]);
  const delQ = (id: string) => setQuestions(questions.filter((q) => q.id !== id));
  const move = (id: string, dir: -1 | 1) => {
    const i = questions.findIndex((q) => q.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= questions.length) return;
    const next = [...questions];
    [next[i], next[j]] = [next[j], next[i]];
    setQuestions(next);
  };

  const worktypeOptions = useMemo(() => WORKTYPES.map((w) => ({ value: w.id, label: w.label })), []);
  const subtypeOptions = useMemo(() => subtypesFor(worktype).map((s) => ({ value: s.id, label: s.label })), [worktype]);

  const lbl = 'block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1';
  const trig = 'w-full flex items-center justify-between gap-2 text-[13px] border border-gray-300 rounded-lg px-2.5 py-2 bg-white text-ink';

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-brand text-white sticky top-0 z-30">
        <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            Services
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-8 w-8 object-cover shrink-0" />
          <div className="font-heading font-extrabold">Form Builder</div>
          <span className="text-[9px] font-bold uppercase tracking-wider bg-white/20 px-1.5 py-0.5 rounded">Admin · Sample</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto w-full px-4 py-4 space-y-4">
        {/* Work type + subtype selector — the form is per (work type × subtype). */}
        <section className="bg-white border border-gray-200 rounded-2xl p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <label className={lbl}>Work Type</label>
              <ListPicker value={worktype} options={worktypeOptions} ariaLabel="Work type" className={trig}
                onChange={(v) => { setWorktype(v); setSubtype(subtypesFor(v)[0]?.id || ''); }} />
            </div>
            <div className="w-40">
              <label className={lbl}>Subtype</label>
              <ListPicker value={subtype} options={subtypeOptions} ariaLabel="Subtype" className={trig} onChange={setSubtype} />
            </div>
            <div className="text-[12px] text-gray-500 ml-auto">
              Editing the form for <b className="text-ink">{worktypeLabel(worktype)} · {subtypeLabel(worktype, subtype)}</b>
            </div>
          </div>
        </section>

        {/* Question list */}
        <div className="space-y-3">
          {questions.map((q, idx) => (
            <QuestionCard key={q.id} q={q} idx={idx} total={questions.length}
              onPatch={(p) => patchQ(q.id, p)} onDelete={() => delQ(q.id)} onMove={(d) => move(q.id, d)}
              lbl={lbl} trig={trig} />
          ))}
          {questions.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-10 border border-dashed border-gray-300 rounded-2xl">
              No questions yet for this work type + subtype.
            </div>
          )}
        </div>

        <button onClick={addQ} className="w-full text-brand bg-brand/5 border border-dashed border-brand/40 rounded-xl py-2.5 text-[13px] font-heading font-bold">+ Add Question</button>

        <div className="sticky bottom-0 bg-gray-50 pt-2 pb-2">
          <button className="w-full rounded-2xl py-3 font-heading font-bold text-sm bg-brand text-white">Save Form</button>
          <div className="text-center text-[11px] text-gray-400 mt-1.5">Preview — nothing saved. In Step 2 this writes to the reused Question / Answer objects.</div>
        </div>
      </main>
    </div>
  );
}

function QuestionCard({ q, idx, total, onPatch, onDelete, onMove, lbl, trig }: {
  q: ServiceQuestion; idx: number; total: number;
  onPatch: (p: Partial<ServiceQuestion>) => void; onDelete: () => void; onMove: (d: -1 | 1) => void;
  lbl: string; trig: string;
}) {
  const toggle = (on: boolean, onText = 'Yes', offText = 'No', onClick: (v: boolean) => void = () => {}) => (
    <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[12px] font-heading font-semibold">
      <button type="button" onClick={() => onClick(true)} className={`px-3 py-1 rounded-md ${on ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>{onText}</button>
      <button type="button" onClick={() => onClick(false)} className={`px-3 py-1 rounded-md ${!on ? 'bg-white text-ink shadow-sm' : 'text-gray-600'}`}>{offText}</button>
    </div>
  );
  return (
    <section className="bg-white border border-gray-200 rounded-2xl p-4 relative">
      <div className="absolute top-3 right-3 flex items-center gap-1">
        <button onClick={() => onMove(-1)} disabled={idx === 0} aria-label="Move up" className="w-7 h-7 grid place-items-center rounded-md text-gray-400 hover:text-brand disabled:opacity-30">↑</button>
        <button onClick={() => onMove(1)} disabled={idx === total - 1} aria-label="Move down" className="w-7 h-7 grid place-items-center rounded-md text-gray-400 hover:text-brand disabled:opacity-30">↓</button>
        <button onClick={onDelete} aria-label="Delete question" className="w-7 h-7 grid place-items-center rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 text-lg leading-none">×</button>
      </div>

      <label className={lbl}>Question {idx + 1}</label>
      <input value={q.label} onChange={(e) => onPatch({ label: e.target.value })} placeholder="Question text…"
        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-ink focus:outline-none focus:border-brand mb-3" />

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-44">
          <label className={lbl}>Answer Type</label>
          <ListPicker value={q.type} options={ANSWER_TYPES.map((a) => ({ value: a.value, label: a.label }))} ariaLabel="Answer type" className={trig}
            onChange={(v) => onPatch({ type: v as AnswerType })} />
        </div>
        <div>
          <label className={lbl}>Required</label>
          {toggle(q.required, 'Yes', 'No', (v) => onPatch({ required: v }))}
        </div>
        <div>
          <label className={lbl}>Notes Field</label>
          {toggle(q.allowNotes, 'On', 'Off', (v) => onPatch({ allowNotes: v }))}
        </div>
      </div>

      {/* Trigger: an answer that spawns a follow-up Estimated service with its own photos. */}
      <div className="mt-3 border-t border-gray-100 pt-3">
        <label className="flex items-center gap-2 cursor-pointer mb-2">
          <input type="checkbox" checked={!!q.trigger}
            onChange={(e) => onPatch({ trigger: e.target.checked ? { whenAnswer: q.type === 'yesno' ? 'no' : 'yes', worktype: 'landscaping', subtype: 'cut', requirePhotos: true } : undefined })} />
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Triggers a Follow-Up Service <span className="normal-case font-normal text-gray-400">(created as Estimated)</span></span>
        </label>
        {q.trigger && (
          <div className="flex flex-wrap items-end gap-2 pl-1">
            {q.type === 'yesno' && (
              <div>
                <label className={lbl}>When answer is</label>
                <div className="inline-flex rounded-lg border border-gray-300 bg-gray-100 p-0.5 text-[12px] font-heading font-semibold">
                  {(['yes', 'no'] as const).map((a) => (
                    <button key={a} type="button" onClick={() => onPatch({ trigger: { ...q.trigger!, whenAnswer: a } })}
                      className={`px-3 py-1 rounded-md capitalize ${q.trigger!.whenAnswer === a ? 'bg-white text-brand shadow-sm' : 'text-gray-600'}`}>{a}</button>
                  ))}
                </div>
              </div>
            )}
            <div className="w-36">
              <label className={lbl}>Create Work Type</label>
              <ListPicker value={q.trigger.worktype} options={WORKTYPES.map((w) => ({ value: w.id, label: w.label }))} ariaLabel="Follow-up work type" className={trig}
                onChange={(v) => onPatch({ trigger: { ...q.trigger!, worktype: v, subtype: subtypesFor(v)[0]?.id || '' } })} />
            </div>
            <div className="w-36">
              <label className={lbl}>Subtype</label>
              <ListPicker value={q.trigger.subtype} options={subtypesFor(q.trigger.worktype).map((s) => ({ value: s.id, label: s.label }))} ariaLabel="Follow-up subtype" className={trig}
                onChange={(v) => onPatch({ trigger: { ...q.trigger!, subtype: v } })} />
            </div>
            <label className="flex items-center gap-2 text-[12px] text-gray-600 pb-2 cursor-pointer">
              <input type="checkbox" checked={q.trigger.requirePhotos} onChange={(e) => onPatch({ trigger: { ...q.trigger!, requirePhotos: e.target.checked } })} />
              Require separate photos
            </label>
          </div>
        )}
      </div>
    </section>
  );
}
