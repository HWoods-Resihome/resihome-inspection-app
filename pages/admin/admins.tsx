/**
 * /admin/admins — manage who is an app admin.
 *
 * App admins can curate the AI Knowledge base, use the form builder, and manage
 * this list. Built-in (seed) admins are permanent; dynamically-added admins can
 * be removed. Gated to admins (the API enforces it too).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';
import { useRouter } from 'next/router';
import { InsightsUsersManager } from '@/components/insights/InsightsUsersManager';

interface AdminEntry {
  email: string;
  seed: boolean;
  addedByEmail?: string;
  addedAt?: number;
}

function fmtDate(ms?: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
}

export default function AdminsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [admins, setAdmins] = useState<AdminEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        setIsAdmin(!!data.authenticated && !!data.isAdmin);
        setAuthChecked(true);
        if (!data.authenticated) router.replace('/login');
      })
      .catch(() => setAuthChecked(true));
  }, [router]);

  async function load() {
    try {
      const r = await fetch('/api/admin/admins', { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to load'); return; }
      setAdmins(d.admins || []);
      setError(null);
    } catch (e: any) { setError(String(e?.message || e)); }
  }
  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  async function addAdmin() {
    const email = newEmail.trim();
    if (!email) return;
    // Optimistic: show the row immediately, revert on failure.
    const prev = admins;
    const cur = admins || [];
    if (!cur.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      setAdmins([...cur, { email, seed: false }].sort((a, b) => a.email.localeCompare(b.email)));
    }
    setNewEmail(''); setError(null); setBusy(true);
    try {
      const r = await fetch('/api/admin/admins', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (!r.ok) { setAdmins(prev); setError(d.error || 'Add failed'); return; }
      setAdmins(d.admins || []);   // reconcile with the authoritative list
    } catch { setAdmins(prev); setError('Add failed — try again.'); }
    finally { setBusy(false); }
  }

  async function removeAdmin(email: string) {
    if (!confirm(`Remove ${email} as an admin?`)) return;
    // Optimistic: drop the row immediately, revert on failure.
    const prev = admins;
    setAdmins((admins || []).filter((a) => a.email !== email)); setError(null); setBusy(true);
    try {
      const r = await fetch(`/api/admin/admins/${encodeURIComponent(email)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) { setAdmins(prev); setError(d.error || 'Remove failed'); return; }
      setAdmins(d.admins || []);
    } catch { setAdmins(prev); setError('Remove failed — try again.'); }
    finally { setBusy(false); }
  }

  if (!authChecked) return null;
  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-gray-700 font-heading font-semibold mb-2">Admin only</p>
          <Link href="/" className="text-brand underline text-sm">Back to inspections</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <PageHeader title="Admins" backHref="/admin/flows" maxW="max-w-3xl" />

      <main className="max-w-3xl mx-auto px-4 py-5">
        <p className="text-[13px] text-gray-600 mb-4 leading-snug">
          Admins can curate the <Link href="/ai-knowledge" className="text-brand underline">AI Knowledge base</Link>, use the <Link href="/admin/forms" className="text-brand underline">form builder</Link>, and manage this list. <strong>Built-in</strong> admins are permanent; others can be removed. First-time setup: <Link href="/admin/setup" className="text-brand underline">run admin setup</Link>.
        </p>

        {/* Add */}
        <div className="bg-white rounded-xl border border-gray-200 p-3 mb-5 shadow-sm">
          <label className="block text-xs font-heading font-semibold text-gray-500 mb-1">Add an admin by email</label>
          <div className="flex gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addAdmin(); }}
              placeholder="person@resihome.com"
              className="focus-brand flex-1 border border-gray-300 rounded-lg p-2.5 text-sm"
            />
            <button type="button" onClick={addAdmin} disabled={busy || !newEmail.trim()}
              className="h-[42px] px-4 rounded-lg bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
              Add
            </button>
          </div>
        </div>

        {error && <div className="mb-4 p-3 bg-rose-50 border border-rose-300 rounded text-sm text-rose-800">{error}</div>}

        {admins === null ? (
          <div className="text-center text-gray-500 py-10 text-sm">Loading…</div>
        ) : (
          <ul className="space-y-2">
            {admins.map((a) => (
              <li key={a.email} className="bg-white rounded-xl border border-gray-200 p-3 shadow-sm flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink truncate">{a.email}</div>
                  <div className="text-[11px] text-gray-500">
                    {a.seed ? 'Built-in admin' : `Added${a.addedByEmail ? ` by ${a.addedByEmail}` : ''}${a.addedAt ? ` · ${fmtDate(a.addedAt)}` : ''}`}
                  </div>
                </div>
                {a.seed ? (
                  <span className="text-[10px] font-heading font-bold uppercase tracking-wide text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5 shrink-0">Built-in</span>
                ) : (
                  <button type="button" onClick={() => removeAdmin(a.email)} disabled={busy}
                    className="inline-flex items-center gap-1 text-xs font-heading font-semibold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded-md px-2.5 py-1 shrink-0 disabled:opacity-50">
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* ResiWalk Insights — view-only analytics access. Separate from admin:
            admins already have insights access (canViewInsights = admin OR
            insights-user), so this list is only for non-admin viewers. */}
        <div className="mt-8 pt-6 border-t border-gray-200">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="font-heading font-bold text-base text-ink">ResiWalk Insights access</h2>
            <Link href="/insights" className="text-xs font-heading font-semibold text-brand underline shrink-0">Open Insights →</Link>
          </div>
          <InsightsUsersManager />
        </div>
      </main>
    </div>
  );
}
