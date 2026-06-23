/**
 * /insights — ResiWalk Insights analytics portal (desktop).
 *
 * Gated by the existing session middleware (this route is NOT in PUBLIC_PATHS)
 * PLUS a role check: the body renders only when canView is true (canView = app
 * admin OR Insights-Only user, per /api/insights/access). Admins additionally
 * get an in-portal menu to manage Insights-Only users (same backend as the
 * /admin/admins console section).
 *
 * The page itself is DARK (#0e0e11, full width) to match the dashboard; the
 * brand header stays pink. The dashboard grid lives in components/insights.
 */
import { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { InsightsDashboard } from '@/components/insights/Dashboard';
import { InsightsUsersManager } from '@/components/insights/InsightsUsersManager';

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
      <div className="min-h-screen bg-[#0e0e11]">
        {/* Brand header — matches the app (app-icon mark on brand pink). */}
        <header className="bg-brand text-white">
          <div className="max-w-[1600px] mx-auto px-5 py-4 flex items-center justify-between gap-3">
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
            <div className="flex items-center gap-4 shrink-0">
              <Link href="/" className="text-xs font-heading font-semibold text-white/90 hover:text-white inline-flex items-center gap-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M11 18l-6-6 6-6" /></svg>
                Inspections
              </Link>
              {access?.user && <AccountMenu name={access.user.name} email={access.user.email} />}
            </div>
          </div>
        </header>

        <main className="max-w-[1600px] mx-auto px-5 py-6">
          {loading ? (
            <div className="text-center py-24">
              <div className="inline-block w-10 h-10 border-4 border-[#ff0060] border-t-transparent rounded-full animate-spin" />
            </div>
          ) : !access?.canView ? (
            <div className="max-w-md mx-auto bg-[#18181c] rounded-2xl border border-white/10 p-8 text-center mt-12">
              <h2 className="font-heading font-bold text-lg text-[#f4f4f5] mb-2">Insights access required</h2>
              <p className="text-sm text-[#a1a1aa] mb-5">
                Your account isn&apos;t enabled for ResiWalk Insights yet. Ask an administrator to add you as an Insights user.
              </p>
              <Link href="/" className="text-[#ff0060] underline text-sm font-heading font-semibold">Back to inspections</Link>
            </div>
          ) : (
            <>
              {access.isAdmin && <AdminMenu />}
              <InsightsDashboard />
            </>
          )}
        </main>
      </div>
    </>
  );
}

/** Account menu on the user's name — sign out clears the session and returns to /login. */
function AccountMenu({ name, email }: { name: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* clear anyway */ }
    window.location.href = '/login';
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center gap-1.5 text-xs font-heading font-semibold text-white/90 hover:text-white"
      >
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-white/20 text-white text-[11px] font-bold uppercase">
          {(name || email || '?').trim().charAt(0)}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {open && (
        <>
          {/* click-away */}
          <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 top-full mt-2 z-50 w-56 bg-[#18181c] rounded-xl border border-white/10 shadow-lg overflow-hidden text-left">
            <div className="px-4 py-3 border-b border-white/10">
              <div className="text-sm font-heading font-semibold text-[#f4f4f5] truncate">{name}</div>
              <div className="text-[11px] text-[#71717a] truncate">{email}</div>
            </div>
            <button
              type="button" role="menuitem" onClick={signOut} disabled={busy}
              className="w-full text-left px-4 py-2.5 text-sm font-heading font-semibold text-[#a1a1aa] hover:bg-white/5 hover:text-[#f4f4f5] disabled:opacity-60 flex items-center gap-2"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Collapsible admin-only menu: manage Insights-Only users from inside the portal.
 *  (Approver NTE moved to Admin → Approval Routing under the home page.) */
function AdminMenu() {
  const [panel, setPanel] = useState<'users' | null>(null);
  const toggle = (p: 'users') => setPanel((cur) => (cur === p ? null : p));
  const gear = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
  );
  const chev = (open: boolean) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>
  );
  const btn = 'inline-flex items-center gap-2 text-sm font-heading font-semibold text-[#a1a1aa] hover:text-[#f4f4f5] bg-[#18181c] border border-white/10 rounded-lg px-3.5 py-2';
  return (
    <section className="mb-5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => toggle('users')} aria-expanded={panel === 'users'} className={btn}>
          {gear} Admin · Insights users {chev(panel === 'users')}
        </button>
      </div>
      {panel === 'users' && <div className="mt-3"><InsightsUsersManager dark /></div>}
    </section>
  );
}
