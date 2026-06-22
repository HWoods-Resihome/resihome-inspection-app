/**
 * /admin/setup — consolidated into /admin/flows (the "Admin Flows" hub, where
 * "Provision Fields (Setup)" now lives alongside Regenerate PDFs and the
 * maintenance backfills). This route now just redirects there so old links and
 * the "provision via /admin/setup" references keep working.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function SetupRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/admin/flows'); }, [router]);
  return null;
}
