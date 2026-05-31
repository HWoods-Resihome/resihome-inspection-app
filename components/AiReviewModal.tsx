import { useEffect, useMemo, useState } from 'react';
import type { AiAdjustment } from '@/lib/aiReview';

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
  // Permanently dismiss a photo-gap flag so future reviews don't re-raise it.
  onIgnore?: (a: AiAdjustment) => void;
  // Persisted approve/decline decisions (restored across reload) + change report.
  initialDecisions?: Record<string, Decision>;
  onDecisionsChange?: (d: Record<string, Decision>) => void;
  // All rooms, so a wrong-room suggestion can offer a target-room dropdown.
  rooms?: { id: string; name: string }[];
}

// Per-suggestion inspector edits — raw input strings so the field can be
// cleared / retyped freely (parsed to numbers only on apply).
type Edit = { tenantPct?: string; quantity?: string; moveToSectionId?: string };

function money(n: number | undefined): string {
  if (n == null || !isFinite(n)) return '';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const SEV: Record<string, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-gray-400',
};

export function AiReviewModal({ open, loading, streaming, applying, error, summary, adjustments, onClose, onRetry, onApply, previewTenantDollars, onAddPhoto, onIgnore, initialDecisions, onDecisionsChange, rooms }: Props) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>(() => initialDecisions || {});
  // Report decision changes up so they can be persisted across reload.
  useEffect(() => { onDecisionsChange?.(decisions); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [decisions]);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [photoAdded, setPhotoAdded] = useState<Record<string, boolean>>({});
  const [addingPhoto, setAddingPhoto] = useState<string | null>(null);

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
  useEffect(() => { if (loading) { setDecisions({}); setEdits({}); setPhotoAdded({}); } }, [loading]);

  const allDecided = adjustments.every((a) => decisions[a.id]);
  const approvedCount = adjustments.filter((a) => decisions[a.id] === 'approve').length;
  const declinedCount = adjustments.filter((a) => decisions[a.id] === 'decline').length;

  // Merge the inspector's edits into each approved adjustment's `suggested`.
  const approved = useMemo(() => adjustments
    .filter((a) => decisions[a.id] === 'approve')
    .map((a) => {
      // Wrong-room: apply the inspector's chosen target room (dropdown).
      if (a.wrongRoom) {
        const sel = edits[a.id]?.moveToSectionId;
        if (sel && a.suggested) return { ...a, suggested: { ...a.suggested, moveToSectionId: sel, moveToRoomName: rooms?.find((r) => r.id === sel)?.name || a.suggested.moveToRoomName } };
        return a;
      }
      if (a.type === 'remove') return a; // remove ignores field edits
      const e = edits[a.id];
      const tp = e?.tenantPct != null && e.tenantPct !== '' ? Number(e.tenantPct) : undefined;
      const q = e?.quantity != null && e.quantity !== '' ? Number(e.quantity) : undefined;
      if (tp == null && q == null) return a;
      return {
        ...a,
        suggested: {
          ...(a.suggested || {}),
          ...(tp != null && isFinite(tp) ? { tenantBillBackPercent: Math.max(0, Math.min(100, tp)) } : {}),
          ...(q != null && isFinite(q) ? { quantity: q } : {}),
        },
      };
    }), [adjustments, decisions, edits]);

  if (!open) return null;

  const setEdit = (id: string, patch: Edit) => setEdits((m) => ({ ...m, [id]: { ...m[id], ...patch } }));

  const setAll = (d: Decision) => {
    const next: Record<string, Decision> = {};
    for (const a of adjustments) next[a.id] = d;
    setDecisions(next);
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-gray-200 flex items-start justify-between gap-3">
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
          <button type="button" onClick={onClose} disabled={applying} className="text-sm text-gray-500 hover:text-gray-800 shrink-0 disabled:opacity-40">Close</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
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
              {summary && <p className="text-sm text-gray-700 mb-3 leading-relaxed">{summary}</p>}

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
                                {a.title}
                                {a.sectionName && <span className="ml-1.5 text-[11px] font-normal text-gray-400">· {a.sectionName}</span>}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="text-xs text-gray-600 mt-1 leading-snug">{a.rationale}</div>

                              {a.needsPhoto ? (
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
                                        className="px-3 py-1 text-xs font-heading font-semibold rounded-md bg-brand text-white hover:bg-brand-dark disabled:opacity-50 inline-flex items-center gap-1"
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
                              ) : (a.wrongRoom && a.suggested?.moveToSectionId) ? (
                                /* Wrong room: pick the correct room (dropdown) and move the line there
                                   (keeps it — doesn't delete). */
                                <div className="mt-2">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-[11px] text-gray-500">Move to</span>
                                    <select
                                      value={edits[a.id]?.moveToSectionId ?? a.suggested.moveToSectionId}
                                      onChange={(e) => setEdit(a.id, { moveToSectionId: e.target.value })}
                                      className="text-sm border border-gray-300 rounded px-2 py-1 bg-white max-w-[170px]"
                                    >
                                      {(rooms && rooms.length ? rooms : [{ id: a.suggested.moveToSectionId!, name: a.suggested.moveToRoomName || 'room' }]).map((r) => (
                                        <option key={r.id} value={r.id}>{r.name}</option>
                                      ))}
                                    </select>
                                  </div>
                                  <div className="flex gap-2">
                                    <button type="button" onClick={() => setDecisions((m) => ({ ...m, [a.id]: 'approve' }))}
                                      className={`px-3 py-1 text-xs font-heading font-semibold rounded-md border ${d === 'approve' ? 'bg-brand text-white border-brand' : 'border-gray-300 text-gray-700 hover:border-brand/50'}`}>
                                      Move
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
                                    const tenantStr = edits[a.id]?.tenantPct ?? String(a.suggested?.tenantBillBackPercent ?? a.current?.tenantBillBackPercent ?? '');
                                    const qtyStr = edits[a.id]?.quantity ?? String(a.suggested?.quantity ?? a.current?.quantity ?? '');
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
                                            <div className="text-[11px] text-gray-400 mb-1">
                                              now: {a.current.tenantBillBackPercent != null && `${a.current.tenantBillBackPercent}% Tenant`}{a.current.tenantDollars != null && ` (${money(a.current.tenantDollars)})`}{a.current.quantity != null && ` · qty ${a.current.quantity}${unit ? ` ${unit}` : ''}`}
                                            </div>
                                          )}
                                        <div className="flex items-end gap-2 flex-wrap">
                                          <label className="text-[11px] text-gray-500">
                                            Tenant %
                                            <input
                                              type="number" min={0} max={100} step={5} inputMode="numeric"
                                              value={tenantStr}
                                              onChange={(e) => setEdit(a.id, { tenantPct: e.target.value })}
                                              className="block w-16 mt-0.5 px-2 py-1 text-sm border border-gray-300 rounded tabular-nums"
                                            />
                                          </label>
                                          <label className="text-[11px] text-gray-500">
                                            Qty{unit ? ` (${unit})` : ''}
                                            <input
                                              type="number" min={0} step="any" inputMode="decimal"
                                              value={qtyStr}
                                              placeholder={/^(SF|LF|SY)$/i.test(unit || '') ? 'enter' : ''}
                                              onChange={(e) => setEdit(a.id, { quantity: e.target.value })}
                                              className="block w-20 mt-0.5 px-2 py-1 text-sm border border-gray-300 rounded tabular-nums"
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
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && !error && (
          <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3">
            <div className="text-xs text-gray-500">
              {streaming ? 'Waiting for the review to finish…' : adjustments.length > 0 ? `${approvedCount} approved · ${declinedCount} declined${allDecided ? '' : ` · ${adjustments.length - approvedCount - declinedCount} pending`}` : ''}
            </div>
            <button
              type="button"
              onClick={() => onApply(approved)}
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
