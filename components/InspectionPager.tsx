// Prev / Next inspection pager shown in the inspection header.
//
// The inspections list page (pages/index.tsx) writes the CURRENT visible,
// filtered + sorted order of inspection record ids to sessionStorage on every
// list change. This control reads that list, finds the open inspection's
// position, and lets the user step left/right through the SAME list they were
// looking at (respecting whatever status/inspector/etc. filter was applied) —
// without bouncing back to the main screen.
//
// Navigation goes through `onNavigate` (not a raw router push) so the host form
// can force-save first — exactly like the Back button — before leaving.

import { useEffect, useState } from 'react';

/** sessionStorage key holding the ordered list of inspection record ids the
 *  user is currently browsing. Written by the list page, read here. */
export const INSPECTION_NAV_KEY = 'resiwalk:inspection-nav';

export default function InspectionPager({
  currentId,
  onNavigate,
}: {
  currentId: string;
  /** Save-then-navigate to the given inspection id (host wires its flush). */
  onNavigate: (id: string) => void;
}) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(INSPECTION_NAV_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) setIds(arr.map((x) => String(x)));
    } catch { /* no/!malformed list — pager just hides */ }
  }, [currentId]);

  const idx = ids.indexOf(String(currentId));
  const prevId = idx > 0 ? ids[idx - 1] : null;
  const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : null;
  // Hide entirely when this inspection isn't in a known list, or it's the only one.
  if (idx === -1 || (!prevId && !nextId)) return null;

  const btn =
    'inline-flex items-center justify-center w-8 h-8 text-gray-700 hover:text-gray-900 ' +
    'border border-gray-300 hover:border-gray-400 rounded-lg bg-white ' +
    'disabled:opacity-30 disabled:cursor-default disabled:hover:border-gray-300';

  return (
    <>
      <button
        type="button"
        disabled={!prevId}
        onClick={() => prevId && onNavigate(prevId)}
        aria-label="Previous inspection"
        title="Previous inspection"
        className={btn}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <button
        type="button"
        disabled={!nextId}
        onClick={() => nextId && onNavigate(nextId)}
        aria-label="Next inspection"
        title="Next inspection"
        className={btn}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18l6-6-6-6" /></svg>
      </button>
    </>
  );
}
