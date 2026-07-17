// Admin "view as / login as" picker — opens as a centered modal. It lists the
// full set of USERS (agents/inspectors seen across inspections; selecting one
// impersonates them app-wide) AND the service VENDORS (selecting one enters the
// external vendor experience). A generic "View as Vendor" preview is pinned at
// the top. Stop impersonation / preview from the banner.

import { useEffect, useMemo, useState } from 'react';
import { setViewAsVendor } from '@/lib/services/viewAs';

type Row = { kind: 'user' | 'vendor'; name: string; email: string };

export function ViewAsPicker({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<Row[]>([]);
  const [vendors, setVendors] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  // When the search input is focused the on-screen keyboard covers the lower
  // half, so pin the modal to the TOP for max list room; re-center on blur.
  const [kbOpen, setKbOpen] = useState(false);

  useEffect(() => {
    const usersP = fetch('/api/admin/impersonate-users')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => setUsers(Array.isArray(d.users) ? d.users.map((u: any) => ({ kind: 'user' as const, name: u.name || u.email, email: u.email })) : []))
      .catch(() => { /* ignore */ });
    // Real vendor options = approved Companies (same source as every picker).
    const vendorsP = fetch('/api/services/vendors')
      .then((r) => (r.ok ? r.json() : { vendors: [] }))
      .then((d) => setVendors(Array.isArray(d.vendors) ? d.vendors.map((v: any) => ({ kind: 'vendor' as const, name: v.name, email: v.email || '' })) : []))
      .catch(() => { /* ignore */ });
    Promise.allSettled([usersP, vendorsP]).finally(() => setLoading(false));
  }, []);

  // The full searchable list: impersonatable users + the service vendors.
  const rows = useMemo<Row[]>(() => [...users, ...vendors], [users, vendors]);

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

  return (
    <div className={`fixed inset-0 z-[2500] bg-black/50 flex justify-center p-4 ${kbOpen ? 'items-start' : 'items-center'}`} onClick={onClose}>
      <div
        className="bg-white w-full max-w-md rounded-2xl max-h-[85vh] flex flex-col overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-heading font-bold text-ink">View as User / Vendor</h2>
            <p className="text-xs text-gray-500">Search all users and vendors. Stop from the banner.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 text-2xl leading-none px-1">×</button>
        </div>

        <div className="p-3 border-b border-gray-200 shrink-0">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setKbOpen(true)}
            // Defer the re-center so a tap on a result row registers its click
            // BEFORE the layout shifts (otherwise the row moves out from under
            // the finger and the tap is lost).
            onBlur={() => window.setTimeout(() => setKbOpen(false), 250)}
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
