import { useEffect, useMemo, useRef, useState } from 'react';
import type { AiAdjustment } from '@/lib/aiReview';
import { formatQty } from '@/lib/photoUpload';
import { NumberField } from '@/components/NumberPad';
import { sendAiFeedback, type AiFeedbackEvent } from '@/lib/aiFeedbackClient';

type Decision = 'approve' | 'decline';

interface Props {
  open: boolean;
  loading: boolean;        // true until the first result arrives
  streaming: boolean;      // true while results are still arriving
  applying: boolean;
  error: string | null;
  summary: string;
  adjustments: AiAdjustment[];
  onClose: () => void;
  onRetry: () => void;
  // Apply the approved adjustments (the parent makes the line changes), then
  // mark the review passed for the resulting scope.
  onApply: (approved: AiAdjustment[]) => void;
  // Live tenant-$ preview as the inspector edits % / qty on a suggestion.
  previewTenantDollars?: (a: AiAdjustment, o: { tenantPct?: number; quantity?: number }) => number | undefined;
  // For needsPhoto suggestions: capture a photo of the damage and attach it to
  // the room + line. Resolves true if a photo was added.
  onAddPhoto?: (a: AiAdjustment) => Promise<boolean>;
  // For missingCategory checks ("Approve — Add Items"): open the manual line-item
  // editor. Resolves with the number of lines added (0 if cancelled).
  onAddLineItems?: (a: AiAdjustment) => Promise<number>;
  // Permanently dismiss a photo-gap flag so future reviews don't re-raise it.
  onIgnore?: (a: AiAdjustment) => void;
  // Persisted approve/decline decisions (restored across reload) + change report.
  initialDecisions?: Record<string, Decision>;
  onDecisionsChange?: (d: Record<string, Decision>) => void;
  // The inspection these suggestions belong to (tags captured feedback).
  inspectionId?: string;
  // All rooms, so a wrong-room suggestion can offer a target-room dropdown.
  rooms?: { id: string; name: string }[];
  // Hide (but keep mounted) while the in-app camera is open over it, so the
  // "Add photo" capture isn't obscured and in-progress decisions survive.
  cameraOpen?: boolean;
}

// Per-suggestion inspector edits — raw input strings so the field can be
// cleared / retyped freely (parsed to numbers only on apply).
type Edit = { tenantPct?: string; quantity?: string; moveToSectionId?: string; removeInstead?: boolean; vendorCost?: string };

// Capitalize the first letter of every word (preserves existing caps/acronyms
// like SS, EA, QC). Used to clean up the AI's suggestion titles.
function titleCase(s: string): string {
  return (s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function money(n: number | undefined): string {
  if (n == null || !isFinite(n)) return '';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const SEV: Record<string, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-gray-400',
};

export function AiReviewModal({ open, loading, streaming, applying, error, summary, adjustments, onClose, onRetry, onApply, previewTenantDollars, onAddPhoto, onAddLineItems, onIgnore, initialDecisions, onDecisionsChange, inspectionId, rooms, cameraOpen }: Props) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => initialDecisions || {});
  // Report decision changes up so they can be persisted across reload.
  useEffect(() => { onDecisionsChange?.(decisions); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [decisions]);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [photoAdded, setPhotoAdded] = useState<Record<string, boolean>>({});
  const [addingPhoto, setAddingPhoto] = useState<string | null>(null);
  // missingCategory checks: how many lines the inspector added, and which is busy.
  const [linesAdded, setLinesAdded] = useState<Record<string, number>>({});
  const [addingItems, setAddingItems] = useState<string | null>(null);

  // Minimize + drag-by-header, so the inspector can pull the review aside and
  // see/edit the original inspection while suggestions stream in. The backdrop
  // is non-blocking (clicks pass through to the form behind).
  const [minimized, setMinimized] = useState(false);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; bx: number; by: number } | null>(null);
  useEffect(() => { if (open) { setDrag({ x: 0, y: 0 }); setMinimized(false); } }, [open]);
  const onHeaderDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // header buttons still work
    dragRef.current = { sx: e.clientX, sy: e.clientY, bx: drag.x, by: drag.y };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const onHeaderMove = (e: React.PointerEvent) => {
    const d = dragRef.current; if (!d) return;
    setDrag({ x: d.bx + (e.clientX - d.sx), y: d.by + (e.clientY - d.sy) });
  };
  const onHeaderUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  // Friendly, cycling status shown the instant the review opens (before the
  // first suggestion streams in) so the inspector gets immediate feedback.
  const PHASES = [
    'Analyzing scope and photos…',
    'Checking depreciation & duplicates…',
    'Reviewing tenant responsibility…',
    'Cross-checking paint & cleaning totals…',
  ];
  const [phase, setPhase] = useState(0);
  const waitingForFirst = !error && (loading || (streaming && adjustments.length === 0));
  useEffect(() => {
    if (!open || !waitingForFirst) { setPhase(0); return; }
    const t = setInterval(() => setPhase((p) => (p + 1) % PHASES.length), 3800);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, waitingForFirst]);

  // Reset decisions/edits only when a NEW review run begins (loading flips
  // true) — NOT on every streamed append, which previously wiped a decision the
  // inspector made mid-stream (the "had to tap Decline twice" glitch).
  useEffect(() => { if (loading) { setDecisions({}); setEdits({}); setPhotoAdded({}); setLinesAdded({}); setAddingItems(null); } }, [loading]);

  const allDecided = adjustments.every((a) => decisions[a.id]);
  const approvedCount = adjustments.filter((a) => decisions[a.id] === 'approve').length;
  const declinedCount = adjustments.filter((a) => decisions[a.id] === 'decline').length;

  // Merge the inspector's edits into each approved adjustment's `suggested`.
  const approved = useMemo(() => adjustments
    .filter((a) => decisions[a.id] === 'approve')
    .map((a) => {
      // Wrong-room: either move to the chosen room, or remove the line entirely.
      if (a.wrongRoom) {
        if (edits[a.id]?.removeInstead) return { ...a, wrongRoom: false, type: 'remove' as const };
        const sel = edits[a.id]?.moveToSectionId ?? a.suggested?.moveToSectionId ?? a.sectionId;
        return { ...a, suggested: { ...(a.suggested || {}), moveToSectionId: sel, moveToRoomName: rooms?.find((r) => r.id === sel)?.name || a.suggested?.moveToRoomName } };
      }
      if (a.type === 'remove') return a; // remove ignores field edits
      const e = edits[a.id];
      // Add-a-vendor-charge: approving with a cost entered sets customVendorCost.
      if (a.needsVendorCost) {
        const vc = e?.vendorCost != null && e.vendorCost !== '' ? Number(e.vendorCost) : undefined;
        if (vc == null || !isFinite(vc)) return a; // approved with no charge → no change
        return { ...a, suggested: { ...(a.suggested || {}), customVendorCost: Math.max(0, vc) } };
      }
      const tp = e?.tenantPct != null && e.tenantPct !== '' ? Number(e.tenantPct) : undefined;
      const q = e?.quantity != null && e.quantity !== '' ? Number(e.quantity) : undefined;
      const vc = e?.vendorCost != null && e.vendorCost !== '' ? Number(e.vendorCost) : undefined;
      if (tp == null && q == null && vc == null) return a;
      return {
        ...a,
        suggested: {
          ...(a.suggested || {}),
          ...(tp != null && isFinite(tp) ? { tenantBillBackPercent: Math.max(0, Math.min(100, tp)) } : {}),
          ...(q != null && isFinite(q) ? { quantity: q } : {}),
          ...(vc != null && isFinite(vc) ? { customVendorCost: Math.max(0, vc) } : {}),
        },
      };
    }), [adjustments, decisions, edits]);

  if (!open) return null;

  const setEdit = (id: string, patch: Edit) => setEdits((m) => ({ ...m, [id]: { ...m[id], ...patch } }));

  const setAll = (d: Decision) => {
    const next: Record<string, Decision> = {};
    for (const a of adjustments) {
      // missingCategory checks must be resolved individually (Approve → add
      // items, or Decline = none needed) — never bulk-set.
      if (a.missingCategory) { if (decisions[a.id]) next[a.id] = decisions[a.id]; continue; }
      next[a.id] = d;
    }
    setDecisions(next);
  };

  // Capture the human's verdict on each suggestion for the AI flywheel. Runs at
  // the authoritative moment (Apply): we record what the AI proposed alongside
  // the inspector's final decision and any qty/tenant% correction. Best-effort.
  const captureFeedback = () => {
    try {
      const events: AiFeedbackEvent[] = [];
      for (const a of adjustments) {
        const d = decisions[a.id];
        if (!d) continue;
        const e = edits[a.id];
        let correction: AiFeedbackEvent['correction'] | undefined;
        const tp = e?.tenantPct, q = e?.quantity;
        if (tp != null && tp !== '' && isFinite(Number(tp))) {
          correction = { ...(correction || {}), fromTenantPct: a.current?.tenantBillBackPercent, toTenantPct: Number(tp) };
        }
        if (q != null && q !== '' && isFinite(Number(q))) {
          correction = { ...(correction || {}), fromQuantity: a.current?.quantity, toQuantity: Number(q) };
        }
        if (e?.moveToSectionId) correction = { ...(correction || {}), movedToSectionId: e.moveToSectionId };
        // Resolve a precise decision label for wrong-room (move vs remove).
        const decision: AiFeedbackEvent['decision'] = a.wrongRoom
          ? (d === 'approve' ? (e?.removeInstead ? 'remove' : 'move') : 'decline')
          : (d === 'approve' && correction && (correction.toQuantity != null || correction.toTenantPct != null) ? 'edit' : d);
        events.push({
          source: 'ai_review',
          decision,
          inspectionId,
          sectionId: a.sectionId,
          suggestion: {
            id: a.id,
            type: a.missingCategory ? `missingCategory:${a.missingCategory}` : a.needsPhoto ? 'needsPhoto' : a.wrongRoom ? 'wrongRoom' : a.type,
            catalogCode: a.suggested?.lineItemCode || a.current?.lineItemCode,
            title: a.title,
            confidence: a.severity,
          },
          correction,
        });
      }
      if (events.length) sendAiFeedback(events);
    } catch { /* never block apply */ }
  };

  return (
    <div data-modal-overlay className={`fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4 pointer-events-none ${cameraOpen ? 'hidden' : ''}`}>
      <div
        className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden pointer-events-auto ring-1 ring-black/10"
        style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }}
      >
        {/* Header — drag handle (click + drag to move the panel aside) */}
        <div
          onPointerDown={onHeaderDown}
          onPointerMove={onHeaderMove}
          onPointerUp={onHeaderUp}
          className="px-5 py-3.5 border-b border-gray-200 flex items-start justify-between gap-3 cursor-move touch-none select-none"
        >
          <div className="min-w-0">
            <div className="font-heading font-bold text-ink text-base flex items-center gap-2">
              <span className="text-brand">✦</span> AI Scope Review
            </div>
            {!loading && !error && (
              <div className="text-xs text-gray-500 mt-0.5">
                {streaming
                  ? `Reviewing… ${adjustments.length} found so far`
                  : adjustments.length === 0 ? 'No changes suggested' : `${adjustments.length} suggestion${adjustments.length === 1 ? '' : 's'}`}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setMinimized((m) => !m)}
              aria-label={minimized ? 'Expand' : 'Minimize'}
              title={minimized ? 'Expand' : 'Minimize'}
              className="text-gray-500 hover:text-gray-800"
            >
              {minimized ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
              )}
            </button>
            <button type="button" onClick={onClose} disabled={applying} className="text-sm text-gray-500 hover:text-gray-800 disabled:opacity-40">Close</button>
          </div>
        </div>

        {/* Body */}
        <div data-modal-scroll className={`flex-1 overflow-y-auto px-5 py-4 ${minimized ? 'hidden' : ''}`}>
          {loading && (
            <div className="py-10 text-center">
              <div className="inline-block w-7 h-7 border-2 border-brand border-t-transparent rounded-full animate-spin mb-3" />
              <div className="text-sm text-gray-700 font-heading transition-opacity">{PHASES[phase]}</div>
              <div className="text-xs text-gray-400 mt-1">Reviewing against the investment-property turn standard.</div>
            </div>
          )}

          {error && !loading && (
            <div className="py-6 text-center">
              <div className="text-sm text-red-600 mb-3">{error}</div>
              <button type="button" onClick={onRetry} className="px-4 py-2 text-sm rounded-lg bg-brand text-white font-semibold hover:bg-brand-dark">Try again</button>
            </div>
          )}

          {!loading && !error && (
            <>
              {/* (Summary moved to the bottom — see below — so streaming
                  suggestions stay anchored at the top.) */}
              {adjustments.length === 0 && summary && !streaming && (
                <p className="text-sm text-gray-700 mb-3 leading-relaxed">{summary}</p>
              )}

              {adjustments.length === 0 ? (
                streaming ? (
                  <div className="py-8 text-center">
                    <div className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin mb-2" />
                    <div className="text-sm text-gray-700 font-heading">{PHASES[phase]}</div>
                  </div>
                ) : (
                  <div className="py-6 text-center text-sm text-emerald-700 font-heading font-semibold">
                    ✓ Scope looks compliant with the turn standard.
                  </div>
                )
              ) : (
                <>
                  {!streaming && (
                    <div className="flex items-center justify-end gap-3 mb-2 text-xs">
                      <button type="button" onClick={() => setAll('approve')} className="text-brand font-heading font-semibold hover:underline">Approve all</button>
                      <button type="button" onClick={() => setAll('decline')} className="text-gray-500 font-heading font-semibold hover:underline">Decline all</button>
                    </div>
                  )}
                  <div className="space-y-2.5">
                    {adjustments.map((a) => {
                      const d = decisions[a.id];
                      return (
                        <div key={a.id} className={`rounded-xl border p-3 ${d === 'approve' ? 'border-brand bg-brand/5' : d === 'decline' ? 'border-gray-200 bg-gray-50 opacity-70' : 'border-gray-200'}`}>
                          <div>
                            <div className="flex items-start gap-2">
                              <span className={`mt-[5px] w-2.5 h-2.5 rounded-full shrink-0 ${SEV[a.severity || 'medium']}`} />
                              <div className="text-sm font-semibold text-ink leading-snug min-w-0 flex-1">
                                {titleCase(a.title)}
                                {a.sectionName && <span className="ml-1.5 text-[11px] font-normal text-gray-400">· {a.sectionName}</span>}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="text-xs text-gray-600 mt-1 leading-snug">{a.rationale}</div>

                              {/* Inspector's own note on the line (e.g. what a bid
                                  item is actually for) — surfaced so the reviewer
                                  can price it instead of skipping over a $5 bid. */}
                              {a.current?.note && (
                                <div className="text-xs mt-1.5 px-2 py-1.5 rounded-md bg-amber-50 border border-amber-200 text-gray-700 leading-snug">
                                  <span className="font-heading font-semibold text-amber-700">Inspector note: </span>
                                  {a.current.note}
                                </div>
                              )}

                              {a.needsVendorCost ? (
                                /* $0 line — enter a vendor charge (Apply), or confirm none needed. */
                                <div className="mt-2">
                                  {a.current?.description && (
                                    <div className="text-xs text-gray-700 mb-1.5">{a.current.description} · <span className="text-gray-400">currently $0</span></div>
                                  )}
                                  <div className="flex items-end gap-2 flex-wrap">
                                    <label className="text-[11px] text-gray-500">
                                      Vendor charge ($)
                                      <NumberField
                                        value={edits[a.id]?.vendorCost ?? ''}
                                        onChange={(v) => setEdit(a.id, { vendorCost: v })}
                                        ariaLabel="Vendor charge"
                                        placeholder="0.00"
                                        className="block w-24 mt-0.5 px-2 py-1 text-sm border border-gray-300 rounded tabular-nums"
                                      />
                                    </label>
                                    <button type="button"
                                      onClick={() => setDecisions((m) => ({ ...m, [a.id]: 'approve' }))}
                                      disabled={!(Number(edits[a.id]?.vendorCost) > 0)}
                                      className={`px-3 py-1.5 text-xs font-heading font-semibold rounded-md border disabled:opacity-40 ${d === 'approve' ? 'bg-brand text-white border-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`}>
                                      Apply charge
                                    </button>
                                    <button type="button" onClick={() => { setEdit(a.id, { vendorCost: '' }); setDecisions((m) => ({ ...m, [a.id]: 'decline' })); }}
                                      className={`px-3 py-1.5 text-xs font-heading font-semibold rounded-md border ${d === 'decline' ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-300 text-gray-700 hover:border-gray-400'}`}>
                                      No charge needed
                                    </button>
                                  </div>
                                </div>
                              ) : a.missingCategory ? (
                                /* Deterministic "no <category> lines anywhere" check. Approve →
                                   add items via the manual editor; Decline = no items required. */
                                (() => {
                                  const label = a.missingCategory === 'paint' ? 'Paint' : 'Cleaning';
                                  if (linesAdded[a.id]) {
                                    return <div className="text-xs text-emerald-700 font-heading font-semibold mt-2">✓ {linesAdded[a.id]} {label.toLowerCase()} line{linesAdded[a.id] === 1 ? '' : 's'} added</div>;
                                  }
                                  return (
                                    <div className="mt-2">
                                      <div className="flex gap-2 flex-wrap">
                                        <button type="button" disabled={addingItems === a.id}
                                          onClick={async () => {
                                            if (!onAddLineItems) return;
                                            setAddingItems(a.id);
                                            const n = await onAddLineItems(a).catch(() => 0);
                                            setAddingItems(null);
                                            if (n > 0) { setLinesAdded((m) => ({ ...m, [a.id]: n })); setDecisions((m) => ({ ...m, [a.id]: 'approve' })); }
                                          }}
                                          className={`px-3 py-1.5 text-xs font-heading font-semibold rounded-md border disabled:opacity-50 ${d === 'approve' ? 'bg-brand text-white border-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`}>
                                          {addingItems === a.id ? 'Opening…' : 'Approve — Add Items'}
                                        </button>
                                        <button type="button" onClick={() => setDecisions((m) => ({ ...m, [a.id]: 'decline' }))}
                                          className={`px-3 py-1.5 text-xs font-heading font-semibold rounded-md border ${d === 'decline' ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-300 text-gray-700 hover:border-gray-400'}`}>
                                          Decline — No Items Required
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })()
                              ) : a.needsPhoto ? (
                                /* Photo evidence gap: add a photo of the damage (attaches to
                                   the room + this line) OR remove the line — not approve/decline. */
                                <>
                                  <div className="text-xs mt-1.5 text-gray-700">
                                    {a.current?.description}{a.current?.tenantDollars != null && <span className="text-gray-400"> · Tenant {money(a.current.tenantDollars)}</span>}
                                  </div>
                                  {photoAdded[a.id] ? (
                                    <div className="text-xs text-emerald-700 font-heading font-semibold mt-2">✓ Photo added — line kept</div>
                                  ) : (
                                    <div className="flex gap-2 mt-2 flex-wrap items-center">
                                      <button
                                        type="button"
                                        disabled={addingPhoto === a.id}
                                        onClick={async () => {
                                          if (!onAddPhoto) return;
                                          setAddingPhoto(a.id);
                                          const ok = await onAddPhoto(a).catch(() => false);
                                          setAddingPhoto(null);
                                          if (ok) { setPhotoAdded((m) => ({ ...m, [a.id]: true })); setDecisions((m) => ({ ...m, [a.id]: 'decline' })); }
                                        }}
                                        className="px-3 py-1 text-xs font-heading font-semibold rounded-md border border-gray-300 text-gray-700 hover:border-brand/50 disabled:opacity-50 inline-flex items-center gap-1"
                                      >
                                        {addingPhoto === a.id ? 'Adding…' : '📷 Add photo'}
                                      </button>
                                      <button type="button" onClick={() => setDecisions((m) => ({ ...m, [a.id]: 'approve' }))}
                                        className={`px-3 py-1 text-xs font-heading font-semibold rounded-md border ${d === 'approve' ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-300 text-gray-700 hover:border-gray-400'}`}>
                                        Remove line
                                      </button>
                                      <button type="button"
                                        onClick={() => { onIgnore?.(a); setDecisions((m) => ({ ...m, [a.id]: 'decline' })); }}
                                        className={`px-3 py-1 text-xs font-heading font-semibold rounded-md border ${d === 'decline' ? 'bg-gray-200 text-gray-700 border-gray-300' : 'border-gray-300 text-gray-500 hover:border-gray-400'}`}
                                        title="Keep the line as-is and don't flag it for a photo again">
                                        Ignore
                                      </button>
                                    </div>
                                  )}
                                </>
                              ) : a.wrongRoom ? (
                                /* Wrong room: pick the correct room (dropdown) and move the line there
                                   (keeps it — doesn't delete). Defaults to the AI's suggested room. */
                                <div className="mt-2">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[11px] text-gray-500">Move to</span>
                                    <select
                                      value={edits[a.id]?.moveToSectionId ?? a.suggested?.moveToSectionId ?? a.sectionId}
                                      onChange={(e) => setEdit(a.id, { moveToSectionId: e.target.value })}
                                      className="text-sm border border-gray-300 rounded px-2 py-1 bg-white max-w-[180px]"
                                    >
                                      {(rooms && rooms.length ? rooms : [{ id: a.sectionId, name: a.sectionName || 'room' }]).map((r) => (
                                        <option key={r.id} value={r.id}>{r.name}</option>
                                      ))}
                                    </select>
                                  </div>
                                  <div className="flex gap-2 flex-wrap">
                                    <button type="button" onClick={() => { setEdit(a.id, { removeInstead: false }); setDecisions((m) => ({ ...m, [a.id]: 'approve' })); }}
                                      className={`px-3 py-1 text-xs font-heading font-semibold rounded-md border ${d === 'approve' && !edits[a.id]?.removeInstead ? 'bg-brand text-white border-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`}>
                                      Move
                                    </button>
                                    <button type="button" onClick={() => { setEdit(a.id, { removeInstead: true }); setDecisions((m) => ({ ...m, [a.id]: 'approve' })); }}
                                      className={`px-3 py-1 text-xs font-heading font-semibold rounded-md border ${d === 'approve' && edits[a.id]?.removeInstead ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-300 text-gray-700 hover:border-gray-400'}`}>
                                      Remove line
                                    </button>
                                    <button type="button" onClick={() => setDecisions((m) => ({ ...m, [a.id]: 'decline' }))}
                                      className={`px-3 py-1 text-xs font-heading font-semibold rounded-md border ${d === 'decline' ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-300 text-gray-700 hover:border-gray-400'}`}>
                                      Decline
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <>
                                  {/* before → after + editable fields */}
                                  {a.type === 'remove' ? (
                                    <div className="text-xs mt-1.5 text-gray-700">
                                      {a.current?.description}{a.current?.tenantDollars != null && <span className="text-gray-400"> · Tenant {money(a.current.tenantDollars)}</span>}
                                    </div>
                                  ) : (() => {
                                    const unit = a.suggested?.unit || a.current?.unit;
                                    // A code SWAP to a different unit of measure must not inherit the
                                    // old quantity (e.g. 1,685 SF → a per-EA clean should be qty 1).
                                    const isSwap = !!a.suggested?.lineItemCode
                                      && (a.suggested?.unit || '').toUpperCase() !== (a.current?.unit || '').toUpperCase();
                                    const tenantStr = edits[a.id]?.tenantPct ?? String(a.suggested?.tenantBillBackPercent ?? a.current?.tenantBillBackPercent ?? '');
                                    const qtyStr = edits[a.id]?.quantity ?? String(a.suggested?.quantity ?? (isSwap ? 1 : a.current?.quantity) ?? '');
                                    const tenantNum = tenantStr === '' ? undefined : Number(tenantStr);
                                    const qtyNum = qtyStr === '' ? undefined : Number(qtyStr);
                                    const previewDollars = previewTenantDollars
                                      ? previewTenantDollars(a, { tenantPct: tenantNum, quantity: qtyNum })
                                      : a.suggestedTenantDollars;
                                    const dollars = previewDollars ?? a.suggestedTenantDollars;
                                    return (
                                      <div className="mt-1.5">
                                        {a.type === 'add'
                                          ? <div className="text-xs text-emerald-700 mb-1">+ {a.suggested?.description || a.suggested?.lineItemCode}</div>
                                          : a.current && (
                                            <>
                                              {/* When the scope is being SWAPPED to a different line item,
                                                  spell out from → to so it's clear what's changing. */}
                                              {isSwap && a.suggested?.description && (
                                                <div className="text-xs text-gray-700 mb-1">
                                                  <span className="text-gray-500">Change:</span> {a.current.description}
                                                  <span className="text-gray-400"> → </span>
                                                  <span className="text-emerald-700">{a.suggested.description}</span>
                                                </div>
                                              )}
                                              <div className="text-[11px] text-gray-400 mb-1">
                                                now: {a.current.tenantBillBackPercent != null && `${a.current.tenantBillBackPercent}% Tenant`}{a.current.tenantDollars != null && ` (${money(a.current.tenantDollars)})`}{a.current.quantity != null && ` · qty ${formatQty(a.current.quantity)}${a.current.unit ? ` ${a.current.unit}` : ''}`}
                                              </div>
                                            </>
                                          )}
                                        <div className="flex items-end gap-2 flex-wrap">
                                          <label className="text-[11px] text-gray-500">
                                            Tenant %
                                            <NumberField
                                              allowDecimal={false}
                                              value={tenantStr}
                                              onChange={(v) => setEdit(a.id, { tenantPct: v })}
                                              ariaLabel="Tenant percent"
                                              className="block w-16 mt-0.5 px-2 py-1 text-sm border border-gray-300 rounded tabular-nums"
                                            />
                                          </label>
                                          <label className="text-[11px] text-gray-500">
                                            Qty{unit ? ` (${unit})` : ''}
                                            <NumberField
                                              value={qtyStr}
                                              placeholder={/^(SF|LF|SY)$/i.test(unit || '') ? 'enter' : ''}
                                              onChange={(v) => setEdit(a.id, { quantity: v })}
                                              ariaLabel="Quantity"
                                              className="block w-20 mt-0.5 px-2 py-1 text-sm border border-gray-300 rounded tabular-nums"
                                            />
                                          </label>
                                          <label className="text-[11px] text-gray-500">
                                            Vendor $
                                            <NumberField
                                              value={edits[a.id]?.vendorCost ?? (a.suggested?.customVendorCost != null ? String(a.suggested.customVendorCost) : (a.current?.vendorCost != null ? String(a.current.vendorCost) : ''))}
                                              placeholder="cost"
                                              onChange={(v) => setEdit(a.id, { vendorCost: v })}
                                              ariaLabel="Vendor cost"
                                              className="block w-24 mt-0.5 px-2 py-1 text-sm border border-gray-300 rounded tabular-nums"
                                            />
                                          </label>
                                          <div className="text-xs text-brand font-semibold pb-1.5 ml-auto">
                                            {dollars != null ? `Tenant ${money(dollars)}` : ''}
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })()}

                                  {/* approve / decline */}
                                  <div className="flex gap-2 mt-2">
                                    <button type="button" onClick={() => setDecisions((m) => ({ ...m, [a.id]: 'approve' }))}
                                      className={`px-3 py-1 text-xs font-heading font-semibold rounded-md border ${d === 'approve' ? 'bg-brand text-white border-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`}>
                                      Approve
                                    </button>
                                    <button type="button" onClick={() => setDecisions((m) => ({ ...m, [a.id]: 'decline' }))}
                                      className={`px-3 py-1 text-xs font-heading font-semibold rounded-md border ${d === 'decline' ? 'bg-gray-700 text-white border-gray-700' : 'border-gray-300 text-gray-700 hover:border-gray-400'}`}>
                                      Decline
                                    </button>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {streaming && (
                    <div className="flex items-center gap-2 mt-3 text-xs text-gray-500">
                      <span className="inline-block w-3.5 h-3.5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                      Finding more…
                    </div>
                  )}
                </>
              )}
              {/* Summary renders LAST/at the bottom so it can't shift the
                  streamed suggestions (and your clicks) as it arrives. */}
              {summary && !streaming && adjustments.length > 0 && (
                <p className="text-xs text-gray-500 mt-3 pt-3 border-t border-gray-100 leading-relaxed">{summary}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && !error && (
          <div className={`px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3 ${minimized ? 'hidden' : ''}`}>
            {/* Always-available exit so the inspector is never trapped behind
                pending flags (a clear "back out" that doesn't require deciding
                every item). */}
            <button
              type="button"
              onClick={onClose}
              disabled={applying}
              className="px-3 py-2 text-sm rounded-lg border border-gray-300 bg-white text-gray-700 font-heading font-semibold hover:bg-gray-100 disabled:opacity-40 shrink-0"
            >
              Close
            </button>
            <div className="text-xs text-gray-500 min-w-0 flex-1 text-right">
              {streaming ? 'Reviewing…' : adjustments.length > 0 ? `${approvedCount}✓ · ${declinedCount}✗${allDecided ? '' : ` · ${adjustments.length - approvedCount - declinedCount} left`}` : ''}
            </div>
            <button
              type="button"
              onClick={() => { captureFeedback(); onApply(approved); }}
              disabled={applying || streaming || (adjustments.length > 0 && !allDecided)}
              className="px-4 py-2 text-sm rounded-lg bg-brand text-white font-heading font-semibold hover:bg-brand-dark disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {applying && <span className="inline-block w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              {adjustments.length === 0 ? 'Mark reviewed' : applying ? 'Applying…' : approvedCount > 0 ? `Apply ${approvedCount} & finish` : 'Finish review'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
