// App-wide banner shown while an admin is "viewing as" someone — the always-
// available way to STOP and the persistent indicator that a view-as is active on
// EVERY page (settings included), so the preview truly lives app-wide until you
// stop it. Two modes:
//   • Viewing as a USER (impersonation cookie) — a full session as that user.
//   • Viewing as a VENDOR (svc_view_as cookie) — the external vendor preview.
// Mounted in _app so it shows everywhere. For the vendor mode we suppress it on
// /services pages, which already carry their own in-context exit control.

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import { loadMe } from '@/lib/me';
import { VIEW_AS_COOKIE, VIEW_AS_EMAIL_COOKIE, setViewAsVendor } from '@/lib/services/viewAs';

export function ImpersonationBanner() {
  const router = useRouter();
  const [viewingAs, setViewingAs] = useState<string | null>(null);
  const [adminName, setAdminName] = useState<string>('');
  const [vendorView, setVendorView] = useState<string | null>(null); // vendor email/label, or null
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let alive = true;
    loadMe()
      .then((d) => {
        if (!alive || !d?.impersonating) return;
        setViewingAs(d.user?.name || d.user?.email || 'user');
        setAdminName(d.realName || d.realEmail || 'admin');
      })
      .catch(() => { /* not impersonating / offline */ });
    // Detect the vendor-preview cookie (client-side) so THAT mode also shows a
    // persistent, stop-anywhere banner across the whole app — not just /services.
    try {
      const c = typeof document !== 'undefined' ? document.cookie : '';
      if (new RegExp(`(?:^|;\\s*)${VIEW_AS_COOKIE}=vendor(?:;|$)`).test(c)) {
        const m = new RegExp(`(?:^|;\\s*)${VIEW_AS_EMAIL_COOKIE}=([^;]*)`).exec(c);
        setVendorView(m ? decodeURIComponent(m[1]) : '');
      }
    } catch { /* noop */ }
    return () => { alive = false; };
  }, []);

  const stopUser = async () => {
    setStopping(true);
    try {
      await fetch('/api/admin/impersonate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stop: true }),
      });
    } catch { /* clear-cookie best effort */ }
    window.location.href = '/app'; // full reload so the real session takes over everywhere
  };

  const stopVendor = () => {
    setStopping(true);
    setViewAsVendor(false);
    window.location.href = '/app'; // back to the admin's own view, app-wide
  };

  const bar = (label: ReactNode, onStop: () => void) => (
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 3000, paddingTop: 'env(safe-area-inset-top)' }}
      className="bg-amber-500 text-white text-[11px] sm:text-xs font-heading font-semibold px-3 py-1 flex items-center justify-center gap-3 shadow"
    >
      <span className="truncate">{label}</span>
      <button type="button" onClick={onStop} disabled={stopping} className="shrink-0 underline underline-offset-2 hover:no-underline disabled:opacity-60">
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  );

  // User impersonation takes precedence (it's a full session as that user).
  if (viewingAs) return bar(<>Viewing as <b>{viewingAs}</b> · admin: {adminName}</>, stopUser);
  // Vendor preview: show everywhere EXCEPT /services (which has its own exit).
  if (vendorView !== null && !router.pathname.startsWith('/services')) {
    return bar(<>Viewing as vendor{vendorView ? <> <b>{vendorView}</b></> : ''} · services preview</>, stopVendor);
  }
  return null;
}
