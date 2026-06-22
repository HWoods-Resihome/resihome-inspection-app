// App-wide banner shown while an admin is "viewing as" another user. It's the
// always-available way to STOP impersonating (the admin menu is hidden while you
// see the impersonated user's view). Mounted in _app so it shows on every page.

import { useEffect, useState } from 'react';

export function ImpersonationBanner() {
  const [viewingAs, setViewingAs] = useState<string | null>(null);
  const [adminName, setAdminName] = useState<string>('');
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.impersonating) return;
        setViewingAs(d.user?.name || d.user?.email || 'user');
        setAdminName(d.realName || d.realEmail || 'admin');
      })
      .catch(() => { /* not impersonating / offline */ });
    return () => { alive = false; };
  }, []);

  if (!viewingAs) return null;

  const stop = async () => {
    setStopping(true);
    try {
      await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stop: true }),
      });
    } catch { /* clear-cookie best effort */ }
    window.location.href = '/'; // full reload so the real session takes over everywhere
  };

  return (
    <div
      style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 3000, paddingTop: 'env(safe-area-inset-top)' }}
      className="bg-amber-500 text-white text-[11px] sm:text-xs font-heading font-semibold px-3 py-1 flex items-center justify-center gap-3 shadow"
    >
      <span className="truncate">
        Viewing as <b>{viewingAs}</b> · admin: {adminName}
      </span>
      <button
        type="button"
        onClick={stop}
        disabled={stopping}
        className="shrink-0 underline underline-offset-2 hover:no-underline disabled:opacity-60"
      >
        {stopping ? 'Stopping…' : 'Stop'}
      </button>
    </div>
  );
}
