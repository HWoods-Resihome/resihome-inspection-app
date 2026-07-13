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
import { PageHeader } from '@/components/PageHeader';
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
        {/* Standard centered header (logo + title + back), with the account menu
            in the right slot. */}
        <PageHeader title="Insights" onBack={() => { if (typeof window !== 'undefined' && window.history.length > 1) window.history.back(); else window.location.href = '/'; }} backHref="/" maxW="max-w-[1600px]" />

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
