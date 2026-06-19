/**
 * components/insights/InsightsUsersManager.tsx — add/remove Insights-Only users.
 *
 * Moved OUT of pages/insights so the /admin/admins console can import it WITHOUT
 * pulling in the dashboard (and its recharts bundle). Same backend as before
 * (/api/insights/users). Renders light by default; pass `dark` for the dark
 * Insights portal (admin menu).
 */
import { useCallback, useEffect, useState } from 'react';

interface InsightsUserEntry { email: string; addedByEmail?: string; addedAt?: number; }

function fmtDate(ms?: number): string {
  if (!ms) return '';
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
}

/** Add/remove Insights-Only users. Same backend as the /admin/admins console section. */
export function InsightsUsersManager({ dark = false }: { dark?: boolean }) {
  const [users, setUsers] = useState<InsightsUserEntry[] | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/insights/users', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); return; }
      setUsers(d.users || []);
    } catch (e: any) { setError(String(e?.message || e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (!email.trim()) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/insights/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Add failed'); return; }
      setUsers(d.users || []); setEmail('');
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  }

  async function remove(target: string) {
    if (!window.confirm(`Remove ${target} from Insights users?`)) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/insights/users/${encodeURIComponent(target)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Remove failed'); return; }
      setUsers(d.users || []);
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  }

  // Theme tokens — light (admins console) vs dark (Insights portal).
  const t = dark
    ? {
        wrap: 'bg-[#18181c] rounded-2xl border border-white/10 p-5 max-w-2xl',
        title: 'font-heading font-bold text-sm text-[#f4f4f5] mb-1',
        sub: 'text-xs text-[#a1a1aa] mb-4',
        input: 'flex-1 border border-white/10 bg-[#232329] text-[#f4f4f5] placeholder-[#71717a] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#ff0060]',
        list: 'divide-y divide-white/10 border border-white/10 rounded-lg',
        rowName: 'text-sm text-[#f4f4f5] truncate',
        rowMeta: 'text-[11px] text-[#71717a] truncate',
        remove: 'text-xs font-heading font-semibold text-[#a1a1aa] hover:text-[#ff0060] shrink-0',
        empty: 'text-sm text-[#71717a]',
      }
    : {
        wrap: 'bg-white rounded-2xl border border-gray-200 shadow-sm p-5 max-w-2xl',
        title: 'font-heading font-bold text-sm text-ink mb-1',
        sub: 'text-xs text-gray-500 mb-4',
        input: 'focus-brand flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm',
        list: 'divide-y divide-gray-100 border border-gray-100 rounded-lg',
        rowName: 'text-sm text-ink truncate',
        rowMeta: 'text-[11px] text-gray-400 truncate',
        remove: 'text-xs font-heading font-semibold text-gray-500 hover:text-brand shrink-0',
        empty: 'text-sm text-gray-400',
      };

  return (
    <div className={t.wrap}>
      <h3 className={t.title}>Insights-Only users</h3>
      <p className={t.sub}>
        View-only access to the dashboards (no admin tools). App admins already have access and don&apos;t need to be added here.
      </p>

      <div className="flex gap-2 mb-3">
        <input
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          placeholder="name@resihome.com"
          disabled={busy}
          className={t.input}
        />
        <button
          type="button" onClick={() => void add()} disabled={busy || !email.trim()}
          className="bg-brand hover:bg-brand-dark disabled:bg-gray-300 text-white font-heading font-semibold rounded-lg px-4 py-2 text-sm whitespace-nowrap"
        >
          Add user
        </button>
      </div>

      {error && <div className="text-sm text-brand font-heading font-semibold mb-3">{error}</div>}

      {users === null ? (
        <div className={t.empty}>Loading…</div>
      ) : users.length === 0 ? (
        <div className={t.empty}>No Insights-Only users yet.</div>
      ) : (
        <ul className={t.list}>
          {users.map((u) => (
            <li key={u.email} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className={t.rowName}>{u.email}</div>
                {(u.addedByEmail || u.addedAt) && (
                  <div className={t.rowMeta}>
                    {u.addedByEmail ? `added by ${u.addedByEmail}` : ''}{u.addedAt ? ` · ${fmtDate(u.addedAt)}` : ''}
                  </div>
                )}
              </div>
              <button
                type="button" onClick={() => void remove(u.email)} disabled={busy}
                className={t.remove}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
