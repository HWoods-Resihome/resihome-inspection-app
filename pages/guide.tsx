// In-app Training Guide — the ResiWalk guide shown inside the app (a full,
// scrollable, clickable page) instead of bouncing out to a separate browser
// tab. Wears the standard app header (back chevron + centered logo + title).

import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { PageHeader } from '@/components/PageHeader';

// Served through our same-origin proxy (resihome.com blocks direct framing).
const GUIDE_SRC = '/api/guide-proxy';

export default function TrainingGuide() {
  const router = useRouter();
  return (
    <>
      <Head><title>Training Guide</title></Head>
      <div className="fixed inset-0 flex flex-col bg-gray-50">
        <PageHeader title="Training Guide" onBack={() => router.back()} backLabel="Back" homeHref="/" />
        {/* Appendix strip — the short vendor-facing Services quick-start lives
            in-app (the main guide is an external doc we can't edit). */}
        <Link href="/guide/vendor-services"
          className="shrink-0 flex items-center justify-between gap-2 bg-brand/5 border-b border-brand/20 px-4 py-2.5 text-[13px] font-heading font-semibold text-brand">
          <span>Appendix: Vendor Guide — Services Quick-Start</span>
          <span aria-hidden>→</span>
        </Link>
        <iframe
          src={GUIDE_SRC}
          title="ResiWalk Training Guide"
          className="flex-1 w-full border-0"
        />
      </div>
    </>
  );
}
