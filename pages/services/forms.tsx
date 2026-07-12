import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { isViewingAsVendor } from '@/lib/services/viewAs';
import { readServiceForms } from '@/lib/hubspot';
import { ListPicker } from '@/components/ListPicker';
import { AutoGrowTextarea } from '@/components/AutoGrowTextarea';
import { WORKTYPES, subtypesFor, worktypeLabel, subtypeLabel } from '@/lib/services/worktypes';
import {
  ANSWER_TYPES, SAMPLE_FORMS, formKey, newQuestion, newOption, answerTypeLabel, hasOptions,
  type ServiceQuestion, type AnswerType, type QuestionOption,
} from '@/lib/services/serviceForms';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  if (isViewingAsVendor(ctx.req)) return { redirect: { destination: '/services', permanent: false } };
  const admin = await isAppAdmin(session?.email).catch(() => false);
  // Persisted forms (Agent-record JSON) override the seeded defaults per key.
  const saved = admin ? await readServiceForms().catch(() => null) : null;
  return { props: { savedForms: saved || null, canSave: admin } };
};

const lbl = 'block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1';
const trig = 'w-full flex items-center justify-between gap-2 text-[13px] border border-gray-300 rounded-lg px-2.5 py-2 bg-white text-ink';

// One-line summary under a collapsed question (mirrors the inspection builder).
function subline(q: ServiceQuestion): string {
  const bits = [answerTypeLabel(q.type), q.required ? 'required' : 'optional'];
  if (hasOptions(q.type)) bits.push(`${q.options?.length || 0} choices`);
  if (q.requirePhoto) bits.push('photo');
  if (q.trigger) bits.push('triggers follow-up');
  return bits.join(' · ');
}

export default function FormBuilder({ savedForms, canSave }: { savedForms: Record<string, ServiceQuestion[]> | null; canSave: boolean }) {
  const [forms, setForms] = useState<Record<string, ServiceQuestion[]>>(() => ({ ...SAMPLE_FORMS, ...(savedForms || {}) }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [worktype, setWorktype] = useState('landscaping');
  const [subtype, setSubtype] = useState('cut');
  const [editId, setEditId] = useState<string | null>(null);
  const key = formKey(worktype, subtype);
  const questions = forms[key] || [];

  const setQuestions = (next: ServiceQuestion[]) => { setSaved(false); setForms((f) => ({ ...f, [key]: next })); };
  const saveAll = async () => {
    setSaving(true);
    try {
      const r = await fetch('/api/services/forms/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ forms }) });
      if (r.ok) setSaved(true);
    } catch { /* keep local; retry */ }
    finally { setSaving(false); }
  };
  const patchQ = (id: string, p: Partial<ServiceQuestion>) => setQuestions(questions.map((q) => (q.id === id ? { ...q, ...p } : q)));
  const delQ = (id: string) => { setQuestions(questions.filter((q) => q.id !== id)); if (editId === id) setEditId(null); };
  const addQ = () => { const q = newQuestion(); setQuestions([...questions, q]); setEditId(q.id); };
  const move = (id: string, dir: -1 | 1) => {
    const i = questions.findIndex((q) => q.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= questions.length) return;
    const next = [...questions];
    [next[i], next[j]] = [next[j], next[i]];
    setQuestions(next);
  };

  // ── Press-and-hold drag to reorder (pointer events; works on touch + mouse) ──
  const [dragId, setDragId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPress = () => { if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; } };
  const onCardPointerDown = (e: React.PointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest('button')) return; // don't start on On/Edit/Delete/arrows
    cancelPress();
    pressTimer.current = setTimeout(() => { dragRef.current = id; setDragId(id); }, 250);
  };
  const reorderOver = (clientY: number) => {
    const id = dragRef.current;
    if (!id) return;
    const cur = forms[key] || [];
    let targetId: string | null = null;
    for (const q of cur) {
      const el = cardRefs.current[q.id]; if (!el) continue;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) { targetId = q.id; break; }
    }
    if (!targetId || targetId === id) return;
    const from = cur.findIndex((q) => q.id === id);
    const to = cur.findIndex((q) => q.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...cur];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setQuestions(next);
  };
  const onListPointerMove = (e: React.PointerEvent) => { if (dragRef.current) { e.preventDefault(); reorderOver(e.clientY); } };
  const endDrag = () => { cancelPress(); dragRef.current = null; setDragId(null);
  };

  const worktypeOptions = useMemo(() => WORKTYPES.map((w) => ({ value: w.id, label: w.label })), []);
  const subtypeOptions = useMemo(() => subtypesFor(worktype).map((s) => ({ value: s.id, label: s.label })), [worktype]);

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
          {canSave && (
            <button onClick={saveAll} disabled={saving}
              className="ml-auto bg-white/15 hover:bg-white/25 text-white font-heading font-bold text-[13px] rounded-lg px-3.5 py-1.5 disabled:opacity-60">
              {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
            </button>
          )}
        </div>
      </header>

      <main className="max-w-3xl mx-auto w-full px-4 py-4 space-y-4">
        {/* Work type + subtype selector — the form is per (work type × subtype). */}
        <section className="bg-white border border-gray-200 rounded-2xl p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40">
              <label className={lbl}>Work Type</label>
              <ListPicker value={worktype} options={worktypeOptions} ariaLabel="Work type" className={trig}
                onChange={(v) => { setWorktype(v); setSubtype(subtypesFor(v)[0]?.id || ''); setEditId(null); }} />
            </div>
            <div className="w-40">
              <label className={lbl}>Subtype</label>
              <ListPicker value={subtype} options={subtypeOptions} ariaLabel="Subtype" className={trig} onChange={(v) => { setSubtype(v); setEditId(null); }} />
            </div>
            <button onClick={addQ} className="ml-auto bg-brand text-white font-heading font-bold text-sm rounded-xl px-4 py-2.5">+ Add Question</button>
          </div>
          <p className="text-[12px] text-gray-500 mt-3">
            Questions for <b className="text-ink">{worktypeLabel(worktype)} · {subtypeLabel(worktype, subtype)}</b>. <b>Save</b> to apply to new service completions of this type.
          </p>
        </section>

        {questions.length > 1 && !editId && (
          <div className="text-[11px] text-gray-400 -mb-1">Reorder with the arrows, or press &amp; hold a card and drag.</div>
        )}
        <div className="space-y-3" style={{ touchAction: dragId ? 'none' : undefined }}
          onPointerMove={onListPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
          {questions.map((q, idx) => (
            editId === q.id
              ? <QuestionEditor key={q.id} q={q} onPatch={(p) => patchQ(q.id, p)} onClose={() => setEditId(null)} onDelete={() => delQ(q.id)} />
              : (
                <section key={q.id} ref={(el) => { cardRefs.current[q.id] = el; }}
                  onPointerDown={(e) => onCardPointerDown(e, q.id)}
                  className={`bg-white border rounded-2xl p-4 flex items-start gap-3 select-none ${q.enabled ? '' : 'opacity-60'} ${dragId === q.id ? 'border-brand ring-2 ring-brand/40 shadow-lg' : 'border-gray-200'}`}>
                  <div className="flex flex-col shrink-0 gap-1">
                    <button onClick={() => move(q.id, -1)} disabled={idx === 0} aria-label="Move up"
                      className="w-8 h-8 grid place-items-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50 disabled:opacity-30">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
                    </button>
                    <button onClick={() => move(q.id, 1)} disabled={idx === questions.length - 1} aria-label="Move down"
                      className="w-8 h-8 grid place-items-center rounded-lg border border-gray-300 bg-white text-gray-600 hover:text-brand hover:border-brand/50 disabled:opacity-30">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
                    </button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-heading font-bold text-[14px] leading-snug text-ink">{q.label || <span className="text-gray-400 font-normal">Untitled question</span>}</div>
                    <div className="text-[12px] text-gray-500 mt-0.5">{subline(q)}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button onClick={() => patchQ(q.id, { enabled: !q.enabled })}
                      className={`text-[12px] font-heading font-semibold px-2.5 py-1.5 rounded-lg border ${q.enabled ? 'text-emerald-700 border-emerald-300 bg-emerald-50' : 'text-gray-500 border-gray-300 bg-white'}`}>{q.enabled ? 'On' : 'Off'}</button>
                    <button onClick={() => setEditId(q.id)} className="text-[12px] font-heading font-semibold px-2.5 py-1.5 rounded-lg border border-gray-300 bg-white text-gray-700 hover:border-brand/50">Edit</button>
                    <button onClick={() => delQ(q.id)} className="text-[12px] font-heading font-semibold px-2.5 py-1.5 rounded-lg border border-red-200 bg-white text-red-600 hover:bg-red-50">Delete</button>
                  </div>
                </section>
              )
          ))}
          {questions.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-10 border border-dashed border-gray-300 rounded-2xl">No questions yet — tap “+ Add Question”.</div>
          )}
        </div>

        {canSave && (
          <div className="sticky bottom-0 bg-gray-50 pt-2 pb-2">
            <button onClick={saveAll} disabled={saving}
              className="w-full rounded-2xl py-3 font-heading font-bold text-sm bg-brand text-white disabled:opacity-60">
              {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save Form'}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

// The expanded editor (pink) — mirrors the inspection builder, minus section/display
// order (we reorder with the up/down arrows on each card instead).
function QuestionEditor({ q, onPatch, onClose, onDelete }: {
  q: ServiceQuestion; onPatch: (p: Partial<ServiceQuestion>) => void; onClose: () => void; onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // When a question opens for editing, scroll the whole editor (incl. its Save
  // button) into view so you don't have to hunt for it below the fold.
  useEffect(() => {
    const t = setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    return () => clearTimeout(t);
  }, []);
  const check = (label: string, on: boolean, set: (v: boolean) => void) => (
    <label className="flex items-center gap-2 text-[13px] text-ink cursor-pointer">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /> {label}
    </label>
  );
  return (
    <section ref={ref} className="bg-pink-50 border border-brand/40 rounded-2xl p-4 space-y-3">
      <AutoGrowTextarea value={q.label} onChange={(e) => onPatch({ label: e.target.value })} minPx={52} placeholder="Question text…"
        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-ink focus:outline-none focus:border-brand" />

      <div className="flex flex-wrap items-end gap-4">
        <div className="w-48">
          <label className={lbl}>Answer Type</label>
          <ListPicker value={q.type} options={ANSWER_TYPES.map((a) => ({ value: a.value, label: a.label }))} ariaLabel="Answer type" className={trig}
            onChange={(v) => onPatch({ type: v as AnswerType, ...(hasOptions(v as AnswerType) && !q.options?.length ? { options: [newOption()] } : {}) })} />
        </div>
      </div>

      {hasOptions(q.type) && (
        <div>
          <label className={lbl}>Choices <span className="text-gray-400 normal-case font-normal">— a selection can adjust the vendor cost</span></label>
          <div className="space-y-1.5">
            {(q.options || []).map((o) => {
              const setOpt = (p: Partial<QuestionOption>) => onPatch({ options: (q.options || []).map((x) => (x.id === o.id ? { ...x, ...p } : x)) });
              return (
                <div key={o.id} className="flex flex-nowrap items-center gap-1.5">
                  <input value={o.label} onChange={(e) => setOpt({ label: e.target.value })} placeholder="Option label…"
                    className="flex-1 min-w-0 text-[13px] border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white text-ink focus:outline-none focus:border-brand" />
                  <ListPicker value={o.priceMode} ariaLabel="Price effect"
                    className="w-28 shrink-0 flex items-center justify-between gap-1 text-[13px] border border-gray-300 rounded-lg px-2 py-2 bg-white text-ink"
                    options={[{ value: 'none', label: 'No price' }, { value: 'delta', label: '+/− vendor $' }, { value: 'set', label: 'Set vendor $' }]}
                    onChange={(v) => setOpt({ priceMode: v as QuestionOption['priceMode'] })} />
                  {o.priceMode !== 'none' && (
                    <div className="flex items-center shrink-0"><span className="text-gray-400 mr-0.5 text-[13px]">$</span>
                      <input value={o.priceValue} inputMode="decimal" onChange={(e) => setOpt({ priceValue: e.target.value.replace(/[^\d.\-]/g, '') })} placeholder="0"
                        className="w-14 text-[13px] text-center tabular-nums border border-gray-300 rounded-lg px-1.5 py-1.5 bg-white text-ink focus:outline-none focus:border-brand" /></div>
                  )}
                  <button onClick={() => onPatch({ options: (q.options || []).filter((x) => x.id !== o.id) })} aria-label="Remove option"
                    className="shrink-0 w-7 h-7 grid place-items-center rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 text-lg leading-none">×</button>
                </div>
              );
            })}
          </div>
          <button onClick={() => onPatch({ options: [...(q.options || []), newOption()] })}
            className="mt-2 text-[12px] font-semibold text-gray-600 border border-gray-300 rounded-lg px-2.5 py-1 bg-white hover:border-brand/40">+ Add Choice</button>
        </div>
      )}

      {/* Trigger — an answer that spawns a follow-up Estimated service with its own photos. */}
      <div className="border-t border-brand/20 pt-3">
        <label className="flex items-center gap-2 cursor-pointer mb-2">
          <input type="checkbox" checked={!!q.trigger}
            onChange={(e) => onPatch({ trigger: e.target.checked ? { whenAnswer: q.type === 'yesno' ? 'no' : 'yes', worktype: 'landscaping', subtype: 'cut', requirePhotos: true } : undefined })} />
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Triggers a Follow-Up Service <span className="normal-case font-normal text-gray-400">(created as Estimated)</span></span>
        </label>
        {q.trigger && (
          <div className="flex flex-wrap items-end gap-2">
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

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-brand/20 pt-3">
        {check('Required', q.required, (v) => onPatch({ required: v }))}
        {check('Require photo', q.requirePhoto, (v) => onPatch({ requirePhoto: v }))}
        {check('Require note', q.requireNote, (v) => onPatch({ requireNote: v }))}
        {check('Enabled', q.enabled, (v) => onPatch({ enabled: v }))}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button onClick={onDelete} className="mr-auto text-[12px] font-heading font-semibold text-red-600 hover:underline">Delete</button>
        <button onClick={onClose} className="text-sm font-heading font-semibold text-gray-600 px-4 py-2">Cancel</button>
        <button onClick={onClose} className="text-sm font-heading font-bold text-white bg-brand rounded-lg px-5 py-2">Save</button>
      </div>
    </section>
  );
}
