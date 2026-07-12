// In-app Training Guide — the ResiWALK guide shown inside the app (a full,
// scrollable, clickable page) instead of bouncing out to a separate browser
// tab. Wears the standard app header (back chevron + centered logo + title).

import Head from 'next/head';
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
        <iframe
          src={GUIDE_SRC}
          title="ResiWALK Training Guide"
          className="flex-1 w-full border-0"
        />
      </div>
    </>
  );
}
