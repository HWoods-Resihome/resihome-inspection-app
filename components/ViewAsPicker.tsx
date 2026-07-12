// Admin "view as / login as" picker — opens as a centered modal. It lists the
// full set of USERS (agents/inspectors seen across inspections; selecting one
// impersonates them app-wide) AND the service VENDORS (selecting one enters the
// external vendor experience). A generic "View as Vendor" preview is pinned at
// the top. Stop impersonation / preview from the banner.

import { useEffect, useMemo, useState } from 'react';
import { setViewAsVendor } from '@/lib/services/viewAs';
import { SERVICE_VENDORS, vendorEmail } from '@/lib/services/vendors';

type Row = { kind: 'user' | 'vendor'; name: string; email: string };

export function ViewAsPicker({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/admin/impersonate-users')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => setUsers(Array.isArray(d.users) ? d.users.map((u: any) => ({ kind: 'user' as const, name: u.name || u.email, email: u.email })) : []))
      .catch(() => { /* ignore */ })
      .finally(() => setLoading(false));
  }, []);

  // The full searchable list: impersonatable users + the service vendors.
  const rows = useMemo<Row[]>(() => {
    const vendors: Row[] = SERVICE_VENDORS.map((v) => ({ kind: 'vendor' as const, name: v.name, email: vendorEmail(v.name) || '' }));
    return [...users, ...vendors];
  }, [users]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(s) || r.email.toLowerCase().includes(s));
  }, [rows, q]);

  // A user → impersonate app-wide. A vendor → enter the external vendor experience.
  const pick = async (r: Row) => {
    setBusy(`${r.kind}:${r.email || r.name}`);
    if (r.kind === 'vendor') {
      setViewAsVendor(true);
      window.location.href = '/services';
      return;
    }
    try {
      await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: r.email, name: r.name }),
      });
    } catch { /* best effort */ }
    window.location.href = '/'; // reload as the impersonated user
  };

  // Generic vendor preview (no specific vendor).
  const viewAsVendorGeneric = () => {
    setBusy('__vendor__');
    setViewAsVendor(true);
    window.location.href = '/services';
  };

  return (
    <div className="fixed inset-0 z-[2500] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white w-full max-w-md rounded-2xl max-h-[80vh] flex flex-col overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-heading font-bold text-ink">View as User / Vendor</h2>
            <p className="text-xs text-gray-500">Search all users and vendors. Stop from the banner.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 text-2xl leading-none px-1">×</button>
        </div>

        {/* Pinned: generic external vendor preview (no specific vendor). */}
        <button
          onClick={viewAsVendorGeneric}
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
            placeholder="Search users or vendors…"
            className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2 text-base bg-white text-ink placeholder-gray-400"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          {loading ? (
            <div className="p-4 text-sm text-gray-500">Loading users…</div>
          ) : filtered.length === 0 ? (
            <div className="p-4 text-sm text-gray-500">No users or vendors match “{q}”.</div>
          ) : (
            filtered.map((r) => {
              const id = `${r.kind}:${r.email || r.name}`;
              return (
                <button
                  key={id}
                  onClick={() => pick(r)}
                  disabled={!!busy}
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50 border-b border-gray-100 disabled:opacity-50 flex items-center gap-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-heading font-semibold text-ink truncate">{r.name}</span>
                    <span className="block text-xs text-gray-500 truncate">{r.email || 'Services vendor'}{busy === id ? ' · switching…' : ''}</span>
                  </span>
                  <span className={`shrink-0 text-[10px] font-heading font-bold uppercase tracking-wide rounded-full px-2 py-0.5 border ${r.kind === 'vendor' ? 'text-brand border-brand/30 bg-brand/5' : 'text-gray-600 border-gray-300 bg-gray-50'}`}>
                    {r.kind === 'vendor' ? 'Vendor' : 'User'}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
