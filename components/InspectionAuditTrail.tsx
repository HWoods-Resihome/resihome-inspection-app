import { useEffect, useState } from 'react';

interface AuditEvent {
  action: string;
  actorEmail?: string;
  actorName?: string;
  detail?: string;
  ts: string;
  meta?: Record<string, any>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  inspectionId: string;
}

// Per-action display: label + dot color + glyph.
const ACTION: Record<string, { label: string; dot: string; glyph: string }> = {
  create:     { label: 'Created',               dot: 'bg-gray-400',    glyph: '＋' },
  submit:     { label: 'Submitted for approval', dot: 'bg-sky-500',     glyph: '↑' },
  approve:    { label: 'Approved & finalized',   dot: 'bg-emerald-500', glyph: '✓' },
  refinalize: { label: 'Re-finalized',           dot: 'bg-amber-500',   glyph: '⟳' },
  regenerate: { label: 'PDFs regenerated',       dot: 'bg-amber-400',   glyph: '⟳' },
  reopen:     { label: 'Reopened',               dot: 'bg-amber-500',   glyph: '↩' },
  edit:       { label: 'Edited',                 dot: 'bg-indigo-500',  glyph: '✎' },
  cancel:     { label: 'Cancelled',              dot: 'bg-red-500',     glyph: '✕' },
};

function fmtWhen(ts: string): string {
  const d = new Date(ts);
  if (isNaN(+d)) return ts;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function actor(e: AuditEvent): string | null {
  const who = e.actorName || e.actorEmail;
  return who ? String(who) : null;
}

export function InspectionAuditTrail({ open, onClose, inspectionId }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/inspections/${inspectionId}/audit`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { if (!cancelled) setEvents(Array.isArray(data?.events) ? data.events : []); })
      .catch((e) => { if (!cancelled) setError(String(e?.message || e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, inspectionId]);

  if (!open) return null;

  return (
    <div data-modal-overlay className="fixed inset-0 z-[80] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-gray-200 flex items-center justify-between gap-3">
          <div className="font-heading font-bold text-ink text-base flex items-center gap-2">
            <span className="text-brand">🕑</span> Audit Trail
          </div>
          <button type="button" onClick={onClose} className="text-sm text-gray-500 hover:text-gray-800 shrink-0">Close</button>
        </div>

        {/* Body */}
        <div data-modal-scroll className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="py-10 text-center">
              <div className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin mb-2" />
              <div className="text-sm text-gray-600">Loading history…</div>
            </div>
          )}

          {error && !loading && (
            <div className="py-6 text-center text-sm text-red-600">Couldn’t load the audit trail: {error}</div>
          )}

          {!loading && !error && events.length === 0 && (
            <div className="py-8 text-center text-sm text-gray-500">No recorded history yet.</div>
          )}

          {!loading && !error && events.length > 0 && (
            <ol className="relative pl-6">
              {/* vertical rail */}
              <span aria-hidden className="absolute left-[7px] top-1 bottom-1 w-px bg-gray-200" />
              {events.map((e, i) => {
                const cfg = ACTION[e.action] || { label: e.action, dot: 'bg-gray-400', glyph: '•' };
                const who = actor(e);
                return (
                  <li key={i} className="relative pb-4 last:pb-0">
                    <span className={`absolute -left-6 top-0.5 w-3.5 h-3.5 rounded-full ring-2 ring-white flex items-center justify-center text-[8px] text-white ${cfg.dot}`} aria-hidden>{cfg.glyph}</span>
                    <div className="text-sm font-semibold text-ink leading-snug">{cfg.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{fmtWhen(e.ts)}</div>
                    {who && <div className="text-xs text-gray-600 mt-0.5">by {who}</div>}
                    {e.detail && e.detail !== cfg.label && <div className="text-xs text-gray-500 mt-0.5">{e.detail}</div>}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
