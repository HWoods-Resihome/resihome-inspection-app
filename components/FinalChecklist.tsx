/**
 * FinalChecklist — the "✦ Final Checklist" section rendered at the bottom of the
 * scope rate-card form. Driven entirely by lib/finalChecklist.ts (the spec).
 *
 * Presentational + controlled: the parent owns the answer map and supplies the
 * persistence / property / line-item hooks. This component renders the UI and
 * calls back; it does no network I/O itself except photo upload (delegated).
 *
 * Phase 2 of the build — not yet mounted in RateCardForm. Mounting + answer
 * persistence + property fetch + Submit gating land in Phase 3; the Master PDF
 * block in Phase 4.
 */

import { useState } from 'react';
import {
  FINAL_CHECKLIST, type FcQuestion, type FcAddLineRule,
  type FcAnswerState, type FcAnswers,
} from '@/lib/finalChecklist';
import { titleCase } from '@/lib/titleCase';

export type { FcAnswerState, FcAnswers } from '@/lib/finalChecklist';
import { ListPicker } from '@/components/ListPicker';
import { WheelPicker } from '@/components/WheelPicker';
import { CameraCapture } from '@/components/CameraCapture';
import { displayImageSrc } from '@/lib/photoDisplay';

interface Props {
  answers: FcAnswers;
  onPatch: (questionId: string, patch: Partial<FcAnswerState>) => void;
  uploadPhoto: (file: File) => Promise<string>;
  propertyName?: string;
  propertyRecordId?: string;
  /** Raw property values (air_filters___total_quantity, septic_fee, …). */
  propertyValues?: Record<string, string | number | null | undefined>;
  /** Filter-size dropdown options, fetched live from the HubSpot field (sorted). */
  filterSizeOptions?: string[];
  /** True if a line with this exact short description already exists anywhere. */
  lineExists?: (shortDescription: string) => boolean;
  /** Auto-add a Whole-House line; resolves with the new line id + a cost label. */
  onAddLine?: (rule: FcAddLineRule, questionId: string) => Promise<{ externalId: string; costLabel: string } | null>;
  onUndoLine?: (externalId: string, questionId: string) => void;
  readOnly?: boolean;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

export function FinalChecklist(props: Props) {
  const { answers, onPatch, readOnly } = props;
  // Which photo field has the camera open: `${questionId}:${photoKey}`.
  const [camFor, setCamFor] = useState<string | null>(null);
  const [busyAdd, setBusyAdd] = useState<string | null>(null);

  const ans = (id: string): FcAnswerState => answers[id] || {};

  // ---- shared photo strip (standardized: yellow dashed "+" add box) ----
  function PhotoStrip({ urls, camKey, required }: { urls: string[]; camKey: string; required?: boolean }) {
    return (
      <div className="flex flex-wrap gap-2 items-center mt-1.5">
        {urls.map((u, i) => (
          <div key={`${u}-${i}`} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={displayImageSrc(u)} alt="" className="w-14 h-14 object-cover rounded-lg border border-gray-200" />
            {!readOnly && (
              <button type="button" onClick={() => removePhoto(camKey, i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-ink text-white text-xs leading-none flex items-center justify-center">&times;</button>
            )}
          </div>
        ))}
        {!readOnly && (
          <button
            type="button"
            onClick={() => setCamFor(camKey)}
            aria-label="Add photo"
            className={`w-14 h-14 rounded-lg border-2 border-dashed flex items-center justify-center text-2xl leading-none
              ${required && urls.length === 0 ? 'border-amber-300 text-amber-500' : 'border-gray-300 text-gray-400 hover:border-brand/50 hover:text-brand'}`}
          >+</button>
        )}
      </div>
    );
  }

  function getPhotoList(camKey: string): string[] {
    const [qid, key] = camKey.split(':');
    const a = ans(qid);
    if (key === 'photo') return a.photoUrls || [];
    return (a.stickerPhotos || {})[key] || [];
  }
  function setPhotoList(camKey: string, urls: string[]) {
    const [qid, key] = camKey.split(':');
    if (key === 'photo') onPatch(qid, { photoUrls: urls });
    else onPatch(qid, { stickerPhotos: { ...(ans(qid).stickerPhotos || {}), [key]: urls } });
  }
  function removePhoto(camKey: string, idx: number) {
    setPhotoList(camKey, getPhotoList(camKey).filter((_, i) => i !== idx));
  }

  // ---- add-line prompt handling ----
  async function acceptAdd(q: FcQuestion, rule: FcAddLineRule) {
    if (!props.onAddLine) return;
    setBusyAdd(q.id);
    try {
      const res = await props.onAddLine(rule, q.id);
      if (res) onPatch(q.id, { added: res, declined: false });
    } finally {
      setBusyAdd(null);
    }
  }
  function undoAdd(q: FcQuestion) {
    const a = ans(q.id);
    if (a.added) props.onUndoLine?.(a.added.externalId, q.id);
    onPatch(q.id, { added: null });
  }

  // ---- renderers ----
  function Pills({ q, value, onPick }: { q: { options?: string[] }; value?: string; onPick: (v: string) => void }) {
    const opts = q.options || [];
    return (
      <div className="flex gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: 'none' }}>
        {opts.map((o) => {
          const sel = value === o;
          return (
            <button key={o} type="button" disabled={readOnly} onClick={() => onPick(o)}
              className={`shrink-0 whitespace-nowrap text-xs font-heading font-semibold px-3.5 py-1.5 rounded-full border-2 transition
                ${sel ? 'bg-brand text-white border-brand shadow-sm' : 'bg-white text-ink border-gray-300 hover:border-brand/50'}`}>
              {titleCase(o)}
            </button>
          );
        })}
      </div>
    );
  }

  function AddLineArea({ q }: { q: FcQuestion }) {
    const a = ans(q.id);
    const match = (q.addLineOnValues || []).find((r) => r.value === a.value);
    if (!match) return null;
    const rule = match.rule;
    const alreadyInScope = props.lineExists?.(rule.shortDescription);

    if (a.added) {
      return (
        <div className="mt-3 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5 flex items-center gap-2.5">
          <span className="shrink-0 w-6 h-6 rounded-full bg-emerald-700 text-white flex items-center justify-center text-[13px] font-bold">✓</span>
          <div className="text-[12.5px] text-emerald-900 leading-tight">
            <span className="font-semibold">{titleCase(rule.shortDescription)}</span> added to <span className="font-semibold">Whole House</span>
            <div className="text-emerald-700 font-medium">Vendor 1 · Qty {rule.quantity} · {rule.tenantBillBackPercent}% Tenant · <span className="font-bold">{a.added.costLabel}</span></div>
          </div>
          {!readOnly && <button type="button" onClick={() => undoAdd(q)} className="ml-auto text-[11.5px] text-emerald-700 underline">Undo</button>}
        </div>
      );
    }
    if (alreadyInScope) {
      return <div className="mt-3 text-[12px] text-gray-500">✓ <span className="font-medium">{titleCase(rule.shortDescription)}</span> already in this scope.</div>;
    }
    return (
      <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
        {rule.optional && <span className="inline-block text-[9.5px] font-bold uppercase tracking-wide text-sky-700 bg-sky-100 rounded px-1.5 py-0.5 mb-1.5">Optional Add</span>}
        <div className="flex gap-2.5 items-start">
          <span className="shrink-0 w-6 h-6 rounded-md bg-sky-100 text-sky-700 flex items-center justify-center font-bold">+</span>
          <div className="text-[12.5px] text-sky-900 leading-snug">
            {rule.optional
              ? <><b>Optional:</b> add a <b>{titleCase(rule.shortDescription)}</b> line under <b>Whole House</b>? Only add it if a pump-out is needed.</>
              : <>No <b>{titleCase(rule.shortDescription)}</b> line found anywhere in this scope. Add it under <b>Whole House</b>?</>}
          </div>
        </div>
        {!readOnly && (
          <div className="flex gap-2 mt-2.5">
            <button type="button" disabled={busyAdd === q.id} onClick={() => acceptAdd(q, rule)}
              className="bg-brand text-white font-heading font-semibold text-xs px-3.5 py-2 rounded-lg disabled:opacity-50">
              {busyAdd === q.id ? 'Adding…' : 'Add Line'}
            </button>
            <button type="button" onClick={() => onPatch(q.id, { declined: true })}
              className={`border font-heading font-semibold text-xs px-3.5 py-2 rounded-lg ${a.declined ? 'bg-gray-700 text-white border-gray-700' : 'bg-white text-gray-700 border-gray-300'}`}>
              Not Needed
            </button>
          </div>
        )}
      </div>
    );
  }

  function ActionPanel({ q }: { q: FcQuestion }) {
    const a = ans(q.id);
    const needPhoto = (q.photoRequiredOnValues || []).includes(a.value || '');
    const needNote = (q.noteRequiredOnValues || []).includes(a.value || '');
    if (!needPhoto && !needNote) return null;
    return (
      <div className="mt-3 p-3 rounded-xl border-2 border-amber-300 bg-white">
        <div className="text-[11px] font-heading font-bold uppercase tracking-wider text-amber-800 mb-2.5">Action Required</div>
        {needNote && (
          <div className="mb-2.5">
            <label className="block text-[11px] font-heading font-bold text-amber-800 mb-1">{titleCase(q.notePrompt || 'Note')} <span className="text-brand">(Required)</span></label>
            <textarea value={a.note || ''} disabled={readOnly} onChange={(e) => onPatch(q.id, { note: e.target.value })} rows={2}
              className="w-full text-sm rounded-md px-2 py-1.5 bg-white border border-gray-300 focus-brand" />
          </div>
        )}
        {needPhoto && (
          <div>
            <div className="text-[11px] font-heading font-bold text-amber-800 mb-1">Photo <span className="text-brand">(Required)</span></div>
            <PhotoStrip urls={a.photoUrls || []} camKey={`${q.id}:photo`} required />
          </div>
        )}
      </div>
    );
  }

  function Reminder({ q }: { q: FcQuestion }) {
    const a = ans(q.id);
    const r = (q.reminderOnValues || []).find((x) => x.value === a.value);
    if (!r) return null;
    return (
      <div className="mt-2.5 flex gap-2.5 items-start rounded-xl border border-brand/20 bg-brand/5 px-3 py-2.5">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-brand mt-0.5"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></svg>
        <div className="text-[12px] font-medium text-brand-dark leading-snug">{r.text}</div>
      </div>
    );
  }

  function CountField({ q }: { q: FcQuestion }) {
    const a = ans(q.id);
    const c = (q.countOnValues || []).find((x) => x.value === a.value);
    if (!c) return null;
    return (
      <div className="mt-3 max-w-[210px]">
        <label className="block text-[11px] font-heading font-bold text-gray-700 mb-1">{titleCase(c.label)} <span className="text-brand">(Required)</span></label>
        <Stepper value={a.count ?? null} min={c.min ?? 0} max={c.max} onChange={(v) => onPatch(q.id, { count: v })} />
      </div>
    );
  }

  function Stepper({ value, min, max, onChange }: { value: number | null; min: number; max?: number; onChange: (v: number) => void }) {
    const v = value ?? min;
    const step = (d: number) => { const nv = Math.max(min, Math.min(max ?? 9999, v + d)); onChange(nv); };
    return (
      <div className="inline-flex items-center border border-gray-300 rounded-xl overflow-hidden">
        <button type="button" disabled={readOnly} onClick={() => step(-1)} className="w-10 h-10 bg-gray-50 text-lg text-gray-600">–</button>
        <div className="w-14 h-10 flex items-center justify-center text-base font-semibold tabular-nums">{value ?? ''}</div>
        <button type="button" disabled={readOnly} onClick={() => step(1)} className="w-10 h-10 bg-gray-50 text-lg text-gray-600">+</button>
      </div>
    );
  }

  function renderQuestion(q: FcQuestion) {
    const a = ans(q.id);

    if (q.type === 'device_subform') {
      const devices = q.devices || [];
      const picked = devices.find((d) => d.value === a.value);
      return (
        <>
          <Pills q={{ options: devices.map((d) => d.value) }} value={a.value} onPick={(v) => onPatch(q.id, { value: v, device: {} })} />
          {picked && picked.fields && (
            <div className="mt-2.5 border border-gray-200 rounded-xl p-3">
              <div className="flex items-center justify-between font-heading font-bold text-[12.5px] mb-2.5">
                <span>{titleCase(picked.value)}</span>
                <span className="text-[10px] font-bold uppercase tracking-wide text-white bg-violet-600 rounded px-1.5 py-0.5">Device</span>
              </div>
              {picked.fields.map((f) => (
                <div key={f.id} className="mb-2.5 last:mb-0">
                  <div className="text-[11px] font-heading font-bold text-gray-700 mb-1">{titleCase(f.label)} {f.required ? <span className="text-brand">(Required)</span> : <span className="text-gray-400">(Optional)</span>}</div>
                  {f.type === 'single_select'
                    ? <Pills q={{ options: f.options }} value={a.device?.[f.id]} onPick={(v) => onPatch(q.id, { device: { ...(a.device || {}), [f.id]: v } })} />
                    : <input type="text" disabled={readOnly} value={a.device?.[f.id] || ''} onChange={(e) => onPatch(q.id, { device: { ...(a.device || {}), [f.id]: e.target.value } })}
                        className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus-brand" />}
                </div>
              ))}
            </div>
          )}
        </>
      );
    }

    if (q.type === 'number') {
      const prefill = q.prefillProperty ? num(props.propertyValues?.[q.prefillProperty]) : null;
      const v = a.quantity ?? prefill ?? q.min ?? null;
      return <Stepper value={v} min={q.min ?? 0} max={q.max} onChange={(nv) => onPatch(q.id, { quantity: nv })} />;
    }

    if (q.type === 'filter_sizes') {
      const qtyAns = ans('fc_air_filters_qty');
      const prefillQty = num(props.propertyValues?.['air_filters___total_quantity']);
      const count = qtyAns.quantity ?? prefillQty ?? 1;
      const opts = (props.filterSizeOptions || []).map((o) => ({ value: o, label: o }));
      const sizes = a.filterSizes || [];
      return (
        <div className="space-y-3">
          {Array.from({ length: Math.max(1, Math.min(3, count)) }).map((_, i) => {
            const propVal = props.propertyValues?.[`air_filters___type__${i + 1}`];
            const val = sizes[i] ?? (propVal != null ? String(propVal) : '');
            return (
              <div key={i}>
                <div className="text-[11px] font-heading font-bold text-gray-700 mb-1">{`Filter Size #${i + 1}`} <span className="text-brand">(Required)</span></div>
                <WheelPicker
                  value={val}
                  options={opts}
                  onChange={(v) => { const next = [...sizes]; next[i] = v; onPatch(q.id, { filterSizes: next }); }}
                  ariaLabel={`Filter Size ${i + 1}`}
                  large
                  className="w-full max-w-[260px] bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm flex items-center justify-between"
                />
              </div>
            );
          })}
          <div className="text-[10.5px] text-gray-400">Options from HubSpot · pre-filled from property</div>
        </div>
      );
    }

    if (q.type === 'photo_set') {
      return (
        <div className="grid grid-cols-3 gap-2.5 mt-1">
          {(q.photos || []).map((p) => {
            const urls = (a.stickerPhotos || {})[p.id] || [];
            return (
              <div key={p.id} className="text-center">
                <PhotoStrip urls={urls} camKey={`${q.id}:${p.id}`} required={p.required} />
                <div className="text-[10.5px] text-gray-500 mt-1.5">{titleCase(p.label)} {p.required && <span className="text-brand">*</span>}</div>
              </div>
            );
          })}
        </div>
      );
    }

    // single_select
    return (
      <>
        <Pills q={{ options: q.options }} value={a.value} onPick={(v) => onPatch(q.id, { value: v, declined: false })} />
        <ActionPanel q={q} />
        <CountField q={q} />
        <Reminder q={q} />
        <AddLineArea q={q} />
      </>
    );
  }

  function visible(q: FcQuestion): boolean {
    if (!q.showWhenProperty) return true;
    const v = num(props.propertyValues?.[q.showWhenProperty.field]);
    if (q.showWhenProperty.gt != null) return (v ?? 0) > q.showWhenProperty.gt;
    return true;
  }

  return (
    <div className="bg-white">
      {/* Pink brand header */}
      <div className="px-5 py-4 bg-brand text-white">
        <div className="font-heading font-bold text-lg flex items-center gap-2"><span>✦</span> Final Checklist</div>
        <p className="text-xs text-white/90 mt-1">All Items Required. Items flagged here can add line items to scope.</p>
      </div>

      {FINAL_CHECKLIST.map((section) => {
        const qs = section.questions.filter(visible);
        if (qs.length === 0) return null;
        return (
          <div key={section.id} className="border-b-8 border-gray-100">
            <div className="px-5 py-3 bg-gray-50 border-b border-gray-200 font-heading font-bold text-sm">
              <span className="inline-block w-2 h-2 rounded-full bg-brand mr-2 align-middle" />{titleCase(section.name)}
            </div>
            {qs.map((q) => (
              <div key={q.id} className="px-5 py-4 border-t border-gray-100 first:border-t-0">
                <div className="font-heading font-semibold text-ink text-sm leading-snug mb-2">
                  {titleCase(q.label)}{q.required && <span className="text-brand ml-1">*</span>}
                </div>
                {q.help && <p className="text-xs text-gray-500 italic -mt-1 mb-2">{q.help}</p>}
                {renderQuestion(q)}
              </div>
            ))}
          </div>
        );
      })}

      {/* one shared camera for every photo field */}
      <CameraCapture
        isOpen={camFor !== null}
        addressSnapshot={props.propertyName}
        propertyRecordId={props.propertyRecordId}
        onClose={() => setCamFor(null)}
        uploadPhoto={props.uploadPhoto}
        onComplete={(urls) => {
          if (camFor && urls.length > 0) setPhotoList(camFor, [...getPhotoList(camFor), ...urls]);
          setCamFor(null);
        }}
      />
    </div>
  );
}
