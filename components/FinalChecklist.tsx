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

import { useEffect, useState } from 'react';
import {
  FINAL_CHECKLIST, FC_FILTER_OTHER, fcSectionCounts,
  type FcQuestion, type FcAddLineRule,
  type FcAnswerState, type FcAnswers, type FcCompletionCtx,
} from '@/lib/finalChecklist';
import { titleCase } from '@/lib/titleCase';
import { ListPicker } from '@/components/ListPicker';
import { WheelPicker } from '@/components/WheelPicker';
import { CameraCapture } from '@/components/CameraCapture';
import { PhotoLightbox } from '@/components/PhotoLightbox';
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
  /** Render only these section ids (e.g. the Q&A templates reuse just the HVAC +
   *  Smart Home sections). Omit to render the full checklist. */
  only?: string[];
  /** Title for the outer bubble (defaults to "Final Checklist"). */
  title?: string;
  /** Render each subsection as its OWN standalone bubble (no outer "Final
   *  Checklist" wrapper, no Inspector Final Notes) — used to embed the sections
   *  into a Q&A form so they look like the form's other sections. */
  bare?: boolean;
  /** Drives the bare subsections' open/closed state from the parent's global
   *  Collapse/Expand-all. Bump `token` to force every subsection to `open`. */
  openAllToken?: { open: boolean; token: number };
  /** Render the selected sections as plain question rows — NO card, NO header,
   *  NO collapse — so they can be embedded as the first rows of another section. */
  seamless?: boolean;
  /** Merge the `only` sections into ONE rendered section under this display name
   *  (questions concatenated in `only` order; the X/Y count sums all members). */
  mergeName?: string;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

// Reserved answer key for the inspector's free-text final notes. NOT part of
// the FINAL_CHECKLIST spec, so it never gates submit (the notes are optional);
// it rides along in the same answers map that's JSON-persisted with the rest.
const FC_FINAL_NOTES_ID = 'fc_inspector_final_notes';

// Dismiss the on-screen keyboard when the inspector hits Enter / Go / Done. On a
// textarea this means Enter closes the keyboard instead of inserting a newline
// (per owner request that every field dismiss on Enter/Go).
function blurOnEnter(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
}

export function FinalChecklist(props: Props) {
  const { answers, onPatch, readOnly } = props;
  const [openInternal, setOpenInternal] = useState(true);
  const open = props.open ?? openInternal;
  const toggleOpen = () => (props.onToggleOpen ? props.onToggleOpen() : setOpenInternal((o) => !o));
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  // When the parent's global Collapse/Expand-all fires, sync every subsection.
  const openAllToken = props.openAllToken?.token;
  useEffect(() => {
    if (props.openAllToken) {
      setOpenSections(Object.fromEntries(FINAL_CHECKLIST.map((s) => [s.id, props.openAllToken!.open])));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAllToken]);
  const [camFor, setCamFor] = useState<string | null>(null);
  const [busyAdd, setBusyAdd] = useState<string | null>(null);
  // Full-screen viewer for FC photos: { groupId: "qid:key", index }. Lets the
  // inspector tap a photo to open it, swipe/arrow left-right across ALL Final
  // Checklist photos, mark it up, or delete it — the same PhotoLightbox the rooms
  // use.
  const [lbox, setLbox] = useState<{ groupId: string; index: number } | null>(null);

  const ans = (id: string): FcAnswerState => answers[id] || {};
  const setCamera = (key: string | null) => { setCamFor(key); props.onCameraOverlayChange?.(key !== null); };

  const sections = props.only ? FINAL_CHECKLIST.filter((s) => props.only!.includes(s.id)) : FINAL_CHECKLIST;
  const allSubsOpen = sections.every((s) => openSections[s.id] ?? true);
  const setAllSubs = (v: boolean) => setOpenSections(Object.fromEntries(sections.map((s) => [s.id, v])));

  // What actually gets rendered. With `mergeName`, the selected sections collapse
  // into ONE section (questions concatenated in `only` order, count summed over
  // all members); otherwise each section renders on its own.
  const renderSections: { id: string; name: string; questions: FcQuestion[]; memberIds: string[] }[] =
    props.mergeName && sections.length > 0
      ? [{
          id: sections[0].id,
          name: props.mergeName,
          questions: sections.flatMap((s) => s.questions),
          memberIds: sections.map((s) => s.id),
        }]
      : sections.map((s) => ({ id: s.id, name: s.name, questions: s.questions, memberIds: [s.id] }));

  // Completion context for the per-section "X/Y" pills (built from props).
  const countCtx: FcCompletionCtx = {
    septicFee: num(props.propertyValues?.septic_fee),
    airQtyPrefill: num(props.propertyValues?.air_filters___total_quantity),
    filterOptionsAvailable: (props.filterSizeOptions?.length || 0) > 0,
    filterPrefills: [
      (props.propertyValues?.air_filters___type__1 as string) || null,
      (props.propertyValues?.air_filters___type__2 as string) || null,
      (props.propertyValues?.air_filters___type__3 as string) || null,
    ],
  };
  const skipLineRules = !props.onAddLine;

  // ---- shared photo strip (standardized yellow dashed "+" add box) ----
  function PhotoStrip({ urls, camKey, required, center }: { urls: string[]; camKey: string; required?: boolean; center?: boolean }) {
    return (
      <div className={`flex flex-wrap gap-2 items-center mt-1.5 ${center ? 'justify-center' : ''}`}>
        {urls.map((u, i) => (
          <div key={`${u}-${i}`} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={displayImageSrc(u)} alt="" onClick={() => openLightbox(camKey, i)}
              title="Tap to view, mark up, or delete"
              className="w-14 h-14 object-cover rounded border border-gray-200 cursor-pointer" />
            {!readOnly && (
              // Quick delete — same size / formatting / corner position as the room
              // section photo strip (RateCardForm) so the × is consistent everywhere.
              // stopPropagation so the tap deletes instead of opening the viewer.
              <button type="button" aria-label="Delete photo"
                onClick={(e) => { e.stopPropagation(); removePhoto(camKey, i); }}
                className="absolute -top-1 -right-1 bg-ink text-white text-xs w-4 h-4 rounded-full leading-none flex items-center justify-center hover:bg-brand">&times;</button>
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
  // Mark-up: the annotator hands back a new file; upload it and swap it in place.
  async function replacePhoto(camKey: string, idx: number, file: File) {
    try {
      const url = await props.uploadPhoto(file, camKey);
      const list = getPhotoList(camKey);
      if (idx >= 0 && idx < list.length) {
        const next = [...list]; next[idx] = url; setPhotoList(camKey, next);
      }
    } catch { /* upload failed — keep the original */ }
  }
  function openLightbox(camKey: string, idx: number) {
    setLbox({ groupId: camKey, index: idx });
    props.onCameraOverlayChange?.(true); // hide the floating mic behind the viewer
  }
  function closeLightbox() {
    setLbox(null);
    props.onCameraOverlayChange?.(false);
  }
  // Every FC photo location that currently holds at least one photo, in document
  // order — the navigable set for the lightbox. Group id is the "qid:key" camKey
  // (the same key getPhotoList/setPhotoList understand).
  function photoGroups(): { id: string; name: string }[] {
    const groups: { id: string; name: string }[] = [];
    for (const section of FINAL_CHECKLIST) {
      for (const q of section.questions) {
        if (!visible(q)) continue;
        const a = ans(q.id);
        if ((a.photoUrls || []).length > 0) groups.push({ id: `${q.id}:photo`, name: titleCase(q.label) });
        if (q.type === 'photo_set') {
          for (const p of (q.photos || [])) {
            if (((a.stickerPhotos || {})[p.id] || []).length > 0) {
              groups.push({ id: `${q.id}:${p.id}`, name: `${titleCase(q.label)} — ${titleCase(p.label)}` });
            }
          }
        }
      }
    }
    return groups;
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
            <button key={o} type="button" disabled={readOnly} onClick={() => onPick(sel ? '' : o)}
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
    // No line system in this context (e.g. the Q&A templates) → no add/decline UI.
    if (!props.onAddLine) return null;
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
              onKeyDown={blurOnEnter}
              className="w-full text-sm rounded-md px-2 py-1.5 bg-white border border-gray-300 focus-brand" />
          </div>
        )}
        {needPhoto && (
          <div>
            <div className="text-[11px] font-heading font-bold text-amber-800 mb-1">Photo <span className="text-brand">(Required)</span></div>
            {q.photoHint && <p className="text-[11px] text-amber-800/80 italic mb-1.5">{q.photoHint}</p>}
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
        {/* Standard "info" glyph: dot on top + vertical stem = a clear lowercase i.
            Round caps make the dot render as a dot (the old hand-rolled path drew
            a malformed hook). */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-brand" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="11" x2="12" y2="16" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
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
    const step = (d: number) => {
      // First press from a BLANK field lands on the starting value (the min, or 1
      // when min is 0) — not min+1 — so "+" goes blank → 1, not blank → 2.
      if (value == null) { onChange(Math.max(min, 1)); return; }
      const nv = Math.max(min, Math.min(max ?? 9999, v + d));
      onChange(nv);
    };
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
                        enterKeyHint="done" onKeyDown={blurOnEnter}
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
        // Drop any HubSpot-provided "other/different size" sentinel — we supply
        // our own single "Different Size" entry below.
        ...(props.filterSizeOptions || [])
          .filter((o) => !/different\s+(filter\s+)?size|i\s+have\s+a\s+different/i.test(o))
          .map((o) => ({ value: o, label: o })),
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
                <div className="flex items-center gap-2 max-w-[260px]">
                  <WheelPicker
                    value={val}
                    options={opts}
                    onChange={(v) => { const next = [...sizes]; next[i] = v; onPatch(q.id, { filterSizes: next }); }}
                    ariaLabel={`Filter Size ${i + 1}`}
                    large
                    className="flex-1 min-w-0 bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm flex items-center justify-between"
                  />
                  {val && !readOnly && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = [...sizes]; next[i] = '';
                        const no = [...others]; no[i] = '';
                        onPatch(q.id, { filterSizes: next, filterSizesOther: no });
                      }}
                      className="shrink-0 text-xs font-heading font-semibold text-gray-400 hover:text-red-600"
                      title="Clear this filter size"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {val === FC_FILTER_OTHER && (
                  <input
                    type="text" disabled={readOnly}
                    value={others[i] || ''}
                    onChange={(e) => { const next = [...others]; next[i] = e.target.value; onPatch(q.id, { filterSizesOther: next }); }}
                    placeholder="Enter the filter size (e.g. 14 × 30 × 1)"
                    enterKeyHint="done" onKeyDown={blurOnEnter}
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

    // single_select.
    // NOTE: ActionPanel/CountField/Reminder/AddLineArea are invoked as FUNCTIONS,
    // not as <Component/> elements. They're defined inside this component, so a
    // new function identity is created on every render — rendering them as JSX
    // makes React treat them as a new type each render and REMOUNT them, which
    // destroyed the note <textarea> (in ActionPanel) and dropped keyboard focus
    // on every keystroke. Calling them inlines their output into the stable tree.
    return (
      <>
        {Pills({ options: q.options, value: a.value, onPick: (v) => pickSingle(q, v) })}
        {ActionPanel({ q })}
        {CountField({ q })}
        {Reminder({ q })}
        {AddLineArea({ q })}
      </>
    );
  }

  function visible(q: FcQuestion): boolean {
    if (!q.showWhenProperty) return true;
    const v = num(props.propertyValues?.[q.showWhenProperty.field]);
    if (q.showWhenProperty.gt != null) return (v ?? 0) > q.showWhenProperty.gt;
    return true;
  }

  // One subsection's header + questions. In bare mode each is its OWN bubble
  // (matching the Q&A form's section style); otherwise it's a row inside the
  // outer "Final Checklist" bubble.
  const sectionEls = renderSections.map((section) => {
    const qs = section.questions.filter(visible);
    if (qs.length === 0) return null;
    // Seamless sections are always open (no collapse chrome).
    const sopen = props.seamless ? true : (openSections[section.id] ?? true);
    // Combined X/Y count across every member section (one member in the common case).
    const counts = section.memberIds.reduce(
      (acc, mid) => {
        const c = fcSectionCounts(answers, countCtx, mid, { skipLineRules });
        return { completed: acc.completed + c.completed, total: acc.total + c.total };
      },
      { completed: 0, total: 0 },
    );
    const header = props.bare ? (
      // Mirror the Q&A form's section header exactly: left rotating chevron,
      // big bold title, no "(Required)" tag.
      <button
        type="button"
        onClick={() => setOpenSections((m) => ({ ...m, [section.id]: !(m[section.id] ?? true) }))}
        aria-expanded={sopen}
        className="w-full bg-gray-50 text-gray-900 border-b border-gray-200 px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-100 transition"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 transition-transform ${sopen ? 'rotate-90' : ''}`}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <h2 className="font-heading font-bold text-lg truncate min-w-0 flex-1">{titleCase(section.name)}</h2>
        <span className="shrink-0 text-sm bg-brand text-white font-heading font-semibold px-2.5 py-0.5 rounded-full">{counts.completed}/{counts.total}</span>
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpenSections((m) => ({ ...m, [section.id]: !(m[section.id] ?? true) }))}
        aria-expanded={sopen}
        className="w-full px-4 py-2.5 bg-gray-50 hover:bg-gray-100 border-b border-gray-200 flex items-center gap-2 text-left"
      >
        <span className="font-heading font-bold text-sm text-ink">{titleCase(section.name)}</span>
        <span className="text-gray-400 ml-auto shrink-0">{sopen ? '▾' : '▸'}</span>
      </button>
    );
    const body = sopen && qs.map((q) => (
      <div key={q.id} className="px-4 py-4 border-t border-gray-100 first:border-t-0">
        <div className="font-heading font-semibold text-ink text-sm leading-snug mb-2">
          {titleCase(q.label)}{q.required && <span className="text-brand ml-1">*</span>}
        </div>
        {q.help && <p className="text-xs text-gray-500 italic -mt-1 mb-2">{q.help}</p>}
        {renderQuestion(q)}
      </div>
    ));
    // Seamless: just the question rows (no card, no header) so they embed as the
    // first rows of another section.
    if (props.seamless) {
      return <div key={section.id}>{body}</div>;
    }
    return props.bare ? (
      <section key={section.id} className="mb-8 rounded-xl border border-gray-200 shadow-md overflow-hidden bg-white">
        {header}
        {body}
      </section>
    ) : (
      <div key={section.id} className="border-b border-gray-100 last:border-b-0">
        {header}
        {body}
      </div>
    );
  });

  const overlays = (
    <>
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
      {/* Full-screen viewer for every Final Checklist photo. */}
      {lbox && (() => {
        const groups = photoGroups();
        const photosByGroup = Object.fromEntries(groups.map((g) => [g.id, getPhotoList(g.id)]));
        if (!photosByGroup[lbox.groupId]) return null;
        return (
          <PhotoLightbox
            groups={groups}
            photosByGroup={photosByGroup}
            initialGroupId={lbox.groupId}
            initialIndex={lbox.index}
            readOnly={readOnly}
            onClose={closeLightbox}
            onDelete={(gid, idx) => removePhoto(gid, idx)}
            onReplace={(gid, idx, file) => { void replacePhoto(gid, idx, file); }}
          />
        );
      })()}
    </>
  );

  // Bare: each subsection is its own standalone bubble (no outer wrapper, no
  // Inspector Final Notes) — used when embedding into the Q&A forms.
  if (props.bare) {
    return <>{sectionEls}{overlays}</>;
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
        <span className="font-semibold text-gray-900 text-sm sm:text-base">{props.title || 'Final Checklist'}</span>
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

          {sectionEls}

          {/* Inspector final notes — free-text and OPTIONAL. */}
          <div className="px-4 py-4 border-t border-gray-100">
            <div className="font-heading font-semibold text-ink text-sm leading-snug mb-2">
              Inspector Final Notes <span className="text-gray-400 font-normal">(Optional)</span>
            </div>
            <textarea
              value={ans(FC_FINAL_NOTES_ID).note || ''}
              disabled={readOnly}
              onChange={(e) => onPatch(FC_FINAL_NOTES_ID, { note: e.target.value })}
              rows={3}
              placeholder="Anything the approver should know about this turn (optional)…"
              onKeyDown={blurOnEnter}
              className="w-full text-sm rounded-md px-2 py-1.5 bg-white border border-gray-300 focus-brand disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
        </>
      )}

      {overlays}
    </section>
  );
}
