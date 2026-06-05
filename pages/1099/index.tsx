import Head from 'next/head';
import Link from 'next/link';

/**
 * Public home page for the "ResiWalk - 1099" Google OAuth app. Reachable WITHOUT
 * login (see middleware) so Google's OAuth verification can read it. The product
 * name here matches the OAuth consent-screen App name exactly ("ResiWalk - 1099"),
 * and it explains the app's purpose + how Google account data is used.
 */
export default function ResiWalk1099Home() {
  return (
    <div className="min-h-screen bg-white text-ink">
      <Head>
        <title>ResiWalk - 1099</title>
        <meta name="description" content="ResiWalk - 1099 is the property-inspection web app authorized leasing agents use to complete 1099 property inspections for ResiHome." />
      </Head>

      <div className="max-w-3xl mx-auto px-6 py-12">
        <header className="flex items-center gap-3 mb-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-192.png" alt="ResiWalk - 1099" className="w-14 h-14 rounded-2xl shadow" />
          <div>
            <h1 className="text-2xl font-heading font-extrabold text-ink">ResiWalk - 1099</h1>
            <p className="text-sm text-gray-500">Property inspections for ResiHome leasing agents</p>
          </div>
        </header>

        <section className="space-y-4 text-[15px] leading-relaxed text-gray-700">
          <p>
            <strong>ResiWalk - 1099</strong> is a web application used by authorized leasing
            agents to complete <strong>1099 property inspections</strong> for ResiHome and its
            affiliates. Agents conduct on-site property assessments — recording inspection
            details, line items, notes, and photos — and submit a report that syncs to
            ResiHome&rsquo;s systems.
          </p>
          <p>
            Access is limited to authorized agents. You sign in with your Google account so we
            can confirm your identity, then you can start and submit your 1099 inspections.
          </p>
        </section>

        <div className="mt-8">
          <Link href="/login"
            className="inline-flex items-center justify-center px-6 py-3 rounded-xl bg-brand text-white text-base font-heading font-bold shadow hover:bg-brand-dark">
            Sign in
          </Link>
        </div>

        <section className="mt-10 rounded-2xl border border-gray-200 bg-gray-50 p-5">
          <h2 className="text-sm font-heading font-bold text-ink mb-2">How we use your Google account</h2>
          <p className="text-[13.5px] leading-relaxed text-gray-600">
            ResiWalk - 1099 requests only your basic Google profile — your <strong>name and
            email address</strong> — solely to verify your identity and create your sign-in
            session. It does <strong>not</strong> request or access your Gmail, contacts, files,
            calendar, or any other Google data. See our{' '}
            <Link href="/1099/privacy" className="text-brand font-semibold hover:underline">Privacy Policy</Link>{' '}
            for details.
          </p>
        </section>

        <footer className="mt-12 pt-6 border-t border-gray-200 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <Link href="/1099/privacy" className="text-gray-600 hover:text-ink font-heading font-semibold">Privacy Policy</Link>
          <Link href="/1099/terms" className="text-gray-600 hover:text-ink font-heading font-semibold">Terms of Service</Link>
          <a href="mailto:support@resihome.com" className="text-gray-600 hover:text-ink font-heading font-semibold">Contact</a>
          <span className="text-gray-400 ml-auto">© {new Date().getFullYear()} ResiHome</span>
        </footer>
      </div>
    </div>
  );
}
