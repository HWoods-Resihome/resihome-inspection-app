// Prev / Next service pager for the service record top bar — mirrors the
// inspection pager. The services list page writes the current visible, filtered +
// sorted order of service ids to sessionStorage on every list change; this control
// reads it, finds the open service's position, and steps left/right through the
// SAME list the user was browsing (respecting their filters).

import { useEffect, useState } from 'react';

/** sessionStorage key holding the ordered service ids the user is browsing. */
export const SERVICE_NAV_KEY = 'resiwalk:service-nav';

export default function ServicePager({ currentId, onNavigate }: {
  currentId: string;
  onNavigate: (id: string) => void;
}) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SERVICE_NAV_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) setIds(arr.map((x) => String(x)));
    } catch { /* no/malformed list — pager just hides */ }
  }, [currentId]);

  const idx = ids.indexOf(String(currentId));
  const prevId = idx > 0 ? ids[idx - 1] : null;
  const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;
  if (idx === -1 || (!prevId && !nextId)) return null;

  const seg =
    'inline-flex items-center justify-center w-7 h-8 text-gray-700 hover:text-gray-900 ' +
    'hover:bg-gray-50 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent';

  return (
    <div className="inline-flex items-center rounded-lg border border-gray-300 overflow-hidden bg-white shrink-0">
      <button type="button" disabled={!prevId} onClick={() => prevId && onNavigate(prevId)} aria-label="Previous service" title="Previous service" className={seg}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <span className="w-px h-5 bg-gray-300" aria-hidden />
      <button type="button" disabled={!nextId} onClick={() => nextId && onNavigate(nextId)} aria-label="Next service" title="Next service" className={seg}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18l6-6-6-6" /></svg>
      </button>
    </div>
  );
}
