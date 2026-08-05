// Admin-only gear on the inspection record → "Change Property". Reassigns the
// inspection to a different property (e.g. it was created against the wrong
// address): pick a property from the live search, confirm, and the server
// re-points the association + refreshes the address/region/status snapshots. If
// the inspection is already completed, it also regenerates the PDF and re-sends
// the completion email. Property-backed inspections only (hidden on Community).
import { useEffect, useRef, useState } from 'react';
import type { Property } from '@/lib/types';
import { syncAllProperties, searchCachedProperties } from '@/lib/propertyCache';

type Step = 'menu' | 'search' | 'confirm' | 'working' | 'done' | 'error';

export function ChangePropertyControl({
  inspectionId, currentAddress, isCompleted, onDone,
}: {
  inspectionId: string;
  currentAddress: string;
  isCompleted: boolean;
  /** Called after a successful reassign so the page can reload the record. */
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('menu');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Property[]>([]);
  const [selected, setSelected] = useState<Property | null>(null);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{ address: string; emailed: boolean } | null>(null);
  const searchSeq = useRef(0);

  // Instant refresh: once the reassign succeeds, reload the record so it shows
  // the new property + all property-derived details (address, region, status,
  // sq ft, bed/bath, regenerated PDF). The record GET reads directly by id
  // (strongly consistent), so the reloaded data reflects the change immediately.
  useEffect(() => {
    if (step !== 'done') return;
    const t = setTimeout(() => onDone(), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Warm the device property cache once the search opens, then run the query.
  useEffect(() => {
    if (step !== 'search') return;
    let cancelled = false;
    (async () => {
      try { await syncAllProperties(); } catch { /* offline / partial — search what's cached */ }
      if (!cancelled) runSearch(query);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function runSearch(q: string) {
    const seq = ++searchSeq.current;
    searchCachedProperties(q, 50).then((rows) => {
      if (seq === searchSeq.current) setResults(rows);
    }).catch(() => { if (seq === searchSeq.current) setResults([]); });
  }

  function reset() {
    setStep('menu'); setQuery(''); setResults([]); setSelected(null); setMessage(''); setResult(null);
  }
  function close() { setOpen(false); reset(); }

  const addressOf = (p: Property) =>
    [p.address || p.name, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  async function submit() {
    if (!selected) return;
    setStep('working'); setMessage('');
    try {
      const r = await fetch('/api/admin/change-inspection-property', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: inspectionId, propertyRecordId: selected.recordId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
      setResult({ address: data?.to?.address || addressOf(selected), emailed: !!data?.emailedTo });
      setStep('done');
    } catch (e: any) {
      setMessage(String(e?.message || e)); setStep('error');
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setStep('menu'); }}
        aria-expanded={open}
        aria-label="Admin actions"
        title="Admin actions"
        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>

      {open && step === 'menu' && (
        <>
          <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={close} />
          <div className="absolute right-0 mt-1.5 z-50 w-52 rounded-xl border border-gray-200 bg-white shadow-lg ring-1 ring-black/5 overflow-hidden py-1">
            <button type="button" onClick={() => setStep('search')} className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400 shrink-0"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>
              Change Property
            </button>
          </div>
        </>
      )}

      {open && step !== 'menu' && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16 sm:pt-24" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl ring-1 ring-black/5 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-heading font-bold text-gray-900">Change Property</h2>
              <button type="button" onClick={close} className="text-gray-400 hover:text-gray-700" aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>

            <div className="p-5">
              <div className="text-xs text-gray-500 mb-3">
                Currently: <span className="font-medium text-gray-800">{currentAddress || '(no address)'}</span>
              </div>

              {step === 'search' && (
                <>
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); runSearch(e.target.value); }}
                    placeholder="Search properties by address…"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
                  />
                  <div className="mt-2 max-h-72 overflow-y-auto divide-y divide-gray-100 rounded-lg border border-gray-100">
                    {results.length === 0 ? (
                      <div className="px-3 py-6 text-center text-xs text-gray-400">{query ? 'No matching properties.' : 'Start typing to search.'}</div>
                    ) : results.map((p) => (
                      <button
                        key={p.recordId}
                        type="button"
                        onClick={() => { setSelected(p); setStep('confirm'); }}
                        className="w-full text-left px-3 py-2.5 text-sm hover:bg-gray-50 transition-colors"
                      >
                        <div className="font-medium text-gray-900">{p.address || p.name}</div>
                        <div className="text-xs text-gray-500">{[p.city, [p.state, p.zip].filter(Boolean).join(' '), p.region].filter(Boolean).join(' · ')}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}

              {step === 'confirm' && selected && (
                <>
                  <p className="text-sm text-gray-700">Reassign this inspection to:</p>
                  <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5">
                    <div className="font-medium text-gray-900">{selected.address || selected.name}</div>
                    <div className="text-xs text-gray-500">{[selected.city, [selected.state, selected.zip].filter(Boolean).join(' '), selected.region].filter(Boolean).join(' · ')}</div>
                  </div>
                  {isCompleted && (
                    <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5 text-xs text-amber-900">
                      This inspection is completed — reassigning will <strong>regenerate the PDF</strong> and <strong>re-send the completion email</strong> with the new address.
                    </div>
                  )}
                  <div className="mt-4 flex gap-2 justify-end">
                    <button type="button" onClick={() => setStep('search')} className="px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100">Back</button>
                    <button type="button" onClick={submit} className="px-4 py-2 rounded-lg text-sm font-heading font-semibold bg-brand text-white hover:bg-brand-dark">Reassign</button>
                  </div>
                </>
              )}

              {step === 'working' && (
                <div className="py-8 text-center text-sm text-brand font-heading font-semibold">
                  Reassigning{isCompleted ? ' + regenerating PDF & email' : ''}…
                </div>
              )}

              {step === 'done' && result && (
                <div className="py-4">
                  <div className="rounded-lg bg-green-50 border border-green-200 px-3 py-3 text-sm text-green-800">
                    <div className="font-heading font-bold mb-1">Property changed</div>
                    <div>Reassigned to <span className="font-medium">{result.address}</span>.</div>
                    {result.emailed && <div className="mt-1 text-xs">Completion email re-sent and PDF regenerated.</div>}
                    <div className="mt-1 text-xs text-green-700/80">Refreshing the record…</div>
                  </div>
                  <div className="mt-4 flex justify-end">
                    <button type="button" onClick={() => { close(); onDone(); }} className="px-4 py-2 rounded-lg text-sm font-heading font-semibold bg-brand text-white hover:bg-brand-dark">View updated record</button>
                  </div>
                </div>
              )}

              {step === 'error' && (
                <div className="py-4">
                  <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-3 text-sm text-red-800">
                    <div className="font-heading font-bold mb-1">Couldn’t change property</div>
                    <div className="text-xs">{message}</div>
                  </div>
                  <div className="mt-4 flex justify-end gap-2">
                    <button type="button" onClick={() => setStep('search')} className="px-3 py-2 rounded-lg text-sm text-gray-600 hover:bg-gray-100">Try again</button>
                    <button type="button" onClick={close} className="px-4 py-2 rounded-lg text-sm font-heading font-semibold bg-gray-200 text-gray-800 hover:bg-gray-300">Close</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
