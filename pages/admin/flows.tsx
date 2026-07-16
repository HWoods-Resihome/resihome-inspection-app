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

  // Photo migration (HubSpot Files → Vercel Blob): a browser-driven loop over
  // batches so progress is visible. Copies inspections THEN services; never deletes.
  const [migBusy, setMigBusy] = useState(false);
  const [migErr, setMigErr] = useState<string | null>(null);
  const [migProg, setMigProg] = useState<null | { phase: string; found: number; copied: number; verified: number; records: number; scanned: number; errors: number; samples: string[]; done: boolean }>(null);
  async function runMigratePhotos() {
    if (migBusy) return;
    if (typeof window !== 'undefined' && !window.confirm('Copy ALL remaining HubSpot-hosted photos (inspections + services) into Vercel Blob and rewrite references? This does NOT delete anything from HubSpot. Keep this tab open until it finishes.')) return;
    setMigBusy(true); setMigErr(null);
    const totals = { found: 0, copied: 0, verified: 0, records: 0, scanned: 0, errors: 0 };
    const samples: string[] = [];
    const objects: { key: 'answer' | 'service'; label: string }[] = [{ key: 'answer', label: 'Inspections' }, { key: 'service', label: 'Services' }];
    try {
      for (const obj of objects) {
        let after: string | undefined; let done = false; let stalls = 0; let guard = 0;
        do {
          const qs = new URLSearchParams({ object: obj.key, apply: '1' });
          if (after) qs.set('after', after);
          const r = await fetch(`/api/admin/migrate-photos?${qs.toString()}`, { method: 'POST' });
          const d = await r.json();
          if (!r.ok) { setMigErr(d.error || 'Migration failed.'); setMigBusy(false); return; }
          totals.found += d.hubspotSeen || 0; totals.copied += d.copied || 0; totals.verified += d.verified || 0; totals.records += d.recordsUpdated || 0; totals.scanned += d.scanned || 0; totals.errors += d.errors || 0;
          for (const s of (d.errorSamples || [])) if (samples.length < 8 && !samples.includes(s)) samples.push(s);
          setMigProg({ phase: obj.label, ...totals, samples, done: false });
          const prevAfter = after;
          after = d.after || undefined; done = !!d.done;
          const progressed = (d.copied || 0) > 0 || (d.recordsUpdated || 0) > 0 || after !== prevAfter;
          stalls = progressed ? 0 : stalls + 1;
          if (stalls >= 3) { done = true; } // no progress for 3 batches → move on
          if (++guard > 5000) { setMigErr('Stopped after 5000 batches (safety cap).'); done = true; }
        } while (!done);
      }
      setMigProg((p) => (p ? { ...p, phase: 'Complete', done: true } : { phase: 'Complete', ...totals, samples, done: true }));
    } catch (e: any) { setMigErr(String(e?.message || e)); }
    finally { setMigBusy(false); }
  }

  // Background (server-side, unattended) migration: start it and it runs on the
  // server with no browser open. Poll status every 10s.
  type BgState = { running: boolean; stopRequested?: boolean; object: string; totals: { found: number; copied: number; verified: number; records: number; scanned: number; errors: number }; startedAt: string; heartbeatAt: string; finishedAt?: string; lastError?: string; errorSamples?: string[] } | null;
  const [bg, setBg] = useState<BgState>(null);
  const [bgBusy, setBgBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    const load = async () => { try { const r = await fetch('/api/admin/migrate-photos-bg'); const d = await r.json(); if (!stopped) setBg(d.state || null); } catch { /* ignore */ } };
    load();
    const id = setInterval(load, 10000);
    return () => { stopped = true; clearInterval(id); };
  }, []);
  async function startBg() { if (bgBusy) return; if (typeof window !== 'undefined' && !window.confirm('Start the migration on the SERVER? It runs unattended — you can close this tab. It copies photos to Vercel Blob and rewrites references; it never deletes from HubSpot.')) return; setBgBusy(true); try { const r = await fetch('/api/admin/migrate-photos-bg?action=start', { method: 'POST' }); const d = await r.json(); if (d.state) setBg(d.state); } finally { setBgBusy(false); } }
  async function stopBg() { if (bgBusy) return; setBgBusy(true); try { await fetch('/api/admin/migrate-photos-bg?action=stop', { method: 'POST' }); } finally { setBgBusy(false); } }

  // Read-only "how much is left to migrate?" tally.
  const [remBusy, setRemBusy] = useState(false);
  const [remErr, setRemErr] = useState<string | null>(null);
  const [rem, setRem] = useState<null | { inspections: { records: number; photos: number }; services: { records: number; photos: number } }>(null);
  async function checkRemaining() {
    if (remBusy) return;
    setRemBusy(true); setRemErr(null);
    try {
      const r = await fetch('/api/admin/migration-status');
      const d = await r.json();
      if (!r.ok) { setRemErr(d.error || 'Failed.'); return; }
      setRem({ inspections: d.inspections, services: d.services });
    } catch (e: any) { setRemErr(String(e?.message || e)); }
    finally { setRemBusy(false); }
  }

  // Reclaim HubSpot space: delete the now-orphaned HubSpot photo originals after
  // migration. Dry-run preview first, then a confirmed delete. Both loop pages.
  const [delBusy, setDelBusy] = useState<'preview' | 'delete' | null>(null);
  const [delErr, setDelErr] = useState<string | null>(null);
  const [delProg, setDelProg] = useState<null | { mode: 'preview' | 'delete'; appPhotos: number; orphaned: number; kept: number; deleted: number; errors: number; referencedCount: number; done: boolean; capped?: boolean }>(null);
  async function runDeleteMigrated(apply: boolean) {
    if (delBusy) return;
    if (apply && typeof window !== 'undefined' && !window.confirm('Permanently DELETE the migrated photo originals from HubSpot? Only files already copied to Vercel Blob and no longer referenced by any record are removed — this cannot be undone. Run a Preview first. Keep this tab open until it finishes.')) return;
    setDelBusy(apply ? 'delete' : 'preview'); setDelErr(null);
    const totals = { appPhotos: 0, orphaned: 0, kept: 0, deleted: 0, errors: 0, referencedCount: 0 };
    let capped = false;
    try {
      let after: string | undefined; let done = false; let guard = 0;
      do {
        const qs = new URLSearchParams(); if (apply) qs.set('apply', '1'); if (after) qs.set('after', after);
        const r = await fetch(`/api/admin/delete-migrated-photos?${qs.toString()}`, { method: 'POST' });
        const d = await r.json();
        if (!r.ok) { setDelErr(d.error || 'Failed.'); setDelBusy(null); return; }
        totals.appPhotos += d.appPhotos || 0; totals.orphaned += d.orphaned || 0; totals.kept += d.referencedKept || 0;
        totals.deleted += d.deleted || 0; totals.errors += d.errors || 0; totals.referencedCount = d.referencedCount || totals.referencedCount;
        if (d.capped) capped = true;
        setDelProg({ mode: apply ? 'delete' : 'preview', ...totals, done: false, capped });
        after = d.after || undefined; done = !!d.done;
        if (++guard > 10000) { setDelErr('Stopped after 10000 pages (safety cap).'); done = true; }
      } while (!done);
      setDelProg({ mode: apply ? 'delete' : 'preview', ...totals, done: true, capped });
    } catch (e: any) { setDelErr(String(e?.message || e)); }
    finally { setDelBusy(null); }
  }

  // Server-side (unattended) reclaim — deletes migrated originals overnight with
  // no browser open. Mirrors the background migration; poll status every 10s.
  type ReclaimBg = { running: boolean; stopRequested?: boolean; totals: { appPhotos: number; orphaned: number; deleted: number; referencedKept: number; errors: number }; passes: number; startedAt: string; heartbeatAt: string; finishedAt?: string; lastError?: string; errorSamples?: string[] } | null;
  const [rbg, setRbg] = useState<ReclaimBg>(null);
  const [rbgBusy, setRbgBusy] = useState(false);
  useEffect(() => {
    let stopped = false;
    const load = async () => { try { const r = await fetch('/api/admin/reclaim-photos-bg'); const d = await r.json(); if (!stopped) setRbg(d.state || null); } catch { /* ignore */ } };
    load();
    const id = setInterval(load, 10000);
    return () => { stopped = true; clearInterval(id); };
  }, []);
  async function startReclaimBg() {
    if (rbgBusy) return;
    if (typeof window !== 'undefined' && !window.confirm('Start the DELETE on the SERVER? It runs unattended (you can close this tab / leave it overnight) and permanently deletes the migrated HubSpot photo originals. Only files no record references are removed — still-in-use photos are protected — but this cannot be undone. Run a Preview first, and finish the migration before reclaiming.')) return;
    setRbgBusy(true);
    // Start returns immediately — the server kicks a detached worker that deletes
    // in the background and chains itself (an every-minute cron watchdog backstops
    // it). The status poll below surfaces live progress; you can close the tab or
    // leave it running overnight.
    try {
      const r = await fetch('/api/admin/reclaim-photos-bg?action=start', { method: 'POST' });
      const d = await r.json();
      if (d.state) setRbg(d.state);
    } catch { /* network — server may still be running; polling updates the UI */ }
    setRbgBusy(false);
  }
  async function stopReclaimBg() { if (rbgBusy) return; setRbgBusy(true); try { await fetch('/api/admin/reclaim-photos-bg?action=stop', { method: 'POST' }); } finally { setRbgBusy(false); } }

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

        {/* ---- Photo migration: HubSpot Files → Vercel Blob ---- */}
        <Section title="Migrate Photos out of HubSpot" desc="Copies every remaining HubSpot-hosted photo (inspections + services) into Vercel Blob and rewrites the references. Does NOT delete from HubSpot — reclaiming that space is a separate step. Safe to re-run; already-migrated photos are skipped. Keep this tab open while it runs.">
          <button type="button" onClick={runMigratePhotos} disabled={migBusy}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
            {migBusy && <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>}
            {migBusy ? 'Migrating…' : 'Start migration'}
          </button>
          {migProg && (
            <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 text-[13px]">
              <div className={`font-heading font-bold ${migProg.done ? (migProg.errors || migProg.verified < migProg.found ? 'text-amber-700' : 'text-emerald-700') : 'text-ink'}`}>
                {migProg.done
                  ? (migProg.errors || migProg.verified < migProg.found
                      ? `Finished with issues — ${migProg.found - migProg.verified} photo(s) not confirmed, ${migProg.errors} error(s)`
                      : `Complete ✓ — all ${migProg.verified} photos migrated & verified`)
                  : `Migrating ${migProg.phase}…`}
              </div>
              {/* Photos: found = HubSpot-hosted photos seen; verified = confirmed in
                  Blob. When done, verified should equal found with 0 errors. */}
              <div className="text-gray-600 mt-1 tabular-nums">
                Photos: {migProg.copied} copied · {migProg.verified}/{migProg.found} verified{migProg.errors ? ` · ${migProg.errors} error(s)` : ''}
              </div>
              {/* Records: how many inspections/services had their photo references
                  rewritten, out of how many were scanned. */}
              <div className="text-gray-600 mt-0.5 tabular-nums">
                {migProg.phase === 'Services' || migProg.phase === 'Complete' ? 'Service records' : 'Answer records'}: {migProg.records} updated · {migProg.scanned} scanned
              </div>
              {migProg.samples.length > 0 && (
                <details className="mt-1.5">
                  <summary className="text-[11px] text-amber-700 cursor-pointer">Why photos failed ({migProg.errors})</summary>
                  <ul className="mt-1 text-[11px] text-gray-500 list-disc pl-4 space-y-0.5">
                    {migProg.samples.map((s, i) => <li key={i} className="break-all">{s}</li>)}
                  </ul>
                </details>
              )}
            </div>
          )}
          {migErr && <p className="text-red-600 text-[13px] mt-2">{migErr}</p>}

          {/* Server-side (unattended) migration — runs overnight, no open tab. */}
          <div className="mt-4 pt-3 border-t border-gray-100">
            <div className="text-[12px] font-heading font-bold text-ink mb-1">Run on the server (overnight)</div>
            <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">Starts the same migration on the server so you can close this tab. It processes continuously and a watchdog resumes it if interrupted. Best for a large backlog.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={startBg} disabled={bgBusy || !!bg?.running}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
                {bg?.running ? 'Running on server…' : bgBusy ? 'Starting…' : 'Start background migration'}
              </button>
              {bg?.running && (
                <button type="button" onClick={stopBg} disabled={bgBusy}
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-xl border border-gray-300 bg-white text-gray-700 font-heading font-bold text-sm hover:border-red-400 hover:text-red-600 disabled:opacity-50">
                  {bg?.stopRequested ? 'Stopping…' : 'Stop'}
                </button>
              )}
            </div>
            {bg && (
              <div className="mt-2 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 text-[13px]">
                <div className={`font-heading font-bold ${bg.running ? 'text-ink' : (bg.totals.errors ? 'text-amber-700' : 'text-emerald-700')}`}>
                  {bg.running
                    ? `Running on server — ${bg.object === 'service' ? 'services' : 'inspections'}${bg.stopRequested ? ' (stopping…)' : ''}`
                    : bg.finishedAt ? `Finished ✓${bg.totals.errors ? ` — ${bg.totals.errors} error(s)` : ''}` : 'Idle'}
                </div>
                <div className="text-gray-600 mt-1 tabular-nums">
                  Photos: {bg.totals.copied} copied · {bg.totals.verified}/{bg.totals.found} verified{bg.totals.errors ? ` · ${bg.totals.errors} error(s)` : ''}
                </div>
                <div className="text-gray-600 mt-0.5 tabular-nums">Answer/service records: {bg.totals.records} updated · {bg.totals.scanned} scanned</div>
                {bg.running && <div className="text-gray-400 mt-0.5 text-[11px]">Last activity {Math.max(0, Math.round((Date.now() - Date.parse(bg.heartbeatAt)) / 1000))}s ago · safe to close this tab.</div>}
                {bg.lastError && <div className="text-amber-700 mt-0.5 text-[11px] break-all">Last error: {bg.lastError}</div>}
                {bg.errorSamples && bg.errorSamples.length > 0 && (
                  <details className="mt-1 text-[11px] text-gray-500">
                    <summary className="cursor-pointer">Recent photo errors ({bg.errorSamples.length})</summary>
                    <ul className="mt-1 space-y-0.5">{bg.errorSamples.slice(0, 10).map((s, i) => <li key={i} className="break-all">• {s}</li>)}</ul>
                  </details>
                )}
              </div>
            )}
          </div>

          {/* Read-only: how many records still reference a HubSpot photo (i.e. left to migrate). */}
          <div className="mt-3 pt-3 border-t border-gray-100">
            <button type="button" onClick={checkRemaining} disabled={remBusy}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-gray-300 bg-white text-ink font-heading font-semibold text-[13px] hover:border-brand/50 disabled:opacity-50">
              {remBusy && <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>}
              {remBusy ? 'Checking…' : 'Check remaining'}
            </button>
            {rem && (
              <div className="mt-2 text-[13px] text-gray-700 tabular-nums">
                {rem.inspections.records === 0 && rem.services.records === 0
                  ? <span className="font-heading font-bold text-emerald-700">Nothing left — all photos are on Blob ✓</span>
                  : <>
                      <div><b>{rem.inspections.photos}</b> inspection photo(s) left, across <b>{rem.inspections.records}</b> answer record(s)</div>
                      <div><b>{rem.services.photos}</b> service photo(s) left, across <b>{rem.services.records}</b> record(s)</div>
                      <div className="text-gray-400 text-[11px] mt-0.5">Answer records are the per-question/section photo holders — many per inspection, not the ~parent inspection count.</div>
                    </>}
              </div>
            )}
            {remErr && <p className="text-red-600 text-[13px] mt-1">{remErr}</p>}
          </div>
        </Section>

        {/* ---- Reclaim HubSpot space: delete migrated originals ---- */}
        <Section title="Delete Migrated Photos from HubSpot" desc="After migrating, this reclaims HubSpot storage by deleting the photo originals that are now safely on Vercel Blob. SAFE: only files in the app's photo folder that NO record still references are removed — anything still in use (not yet migrated) is left untouched. Always Preview first; deletion cannot be undone.">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => runDeleteMigrated(false)} disabled={!!delBusy}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-xl border border-gray-300 bg-white text-ink font-heading font-bold text-sm hover:border-brand/50 disabled:opacity-50">
              {delBusy === 'preview' && <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>}
              {delBusy === 'preview' ? 'Previewing…' : 'Preview (dry-run)'}
            </button>
            <button type="button" onClick={() => runDeleteMigrated(true)} disabled={!!delBusy}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-red-600 text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
              {delBusy === 'delete' && <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.5" /></svg>}
              {delBusy === 'delete' ? 'Deleting…' : 'Delete orphaned files'}
            </button>
          </div>
          {delProg && (
            <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 text-[13px]">
              <div className={`font-heading font-bold ${delProg.done ? (delProg.errors ? 'text-amber-700' : 'text-emerald-700') : 'text-ink'}`}>
                {!delProg.done
                  ? (delProg.mode === 'delete' ? 'Deleting…' : 'Scanning…')
                  : delProg.mode === 'preview'
                    ? `Preview: ${delProg.orphaned} orphaned file(s) can be deleted`
                    : `Done ✓ — ${delProg.deleted} file(s) deleted${delProg.errors ? `, ${delProg.errors} error(s)` : ''}`}
              </div>
              <div className="text-gray-600 mt-1 tabular-nums">
                {delProg.appPhotos} app photos checked · {delProg.orphaned} orphaned · {delProg.kept} still referenced (kept)
                {delProg.mode === 'delete' ? ` · ${delProg.deleted} deleted` : ''}
              </div>
              <div className="text-gray-400 mt-0.5 text-[11px] tabular-nums">Safety set: {delProg.referencedCount} photo URL(s) still referenced by records are protected.</div>
              {delProg.capped && (
                <div className="text-amber-700 mt-1 text-[11px]">Note: HubSpot stopped the scan early (list cap/blip). Counts are a partial pass — run again to continue where it left off.</div>
              )}
            </div>
          )}

          {/* Run on the SERVER (unattended) — same as the background migration.
              Chews through the ~10k-per-scroll cap across multiple passes on its
              own; you can close the tab / leave it overnight. */}
          <div className="mt-4 pt-3 border-t border-gray-200">
            <div className="text-[12px] font-heading font-bold text-ink mb-1">Run in background (server-side)</div>
            <p className="text-[11px] text-gray-500 mb-2 leading-relaxed">Deletes overnight with no browser open — resumes itself and works past HubSpot's ~10k list cap across passes. Finish the migration and Preview first.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={startReclaimBg} disabled={rbgBusy || !!rbg?.running}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-red-600 text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
                {rbg?.running ? 'Running on server…' : rbgBusy ? 'Starting…' : 'Start background delete'}
              </button>
              {rbg?.running && (
                <button type="button" onClick={stopReclaimBg} disabled={rbgBusy}
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-xl border border-gray-300 bg-white text-ink font-heading font-bold text-sm hover:border-brand/50 disabled:opacity-50">
                  {rbg.stopRequested ? 'Stopping…' : 'Stop'}
                </button>
              )}
            </div>
            {rbg && (
              <div className="mt-3 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 text-[13px]">
                <div className={`font-heading font-bold ${rbg.running ? 'text-ink' : (rbg.totals.errors ? 'text-amber-700' : 'text-emerald-700')}`}>
                  {rbg.running
                    ? (rbg.stopRequested ? 'Stopping after the current batch…' : 'Deleting on the server…')
                    : rbg.finishedAt ? `Finished ✓ — ${rbg.totals.deleted} file(s) deleted${rbg.totals.errors ? ` · ${rbg.totals.errors} error(s)` : ''}` : 'Idle'}
                </div>
                <div className="text-gray-600 mt-1 tabular-nums">
                  {rbg.totals.deleted} deleted · {rbg.totals.orphaned} orphaned found · {rbg.totals.referencedKept} still referenced (kept) · {rbg.totals.appPhotos} checked · pass {rbg.passes}
                </div>
                {rbg.running && <div className="text-gray-400 mt-0.5 text-[11px]">Last activity {Math.max(0, Math.round((Date.now() - Date.parse(rbg.heartbeatAt)) / 1000))}s ago · safe to close this tab.</div>}
                {rbg.lastError && <div className="text-amber-700 mt-0.5 text-[11px] break-all">Last hiccup (auto-retried): {rbg.lastError}</div>}
                {rbg.errorSamples && rbg.errorSamples.length > 0 && (
                  <details className="mt-1 text-[11px] text-gray-500">
                    <summary className="cursor-pointer">Recent delete errors ({rbg.errorSamples.length})</summary>
                    <ul className="mt-1 space-y-0.5">{rbg.errorSamples.slice(0, 10).map((s, i) => <li key={i} className="break-all">• {s}</li>)}</ul>
                  </details>
                )}
              </div>
            )}
          </div>

          {delErr && <p className="text-red-600 text-[13px] mt-2">{delErr}</p>}
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
