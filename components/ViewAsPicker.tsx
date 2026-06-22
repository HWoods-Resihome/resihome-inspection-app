// Admin "view as / login as" picker. Lists inspectors seen across inspections;
// selecting one starts impersonation (server sets the cookie) and reloads so the
// whole app renders with that user's permission set. Stop via the top banner.

import { useEffect, useMemo, useState } from 'react';

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

  return (
    <div className="fixed inset-0 z-[2500] bg-black/50 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="font-heading font-bold text-ink">View as user</h2>
            <p className="text-xs text-gray-500">See the app with this inspector’s permissions. Stop from the banner.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 text-2xl leading-none px-1">×</button>
        </div>
        <div className="p-3 border-b border-gray-200">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search inspectors…"
            className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2 text-base"
            autoFocus
          />
        </div>
        <div className="overflow-y-auto">
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
