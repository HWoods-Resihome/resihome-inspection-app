/**
 * /admin/regenerate-pdfs — consolidated into /admin/flows (the "Admin Flows" hub,
 * which holds Setup, Regenerate PDFs, and the maintenance backfills). This route
 * now just redirects there so old links/bookmarks keep working.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function RegeneratePdfsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin/flows'); }, [router]);
  return null;
}
