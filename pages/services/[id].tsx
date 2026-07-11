import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';
import type { NextApiRequest } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isInternalEmail } from '@/lib/userAccess';
import { worktypeLabel, subtypeLabel, type Worktype } from '@/lib/services/worktypes';
import { SAMPLE_FORMS, formKey, type ServiceQuestion } from '@/lib/services/serviceForms';
import { SAMPLE_SERVICES } from '@/lib/services/sampleData';
import { fetchServiceWorkOrder, fetchPropertyLockInfo } from '@/lib/hubspot';
import { CameraCapture } from '@/components/CameraCapture';
import { PhotoThumb } from '@/components/PhotoThumb';
import { PhotoLightbox } from '@/components/PhotoLightbox';
import { UnlockButton, lockRingFromProperty, type LockRing } from '@/components/UnlockButton';
import { capturePhotoOrQueue, submitServiceOrQueue, initServiceSync, hasPendingSubmit, onServiceSync } from '@/lib/services/offlineServices';

interface ServiceView {
  id: string; live: boolean;
  worktype: Worktype; subtype: string; scope: 'property' | 'community';
  address: string; locality: string; vendor: string | null; dueDate: string;
  petStations: boolean; status: string; propertyRecordId: string;
  vendorCost: number | null; markupPct: number | null; clientCost: number | null;
  vendorCostAdjustment: number | null; adjustmentReason: string;
  aiVerdict: string; aiNotes: string;
  reviewDecision: string; reviewNotes: string; reviewedBy: string;
  answers: Record<string, any>;
  before: string[]; after: string[]; petBefore: string[]; petAfter: string[];
}

const EDITABLE = new Set(['', 'estimated', 'assigned']);
const splitUrls = (v: any): string[] => String(v || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
const num = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const normDate = (v: any): string => {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (/^\d{10,}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  return s.slice(0, 10);
};

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSessionFromRequest(ctx.req as unknown as NextApiRequest).catch(() => null);
  const ok = await servicesEnabled(session?.email).catch(() => false);
  if (!ok) return { redirect: { destination: '/', permanent: false } };
  const isInternal = isInternalEmail(session?.email);
  const id = String(ctx.params?.id || '');

  let svc: ServiceView | null = null;
  if (/^\d+$/.test(id)) {
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
        propertyRecordId: p.property_id_ref || '',
        vendorCost: num(p.vendor_cost), markupPct: num(p.markup_pct), clientCost: num(p.client_cost),
        vendorCostAdjustment: num(p.vendor_cost_adjustment), adjustmentReason: p.vendor_cost_adjustment_reason || '',
        aiVerdict: p.ai_verdict || '', aiNotes: p.ai_notes || '',
        reviewDecision: p.review_decision || '', reviewNotes: p.review_notes || '', reviewedBy: p.reviewed_by || '',
        answers: (() => { try { return JSON.parse(p.answers_json || '{}'); } catch { return {}; } })(),
        before: splitUrls(p.before_photo_urls), after: splitUrls(p.after_photo_urls),
        petBefore: splitUrls(p.pet_before_photo_urls), petAfter: splitUrls(p.pet_after_photo_urls),
      };
    }
  } else {
    const s = SAMPLE_SERVICES.find((x) => x.id === id);
    if (s) svc = {
      id: s.id, live: false, worktype: s.worktype, subtype: s.subtype, scope: s.scope,
      address: s.address, locality: s.locality, vendor: s.vendor, dueDate: s.dueDate,
      petStations: !!s.petStations, status: s.status, propertyRecordId: '',
      vendorCost: null, markupPct: null, clientCost: null, vendorCostAdjustment: null, adjustmentReason: '',
      aiVerdict: '', aiNotes: '', reviewDecision: '', reviewNotes: '', reviewedBy: '',
      answers: {}, before: [], after: [], petBefore: [], petAfter: [],
    };
  }
  if (!svc) return { redirect: { destination: '/services', permanent: false } };
  const form = SAMPLE_FORMS[formKey(svc.worktype, svc.subtype)]?.filter((q) => q.enabled) || [];

  // Cleaning services at a NON-"Tenant Leased" (i.e. vacant) home need indoor
  // access — surface the same Rently unlock button + online/offline ring the
  // inspection uses. Only cleaning; only when the property isn't tenant-occupied.
  let unlock: { propertyId: string; address: string; ring: LockRing } | null = null;
  if (svc.live && svc.scope === 'property' && svc.worktype === 'cleaning' && svc.propertyRecordId) {
    const info = await fetchPropertyLockInfo(svc.propertyRecordId).catch(() => null);
    if (info && info.status && info.status !== 'Tenant Leased') {
      unlock = { propertyId: svc.propertyRecordId, address: svc.address, ring: lockRingFromProperty(info.deviceType, info.hubStatus, info.lockStatus) };
    }
  }
  return { props: { svc, form, isInternal, unlock } };
};

const money = (n: number | null | undefined) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Camera-backed photo group (recycles the 1099 in-camera + gallery experience) ──
function CameraPhotos({ label, required, urls, onChange, address, propertyRecordId, upload }: {
  label: string; required?: boolean; urls: string[]; onChange: (next: string[]) => void; address: string; propertyRecordId: string;
  upload: (file: File) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{label}{required && <span className="text-brand"> *</span>}</div>
      <div className="grid grid-cols-4 gap-2">
        {urls.map((u, i) => (
          <div key={`${u}-${i}`} className="relative aspect-square rounded-lg overflow-hidden border border-gray-300 bg-gray-100">
            <PhotoThumb url={u} alt={`${label} ${i + 1}`} className="w-full h-full object-cover" />
            {u.startsWith('blob:') && <span className="absolute bottom-0.5 left-0.5 text-[9px] font-bold text-white bg-black/55 rounded px-1">syncing</span>}
            <button type="button" onClick={() => onChange(urls.filter((_, j) => j !== i))}
              className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white text-xs leading-none grid place-items-center" aria-label="Remove photo">×</button>
          </div>
        ))}
        <button type="button" onClick={() => setOpen(true)} className="aspect-square rounded-lg border-2 border-dashed border-gray-300 text-gray-400 hover:border-brand hover:text-brand flex items-center justify-center text-2xl">+</button>
      </div>
      <CameraCapture isOpen={open} onClose={() => setOpen(false)} uploadPhoto={upload}
        addressSnapshot={address} propertyRecordId={propertyRecordId || undefined}
        onComplete={(newUrls) => { setOpen(false); if (newUrls.length) onChange([...urls, ...newUrls]); }} />
    </div>
  );
}

function PhotoGrid({ label, urls, onOpen }: { label: string; urls: string[]; onOpen: (index: number) => void }) {
  if (!urls.length) return null;
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">{label}</div>
      <div className="grid grid-cols-4 gap-2">
        {urls.map((u, i) => (
          <button key={`${u}-${i}`} type="button" onClick={() => onOpen(i)}
            className="aspect-square rounded-lg overflow-hidden border border-gray-300 bg-gray-100 cursor-zoom-in">
            <PhotoThumb url={u} alt={`${label} ${i + 1}`} className="w-full h-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ServiceDetail({ svc, form, isInternal, unlock }: { svc: ServiceView; form: ServiceQuestion[]; isInternal: boolean; unlock: { propertyId: string; address: string; ring: LockRing } | null }) {
  const editable = EDITABLE.has(svc.status);
  const underReview = svc.status === 'review';
  const canReview = isInternal && underReview;

  // ── Completion (editable) state ──
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [before, setBefore] = useState<string[]>([]);
  const [after, setAfter] = useState<string[]>([]);
  const [petBefore, setPetBefore] = useState<string[]>([]);
  const [petAfter, setPetAfter] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [doneStatus, setDoneStatus] = useState<string>('');   // '' | submitted | queued | completed
  const [error, setError] = useState('');
  const [pendingQueued, setPendingQueued] = useState(false);
  const setAns = (id: string, v: any) => setAnswers((a) => ({ ...a, [id]: v }));

  // Kick offline sync (photos + any queued submit) on mount and reconnect; flag a
  // completion that's already queued offline for this service.
  useEffect(() => {
    initServiceSync();
    let alive = true;
    hasPendingSubmit(svc.id).then((p) => { if (alive) setPendingQueued(p); }).catch(() => {});
    // When a queued photo finishes uploading, swap its draft blob: URL for the hosted URL.
    const off = onServiceSync(({ url, draftUrl }) => {
      if (!draftUrl) return;
      const swap = (arr: string[]) => arr.map((u) => (u === draftUrl ? url : u));
      setBefore(swap); setAfter(swap); setPetBefore(swap); setPetAfter(swap);
    });
    return () => { alive = false; off(); };
  }, [svc.id]);
  const uploadFor = useMemo(() => (file: File) => capturePhotoOrQueue(svc.id, file), [svc.id]);

  const requiredMissing = useMemo(() => form.some((q) => {
    if (!q.required) return false;
    const v = answers[q.id];
    if (q.type === 'multi') return !Array.isArray(v) || v.length === 0;
    return v === undefined || v === '' || v === null;
  }), [form, answers]);
  const ready = !requiredMissing && before.length > 0 && after.length > 0 && !submitting;

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      const res = await submitServiceOrQueue(svc.id, { answers, before, after, petBefore, petAfter, submittedAt: new Date().toISOString() });
      setDoneStatus(res.status === 'sent' ? 'submitted' : 'queued');
    } catch { setError('Couldn’t save. Try again.'); }
    finally { setSubmitting(false); }
  };

  // ── Review (approve/reject) state ──
  const [reviewNotes, setReviewNotes] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectCost, setRejectCost] = useState('0');       // default reject → $0
  const [rejectReason, setRejectReason] = useState('');
  const [deciding, setDeciding] = useState(false);

  const origCost = svc.vendorCost ?? 0;
  const decide = async (decision: 'approve' | 'reject') => {
    setDeciding(true); setError('');
    try {
      const body: any = { decision, notes: reviewNotes };
      if (decision === 'reject') { body.vendorCost = Number(rejectCost || '0'); body.reason = rejectReason || reviewNotes; }
      const r = await fetch(`/api/services/${encodeURIComponent(svc.id)}/review-decision`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Could not save decision.'); return; }
      setDoneStatus('completed');
    } catch { setError('Couldn’t reach the server. Try again.'); }
    finally { setDeciding(false); }
  };

  const inputCls = 'w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:border-brand';
  const chip = (t: string, cls: string) => <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${cls}`}>{t}</span>;

  // Photo gallery (read-only lightbox): Before / After / Pet groups you can toggle
  // between and swipe through — same viewer inspections use.
  const gallery = useMemo(() => {
    const groups: { id: string; name: string }[] = [];
    const map: Record<string, string[]> = {};
    const add = (id: string, name: string, urls: string[]) => { if (urls.length) { groups.push({ id, name }); map[id] = urls; } };
    add('before', 'Before', svc.before); add('after', 'After', svc.after);
    add('petBefore', 'Pet — Before', svc.petBefore); add('petAfter', 'Pet — After', svc.petAfter);
    return { groups, map };
  }, [svc]);
  const [lightbox, setLightbox] = useState<{ groupId: string; index: number } | null>(null);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b-2 border-brand sticky top-0 z-20 shrink-0" style={{ paddingTop: 'min(env(safe-area-inset-top), 0.5rem)' }}>
        <div className="max-w-2xl mx-auto px-3 pt-2 pb-2.5 flex items-start gap-2.5">
          <Link href="/services" aria-label="Back to Services" className="shrink-0 mt-1 text-gray-400 hover:text-ink">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
          </Link>
          <img src="/app-icon.svg" alt="ResiWalk" className="h-9 w-9 object-cover shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h1 className="font-heading font-extrabold text-[15px] text-ink leading-snug min-w-0">{svc.address}{svc.locality ? `, ${svc.locality}` : ''}</h1>
              <div className="flex items-center gap-1.5 shrink-0">
                {unlock && <UnlockButton propertyId={unlock.propertyId} address={unlock.address} lockRing={unlock.ring} className="w-7 h-7" />}
                <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${underReview ? 'bg-amber-100 text-amber-700' : svc.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : svc.status === 'submitted' ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-500'}`}>{svc.status || 'assigned'}</span>
              </div>
            </div>
            <div className="text-xs text-gray-500 mt-0.5 truncate">{worktypeLabel(svc.worktype)} · {subtypeLabel(svc.worktype, svc.subtype)} · {svc.scope === 'community' ? 'Community' : 'SFR'} · {svc.vendor || 'Unassigned'}</div>
            <div className="text-xs text-gray-500 truncate">
              {svc.dueDate ? `Due ${svc.dueDate}` : ''}
              {svc.vendorCost != null ? `${svc.dueDate ? ' · ' : ''}Vendor ${money(svc.vendorCost)}` : ''}
              {isInternal && svc.markupPct != null ? ` · Markup ${svc.markupPct}%` : ''}
              {isInternal && svc.clientCost != null ? ` · Client ${money(svc.clientCost)}` : ''}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto w-full px-4 py-4 flex-1 space-y-4">
        {doneStatus === 'submitted' ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-indigo-100 text-indigo-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Submitted — AI Processing</div>
            <p className="text-sm text-gray-500 mt-1">The AI reviews the photos, timing, and selections. If everything looks clean it moves to <b>Completed</b>; if anything needs a human it moves to <b>Review</b>.</p>
            <Link href="/services" className="inline-block mt-4 bg-brand text-white font-heading font-bold text-sm rounded-xl px-5 py-2.5">Back to Services</Link>
          </div>
        ) : doneStatus === 'queued' ? (
          <div className="bg-white border border-amber-300 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 grid place-items-center text-2xl mx-auto mb-3">⤓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Saved offline</div>
            <p className="text-sm text-gray-500 mt-1">You’re offline. This completion and its photos are saved on your device and will submit automatically the moment you’re back online — you can close the app.</p>
            <Link href="/services" className="inline-block mt-4 bg-brand text-white font-heading font-bold text-sm rounded-xl px-5 py-2.5">Back to Services</Link>
          </div>
        ) : doneStatus === 'completed' ? (
          <div className="bg-white border border-emerald-300 rounded-2xl p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 grid place-items-center text-2xl mx-auto mb-3">✓</div>
            <div className="font-heading font-extrabold text-lg text-ink">Completed</div>
            <p className="text-sm text-gray-500 mt-1">The decision was recorded and the service is closed out.</p>
            <Link href="/services" className="inline-block mt-4 bg-brand text-white font-heading font-bold text-sm rounded-xl px-5 py-2.5">Back to Services</Link>
          </div>
        ) : (
          <>
            {/* View PDF — available once the service has been submitted (live records). */}
            {!editable && svc.live && (
              <a href={`/api/services/${encodeURIComponent(svc.id)}/pdf`} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[13px] font-heading font-bold text-brand">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                View PDF
              </a>
            )}

            {pendingQueued && editable && (
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[13px] text-amber-800">
                A completion for this service is saved offline and will submit automatically when you’re back online. No need to re-enter it.
              </div>
            )}

            {editable ? (
              /* ── Editable completion form (assigned crew) ── */
              <>
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
                  <div className="font-heading font-bold text-[15px] text-ink">Photos</div>
                  <CameraPhotos label="Before photos" required urls={before} onChange={setBefore} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                  <CameraPhotos label="After photos" required urls={after} onChange={setAfter} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                  {svc.petStations && (
                    <div className="border-t border-gray-100 pt-4 space-y-4">
                      <div className="text-[12px] font-bold uppercase tracking-wide text-brand">Pet Stations</div>
                      <CameraPhotos label="Pet station — before" urls={petBefore} onChange={setPetBefore} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                      <CameraPhotos label="Pet station — after" urls={petAfter} onChange={setPetAfter} address={svc.address} propertyRecordId={svc.propertyRecordId} upload={uploadFor} />
                    </div>
                  )}
                </section>

                <button type="button" disabled={!ready} onClick={submit}
                  className={`w-full rounded-2xl py-3.5 font-heading font-bold text-sm ${ready ? 'bg-brand text-white' : 'bg-gray-200 text-gray-400'}`}>
                  {submitting ? 'Submitting…' : 'Submit completion'}
                </button>
                {error && <div className="text-center text-xs text-red-600 -mt-2">{error}</div>}
                {!ready && !error && !submitting && <div className="text-center text-xs text-gray-400 -mt-2">Answer the required questions and add at least one before and one after photo to submit.</div>}
              </>
            ) : (
              /* ── Read-only view (submitted / review / completed) ── */
              <>
                {(svc.aiVerdict || svc.aiNotes) && (
                  <section className="bg-white border border-gray-200 rounded-2xl p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="font-heading font-bold text-[15px] text-ink">AI review</div>
                      {svc.aiVerdict && chip(svc.aiVerdict === 'clean' ? 'Clean' : 'Needs review', svc.aiVerdict === 'clean' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}
                    </div>
                    {svc.aiNotes && <p className="text-[13px] text-gray-600 whitespace-pre-line">{svc.aiNotes}</p>}
                  </section>
                )}

                {Object.keys(svc.answers).length > 0 && (
                  <section className="bg-white border border-gray-200 rounded-2xl p-4">
                    <div className="font-heading font-bold text-[15px] text-ink mb-2">Answers</div>
                    <dl className="space-y-1.5">
                      {form.map((q) => svc.answers[q.id] != null && svc.answers[q.id] !== '' && (
                        <div key={q.id} className="flex gap-2 text-[13px]">
                          <dt className="text-gray-500 flex-1">{q.label}</dt>
                          <dd className="text-ink font-semibold text-right">{Array.isArray(svc.answers[q.id]) ? svc.answers[q.id].join(', ') : String(svc.answers[q.id])}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}

                <section className="bg-white border border-gray-200 rounded-2xl p-4 space-y-4">
                  <div className="font-heading font-bold text-[15px] text-ink">Photos <span className="text-[11px] font-normal text-gray-400">— tap a photo to enlarge</span></div>
                  <PhotoGrid label="Before photos" urls={svc.before} onOpen={(i) => setLightbox({ groupId: 'before', index: i })} />
                  <PhotoGrid label="After photos" urls={svc.after} onOpen={(i) => setLightbox({ groupId: 'after', index: i })} />
                  <PhotoGrid label="Pet station — before" urls={svc.petBefore} onOpen={(i) => setLightbox({ groupId: 'petBefore', index: i })} />
                  <PhotoGrid label="Pet station — after" urls={svc.petAfter} onOpen={(i) => setLightbox({ groupId: 'petAfter', index: i })} />
                  {!svc.before.length && !svc.after.length && !svc.petBefore.length && !svc.petAfter.length && <div className="text-[13px] text-gray-400">No photos on this service.</div>}
                </section>

                {svc.reviewDecision && (
                  <section className={`border rounded-2xl p-4 ${svc.reviewDecision === 'approve' ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                    <div className="font-heading font-bold text-[14px] text-ink">Review: {svc.reviewDecision === 'approve' ? 'Approved' : 'Rejected'}{svc.reviewedBy ? ` · ${svc.reviewedBy}` : ''}</div>
                    {svc.reviewNotes && <p className="text-[13px] text-gray-700 mt-1 whitespace-pre-line">{svc.reviewNotes}</p>}
                    {svc.reviewDecision === 'reject' && svc.vendorCostAdjustment != null && svc.vendorCostAdjustment > 0 && (
                      <p className="text-[13px] text-red-700 mt-1 font-semibold">Payout reduced by {money(svc.vendorCostAdjustment)} → vendor {money(svc.vendorCost)}{svc.adjustmentReason ? ` (${svc.adjustmentReason})` : ''}</p>
                    )}
                  </section>
                )}

                {canReview && (
                  <section className="bg-white border-2 border-brand/30 rounded-2xl p-4 space-y-3">
                    <div className="font-heading font-bold text-[15px] text-ink">Your decision</div>
                    <textarea value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} rows={3} className={inputCls} placeholder="Review notes for this decision (visible on the record)…" />
                    {!rejecting ? (
                      <div className="flex gap-2">
                        <button type="button" disabled={deciding} onClick={() => decide('approve')}
                          className="flex-1 rounded-xl py-3 font-heading font-bold text-sm bg-emerald-600 text-white disabled:opacity-50">{deciding ? '…' : 'Approve → Completed'}</button>
                        <button type="button" disabled={deciding} onClick={() => { setRejecting(true); setRejectCost('0'); setRejectReason(''); }}
                          className="flex-1 rounded-xl py-3 font-heading font-bold text-sm bg-white text-red-600 border border-red-300">Reject…</button>
                      </div>
                    ) : (
                      <div className="space-y-3 border-t border-gray-100 pt-3">
                        <div className="text-[12px] font-bold uppercase tracking-wide text-gray-400">Adjust payout</div>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => { setRejectCost('0'); setRejectReason('Rejected — no payout'); }}
                            className={`px-3 py-2 rounded-full border text-[13px] font-heading font-semibold ${Number(rejectCost) === 0 ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>Set $0 (default)</button>
                          <button type="button" onClick={() => { setRejectCost((origCost * 0.75).toFixed(2)); setRejectReason('Back yard not serviced (−25%)'); }}
                            className={`px-3 py-2 rounded-full border text-[13px] font-heading font-semibold ${Math.abs(Number(rejectCost) - origCost * 0.75) < 0.005 && origCost > 0 ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300'}`}>Back yard not serviced −25%</button>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] text-gray-500">Final vendor payout</span>
                          <div className="relative">
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">$</span>
                            <input type="number" inputMode="decimal" value={rejectCost} onChange={(e) => setRejectCost(e.target.value)} className="w-28 text-sm border border-gray-300 rounded-lg pl-6 pr-2 py-2 bg-white focus:outline-none focus:border-brand" />
                          </div>
                          {origCost > 0 && <span className="text-[12px] text-gray-400">was {money(origCost)}</span>}
                        </div>
                        <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} className={inputCls} placeholder="Reason (shown on the record)" />
                        <div className="flex gap-2">
                          <button type="button" onClick={() => setRejecting(false)} className="px-4 py-2.5 rounded-xl text-sm font-heading font-semibold bg-white text-gray-600 border border-gray-300">Cancel</button>
                          <button type="button" disabled={deciding} onClick={() => decide('reject')}
                            className="flex-1 rounded-xl py-2.5 font-heading font-bold text-sm bg-red-600 text-white disabled:opacity-50">{deciding ? '…' : 'Reject & close out → Completed'}</button>
                        </div>
                      </div>
                    )}
                    {error && <div className="text-center text-xs text-red-600">{error}</div>}
                  </section>
                )}

                {!canReview && underReview && (
                  <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 text-[13px] text-amber-800">Under review by the ResiHome team.</div>
                )}
                {!editable && !underReview && svc.status === 'submitted' && (
                  <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-3 text-[13px] text-indigo-800">Submitted — awaiting AI review. This service is locked and can no longer be edited.</div>
                )}
              </>
            )}
          </>
        )}
      </main>

      {lightbox && gallery.groups.length > 0 && (
        <PhotoLightbox
          groups={gallery.groups}
          photosByGroup={gallery.map}
          initialGroupId={lightbox.groupId}
          initialIndex={lightbox.index}
          readOnly
          onClose={() => setLightbox(null)}
          onDelete={() => { /* read-only */ }}
          onReplace={() => { /* read-only */ }}
        />
      )}
    </div>
  );
}
