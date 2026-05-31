import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';

// Friendly messages for ?error= codes bounced back from the Google flow.
const ERROR_MESSAGES: Record<string, string> = {
  not_recognized: 'Email not recognized.',
  invalid_email: 'Please enter a valid email.',
  verify_failed: 'Could not verify users right now. Please try again.',
  google_not_configured: 'Google sign-in is not configured yet. Contact your administrator.',
  google_missing_code: 'Google sign-in did not complete. Please try again.',
  google_state_mismatch: 'Your sign-in session expired. Please try again.',
  google_exchange_failed: 'Google sign-in failed. Please try again.',
  google_no_identity: 'Could not read your Google account. Please try again.',
  google_email_mismatch: 'The Google account you signed in with does not match that email. Sign in with the matching Google account.',
  access_denied: 'Google sign-in was cancelled.',
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Surface errors bounced back from the Google sign-in flow.
  useEffect(() => {
    const code = typeof router.query.error === 'string' ? router.query.error : '';
    if (code) {
      setError(ERROR_MESSAGES[code] || 'Sign-in failed. Please try again.');
      // Clean the URL so a refresh doesn't keep showing the error.
      router.replace('/login', undefined, { shallow: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.query.error]);

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
      // Email is a valid HubSpot user. Hand off to Google sign-in to prove
      // ownership of the email. This is a full-page navigation (OAuth redirect);
      // keep `submitting` true so the button shows the in-progress state.
      window.location.href = `/api/auth/google-login?email=${encodeURIComponent(email.trim())}`;
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
              className="w-full max-w-[280px] object-contain mb-2"
            />
            <p className="text-sm text-gray-500 font-heading uppercase tracking-widest">
              Field Inspections
            </p>
          </div>

          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
            <h2 className="text-lg font-heading font-bold mb-2">Sign in</h2>
            <p className="text-sm text-gray-600 mb-6">
              Enter your HubSpot account email. You&apos;ll confirm it with Google to continue.
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
              {submitting ? 'Redirecting to Google…' : 'Continue with Google'}
            </button>

            <p className="text-xs text-gray-400 text-center mt-5">
              Access is restricted to active HubSpot users. You&apos;ll verify ownership of your email through Google.
            </p>
          </form>

          <p className="text-xs text-gray-400 text-center mt-6">
            ResiHome Inspections{process.env.NEXT_PUBLIC_APP_VERSION ? ` · v${process.env.NEXT_PUBLIC_APP_VERSION}` : ''}
          </p>
        </div>
      </main>
    </>
  );
}
