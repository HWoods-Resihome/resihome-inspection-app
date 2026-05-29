import { useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) {
      setError('Please enter your email');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || 'Login failed');
        setSubmitting(false);
        return;
      }
      // Success -- redirect to home
      router.replace('/');
    } catch (err: any) {
      setError(String(err.message || err));
      setSubmitting(false);
    }
  }

  return (
    <>
      <Head>
        <title>Sign in - ResiHome Inspection</title>
      </Head>
      <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-white">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/resiwalk-logo.png"
              alt="ResiWALK"
              className="w-full max-w-xs object-contain mb-3"
            />
            <p className="text-sm text-gray-500 font-heading uppercase tracking-widest">
              Field Inspections
            </p>
          </div>

          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
            <h2 className="text-lg font-heading font-bold mb-2">Sign in</h2>
            <p className="text-sm text-gray-600 mb-6">
              Enter your HubSpot account email to access the app.
            </p>

            <label htmlFor="email" className="block text-sm font-heading font-semibold text-ink mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
              placeholder="you@resihome.com"
              disabled={submitting}
              className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base mb-1"
            />

            {error && (
              <div className="mt-2 mb-1 text-sm text-brand font-heading font-semibold">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="w-full bg-brand hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-heading font-semibold py-3.5 px-4 rounded-lg transition mt-5 active:scale-[0.98]"
            >
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>

            <p className="text-xs text-gray-400 text-center mt-5">
              Access is restricted to active HubSpot users.
            </p>
          </form>

          <p className="text-xs text-gray-400 text-center mt-6">
            Sandbox build &middot; ResiTest Portal 51415639
          </p>
        </div>
      </main>
    </>
  );
}
