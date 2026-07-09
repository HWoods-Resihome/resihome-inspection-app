import { useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { worktypeLabel } from '@/lib/services/worktypes';
import { SAMPLE_SERVICES, type SampleService } from '@/lib/services/sampleData';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  const svc = SAMPLE_SERVICES.find((s) => s.id === String(ctx.params?.id)) || null;
  if (!svc) return { redirect: { destination: '/services', permanent: false } };
  return { props: { svc } };
};

// A short worktype-agnostic completion checklist (the real set will come from the
// reused Questions object per worktype in a later step).
const QUESTIONS = [
  { id: 'done', label: 'Work completed as scoped?', type: 'yesno' as const, required: true },
  { id: 'access', label: 'Gate / lock code used', type: 'short' as const, required: false },
  { id: 'notes', label: 'Notes for the coordinator', type: 'long' as const, required: false },
];

function PhotoTiles({ label, required, urls, onAdd }: { label: string; required?: boolean; urls: string[]; onAdd: () => void }) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{label}{required && <span className="text-brand"> *</span>}</div>
      <div className="grid grid-cols-4 gap-2">
        {urls.map((_, i) => (
          <div key={i} className="aspect-square rounded-lg bg-gray-200 border border-gray-300 flex items-center justify-center text-gray-400 text-xs">Photo {i + 1}</div>
        ))}
        <button type="button" onClick={onAdd} className="aspect-square rounded-lg border-2 border-dashed border-gray-300 text-gray-400 hover:border-brand hover:text-brand flex items-center justify-center text-2xl">+</button>
      </div>
    </div>
  );
}

export default function ServiceComplete({ svc }: { svc: SampleService }) {
  const [done, setDone] = useState<'yes' | 'no' | ''>('');
  const [access, setAccess] = useState('');
  const [notes, setNotes] = useState('');
  const [before, setBefore] = useState<string[]>([]);
  const [after, setAfter] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const canSubmit = done !== '' && after.length > 0;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-brand text-white sticky top-0 z-20 shrink-0" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
        <div className="max-w-2xl mx-auto px-4 pt-2 pb-2.5 flex items-center gap-3">
          <Link href="/services" className="text-white/90 hover:text-white text-sm shrink-0">← Services</Link>
          <div className="min-w-0">
            <h1 className="font-heading font-extrabold text-base tracking-tight truncate">{svc.address}</h1>
            <div className="text-xs text-white/80 truncate">{worktypeLabel(svc.worktype)} · {svc.locality}</div>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-4 flex-1 space-y-4">
        {submitted ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Completion submitted</div>
            <p className="text-sm text-gray-500 mt-1">This work order moves to <b>Submitted</b> for coordinator review. (Preview — nothing saved.)</p>
            <Link href="/services" className="inline-block mt-4 bg-brand text-white font-heading font-bold text-sm rounded-xl px-5 py-2.5">Back to Services</Link>
          </div>
        ) : (
          <>
            <div className="bg-white border border-gray-200 rounded-2xl p-4">
              <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-1">Work order</div>
              <div className="text-sm text-ink"><b>{worktypeLabel(svc.worktype)}</b> · {svc.scope === 'community' ? 'Community' : 'SFR'} · {svc.vendor || 'Unassigned'}</div>
              <div className="text-xs text-gray-500 mt-0.5">Due {svc.dueDate}</div>
            </div>

            <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-4">
              <div className="font-heading font-bold text-[15px] text-ink">Completion checklist</div>
              {QUESTIONS.map((q) => (
                <div key={q.id}>
                  <label className="block text-sm font-semibold text-ink mb-1.5">{q.label}{q.required && <span className="text-brand"> *</span>}</label>
                  {q.type === 'yesno' && (
                    <div className="flex gap-2">
                      {(['yes', 'no'] as const).map((v) => (
                        <button key={v} type="button" onClick={() => setDone(v)}
                          className={`px-5 py-2 rounded-full border text-sm font-heading font-semibold ${done === v ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>{v === 'yes' ? 'Yes' : 'No'}</button>
                      ))}
                    </div>
                  )}
                  {q.type === 'short' && (
                    <input value={access} onChange={(e) => setAccess(e.target.value)} className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand" placeholder="e.g. #4821" />
                  )}
                  {q.type === 'long' && (
                    <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand" placeholder="Optional" />
                  )}
                </div>
              ))}
            </section>

            <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-4">
              <div className="font-heading font-bold text-[15px] text-ink">Evidence</div>
              <PhotoTiles label="Before photos" urls={before} onAdd={() => setBefore((u) => [...u, 'x'])} />
              <PhotoTiles label="After photos" required urls={after} onAdd={() => setAfter((u) => [...u, 'x'])} />
            </section>

            <button type="button" disabled={!canSubmit} onClick={() => setSubmitted(true)}
              className={`w-full rounded-2xl py-3.5 font-heading font-bold text-sm ${canSubmit ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
              Submit completion
            </button>
            {!canSubmit && <div className="text-center text-xs text-gray-400 -mt-2">Answer “completed?” and add at least one after photo to submit.</div>}
          </>
        )}
      </main>
    </div>
  );
}
