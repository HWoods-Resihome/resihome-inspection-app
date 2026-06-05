import Head from 'next/head';
import Link from 'next/link';

/** Public Terms of Service for the "ResiWalk - 1099" OAuth app. Reachable without
 *  login. Plain template — have counsel review before relying on it. */
export default function ResiWalk1099Terms() {
  return (
    <div className="min-h-screen bg-white text-ink">
      <Head><title>Terms of Service — ResiWalk - 1099</title></Head>
      <div className="max-w-3xl mx-auto px-6 py-12">
        <header className="mb-6">
          <Link href="/1099" className="text-sm text-brand font-heading font-semibold hover:underline">← ResiWalk - 1099</Link>
          <h1 className="text-2xl font-heading font-extrabold mt-2">Terms of Service</h1>
          <p className="text-sm text-gray-500 mt-1">ResiWalk - 1099 · Last updated June 2026</p>
        </header>

        <div className="space-y-6 text-[14.5px] leading-relaxed text-gray-700">
          <p>
            These Terms of Service (&ldquo;Terms&rdquo;) govern your use of <strong>ResiWalk - 1099</strong>
            (the &ldquo;Service&rdquo;), operated by ResiHome. By signing in or using the Service, you
            agree to these Terms.
          </p>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">1. Eligibility &amp; access</h2>
            <p>
              The Service is for <strong>authorized leasing agents</strong> performing 1099 property
              inspections for ResiHome and its affiliates. Access requires a valid, approved account
              and Google sign-in to verify your identity. Don&rsquo;t share your account or let others
              use it.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">2. Acceptable use</h2>
            <p>
              Use the Service only for legitimate property inspections you are authorized to perform.
              Provide accurate information and only capture photos/details appropriate to the
              inspection. Don&rsquo;t misuse, disrupt, reverse engineer, or attempt unauthorized access
              to the Service or its data.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">3. Your content</h2>
            <p>
              Inspection details and photos you submit are provided to ResiHome for its property
              management and inspection purposes. You represent that you have the right to capture
              and submit that content for these purposes.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">4. Intellectual property</h2>
            <p>
              The Service, including its software and branding, is owned by ResiHome and its
              licensors. These Terms don&rsquo;t grant you any rights to it except to use the Service
              as intended.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">5. Disclaimer &amp; limitation of liability</h2>
            <p>
              The Service is provided &ldquo;as is&rdquo; without warranties of any kind. To the maximum
              extent permitted by law, ResiHome is not liable for indirect, incidental, or
              consequential damages arising from your use of the Service.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">6. Termination</h2>
            <p>
              We may suspend or end your access at any time, including if you violate these Terms or
              your authorization is revoked. You may stop using the Service at any time.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">7. Changes</h2>
            <p>
              We may update these Terms from time to time. Continued use after an update means you
              accept the revised Terms.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">8. Contact</h2>
            <p>Questions? Email <a href="mailto:support@resihome.com" className="text-brand font-semibold hover:underline">support@resihome.com</a>.</p>
          </section>
        </div>

        <footer className="mt-12 pt-6 border-t border-gray-200 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link href="/1099" className="text-gray-600 hover:text-ink font-heading font-semibold">Home</Link>
          <Link href="/1099/privacy" className="text-gray-600 hover:text-ink font-heading font-semibold">Privacy Policy</Link>
          <span className="text-gray-400 ml-auto">© {new Date().getFullYear()} ResiHome</span>
        </footer>
      </div>
    </div>
  );
}
