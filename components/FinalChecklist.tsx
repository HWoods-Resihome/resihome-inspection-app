/**
 * FinalChecklist — the "Final Checklist" section rendered as another room-style
 * bubble at the very bottom of the scope rate-card form. Driven entirely by
 * lib/finalChecklist.ts (the spec).
 *
 * Presentational + controlled: the parent owns the answer map (and the outer
 * open/closed state so the form's global Expand/Collapse-all reaches it) and
 * supplies the persistence / property / line-item hooks. Each subsection
 * (Smart Home Tech, …) collapses independently, with its own Expand/Collapse-all.
 */

import { useState } from 'react';
import {
  FINAL_CHECKLIST, FC_FILTER_OTHER,
  type FcQuestion, type FcAddLineRule,
  type FcAnswerState, type FcAnswers,
} from '@/lib/finalChecklist';
import { titleCase } from '@/lib/titleCase';
import { ListPicker } from '@/components/ListPicker';
import { WheelPicker } from '@/components/WheelPicker';
import { CameraCapture } from '@/components/CameraCapture';
import { displayImageSrc } from '@/lib/photoDisplay';

export type { FcAnswerState, FcAnswers } from '@/lib/finalChecklist';

interface Props {
  answers: FcAnswers;
  onPatch: (questionId: string, patch: Partial<FcAnswerState>) => void;
  /** Upload a photo for a field. fieldKey ("qid:photoKey") lets the parent queue
   *  it offline and swap the draft for the real URL on reconnect. */
  uploadPhoto: (file: File, fieldKey?: string) => Promise<string>;
  propertyName?: string;
  propertyRecordId?: string;
  propertyValues?: Record<string, string | number | null | undefined>;
  filterSizeOptions?: string[];
  lineExists?: (lineItemCode: string) => boolean;
  onAddLine?: (rule: FcAddLineRule, questionId: string) => Promise<{ externalId: string; costLabel: string } | null>;
  onUndoLine?: (externalId: string, questionId: string) => void;
  /** Remove EVERY line in the scope matching this catalog code (wherever it
   *  lives) — used to delete a suggested line that already exists. */
  onRemoveLineByCode?: (lineItemCode: string, questionId: string) => void;
  /** Notify the parent when our camera overlay opens/closes (hides the floating mic). */
  onCameraOverlayChange?: (open: boolean) => void;
  /** Outer collapse, controlled by the parent so the form's Expand/Collapse-all reaches it. */
  open?: boolean;
  onToggleOpen?: () => void;
  readOnly?: boolean;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

export function FinalChecklist(props: Props) {
  const { answers, onPatch, readOnly } = props;
  const [openInternal, setOpenInternal] = useState(true);
  const open = props.open ?? openInternal;
  const toggleOpen = () => (props.onToggleOpen ? props.onToggleOpen() : setOpenInternal((o) => !o));
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [camFor, setCamFor] = useState<string | null>(null);
  const [busyAdd, setBusyAdd] = useState<string | null>(null);

  const ans = (id: string): FcAnswerState => answers[id] || {};
  const setCamera = (key: string | null) => { setCamFor(key); props.onCameraOverlayChange?.(key !== null); };

  const sections = FINAL_CHECKLIST;
  const allSubsOpen = sections.every((s) => openSections[s.id] ?? true);
  const setAllSubs = (v: boolean) => setOpenSections(Object.fromEntries(sections.map((s) => [s.id, v])));

  // ---- shared photo strip (standardized yellow dashed "+" add box) ----
  function PhotoStrip({ urls, camKey, required, center }: { urls: string[]; camKey: string; required?: boolean; center?: boolean }) {
    return (
      <div className={`flex flex-wrap gap-2 items-center mt-1.5 ${center ? 'justify-center' : ''}`}>
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
            onClick={() => setCamera(camKey)}
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

  // Changing a single-select answer: if a line was auto-added for the prior
  // answer and the new answer no longer triggers that add, auto-remove the line.
  function pickSingle(q: FcQuestion, v: string) {
    const a = ans(q.id);
    if (a.added) {
      const stillTriggers = (q.addLineOnValues || []).some((r) => r.value === v);
      if (!stillTriggers) {
        props.onUndoLine?.(a.added.externalId, q.id);
        onPatch(q.id, { value: v, declined: false, added: null });
        return;
      }
    }
    onPatch(q.id, { value: v, declined: false });
  }

  // ---- small renderers ----
  function Pills({ options, value, onPick, compact }: { options?: string[]; value?: string; onPick: (v: string) => void; compact?: boolean }) {
    // compact: wrap (no horizontal scroll) + smaller font, for long option sets
    // like the device types. Default: single line that scrolls if needed.
    return (
      <div className={compact ? 'flex flex-wrap gap-1' : 'flex gap-1.5 overflow-x-auto pb-0.5'} style={compact ? undefined : { scrollbarWidth: 'none' }}>
        {(options || []).map((o) => {
          const sel = value === o;
          return (
            <button key={o} type="button" disabled={readOnly} onClick={() => onPick(o)}
              className={`shrink-0 whitespace-nowrap font-heading font-semibold rounded-full border-2 transition
                ${compact ? 'text-[10px] px-2 py-1' : 'text-xs px-3.5 py-1.5'}
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
    const alreadyInScope = props.lineExists?.(rule.lineItemCode);

    if (a.added) {
      return (
        <div className="mt-3 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2.5 flex items-center gap-2.5">
          <span className="shrink-0 w-6 h-6 rounded-full bg-emerald-700 text-white flex items-center justify-center text-[13px] font-bold">✓</span>
          <div className="text-[12.5px] text-emerald-900 leading-tight">
            <span className="font-semibold">{titleCase(rule.label)}</span> added to <span className="font-semibold">Whole House</span>
            <div className="text-emerald-700 font-medium">Vendor 1 · Qty {rule.quantity} · {rule.tenantBillBackPercent}% Tenant · <span className="font-bold">{a.added.costLabel}</span></div>
          </div>
          {!readOnly && <button type="button" onClick={() => undoAdd(q)} className="ml-auto text-[11.5px] text-emerald-700 underline">Undo</button>}
        </div>
      );
    }
    if (a.declined) {
      return (
        <div className="mt-3 rounded-xl border border-gray-300 bg-gray-100 px-3 py-2.5 flex items-center gap-2.5">
          <span className="shrink-0 w-6 h-6 rounded-full bg-gray-500 text-white flex items-center justify-center text-[12px] font-bold">✕</span>
          <div className="text-[12.5px] text-gray-700 leading-tight">
            Add <span className="font-semibold">{titleCase(rule.label)}</span> — declined<div className="text-gray-500">Not added to the scope.</div>
          </div>
          {!readOnly && <button type="button" onClick={() => onPatch(q.id, { declined: false })} className="ml-auto text-[11.5px] text-gray-600 underline">Undo</button>}
        </div>
      );
    }
    if (alreadyInScope) {
      return (
        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 flex items-center gap-2.5">
          <span className="shrink-0 w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center text-[13px] font-bold">✓</span>
          <div className="text-[12.5px] text-gray-700 leading-tight">
            <span className="font-semibold">{titleCase(rule.label)}</span> already in this scope.
          </div>
          {!readOnly && props.onRemoveLineByCode && (
            <button type="button" onClick={() => props.onRemoveLineByCode!(rule.lineItemCode, q.id)}
              className="ml-auto shrink-0 text-[11.5px] text-red-600 underline">Remove</button>
          )}
        </div>
      );
    }
    return (
      <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
        {rule.optional && <span className="inline-block text-[9.5px] font-bold uppercase tracking-wide text-sky-700 bg-sky-100 rounded px-1.5 py-0.5 mb-1.5">Optional Add</span>}
        <div className="flex gap-2.5 items-center">
          <span className="shrink-0 w-6 h-6 rounded-md bg-sky-100 text-sky-700 flex items-center justify-center font-bold">+</span>
          <div className="text-[12.5px] text-sky-900 leading-snug">
            {rule.optional
              ? <><b>Optional:</b> add a <b>{titleCase(rule.label)}</b> line under <b>Whole House</b>? Only add it if a pump-out is needed.</>
              : <>No <b>{titleCase(rule.label)}</b> line found anywhere in this scope. Add it under <b>Whole House</b>?</>}
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
      <div className="mt-2.5 flex gap-2.5 items-center rounded-xl border border-brand/20 bg-brand/5 px-3 py-2.5">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-brand"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></svg>
        <div className="text-[12px] font-medium text-brand-dark leading-snug">{r.text}</div>
      </div>
    );
  }

  function CountField({ q }: { q: FcQuestion }) {
    const a = ans(q.id);
    const c = (q.countOnValues || []).find((x) => x.value === a.value);
    if (!c) return null;
    return (
      <div className="mt-3 max-w-[230px]">
        <label className="block text-[11px] font-heading font-bold text-gray-700 mb-1">{titleCase(c.label)} <span className="text-brand">(Required)</span></label>
        <Stepper value={a.count ?? null} min={c.min ?? 0} max={c.max} onChange={(v) => onPatch(q.id, { count: v })} />
      </div>
    );
  }

  // Stepper — wide, full-height tap targets on each side (whole side is the button).
  function Stepper({ value, min, max, onChange }: { value: number | null; min: number; max?: number; onChange: (v: number) => void }) {
    const v = value ?? min;
    const step = (d: number) => { const nv = Math.max(min, Math.min(max ?? 9999, v + d)); onChange(nv); };
    const atMin = v <= min;
    const atMax = max != null && v >= max;
    return (
      <div className="inline-flex items-stretch border border-gray-300 rounded-lg overflow-hidden select-none h-9">
        <button type="button" disabled={readOnly || atMin} onClick={() => step(-1)} aria-label="Decrease"
          className="w-10 bg-gray-50 active:bg-gray-100 text-lg text-gray-600 flex items-center justify-center disabled:opacity-30">–</button>
        <div className="w-11 flex items-center justify-center text-sm font-semibold tabular-nums border-x border-gray-200">{value ?? ''}</div>
        <button type="button" disabled={readOnly || atMax} onClick={() => step(1)} aria-label="Increase"
          className="w-10 bg-gray-50 active:bg-gray-100 text-lg text-gray-600 flex items-center justify-center disabled:opacity-30">+</button>
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
          <Pills compact options={devices.map((d) => d.value)} value={a.value} onPick={(v) => onPatch(q.id, { value: v, device: {} })} />
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
                    ? <Pills options={f.options} value={a.device?.[f.id]} onPick={(v) => onPatch(q.id, { device: { ...(a.device || {}), [f.id]: v } })} />
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
      const count = Math.max(1, Math.min(3, qtyAns.quantity ?? prefillQty ?? 1));
      const opts = [
        ...(props.filterSizeOptions || []).map((o) => ({ value: o, label: o })),
        { value: FC_FILTER_OTHER, label: FC_FILTER_OTHER },
      ];
      const sizes = a.filterSizes || [];
      const others = a.filterSizesOther || [];
      return (
        <div className="space-y-3">
          {Array.from({ length: count }).map((_, i) => {
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
                {val === FC_FILTER_OTHER && (
                  <input
                    type="text" disabled={readOnly}
                    value={others[i] || ''}
                    onChange={(e) => { const next = [...others]; next[i] = e.target.value; onPatch(q.id, { filterSizesOther: next }); }}
                    placeholder="Enter the filter size (e.g. 14 × 30 × 1)"
                    className="mt-2 w-full max-w-[260px] bg-white border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus-brand"
                  />
                )}
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
                <PhotoStrip urls={urls} camKey={`${q.id}:${p.id}`} required={p.required} center />
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
        <Pills options={q.options} value={a.value} onPick={(v) => pickSingle(q, v)} />
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
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Header — title left-aligned like a room name; (Required) beside it; the
          collapse chevron flush right (matches SectionHeader). */}
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="w-full px-4 py-3 bg-brand/5 hover:bg-brand/10 border-b border-gray-200 flex items-center gap-2 text-left"
      >
        <span className="font-semibold text-gray-900 text-sm sm:text-base">Final Checklist</span>
        <span className="text-[11px] text-brand font-semibold">(Required)</span>
        <span className="text-gray-400 ml-auto shrink-0">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <>
          {/* The checklist's own Expand all / Collapse all for its subsections. */}
          <div className="flex justify-end px-4 pt-2">
            <button
              type="button"
              onClick={() => setAllSubs(!allSubsOpen)}
              className="inline-flex items-center gap-1 text-[11px] font-heading text-gray-500 hover:text-gray-800 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={`transition-transform ${allSubsOpen ? '' : 'rotate-180'}`}>
                <polyline points="18 15 12 9 6 15" />
              </svg>
              {allSubsOpen ? 'Collapse all' : 'Expand all'}
            </button>
          </div>

          {sections.map((section) => {
            const qs = section.questions.filter(visible);
            if (qs.length === 0) return null;
            const sopen = openSections[section.id] ?? true;
            return (
              <div key={section.id} className="border-b border-gray-100 last:border-b-0">
                <button
                  type="button"
                  onClick={() => setOpenSections((m) => ({ ...m, [section.id]: !(m[section.id] ?? true) }))}
                  aria-expanded={sopen}
                  className="w-full px-4 py-2.5 bg-gray-50 hover:bg-gray-100 flex items-center gap-2 text-left"
                >
                  <span className="font-heading font-bold text-sm text-ink">{titleCase(section.name)}</span>
                  <span className="text-gray-400 ml-auto shrink-0">{sopen ? '▾' : '▸'}</span>
                </button>
                {sopen && qs.map((q) => (
                  <div key={q.id} className="px-4 py-4 border-t border-gray-100">
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
        </>
      )}

      {/* one shared camera for every photo field; signals the parent so the
          floating mic hides while it's open. */}
      <CameraCapture
        isOpen={camFor !== null}
        addressSnapshot={props.propertyName}
        propertyRecordId={props.propertyRecordId}
        onClose={() => setCamera(null)}
        uploadPhoto={(file) => props.uploadPhoto(file, camFor || undefined)}
        onComplete={(urls) => {
          if (camFor && urls.length > 0) setPhotoList(camFor, [...getPhotoList(camFor), ...urls]);
          setCamera(null);
        }}
      />
    </section>
  );
}
