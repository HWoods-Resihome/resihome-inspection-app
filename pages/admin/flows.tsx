/**
 * /admin/flows — consolidated admin operations hub (admin only).
 *
 * One page for the app's admin "flows": provisioning HubSpot fields (Setup),
 * regenerating PDFs, and quick links to the maintenance backfills. Add future
 * flows/URLs here as new sections so they all live in one place.
 *
 * Replaces the standalone /admin/setup and /admin/regenerate-pdfs pages (both now
 * redirect here).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { RegenPdfPicker } from '@/components/admin/RegenPdfPicker';
import { ApprovalRoutingManager } from '@/components/admin/ApprovalRoutingManager';
import { SlackNotificationsManager } from '@/components/admin/SlackNotificationsManager';
import { ErrorLogManager } from '@/components/admin/ErrorLogManager';

const SETUP_LABELS: Record<string, string> = {
  app_admins_json: 'Admins storage (Agent)',
  app_templates_json: 'Custom templates storage (Agent)',
  is_enabled: 'Question on/off flag (Question)',
};

function Chevron({ open }: { open: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}><polyline points="6 9 12 15 18 9" /></svg>;
}

// Collapsible admin section — matches the self-contained manager cards
// (Approval Routing / Slack / Error Log) so every section on this page opens and
// closes the same way. Collapsed by default.
function Section({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-5 border border-gray-200 rounded-xl bg-white">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 p-4 text-left">
        <div>
          <h2 className="font-heading font-bold text-base text-ink">{title}</h2>
          {desc && <p className="text-[12px] text-gray-500 mt-0.5 leading-relaxed">{desc}</p>}
        </div>
        <Chevron open={open} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

export default function AdminFlowsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Setup section state
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => {
      setIsAdmin(!!d.authenticated && !!d.isAdmin); setAuthChecked(true);
      if (!d.authenticated) router.replace('/login');
    }).catch(() => setAuthChecked(true));
  }, [router]);

  async function runSetup() {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/admin/setup', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Setup failed'); return; }
      setResults(d.results || {});
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally { setBusy(false); }
  }

  // Services AI review — the same apply pass the nightly cron runs. Clean →
  // auto-completed, else → Review. (Moved here from the settings gear.)
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMsg, setReviewMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function rerunAiReview() {
    if (reviewBusy) return;
    setReviewBusy(true); setReviewMsg(null);
    try {
      const r = await fetch('/api/services/admin/review?apply=1');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setReviewMsg({ ok: false, text: d.error || 'AI review failed.' }); return; }
      if (d.configured === false) { setReviewMsg({ ok: false, text: 'The Services object isn’t configured.' }); return; }
      if (!d.reviewed) { setReviewMsg({ ok: true, text: 'No submitted services to review right now.' }); return; }
      const parts = [`${d.reviewed} reviewed`];
      if (d.completed) parts.push(`${d.completed} auto-completed`);
      if (d.routedToReview) parts.push(`${d.routedToReview} → Review`);
      if (d.errors) parts.push(`${d.errors} error${d.errors > 1 ? 's' : ''}`);
      setReviewMsg({ ok: !d.errors, text: parts.join(' · ') });
    } catch {
      setReviewMsg({ ok: false, text: 'Couldn’t reach the server. Try again.' });
    } finally { setReviewBusy(false); }
  }

  if (!authChecked) return null;
  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div><p className="text-gray-700 font-heading font-semibold mb-2">Admin only</p><Link href="/" className="text-brand underline text-sm">Back</Link></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <Head><title>Admin</title></Head>
      <header className="bg-brand text-white">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="font-heading font-extrabold text-lg">Admin</h1>
          <Link href="/" className="text-xs font-heading font-semibold text-white/90 hover:text-white inline-flex items-center gap-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M11 18l-6-6 6-6" /></svg> Inspections</Link>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6">
        {/* ---- Admins ---- */}
        <Section title="Admins" desc="Manage who has admin access to ResiWalk (insights, form builder, these flows, and view-as).">
          <Link href="/admin/admins"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-brand text-white font-heading font-bold text-sm hover:opacity-90">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            Manage Admins
          </Link>
        </Section>

        {/* ---- Services AI Review (moved here from the settings gear) ---- */}
        <Section title="Rerun AI Review" desc="Re-runs the Services AI review across every currently-submitted service — the same pass the nightly job runs. Clean submissions auto-complete; anything with a concern routes to Review.">
          <button type="button" onClick={rerunAiReview} disabled={reviewBusy}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" /></svg>
            {reviewBusy ? 'Rerunning…' : 'Rerun AI Review'}
          </button>
          {reviewMsg && <p className={`text-[13px] mt-2 font-heading font-semibold ${reviewMsg.ok ? 'text-emerald-700' : 'text-red-600'}`}>{reviewMsg.text}</p>}
        </Section>

        {/* ---- Approval Routing (PODs / Regions) — self-contained collapsible card ---- */}
        <ApprovalRoutingManager />

        {/* ---- Slack Notifications (on/off + sandbox) — self-contained card ---- */}
        <SlackNotificationsManager />

        {/* ---- Error Log (real-time app failures) — self-contained card ---- */}
        <ErrorLogManager />

        {/* ---- Provision Fields (Setup) ---- */}
        <Section
          title="Provision Fields (Setup)"
          desc="Creates the HubSpot properties the app's features need (dynamic admins, custom templates, question on/off, utilities, Smart Home Device Installed / Serial Number, etc.). Safe to run repeatedly — existing properties are left as-is."
        >
          <button type="button" onClick={runSetup} disabled={busy}
            className="h-10 px-5 rounded-xl bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
            {busy ? 'Running…' : 'Run setup'}
          </button>
          {error && <div className="mt-3 p-3 bg-rose-50 border border-rose-300 rounded text-sm text-rose-800">{error}</div>}
          {results && (
            <ul className="mt-4 space-y-2">
              {Object.entries(results).map(([key, status]) => {
                const ok = status === 'exists' || status === 'created';
                return (
                  <li key={key} className="flex items-start gap-2.5 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5">
                    <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[12px] font-bold text-white ${ok ? 'bg-emerald-500' : 'bg-red-500'}`}>{ok ? '✓' : '✕'}</span>
                    <div>
                      <div className="text-sm font-heading font-semibold">{SETUP_LABELS[key] || key}</div>
                      <div className="text-[11.5px] text-gray-500">{status === 'created' ? 'Created.' : status === 'exists' ? 'Already present.' : status}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {results && Object.values(results).some((v) => v.startsWith('error')) && (
            <p className="mt-3 text-[12px] text-gray-500">If a property shows an error, the app’s HubSpot token likely lacks schema-write scope — grant the token the “CRM → schemas” write scope and re-run.</p>
          )}
        </Section>

        {/* ---- Regenerate PDFs ---- */}
        <Section title="Regenerate PDFs" desc="Rebuild inspection PDFs in place from saved data — never changing status, bypassing approval, or sending email/ticket. Keep this tab open while it runs.">
          <RegenPdfPicker embedded />
        </Section>
      </main>
    </div>
  );
}
