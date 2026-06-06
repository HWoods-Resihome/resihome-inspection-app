import { useEffect, useRef } from 'react';

/**
 * Make the Android back button / back-swipe (and the browser Back) close an
 * open overlay (camera, modal, popup) instead of navigating away from the page.
 *
 * How: while `active`, we push one history entry. The back gesture pops it,
 * which fires `popstate` → we run `onClose()`. When the overlay is closed via
 * its own UI instead (a tap), the effect cleanup pops our pushed entry so the
 * history stays clean and a later back press doesn't land on a dead state.
 *
 * Result: with no overlay open, back behaves normally (e.g. inspection → home).
 * With an overlay open, back just dismisses the overlay and stays put.
 */
export function useBackToClose(active: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    let poppedByBack = false;
    window.history.pushState({ rwOverlay: true }, '');
    const onPop = () => {
      poppedByBack = true; // the back gesture already consumed our entry
      closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed via the UI (not back) — remove the entry we pushed so history
      // doesn't accumulate a dangling state.
      if (!poppedByBack && (window.history.state as any)?.rwOverlay) {
        window.history.back();
      }
    };
  }, [active]);
}
