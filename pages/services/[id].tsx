import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { worktypeLabel, subtypeLabel, type Worktype } from '@/lib/services/worktypes';
import { SAMPLE_FORMS, formKey, type ServiceQuestion } from '@/lib/services/serviceForms';
import { SAMPLE_SERVICES } from '@/lib/services/sampleData';
import { fetchServiceWorkOrder } from '@/lib/hubspot';
import { uploadPhoto } from '@/lib/photoUpload';

interface ServiceView {
  id: string; live: boolean;
  worktype: Worktype; subtype: string; scope: 'property' | 'community';
  address: string; locality: string; vendor: string | null; dueDate: string;
  petStations: boolean; status: string;
}

const normDate = (v: any): string => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{10,}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10); // epoch ms
  return s.slice(0, 10);
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  const canSubmit = isInternalEmail(session?.email);
  const id = String(ctx.params?.id || '');

  let svc: ServiceView | null = null;
  if (/^\d+$/.test(id)) {
    // Real Service Work Order (HubSpot record id).
    const rec = await fetchServiceWorkOrder(id).catch(() => null);
    if (rec) {
      const p = rec.props;
      svc = {
        id: rec.id, live: true,
        worktype: (p.worktype || 'landscaping') as Worktype, subtype: p.subtype || '',
        scope: p.scope === 'community' ? 'community' : 'property',
        address: p.address_snapshot || p.service_name || '(Service)', locality: p.locality_snapshot || '',
        vendor: p.vendor_name || null, dueDate: normDate(p.due_date),
        petStations: p.pet_stations === 'true', status: p.status || 'assigned',
      };
    }
  } else {
    // Sample fallback (preview ids like S-1041).
    const s = SAMPLE_SERVICES.find((x) => x.id === id);
    if (s) svc = {
      id: s.id, live: false, worktype: s.worktype, subtype: s.subtype, scope: s.scope,
      address: s.address, locality: s.locality, vendor: s.vendor, dueDate: s.dueDate,
      petStations: !!s.petStations, status: s.status,
    };
  }
  if (!svc) return { redirect: { destination: '/services', permanent: false } };
  const form = SAMPLE_FORMS[formKey(svc.worktype, svc.subtype)]?.filter((q) => q.enabled) || [];
  return { props: { svc, form, canSubmit } };
};

// ── Photo capture (file input → Vercel Blob/HubSpot via uploadPhoto) ──
function PhotoField({ label, required, urls, onChange }: {
  label: string; required?: boolean; urls: string[]; onChange: (next: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  const pick = () => inputRef.current?.click();
  const onFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const list = Array.from(files);
    setBusy((n) => n + list.length);
    for (const f of list) {
      try { const url = await uploadPhoto(f); if (url) onChange([...urls, url]); }
      catch { /* skip a failed file; the crew can retake */ }
      finally { setBusy((n) => Math.max(0, n - 1)); }
    }
    if (inputRef.current) inputRef.current.value = '';
  };
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{label}{required && <span className="text-brand"> *</span>}</div>
      <div className="grid grid-cols-4 gap-2">
        {urls.map((u, i) => (
          <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-gray-300 bg-gray-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt={`${label} ${i + 1}`} className="w-full h-full object-cover" />
            <button type="button" onClick={() => onChange(urls.filter((_, j) => j !== i))}
              className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white text-xs leading-none grid place-items-center" aria-label="Remove photo">×</button>
          </div>
        ))}
        <button type="button" onClick={pick} className="aspect-square rounded-lg border-2 border-dashed border-gray-300 text-gray-400 hover:border-brand hover:text-brand flex items-center justify-center text-2xl">
          {busy > 0 ? <span className="text-xs font-semibold">…</span> : '+'}
        </button>
      </div>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={(e) => onFiles(e.target.files)} />
    </div>
  );
}

export default function ServiceComplete({ svc, form, canSubmit }: { svc: ServiceView; form: ServiceQuestion[]; canSubmit: boolean }) {
  const already = svc.status === 'submitted' || svc.status === 'completed' || svc.status === 'review';
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [before, setBefore] = useState<string[]>([]);
  const [after, setAfter] = useState<string[]>([]);
  const [petBefore, setPetBefore] = useState<string[]>([]);
  const [petAfter, setPetAfter] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const setAns = (id: string, v: any) => setAnswers((a) => ({ ...a, [id]: v }));

  const requiredMissing = useMemo(() => form.some((q) => {
    if (!q.required) return false;
    const v = answers[q.id];
    if (q.type === 'multi') return !Array.isArray(v) || v.length === 0;
    return v === undefined || v === '' || v === null;
  }), [form, answers]);
  const ready = !requiredMissing && after.length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      const r = await fetch(`/api/services/${encodeURIComponent(svc.id)}/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, before, after, petBefore, petAfter, submittedAt: new Date().toISOString() }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not submit.'); return; }
      setSubmitted(true);
    } catch { setError('Couldn’t reach the server. Try again.'); }
    finally { setSubmitting(false); }
  };

  const inputCls = 'w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-brand text-white sticky top-0 z-20 shrink-0" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
        <div className="max-w-2xl mx-auto px-4 pt-2 pb-2.5 flex items-center gap-3">
          <Link href="/services" className="inline-flex items-center gap-1 text-white/90 hover:text-white text-sm font-semibold shrink-0">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
            Services
          </Link>
          <div className="min-w-0">
            <h1 className="font-heading font-extrabold text-base tracking-tight truncate">{svc.address}</h1>
            <div className="text-xs text-white/80 truncate">{worktypeLabel(svc.worktype)} · {subtypeLabel(svc.worktype, svc.subtype)} · {svc.locality}</div>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-4 flex-1 space-y-4">
        {submitted || already ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-indigo-100 text-indigo-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">{submitted ? 'Submitted — AI Processing' : `Already ${svc.status}`}</div>
            <p className="text-sm text-gray-500 mt-1">The AI reviews the photos, timing, and selections. If everything looks clean it moves to <b>Completed</b>; if anything needs a human it moves to <b>Review</b>.</p>
            <Link href="/services" className="inline-block mt-4 bg-brand text-white font-heading font-bold text-sm rounded-xl px-5 py-2.5">Back to Services</Link>
          </div>
        ) : (
          <>
            <div className="bg-white border border-gray-200 rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <div className="text-[11px] font-bold uppercase tracking-wider text-gray-400">Work order</div>
                <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${svc.live ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{svc.live ? 'Live' : 'Sample'}</span>
              </div>
              <div className="text-sm text-ink mt-1"><b>{worktypeLabel(svc.worktype)} · {subtypeLabel(svc.worktype, svc.subtype)}</b> · {svc.scope === 'community' ? 'Community' : 'SFR'} · {svc.vendor || 'Unassigned'}</div>
              {svc.dueDate && <div className="text-xs text-gray-500 mt-0.5">Due {svc.dueDate}</div>}
            </div>

            {!canSubmit && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[13px] text-amber-800">
                View only — completion is submitted by the assigned vendor/field crew.
              </div>
            )}

            <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-4">
              <div className="font-heading font-bold text-[15px] text-ink">Completion checklist</div>
              {form.length === 0 && <div className="text-[13px] text-gray-400">No completion form is configured for this service type yet.</div>}
              {form.map((q) => (
                <div key={q.id}>
                  <label className="block text-sm font-semibold text-ink mb-1.5">{q.label}{q.required && <span className="text-brand"> *</span>}</label>
                  {q.type === 'yesno' && (
                    <div className="flex gap-2">
                      {(['yes', 'no'] as const).map((v) => (
                        <button key={v} type="button" onClick={() => setAns(q.id, v)}
                          className={`px-5 py-2 rounded-full border text-sm font-heading font-semibold ${answers[q.id] === v ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>{v === 'yes' ? 'Yes' : 'No'}</button>
                      ))}
                    </div>
                  )}
                  {q.type === 'single' && (
                    <div className="flex flex-wrap gap-2">
                      {(q.options || []).map((o) => (
                        <button key={o.id} type="button" onClick={() => setAns(q.id, o.label)}
                          className={`px-3.5 py-2 rounded-full border text-[13px] font-heading font-semibold ${answers[q.id] === o.label ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>{o.label}</button>
                      ))}
                    </div>
                  )}
                  {q.type === 'multi' && (
                    <div className="flex flex-wrap gap-2">
                      {(q.options || []).map((o) => {
                        const sel: string[] = Array.isArray(answers[q.id]) ? answers[q.id] : [];
                        const on = sel.includes(o.label);
                        return (
                          <button key={o.id} type="button"
                            onClick={() => setAns(q.id, on ? sel.filter((x) => x !== o.label) : [...sel, o.label])}
                            className={`px-3.5 py-2 rounded-full border text-[13px] font-heading font-semibold ${on ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>{o.label}</button>
                        );
                      })}
                    </div>
                  )}
                  {q.type === 'text' && (
                    <textarea value={answers[q.id] || ''} onChange={(e) => setAns(q.id, e.target.value)} rows={q.requireNote ? 3 : 1} className={inputCls} placeholder={q.required ? '' : 'Optional'} />
                  )}
                  {q.type === 'number' && (
                    <input type="number" inputMode="decimal" value={answers[q.id] || ''} onChange={(e) => setAns(q.id, e.target.value)} className={inputCls} />
                  )}
                  {q.type === 'date' && (
                    <input type="date" value={answers[q.id] || ''} onChange={(e) => setAns(q.id, e.target.value)} className={inputCls} />
                  )}
                </div>
              ))}
            </section>

            <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-4">
              <div className="font-heading font-bold text-[15px] text-ink">Evidence</div>
              <PhotoField label="Before photos" urls={before} onChange={setBefore} />
              <PhotoField label="After photos" required urls={after} onChange={setAfter} />
              {svc.petStations && (
                <div className="border-t border-gray-100 pt-4 space-y-4">
                  <div className="text-[12px] font-bold uppercase tracking-wide text-brand">Pet Stations</div>
                  <PhotoField label="Pet station — before" urls={petBefore} onChange={setPetBefore} />
                  <PhotoField label="Pet station — after" urls={petAfter} onChange={setPetAfter} />
                </div>
              )}
            </section>

            <button type="button" disabled={!ready || !canSubmit} onClick={submit}
              className={`w-full rounded-2xl py-3.5 font-heading font-bold text-sm ${ready && canSubmit ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
              {submitting ? 'Submitting…' : 'Submit completion'}
            </button>
            {error && <div className="text-center text-xs text-red-600 -mt-2">{error}</div>}
            {canSubmit && !ready && !error && !submitting && <div className="text-center text-xs text-gray-400 -mt-2">Answer the required questions and add at least one after photo to submit.</div>}
          </>
        )}
      </main>
    </div>
  );
}
