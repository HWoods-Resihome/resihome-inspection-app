/**
 * /admin/setup — one-click HubSpot property provisioning for the new admin
 * features (dynamic admins, custom templates, question on/off). Replaces the
 * Python setup scripts: the app uses its own HubSpot token. Admin only.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

const LABELS: Record<string, string> = {
  app_admins_json: 'Admins storage (Agent)',
  app_templates_json: 'Custom templates storage (Agent)',
  is_enabled: 'Question on/off flag (Question)',
};

export default function SetupPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me').then((r) => r.json()).then((d) => {
      setIsAdmin(!!d.authenticated && !!d.isAdmin); setAuthChecked(true);
      if (!d.authenticated) router.replace('/login');
    }).catch(() => setAuthChecked(true));
  }, [router]);

  async function run() {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/admin/setup', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Setup failed'); return; }
      setResults(d.results || {});
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
      <header className="bg-brand text-white">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="font-heading font-extrabold text-lg">Admin Setup</h1>
          <Link href="/" className="text-xs font-heading font-semibold text-white/90 hover:text-white inline-flex items-center gap-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M11 18l-6-6 6-6" /></svg> Inspections</Link>
        </div>
      </header>
      <main className="max-w-2xl mx-auto px-4 py-6">
        <p className="text-sm text-gray-600 mb-4 leading-relaxed">
          Creates the HubSpot properties the new admin features need (dynamic admins, custom templates, question on/off). Safe to run repeatedly — existing properties are left as-is. No Python needed; the app uses its own HubSpot connection.
        </p>
        <button type="button" onClick={run} disabled={busy}
          className="h-11 px-5 rounded-xl bg-brand text-white font-heading font-bold text-sm hover:opacity-90 disabled:bg-gray-300">
          {busy ? 'Running…' : 'Run setup'}
        </button>

        {error && <div className="mt-4 p-3 bg-rose-50 border border-rose-300 rounded text-sm text-rose-800">{error}</div>}

        {results && (
          <ul className="mt-5 space-y-2">
            {Object.entries(results).map(([key, status]) => {
              const ok = status === 'exists' || status === 'created';
              return (
                <li key={key} className="flex items-start gap-2.5 rounded-lg bg-white border border-gray-200 px-3 py-2.5">
                  <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[12px] font-bold text-white ${ok ? 'bg-emerald-500' : 'bg-red-500'}`}>{ok ? '✓' : '✕'}</span>
                  <div>
                    <div className="text-sm font-heading font-semibold">{LABELS[key] || key}</div>
                    <div className="text-[11.5px] text-gray-500">{status === 'created' ? 'Created.' : status === 'exists' ? 'Already present.' : status}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {results && Object.values(results).some((v) => v.startsWith('error')) && (
          <p className="mt-4 text-[12px] text-gray-500">If a property shows an error, the app’s HubSpot token likely lacks schema-write scope — run the matching Python script in <code>scripts/</code> instead, or grant the token the “CRM → custom objects → schemas” write scope and re-run.</p>
        )}
      </main>
    </div>
  );
}
