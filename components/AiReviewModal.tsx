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
}

// Per-suggestion inspector edits (override the AI's suggested values before applying).
type Edit = { tenantPct?: number; quantity?: number };

function money(n: number | undefined): string {
  if (n == null || !isFinite(n)) return '';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const SEV: Record<string, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-gray-400',
};

const TYPE_LABEL: Record<string, string> = {
  edit: 'Edit',
  remove: 'Remove',
  add: 'Add',
};

export function AiReviewModal({ open, loading, streaming, applying, error, summary, adjustments, onClose, onRetry, onApply, previewTenantDollars }: Props) {
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [edits, setEdits] = useState<Record<string, Edit>>({});

  // Reset decisions/edits whenever a new set of adjustments arrives.
  useEffect(() => { setDecisions({}); setEdits({}); }, [adjustments]);

  const allDecided = adjustments.every((a) => decisions[a.id]);
  const approvedCount = adjustments.filter((a) => decisions[a.id] === 'approve').length;
  const declinedCount = adjustments.filter((a) => decisions[a.id] === 'decline').length;

  // Merge the inspector's edits into each approved adjustment's `suggested`.
  const approved = useMemo(() => adjustments
    .filter((a) => decisions[a.id] === 'approve')
    .map((a) => {
      const e = edits[a.id];
      if (!e || a.type === 'remove') return a;
      return {
        ...a,
        suggested: {
          ...(a.suggested || {}),
          ...(e.tenantPct != null ? { tenantBillBackPercent: e.tenantPct } : {}),
          ...(e.quantity != null ? { quantity: e.quantity } : {}),
        },
      };
    }), [adjustments, decisions, edits]);

  if (!open) return null;

  const setEdit = (id: string, patch: Edit) => setEdits((m) => ({ ...m, [id]: { ...m[id], ...patch } }));
  const num = (v: string): number | undefined => {
    if (v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

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
              <div className="text-sm text-gray-600">Reviewing the scope against the turn standard…</div>
              <div className="text-xs text-gray-400 mt-1">Checking depreciation, duplicates, tenant responsibility and photos.</div>
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
                    <div className="text-sm text-gray-600">Reviewing the scope…</div>
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
                          <div className="flex items-start gap-2">
                            <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${SEV[a.severity || 'medium']}`} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[10px] uppercase tracking-wide font-heading font-bold text-gray-500 bg-gray-100 rounded px-1.5 py-0.5">{TYPE_LABEL[a.type]}</span>
                                {a.sectionName && <span className="text-[11px] text-gray-400">{a.sectionName}</span>}
                              </div>
                              <div className="text-sm font-semibold text-ink mt-1 leading-snug">{a.title}</div>
                              <div className="text-xs text-gray-600 mt-0.5 leading-snug">{a.rationale}</div>

                              {/* before → after + editable fields */}
                              {a.type === 'remove' ? (
                                <div className="text-xs mt-1.5 text-gray-700">
                                  {a.current?.description}{a.current?.tenantDollars != null && <span className="text-gray-400"> · tenant {money(a.current.tenantDollars)}</span>}
                                </div>
                              ) : (() => {
                                const unit = a.suggested?.unit || a.current?.unit;
                                const tenantVal = edits[a.id]?.tenantPct ?? a.suggested?.tenantBillBackPercent ?? a.current?.tenantBillBackPercent;
                                const qtyVal = edits[a.id]?.quantity ?? a.suggested?.quantity ?? a.current?.quantity;
                                const previewDollars = previewTenantDollars
                                  ? previewTenantDollars(a, { tenantPct: tenantVal, quantity: qtyVal })
                                  : (edits[a.id] ? undefined : a.suggestedTenantDollars);
                                const dollars = previewDollars ?? a.suggestedTenantDollars;
                                return (
                                  <div className="mt-1.5">
                                    {a.type === 'add'
                                      ? <div className="text-xs text-emerald-700 mb-1">+ {a.suggested?.description || a.suggested?.lineItemCode}</div>
                                      : a.current && (
                                        <div className="text-[11px] text-gray-400 mb-1">
                                          now: {a.current.tenantBillBackPercent != null && `${a.current.tenantBillBackPercent}% tenant`}{a.current.tenantDollars != null && ` (${money(a.current.tenantDollars)})`}{a.current.quantity != null && ` · qty ${a.current.quantity}${unit ? ` ${unit}` : ''}`}
                                        </div>
                                      )}
                                    <div className="flex items-end gap-2 flex-wrap">
                                      <label className="text-[11px] text-gray-500">
                                        Tenant %
                                        <input
                                          type="number" min={0} max={100} step={5} inputMode="numeric"
                                          value={tenantVal ?? ''}
                                          onChange={(e) => setEdit(a.id, { tenantPct: num(e.target.value) })}
                                          className="block w-16 mt-0.5 px-2 py-1 text-sm border border-gray-300 rounded tabular-nums"
                                        />
                                      </label>
                                      <label className="text-[11px] text-gray-500">
                                        Qty{unit ? ` (${unit})` : ''}
                                        <input
                                          type="number" min={0} step="any" inputMode="decimal"
                                          value={qtyVal ?? ''}
                                          placeholder={/^(SF|LF|SY)$/i.test(unit || '') ? 'enter' : ''}
                                          onChange={(e) => setEdit(a.id, { quantity: num(e.target.value) })}
                                          className="block w-20 mt-0.5 px-2 py-1 text-sm border border-gray-300 rounded tabular-nums"
                                        />
                                      </label>
                                      <div className="text-xs text-brand font-semibold pb-1.5 ml-auto">
                                        {dollars != null ? `tenant ${money(dollars)}` : ''}
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
