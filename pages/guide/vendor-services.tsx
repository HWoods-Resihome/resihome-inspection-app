// Vendor Services Quick-Start — the SHORT, services-only appendix to the main
// Training Guide. Native in-app content (the main guide is an external doc
// framed via /api/guide-proxy, so the appendix lives here and is linked from a
// bar on the Training Guide screen). Vendor-accessible (middleware allowlists
// this path for vendor sessions).

import Head from 'next/head';
import { useRouter } from 'next/router';
import { PageHeader } from '@/components/PageHeader';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl shadow-md overflow-hidden bg-white border border-gray-200">
      <div className="bg-brand/5 border-b border-brand/20 px-4 py-3">
        <h2 className="font-heading font-bold text-lg text-ink">{title}</h2>
      </div>
      <div className="p-4 text-sm text-gray-700 space-y-2">{children}</div>
    </section>
  );
}

export default function VendorServicesGuide() {
  const router = useRouter();
  return (
    <>
      <Head><title>Vendor Guide — Services</title></Head>
      <main className="min-h-screen bg-gray-50 pb-16">
        <PageHeader title="Vendor Guide: Services" onBack={() => router.back()} backLabel="Back" homeHref="/services" />
        <div className="max-w-3xl mx-auto px-4 pt-4 space-y-4">
          <p className="text-[13px] text-gray-500">
            Appendix to the ResiWalk Training Guide — the short version of everything a
            service vendor needs. Bookmark this page.
          </p>

          <Section title="1 · Signing In">
            <p>Go to the ResiWalk sign-in page and enter your <strong>company email</strong> (the one your welcome email arrived at).</p>
            <p>The first time, we email you a <strong>verification code</strong> and you set a password. After that it&apos;s email + password — you&apos;ll be asked to sign in once per day.</p>
          </Section>

          <Section title="2 · Your Work Orders">
            <p>The Services home lists <strong>only the work assigned to your company</strong>. Each card shows the property address, the service type, the due date, and a status chip.</p>
            <p><strong>Assigned</strong> means it&apos;s yours to do. Use the search bar or the Type filter to find a specific job, and the calendar icon for a day-by-day view.</p>
          </Section>

          <Section title="3 · Completing A Service">
            <p>Open the work order and follow the form top to bottom:</p>
            <p>• <strong>Before photos</strong> — take them when you arrive, before any work.</p>
            <p>• Do the work.</p>
            <p>• <strong>After photos</strong> — same angles as the before shots wherever possible.</p>
            <p>• Add any notes (gate codes that didn&apos;t work, access problems, extra work needed), then <strong>Submit</strong>.</p>
            <p>Photos are taken with the in-app camera and are time-and-location stamped — take them at the property.</p>
          </Section>

          <Section title="4 · After You Submit">
            <p>Your submission shows <strong>Submitted – Under Review</strong> while it&apos;s checked. Most services complete automatically; a few get a quick human look.</p>
            <p>If something needs fixing (missing photo, wrong property), the work order comes back to you with a note explaining what&apos;s needed.</p>
          </Section>

          <Section title="5 · Bids &amp; Extra Work">
            <p>See work that&apos;s needed beyond the assigned scope? Submit it as a <strong>bid item</strong> from the work order. It goes to ResiHome for approval — don&apos;t do the extra work until the bid is approved and assigned back to you.</p>
          </Section>

          <Section title="6 · Due Dates">
            <p>Every work order has a due date; completing <strong>on or before</strong> it counts as on-time. If you can&apos;t make a date, say so early — use the notes on the work order.</p>
          </Section>

          <Section title="7 · Help">
            <p>Notification emails come from the ResiWalk system mailbox — replies there reach the team. You can manage which emails you get under <strong>Settings → Notifications</strong>.</p>
          </Section>
        </div>
      </main>
    </>
  );
}
