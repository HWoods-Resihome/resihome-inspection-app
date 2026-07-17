import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import { isExternalEmail } from '@/lib/userAccess';
import { openOAuthStartNative } from '@/lib/nativeBridge';

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
  access_denied: 'Sign-in was cancelled.',
  microsoft_not_configured: 'Microsoft sign-in is not configured yet. Contact your administrator.',
  microsoft_missing_code: 'Microsoft sign-in did not complete. Please try again.',
  microsoft_state_mismatch: 'Your sign-in session expired. Please try again.',
  microsoft_exchange_failed: 'Microsoft sign-in failed. Please try again.',
  microsoft_no_identity: 'Could not read your Microsoft account. Please try again.',
  microsoft_email_mismatch: 'The Microsoft account you signed in with does not match that email. Sign in with the matching account.',
  microsoft_internal_blocked: 'Please sign in with Google for an internal account.',
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Email sign-in code (OTP) fallback — for users who can't use Google/Microsoft
  // OAuth (e.g. a Zoho mailbox). 'idle' shows the link; 'sent' shows the code box.
  const [otpStage, setOtpStage] = useState<'idle' | 'sent'>('idle');
  const [code, setCode] = useState('');
  const [otpBusy, setOtpBusy] = useState(false);
  // Vendor (Services) sign-in is MERGED into the main flow: on "Continue" we
  // detect whether the email is an approved vendor and, if so, switch to the
  // password stage (or first-login 'setup'); otherwise we fall through to staff
  // (Google). 'none' = normal email entry; 'reset' = forgot-password (emailed
  // code + new password). No separate button.
  const [vendorStage, setVendorStage] = useState<'none' | 'password' | 'setup' | 'reset'>('none');
  const [confirm, setConfirm] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [vendorBusy, setVendorBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);   // reveal the vendor password field(s)
  const inVendorFlow = vendorStage !== 'none';

  // Main "Continue": approved-vendor detection first, else staff Google sign-in.
  async function continueEmail() {
    if (!email.trim()) { setError('Please enter your email'); return; }
    setVendorBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/vendor-check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.approved) {
        setVendorName(d.name || '');
        setVendorStage(d.hasPassword ? 'password' : 'setup');
        setVendorBusy(false);
        return;
      }
    } catch { /* fall through to staff sign-in */ }
    // Not an approved vendor (or the check failed) → staff sign-in with Google.
    setVendorBusy(false);
    await startLogin('google');
  }

  async function vendorSubmit() {
    if (!password) { setError('Enter your password'); return; }
    if (vendorStage === 'setup' && password !== confirm) { setError('Passwords do not match.'); return; }
    setVendorBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/vendor-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, confirm }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setError(d.error || 'Sign-in failed'); setVendorBusy(false); return; }
      window.location.href = d.redirect || '/services';
    } catch (err: any) { setError(String(err.message || err)); setVendorBusy(false); }
  }

  // Forgot password (approved vendors only): email a one-time code → set new one.
  async function vendorResetRequest() {
    if (!email.trim()) { setError('Please enter your email'); return; }
    setVendorBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/vendor-reset-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'Could not send a code.'); setVendorBusy(false); return; }
      setPassword(''); setConfirm(''); setCode(''); setVendorStage('reset');
    } catch (err: any) { setError(String(err.message || err)); }
    finally { setVendorBusy(false); }
  }

  async function vendorResetVerify() {
    if (!code.trim()) { setError('Enter the code from your email'); return; }
    if (!password) { setError('Enter a new password'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setVendorBusy(true); setError(null);
    try {
      const r = await fetch('/api/auth/vendor-reset-verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim(), password, confirm }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { setError(d.error || 'Reset failed'); setVendorBusy(false); return; }
      window.location.href = d.redirect || '/services';
    } catch (err: any) { setError(String(err.message || err)); setVendorBusy(false); }
  }

  // Back out of the vendor flow to a fresh email entry.
  function backToEmail() { setVendorStage('none'); setPassword(''); setConfirm(''); setCode(''); setError(null); }

  async function requestOtp() {
    if (!email.trim()) { setError('Please enter your email'); return; }
    setOtpBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/otp-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setError(data.error || 'Could not send a code.'); setOtpBusy(false); return; }
      setOtpStage('sent');
      setCode('');
    } catch (err: any) {
      setError(String(err.message || err));
    } finally {
      setOtpBusy(false);
    }
  }

  async function verifyOtp() {
    if (!code.trim()) { setError('Enter the code from your email'); return; }
    setOtpBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/otp-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), code: code.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) { setError(data.error || 'Sign-in failed'); setOtpBusy(false); return; }
      window.location.href = data.redirect || '/';
    } catch (err: any) {
      setError(String(err.message || err));
      setOtpBusy(false);
    }
  }

  // App Store / Play review demo account: when the reviewer types this email, a
  // password field appears and sign-in goes through the password path (which
  // bypasses Google/2FA, validated server-side). Email is not a secret (it's in
  // App Store Connect); the password lives only in a server env var.
  const REVIEW_EMAIL = (process.env.NEXT_PUBLIC_APP_REVIEW_EMAIL || 'apptest@resihome.com').trim().toLowerCase();
  const isReviewEmail = email.trim().toLowerCase() === REVIEW_EMAIL;

  // App-review password sign-in (no Google). Mints the session server-side.
  async function reviewLogin() {
    if (!password) { setError('Please enter the password'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/review-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        setError(data.error || 'Sign-in failed');
        setSubmitting(false);
        return;
      }
      window.location.href = data.redirect || '/';
    } catch (err: any) {
      setError(String(err.message || err));
      setSubmitting(false);
    }
  }

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

  async function startLogin(provider: 'google' | 'microsoft') {
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
      // Email is a valid HubSpot user. Hand off to the chosen provider to prove
      // ownership. Full-page navigation (OAuth redirect); keep `submitting` true.
      const route = provider === 'microsoft' ? 'microsoft-login' : 'google-login';
      const startUrl = `/api/auth/${route}?email=${encodeURIComponent(email.trim())}`;
      // In the native (Capacitor) shell, open the OAuth start in the system
      // browser tagged client=native so it returns via the resiwalk:// deep link
      // and /api/auth/exchange. (Reliable on iOS, where the location monkey-patch
      // in installOAuthBridge silently no-ops.) No-op in a normal browser.
      if (await openOAuthStartNative(startUrl)) return;
      window.location.href = startUrl;
    } catch (err: any) {
      setError(String(err.message || err));
      setSubmitting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (vendorStage === 'password' || vendorStage === 'setup') { void vendorSubmit(); return; }
    if (vendorStage === 'reset') { void vendorResetVerify(); return; }
    if (otpStage === 'sent') { void verifyOtp(); return; }
    if (isReviewEmail) { void reviewLogin(); return; }
    void continueEmail();
  }

  return (
    <>
      <Head>
        {/* Authoritative title + description so search engines/link previews show
            the correct branding ("ResiWalk", proper case — never "ResiHome
            Inspection" or all-caps "ResiWALK"). The old crawl that shows those was
            a stale version; these explicit tags replace the auto-generated snippet
            on the next crawl. (No robots:noindex — this is the public landing for
            resiwalk.com, so it should be indexable with the description below.) */}
        <title>ResiWalk — Field Inspections & Recurring Services</title>
        <meta name="description" content="ResiWalk is the leading edge field inspection and recurring services platform for Property Managers. Powered with AI automation, customizable workflows, and an intuitive interface that maximizes efficiency and solves day to day challenges." />
        <meta property="og:site_name" content="ResiWalk" />
        <meta property="og:title" content="ResiWalk — Field Inspections & Recurring Services" />
        <meta property="og:description" content="ResiWalk is the leading edge field inspection and recurring services platform for Property Managers. Powered with AI automation, customizable workflows, and an intuitive interface that maximizes efficiency and solves day to day challenges." />
        {/* WebSite structured data — the authoritative signal Google uses for the
            "site name" line in results, so it reads "ResiWalk" instead of the bare
            resiwalk.com domain. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'ResiWalk',
            alternateName: 'ResiWalk — Field Inspections & Recurring Services',
            url: 'https://resiwalk.com/',
          }) }}
        />
      </Head>
      <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-white">
        <div className="w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/resiwalk-logo.svg"
              alt="ResiWalk"
              className="w-full max-w-[300px] object-contain mb-2"
            />
            <p className="text-sm text-gray-500 font-heading uppercase tracking-widest">
              Field Inspections
            </p>
          </div>

          <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
            <h2 className="text-lg font-heading font-bold mb-2">Sign in</h2>
            <p className="text-sm text-gray-600 mb-6">
              {vendorStage === 'setup'
                ? `Welcome${vendorName ? `, ${vendorName}` : ''}. Create a password for your ResiWalk Services account.`
                : vendorStage === 'password'
                  ? `Enter your ResiWalk password${vendorName ? ` for ${vendorName}` : ''}.`
                  : vendorStage === 'reset'
                    ? `Enter the code we emailed to ${email.trim()} and choose a new password.`
                    : 'Enter your account email to continue.'}
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
              disabled={submitting || vendorBusy || inVendorFlow}
              className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base mb-1"
            />

            {/* Vendor password: enter (returning), create (first login), or reset
                (forgot-password: emailed code + new password). Shown once the email
                is confirmed to be an approved vendor. */}
            {inVendorFlow && (
              <div className="mt-4">
                {vendorStage === 'reset' && (
                  <>
                    <label htmlFor="vendor-code" className="block text-sm font-heading font-semibold text-ink mb-1.5">
                      Code from your email
                    </label>
                    <input
                      id="vendor-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                      value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError(null); }}
                      placeholder="123456" disabled={vendorBusy} autoFocus
                      className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base tracking-[0.4em] text-center mb-3"
                    />
                  </>
                )}
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="vendor-password" className="block text-sm font-heading font-semibold text-ink">
                    {vendorStage === 'password' ? 'Password' : vendorStage === 'reset' ? 'New password' : 'Create password'}
                  </label>
                  <button type="button" onClick={() => setShowPw((s) => !s)} tabIndex={-1}
                    className="text-xs text-brand font-heading font-semibold hover:underline">
                    {showPw ? 'Hide' : 'Show'}
                  </button>
                </div>
                <input
                  id="vendor-password"
                  type={showPw ? 'text' : 'password'}
                  autoComplete={vendorStage === 'password' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(null); }}
                  placeholder={vendorStage === 'password' ? 'Password' : 'At least 8 characters'}
                  disabled={vendorBusy}
                  autoFocus={vendorStage !== 'reset'}
                  className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base"
                />
                {(vendorStage === 'setup' || vendorStage === 'reset') && (
                  <>
                    <label htmlFor="vendor-confirm" className="block text-sm font-heading font-semibold text-ink mb-1.5 mt-3">
                      Confirm password
                    </label>
                    <input
                      id="vendor-confirm"
                      type={showPw ? 'text' : 'password'}
                      autoComplete="new-password"
                      value={confirm}
                      onChange={(e) => { setConfirm(e.target.value); setError(null); }}
                      placeholder="Re-enter password"
                      disabled={vendorBusy}
                      className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base"
                    />
                  </>
                )}
                {vendorStage === 'password' && (
                  <button type="button" onClick={() => void vendorResetRequest()} disabled={vendorBusy}
                    className="text-sm text-brand font-heading font-semibold hover:underline disabled:opacity-50 mt-3">
                    {vendorBusy ? 'Please wait…' : 'Forgot password? Email me a reset code'}
                  </button>
                )}
              </div>
            )}

            {/* App-review demo account: password field appears when the
                reviewer enters the review email. Validated server-side. */}
            {!inVendorFlow && isReviewEmail && (
              <div className="mt-4">
                <label htmlFor="review-password" className="block text-sm font-heading font-semibold text-ink mb-1.5">
                  Password
                </label>
                <input
                  id="review-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(null); }}
                  placeholder="Password"
                  disabled={submitting}
                  className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base"
                />
              </div>
            )}

            {/* Email sign-in code (OTP): the 6-digit box appears after a code is
                sent. Works for any provider (e.g. Zoho). */}
            {!inVendorFlow && otpStage === 'sent' && !isReviewEmail && (
              <div className="mt-4">
                <label htmlFor="otp-code" className="block text-sm font-heading font-semibold text-ink mb-1.5">
                  Enter the code we emailed to {email.trim()}
                </label>
                <input
                  id="otp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => { setCode(e.target.value.replace(/\D/g, '')); setError(null); }}
                  placeholder="123456"
                  disabled={otpBusy}
                  className="focus-brand w-full border border-gray-300 rounded-lg px-3 py-2.5 text-base tracking-[0.4em] text-center"
                />
              </div>
            )}

            {error && (
              <div className="mt-2 mb-1 text-sm text-brand font-heading font-semibold">
                {error}
              </div>
            )}

            {inVendorFlow ? (
              <>
                <button
                  type="submit"
                  disabled={vendorBusy || !password || ((vendorStage === 'setup' || vendorStage === 'reset') && !confirm) || (vendorStage === 'reset' && code.trim().length < 4)}
                  className="w-full bg-brand hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-heading font-semibold py-3.5 px-4 rounded-lg transition mt-5 active:scale-[0.98]"
                >
                  {vendorBusy
                    ? 'Please wait…'
                    : vendorStage === 'setup' ? 'Create password & sign in' : vendorStage === 'reset' ? 'Reset password & sign in' : 'Sign in'}
                </button>
                <button type="button" onClick={backToEmail} disabled={vendorBusy}
                  className="w-full text-sm text-gray-500 font-heading font-semibold hover:underline disabled:opacity-50 mt-4">
                  ← Use a different email
                </button>
              </>
            ) : otpStage === 'sent' && !isReviewEmail ? (
              <>
                <button
                  type="submit"
                  disabled={otpBusy || code.trim().length < 4}
                  className="w-full bg-brand hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-heading font-semibold py-3.5 px-4 rounded-lg transition mt-5 active:scale-[0.98]"
                >
                  {otpBusy ? 'Verifying…' : 'Verify & sign in'}
                </button>
                <div className="flex items-center justify-between mt-3">
                  <button type="button" onClick={() => void requestOtp()} disabled={otpBusy}
                    className="text-sm text-brand font-heading font-semibold hover:underline disabled:opacity-50">
                    Resend code
                  </button>
                  <button type="button" onClick={() => { setOtpStage('idle'); setCode(''); setError(null); }} disabled={otpBusy}
                    className="text-sm text-gray-500 font-heading font-semibold hover:underline disabled:opacity-50">
                    Use a different method
                  </button>
                </div>
              </>
            ) : (
            <>
            <button
              type="submit"
              disabled={submitting || vendorBusy || !email.trim() || (isReviewEmail && !password)}
              className="w-full bg-brand hover:bg-brand-dark disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-heading font-semibold py-3.5 px-4 rounded-lg transition mt-5 active:scale-[0.98]"
            >
              {(submitting || vendorBusy) ? (isReviewEmail ? 'Signing in…' : 'Continuing…') : (isReviewEmail ? 'Sign in' : 'Continue')}
            </button>

            {/* Microsoft/Outlook is for EXTERNAL (1099) agents only — internal
                staff sign in with Google (Workspace + Gmail-send token). */}
            {isExternalEmail(email.trim()) && (
              <button
                type="button"
                onClick={() => void startLogin('microsoft')}
                disabled={submitting || !email.trim()}
                className="w-full bg-white hover:bg-gray-50 disabled:bg-gray-100 disabled:cursor-not-allowed text-ink border border-gray-300 font-heading font-semibold py-3.5 px-4 rounded-lg transition mt-3 active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <svg width="16" height="16" viewBox="0 0 23 23" aria-hidden><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>
                Continue with Microsoft
              </button>
            )}

            {/* Universal fallback: email a one-time code. Works for any provider
                (e.g. Zoho) that can't complete Google/Microsoft OAuth. */}
            {!isReviewEmail && (
              <button
                type="button"
                onClick={() => void requestOtp()}
                disabled={otpBusy || !email.trim()}
                className="w-full text-sm text-brand font-heading font-semibold hover:underline disabled:opacity-50 mt-4"
              >
                {otpBusy ? 'Sending code…' : 'Can’t use Google or Microsoft? Email me a sign-in code'}
              </button>
            )}
            </>
            )}

          </form>
        </div>
      </main>
    </>
  );
}
