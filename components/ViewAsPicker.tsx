// Admin "view as / login as" picker. Lists inspectors seen across inspections;
// selecting one starts impersonation (server sets the cookie) and reloads so the
// whole app renders with that user's permission set. Stop via the top banner.
//
// It also folds in the Services "View as Vendor" preview (the old separate gear
// item): the pinned option at the top enters the external vendor experience
// (a cookie-persisted preview, whole-app) rather than impersonating a person.

import { useEffect, useMemo, useState } from 'react';
import { setViewAsVendor } from '@/lib/services/viewAs';

type U = { email: string; name: string };

export function ViewAsPicker({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<U[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/impersonate-users')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => setUsers(Array.isArray(d.users) ? d.users : []))
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return users;
    return users.filter((u) => u.name.toLowerCase().includes(s) || u.email.toLowerCase().includes(s));
  }, [users, q]);

  const pick = async (u: U) => {
    setBusy(u.email);
    try {
      await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: u.email, name: u.name }),
      });
    } catch { /* best effort */ }
    window.location.href = '/'; // reload as the impersonated user
  };

  // Enter the external vendor preview (Services). Cookie-persisted whole-app;
  // exit from the top banner. Land on /services so the effect is immediate.
  const viewAsVendor = () => {
    setBusy('__vendor__');
    setViewAsVendor(true);
    window.location.href = '/services';
  };

  return (
    <div className="fixed inset-0 z-[2500] bg-black/50 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-heading font-bold text-ink">View as User / Vendor</h2>
            <p className="text-xs text-gray-500">Preview as an external vendor, or see the app with an inspector’s permissions. Stop from the banner.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 text-2xl leading-none px-1">×</button>
        </div>
        {/* Pinned: enter the external vendor preview (Services). */}
        <button
          onClick={viewAsVendor}
          disabled={!!busy}
          className="w-full text-left px-4 py-3 flex items-center gap-3 border-b border-gray-200 hover:bg-gray-50 disabled:opacity-50 shrink-0"
        >
          <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-brand/10 text-brand shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l1-5h16l1 5" /><path d="M4 9v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9" /><path d="M9 21v-6h6v6" /></svg>
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-heading font-semibold text-ink">View as Vendor</span>
            <span className="block text-xs text-gray-500 truncate">{busy === '__vendor__' ? 'Switching…' : 'External vendor experience (Services)'}</span>
          </span>
        </button>
        <div className="p-3 border-b border-gray-200 shrink-0">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search inspectors…"
            className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2 text-base"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          {loading ? (
            <div className="p-4 text-sm text-gray-500">Loading inspectors…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No inspectors found.</div>
          ) : (
            filtered.map((u) => (
              <button
                key={u.email}
                onClick={() => pick(u)}
                disabled={!!busy}
                className="w-full text-left px-4 py-2.5 hover:bg-gray-50 border-b border-gray-100 disabled:opacity-50"
              >
                <div className="text-sm font-heading font-semibold text-ink truncate">{u.name}</div>
                <div className="text-xs text-gray-500 truncate">{u.email}{busy === u.email ? ' · switching…' : ''}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
