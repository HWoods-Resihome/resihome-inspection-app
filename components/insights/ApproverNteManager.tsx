/**
 * Set Approver NTE — lists every approver name pulled from the Approved-By data
 * (snapshot) and lets an admin set a not-to-exceed $ ceiling next to each, then
 * Save. On save it POSTs the map and broadcasts 'resiwalk:nte-updated' so the
 * scope-approvals card refreshes its over-NTE flags immediately. Dark theme to
 * match the in-portal admin menu. Backend: /api/insights/approver-nte.
 */
import { useCallback, useEffect, useState } from 'react';

export const NTE_UPDATED_EVENT = 'resiwalk:nte-updated';

export function ApproverNteManager() {
  const [approvers, setApprovers] = useState<string[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/insights/approver-nte', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); return; }
      setApprovers(d.approvers || []);
      const v: Record<string, string> = {};
      for (const [k, amt] of Object.entries(d.thresholds || {})) v[k] = String(amt);
      // Include any approvers without a threshold as blank rows.
      for (const name of d.approvers || []) if (!(name in v)) v[name] = '';
      setValues(v);
    } catch (e: any) { setError(String(e?.message || e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const thresholds: Record<string, number> = {};
      for (const [k, raw] of Object.entries(values)) {
        const n = Number(raw);
        if (raw !== '' && Number.isFinite(n) && n > 0) thresholds[k] = n;
      }
      const r = await fetch('/api/insights/approver-nte', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thresholds }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Save failed'); return; }
      setSaved(true);
      // Tell dependent cards (scope approvals) to re-pull and re-flag.
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(NTE_UPDATED_EVENT));
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="bg-[#18181c] rounded-2xl border border-white/10 p-5 max-w-2xl">
      <h3 className="font-heading font-bold text-sm text-[#f4f4f5] mb-1">Set Approver NTE</h3>
      <p className="text-xs text-[#a1a1aa] mb-4">
        Per-approver not-to-exceed ceiling. Approvers below are pulled from the Approved-By data; set a dollar amount and Save — the scope-approvals card flags any approval over the limit.
      </p>

      {error && <div className="text-sm text-[#ff0060] font-heading font-semibold mb-3">{error}</div>}

      {approvers === null ? (
        <div className="text-sm text-[#71717a]">Loading…</div>
      ) : approvers.length === 0 ? (
        <div className="text-sm text-[#71717a]">No approvers found yet — they appear once scopes have been approved.</div>
      ) : (
        <>
          <ul className="divide-y divide-white/10 border border-white/10 rounded-lg mb-4">
            {approvers.map((name) => (
              <li key={name} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-sm text-[#f4f4f5] truncate">{name}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[#71717a] text-sm">$</span>
                  <input
                    type="number" min="0" step="100" inputMode="numeric"
                    value={values[name] ?? ''}
                    onChange={(e) => { setValues((v) => ({ ...v, [name]: e.target.value })); setSaved(false); }}
                    placeholder="—"
                    className="w-28 border border-white/10 bg-[#232329] text-[#f4f4f5] placeholder-[#71717a] rounded-lg px-2 py-1.5 text-sm text-right focus:outline-none focus:border-[#ff0060] [color-scheme:dark]"
                  />
                </div>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <button
              type="button" onClick={() => void save()} disabled={busy}
              className="bg-[#ff0060] hover:bg-[#cc004d] disabled:opacity-50 text-white font-heading font-semibold rounded-lg px-4 py-2 text-sm"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="text-[#73E3DF] text-sm font-heading font-semibold">Saved ✓</span>}
          </div>
        </>
      )}
    </div>
  );
}
