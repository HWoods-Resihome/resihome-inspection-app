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
import { PageHeader } from '@/components/PageHeader';
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
      <PageHeader title="Admin" onBack={() => (typeof window !== 'undefined' && window.history.length > 1 ? router.back() : router.push('/'))} backHref="/" maxW="max-w-2xl" />

      <main className="max-w-2xl mx-auto px-4 py-6">
        {/* ---- Admins ---- */}
        <Section title="Admins" desc="Manage who has admin access to ResiWalk (insights, form builder, these flows, and view-as).">
          <Link href="/admin/admins"
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-brand text-white font-heading font-bold text-sm hover:opacity-90">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            Manage Admins
          </Link>
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
