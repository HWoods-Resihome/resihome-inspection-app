import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

export default function LoginPage() {
  const router = useRouter();
  const [hasLogo, setHasLogo] = useState(false);
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => setHasLogo(true);
    img.onerror = () => setHasLogo(false);
    img.src = '/logo.png';
  }, []);

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
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
      </Head>
      <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-white">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            {hasLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src="/logo.png"
                alt="ResiHome"
                className="h-24 w-24 object-contain rounded-2xl mb-4 shadow-lg"
              />
            ) : (
              <div className="h-24 w-24 mb-4 flex items-center justify-center bg-brand text-white rounded-2xl text-3xl font-heading font-extrabold">
                RH
              </div>
            )}
            <h1 className="text-3xl font-heading font-extrabold text-ink tracking-tight">
              RESI<span className="text-brand">HOME</span>
            </h1>
            <p className="text-sm text-gray-500 mt-1 font-heading uppercase tracking-widest">
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
