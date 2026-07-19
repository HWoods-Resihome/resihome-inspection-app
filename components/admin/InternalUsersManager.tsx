/**
 * Internal User Management (admin · /admin/flows). Replaces the old Admins list.
 *
 * Lists every internal user who has signed in at least once (name · email · last
 * login) as a collapsible card with five access toggles — ResiWalk Active,
 * Inspections, Services, Insights, Admin. Search, a single row of filters + sort,
 * and a bulk bar to apply one toggle across all currently-shown users. Edits stage
 * locally and save in one batch. Backed by /api/admin/users.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

type CapKey = 'active' | 'inspections' | 'services' | 'insights' | 'admin';
const CAPS: { key: CapKey; label: string }[] = [
  { key: 'active', label: 'ResiWalk Active' },
  { key: 'inspections', label: 'Inspections' },
  { key: 'services', label: 'Services' },
  { key: 'insights', label: 'Insights' },
  { key: 'admin', label: 'Admin' },
];
const SECTION_CAPS: CapKey[] = ['inspections', 'services', 'insights'];

interface UserRow {
  email: string; name: string; lastLogin: string | null; loginCount: number; seed: boolean;
  access: Record<CapKey, boolean>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>;
}
function Toggle({ on, disabled, onClick, label }: { on: boolean; disabled?: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${on ? 'bg-brand' : 'bg-gray-300'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

const fmtLogin = (iso: string | null): string => {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}-${d.getDate()}-${String(d.getFullYear()).slice(-2)}`;
};

type Tri = 'any' | 'yes' | 'no';

export function InternalUsersManager() {
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Staged edits: email → { cap: bool }. Effective value = edit ?? row.access[cap].
  const [edits, setEdits] = useState<Record<string, Partial<Record<CapKey, boolean>>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Search / filter / sort.
  const [q, setQ] = useState('');
  const [fActive, setFActive] = useState<Tri>('any');
  const [fAdmin, setFAdmin] = useState<Tri>('any');
  const [fSections, setFSections] = useState<CapKey[]>([]);   // show users who HAVE all selected sections
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [sortKey, setSortKey] = useState<'name' | 'lastLogin'>('lastLogin');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/admin/users', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); return; }
      setUsers(Array.isArray(d.users) ? d.users : []);
      setEdits({});
    } catch (e: any) { setError(String(e?.message || e)); }
  }, []);
  useEffect(() => { if (open && users === null) void load(); }, [open, users, load]);

  const eff = (row: UserRow, cap: CapKey): boolean => {
    const e = edits[row.email];
    return e && typeof e[cap] === 'boolean' ? (e[cap] as boolean) : row.access[cap];
  };
  const setCap = (row: UserRow, cap: CapKey, val: boolean) => {
    if (row.seed && (cap === 'active' || cap === 'admin')) return; // seed admins locked on
    setSaved(false);
    setEdits((prev) => {
      const next = { ...prev };
      const cur = { ...(next[row.email] || {}) };
      if (val === row.access[cap]) delete cur[cap]; else cur[cap] = val;   // no-op edits drop out
      if (Object.keys(cur).length) next[row.email] = cur; else delete next[row.email];
      return next;
    });
  };

  const dirtyCount = Object.keys(edits).length;

  const visible = useMemo(() => {
    let list = (users || []).slice();
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(needle));
    if (fActive !== 'any') list = list.filter((u) => eff(u, 'active') === (fActive === 'yes'));
    if (fAdmin !== 'any') list = list.filter((u) => eff(u, 'admin') === (fAdmin === 'yes'));
    if (fSections.length) list = list.filter((u) => fSections.every((c) => eff(u, c)));
    list.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'name') return (a.name || a.email).localeCompare(b.name || b.email) * dir;
      return (a.lastLogin || '').localeCompare(b.lastLogin || '') * dir;
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, edits, q, fActive, fAdmin, fSections, sortKey, sortDir]);

  const save = async () => {
    if (!dirtyCount) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const updates: Record<string, any> = {};
      for (const [email, caps] of Object.entries(edits)) {
        const row = (users || []).find((u) => u.email === email);
        updates[email] = { ...caps, ...(row?.name ? { name: row.name } : {}) };
      }
      const r = await fetch('/api/admin/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Save failed'); return; }
      await load();
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const selCls = 'text-[12px] font-heading font-semibold border border-gray-300 rounded-lg px-2 py-1.5 bg-white text-gray-700 focus:outline-none focus:border-brand';

  return (
    <section className="mt-5 border border-gray-200 rounded-xl bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 p-4 text-left">
        <div>
          <h2 className="font-heading font-bold text-base text-ink">User Management</h2>
          <p className="text-[12px] text-gray-500 mt-0.5">Internal users who’ve signed in — control each person’s access to ResiWalk, Inspections, Services, Insights, and Admin.</p>
        </div>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="px-4 pb-4">
          {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-3">{error}</div>}
          {users === null ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : (
            <>
              {/* Search + filter toggle — one line, mirroring Vendor Management
                  (search bar + funnel button; filters/sort drop to the next line). */}
              <div className="flex items-center gap-2 mb-2">
                <div className="relative flex-1 min-w-0">
                  <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…"
                    className="w-full text-sm border border-gray-300 rounded-lg pl-3 pr-9 py-2.5 bg-white focus:outline-none focus:border-brand" />
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                </div>
                <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-label="Filters"
                  className={`shrink-0 inline-flex items-center justify-center gap-1 w-14 h-11 rounded-lg border bg-white transition-colors ${(fActive !== 'any' || fAdmin !== 'any' || fSections.length) ? 'border-brand text-brand' : 'border-gray-300 text-gray-600 hover:text-brand hover:border-brand/50'}`}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${filtersOpen ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
                </button>
              </div>

              {/* Filter + sort chips row (collapsible, like Vendor Management). */}
              {filtersOpen && (
                <div className="grid grid-cols-4 gap-1.5 mb-3">
                  <select aria-label="Filter by active" value={fActive} onChange={(e) => setFActive(e.target.value as Tri)}
                    className={`w-full truncate ${selCls} ${fActive !== 'any' ? 'border-brand text-brand' : ''}`}>
                    <option value="any">Active</option><option value="yes">Active: Yes</option><option value="no">Active: No</option>
                  </select>
                  <select aria-label="Filter by admin" value={fAdmin} onChange={(e) => setFAdmin(e.target.value as Tri)}
                    className={`w-full truncate ${selCls} ${fAdmin !== 'any' ? 'border-brand text-brand' : ''}`}>
                    <option value="any">Admin</option><option value="yes">Admin: Yes</option><option value="no">Admin: No</option>
                  </select>
                  <div className="relative">
                    <button type="button" onClick={() => setSectionsOpen((o) => !o)}
                      className={`w-full truncate ${selCls} inline-flex items-center justify-between gap-1 ${fSections.length ? 'border-brand text-brand' : ''}`}>
                      <span className="truncate">Sections{fSections.length ? ` (${fSections.length})` : ''}</span>
                      <Chevron open={sectionsOpen} />
                    </button>
                    {sectionsOpen && (<>
                      <div className="fixed inset-0 z-30" onClick={() => setSectionsOpen(false)} />
                      <div className="absolute left-0 mt-1 z-40 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                        {SECTION_CAPS.map((c) => {
                          const on = fSections.includes(c);
                          return (
                            <button key={c} type="button"
                              onClick={() => setFSections((s) => on ? s.filter((x) => x !== c) : [...s, c])}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left hover:bg-gray-50">
                              <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] font-bold ${on ? 'bg-brand border-brand text-white' : 'border-gray-300'}`}>{on ? '✓' : ''}</span>
                              <span className="capitalize">Has {c}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>)}
                  </div>
                  <div className="relative">
                    <button type="button" onClick={() => setSortOpen((o) => !o)} aria-expanded={sortOpen}
                      className={`w-full truncate ${selCls} inline-flex items-center justify-between gap-1`}>
                      <span className="truncate">Sort: {sortKey === 'name' ? 'Name' : 'Login'} {sortDir === 'asc' ? '↑' : '↓'}</span>
                      <Chevron open={sortOpen} />
                    </button>
                    {sortOpen && (<>
                      <div className="fixed inset-0 z-30" onClick={() => setSortOpen(false)} />
                      <div className="absolute right-0 mt-1 z-40 w-40 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                        {([['name', 'Name'], ['lastLogin', 'Last Login']] as const).map(([k, label]) => (
                          <button key={k} type="button"
                            onClick={() => { if (sortKey === k) setSortDir((d) => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc'); } }}
                            className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-gray-50 ${sortKey === k ? 'text-brand font-heading font-semibold' : 'text-gray-700'}`}>
                            {label} {sortKey === k ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                          </button>
                        ))}
                      </div>
                    </>)}
                  </div>
                </div>
              )}

              {/* User cards */}
              <div className="flex flex-col gap-2">
                {visible.length === 0 && <div className="text-sm text-gray-400 py-4 text-center">No users match these filters.</div>}
                {visible.map((u) => {
                  const isOpen = expanded.has(u.email);
                  const dirty = !!edits[u.email];
                  return (
                    <div key={u.email} className={`border rounded-xl overflow-hidden ${dirty ? 'border-brand/50' : 'border-gray-200'}`}>
                      <button type="button" onClick={() => setExpanded((s) => { const n = new Set(s); n.has(u.email) ? n.delete(u.email) : n.add(u.email); return n; })}
                        className="w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-gray-50">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-heading font-bold text-[14px] text-ink truncate">{u.name || u.email}</span>
                            {u.seed && <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-white bg-gray-500 rounded px-1.5 py-0.5">Built-in</span>}
                            {dirty && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-brand" />}
                          </div>
                          <div className="text-[12px] text-gray-500 truncate">{u.email} · last active {fmtLogin(u.lastLogin)}</div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {CAPS.map((c) => (
                            <span key={c.key} title={c.label}
                              className={`w-6 h-6 grid place-items-center rounded text-[9px] font-heading font-bold ${eff(u, c.key) ? 'bg-brand/10 text-brand' : 'bg-gray-100 text-gray-300'}`}>
                              {c.key === 'active' ? 'A' : c.key === 'inspections' ? 'IN' : c.key === 'services' ? 'SV' : c.key === 'insights' ? 'IQ' : 'AD'}
                            </span>
                          ))}
                          <Chevron open={isOpen} />
                        </div>
                      </button>
                      {isOpen && (
                        <div className="px-3.5 pb-3 pt-1 border-t border-gray-100 divide-y divide-gray-100">
                          {CAPS.map((c) => {
                            const locked = u.seed && (c.key === 'active' || c.key === 'admin');
                            return (
                              <div key={c.key} className="flex items-center justify-between py-2.5">
                                <div>
                                  <div className="text-[13px] font-heading font-semibold text-ink">{c.label}</div>
                                  {locked && <div className="text-[11px] text-gray-400">Built-in admin — always on</div>}
                                </div>
                                <label className="flex items-center gap-2 text-[12px] text-gray-500 cursor-pointer">
                                  <span>{eff(u, c.key) ? 'Yes' : 'No'}</span>
                                  <Toggle on={eff(u, c.key)} disabled={locked} label={`${u.email} ${c.label}`} onClick={() => setCap(u, c.key, !eff(u, c.key))} />
                                </label>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Save bar */}
              <div className="flex items-center gap-3 mt-4">
                <button type="button" onClick={() => void save()} disabled={busy || !dirtyCount}
                  className="h-10 px-5 rounded-xl bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
                  {busy ? 'Saving…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}` : 'Save'}
                </button>
                {dirtyCount > 0 && !busy && <button type="button" onClick={() => { setEdits({}); setSaved(false); }} className="text-[13px] font-heading font-semibold text-gray-500 hover:text-gray-800">Discard</button>}
                {saved && <span className="text-emerald-600 text-sm font-heading font-semibold">Saved ✓</span>}
                <span className="ml-auto text-[12px] text-gray-400">{(users || []).length} internal user{(users || []).length === 1 ? '' : 's'}</span>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
