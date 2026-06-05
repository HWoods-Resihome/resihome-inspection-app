import Head from 'next/head';
import Link from 'next/link';

/** Public Privacy Policy for the "ResiWalk - 1099" OAuth app. Reachable without
 *  login. Includes the Google API Services "Limited Use" disclosure required for
 *  OAuth verification. Plain template — have counsel review before relying on it. */
export default function ResiWalk1099Privacy() {
  return (
    <div className="min-h-screen bg-white text-ink">
      <Head><title>Privacy Policy — ResiWalk - 1099</title></Head>
      <div className="max-w-3xl mx-auto px-6 py-12">
        <header className="mb-6">
          <Link href="/1099" className="text-sm text-brand font-heading font-semibold hover:underline">← ResiWalk - 1099</Link>
          <h1 className="text-2xl font-heading font-extrabold mt-2">Privacy Policy</h1>
          <p className="text-sm text-gray-500 mt-1">ResiWalk - 1099 · Last updated June 2026</p>
        </header>

        <div className="space-y-6 text-[14.5px] leading-relaxed text-gray-700">
          <p>
            This Privacy Policy explains how <strong>ResiWalk - 1099</strong> (&ldquo;ResiWalk,&rdquo;
            &ldquo;we,&rdquo; &ldquo;us&rdquo;), operated by ResiHome, collects and uses information
            when authorized leasing agents use the application to complete 1099 property
            inspections.
          </p>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">Information we collect</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li><strong>Google account information.</strong> When you sign in with Google, we receive your name and email address to verify your identity and create your session. We do not receive your Google password.</li>
              <li><strong>Inspection content you provide.</strong> Property details, line items, notes, answers, and the photos or video you capture during an inspection.</li>
              <li><strong>Location &amp; device data.</strong> With your permission, approximate device location at the time a photo is taken (to confirm the inspection was performed on-site) and basic device/browser information for reliability and security.</li>
              <li><strong>Usage logs.</strong> Standard logs such as actions taken and timestamps, used to operate and secure the service.</li>
            </ul>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">How we use information</h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>To authenticate you and provide the inspection application.</li>
              <li>To record, generate, and deliver inspection reports to ResiHome and its affiliates.</li>
              <li>To sync inspection records to ResiHome&rsquo;s systems (including our CRM, HubSpot).</li>
              <li>To provide support, maintain reliability, and protect against fraud, abuse, and security threats.</li>
            </ul>
          </section>

          <section className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <h2 className="text-base font-heading font-bold text-ink mb-2">Google user data — Limited Use</h2>
            <p>
              ResiWalk - 1099&rsquo;s use of information received from Google APIs adheres to the{' '}
              <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer" className="text-brand font-semibold hover:underline">Google API Services User Data Policy</a>,
              including the Limited Use requirements. We only request your basic profile (name and
              email) to sign you in. We do <strong>not</strong> access your Gmail, contacts, files,
              or other Google data; we do not sell Google user data; we do not use it for
              advertising; and we do not transfer it except as needed to provide the service or as
              required by law.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">How we share information</h2>
            <p>
              We share information with ResiHome and its affiliates to operate the inspection
              program, and with service providers that help us run the application (for example,
              cloud hosting and our CRM). We do not sell your personal information. We may disclose
              information if required by law or to protect rights, safety, and security.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">Data retention &amp; security</h2>
            <p>
              We retain inspection records for as long as needed for the business and legal
              purposes described above. We use reasonable technical and organizational measures
              (including encryption in transit and access controls) to protect information.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">Your choices</h2>
            <p>
              You can decline or revoke Google access at any time in your{' '}
              <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-brand font-semibold hover:underline">Google Account permissions</a>;
              doing so will sign you out of ResiWalk - 1099. For questions or requests about your
              information, contact us below.
            </p>
          </section>

          <section>
            <h2 className="text-base font-heading font-bold text-ink mb-2">Contact</h2>
            <p>Questions about this policy? Email <a href="mailto:support@resihome.com" className="text-brand font-semibold hover:underline">support@resihome.com</a>.</p>
          </section>
        </div>

        <footer className="mt-12 pt-6 border-t border-gray-200 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link href="/1099" className="text-gray-600 hover:text-ink font-heading font-semibold">Home</Link>
          <Link href="/1099/terms" className="text-gray-600 hover:text-ink font-heading font-semibold">Terms of Service</Link>
          <span className="text-gray-400 ml-auto">© {new Date().getFullYear()} ResiHome</span>
        </footer>
      </div>
    </div>
  );
}
