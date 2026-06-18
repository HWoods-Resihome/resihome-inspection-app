/**
 * /insights — ResiWalk Insights analytics portal (desktop).
 *
 * Phase 1: shell + auth + RBAC. Gated by the existing session middleware (this
 * route is NOT in PUBLIC_PATHS) PLUS a role check: the body renders only when
 * canView is true (canView = app admin OR Insights-Only user, per
 * /api/insights/access). Admins additionally get an in-portal menu to manage
 * Insights-Only users (same backend as the /admin/admins console section).
 *
 * Dashboards (KPI/chart grid, filters, analytical views) arrive in Phases 2–3.
 * Branding intentionally matches the live app: brand pink #ff0060, app-icon mark,
 * Raleway headings.
 */
import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';

interface Access {
  authenticated: boolean;
  canView: boolean;
  isAdmin: boolean;
  isInsightsUser: boolean;
  user?: { email: string; name: string };
}

export default function InsightsPortal() {
  const [access, setAccess] = useState<Access | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/insights/access', { cache: 'no-store' })
      .then((r) => (r.status === 401 ? null : r.json()))
      .then((d) => {
        if (cancelled) return;
        if (!d) { window.location.href = '/login'; return; } // not signed in
        setAccess(d);
        setLoading(false);
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <Head><title>ResiWalk Insights</title></Head>
      <div className="min-h-screen bg-gray-50">
        {/* Brand header — matches the app (app-icon mark on brand pink). */}
        <header className="bg-brand text-white">
          <div className="max-w-6xl mx-auto px-5 py-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/app-icon.svg" alt="ResiWalk" className="h-10 w-10 object-cover shrink-0"
                   onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
              <div className="min-w-0">
                <h1 className="font-heading font-extrabold text-xl tracking-tight leading-none">
                  ResiWalk <span className="text-white/85">Insights</span>
                </h1>
                {access?.user && (
                  <div className="text-xs text-white/80 truncate mt-0.5">{access.user.name}</div>
                )}
              </div>
            </div>
            <Link href="/" className="text-xs font-heading font-semibold text-white/90 hover:text-white shrink-0 inline-flex items-center gap-1">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M11 18l-6-6 6-6" /></svg>
              Inspections
            </Link>
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-5 py-8">
          {loading ? (
            <div className="text-center py-24">
              <div className="inline-block w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
            </div>
          ) : !access?.canView ? (
            <div className="max-w-md mx-auto bg-white rounded-2xl border border-gray-200 shadow-sm p-8 text-center mt-12">
              <h2 className="font-heading font-bold text-lg text-ink mb-2">Insights access required</h2>
              <p className="text-sm text-gray-600 mb-5">
                Your account isn&apos;t enabled for ResiWalk Insights yet. Ask an administrator to add you as an Insights user.
              </p>
              <Link href="/" className="text-brand underline text-sm font-heading font-semibold">Back to inspections</Link>
            </div>
          ) : (
            <>
              {access.isAdmin && <AdminMenu />}

              {/* Phase 1 placeholder — the dashboard framework + analytical views
                  land in Phases 2–3. Kept honest: no mocked metrics. */}
              <section className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
                <h2 className="font-heading font-bold text-lg text-ink mb-1">Dashboards are on the way</h2>
                <p className="text-sm text-gray-600">
                  Phase 1 (portal, sign-in, and roles) is live. The KPI &amp; chart grid, global filters,
                  and analytical views (completion time, pass/fail, inspector performance, completed-inspections
                  export) arrive in the next phases. No metrics are shown until they read from real data.
                </p>
              </section>
            </>
          )}
        </main>
      </div>
    </>
  );
}

/** Collapsible admin-only menu: manage Insights-Only users from inside the portal. */
function AdminMenu() {
  const [open, setOpen] = useState(false);
  return (
    <section className="mb-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 text-sm font-heading font-semibold text-gray-700 hover:text-ink bg-white border border-gray-200 rounded-lg px-3.5 py-2 shadow-sm"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        Admin · Insights users
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && <div className="mt-3"><InsightsUsersManager /></div>}
    </section>
  );
}

interface InsightsUserEntry { email: string; addedByEmail?: string; addedAt?: number; }

function fmtDate(ms?: number): string {
  if (!ms) return '';
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
}

/** Add/remove Insights-Only users. Same backend as the /admin/admins console section. */
export function InsightsUsersManager() {
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

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 max-w-2xl">
      <h3 className="font-heading font-bold text-sm text-ink mb-1">Insights-Only users</h3>
      <p className="text-xs text-gray-500 mb-4">
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
          className="focus-brand flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
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
        <div className="text-sm text-gray-400">Loading…</div>
      ) : users.length === 0 ? (
        <div className="text-sm text-gray-400">No Insights-Only users yet.</div>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
          {users.map((u) => (
            <li key={u.email} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm text-ink truncate">{u.email}</div>
                {(u.addedByEmail || u.addedAt) && (
                  <div className="text-[11px] text-gray-400 truncate">
                    {u.addedByEmail ? `added by ${u.addedByEmail}` : ''}{u.addedAt ? ` · ${fmtDate(u.addedAt)}` : ''}
                  </div>
                )}
              </div>
              <button
                type="button" onClick={() => void remove(u.email)} disabled={busy}
                className="text-xs font-heading font-semibold text-gray-500 hover:text-brand shrink-0"
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
