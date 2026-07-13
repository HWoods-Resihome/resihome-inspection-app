// Pull-to-refresh for document-scrolled pages (Inspections / Services home).
// Drop <PullToRefresh onRefresh={...} /> anywhere on the page — it listens on
// the window, and when the user drags down from the very top past a threshold it
// shows a spinner and runs onRefresh. Non-invasive: no wrapper/scroll container
// needed; it only engages a downward drag while scrollTop is 0.

import { useEffect, useRef, useState } from 'react';

export function PullToRefresh({ onRefresh, threshold = 70 }: { onRefresh: () => Promise<void> | void; threshold?: number }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Refs mirror state for the (stale-closure-free) touch handlers.
  const startY = useRef<number | null>(null);
  const armed = useRef(false);
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  // The scroll container the current gesture lives in (the Home list scrolls
  // inside `.frozen-scroll`, NOT the document — so we must read ITS scrollTop,
  // else a downward drag inside a scrolled list wrongly arms the refresh).
  const scroller = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Nearest scrollable ancestor of a node (overflow-y auto/scroll with real
    // overflow). Null → the page scrolls the document.
    const findScrollable = (node: EventTarget | null): HTMLElement | null => {
      let el: HTMLElement | null = node instanceof Element ? (node as HTMLElement) : null;
      while (el && el !== document.body && el !== document.documentElement) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
        el = el.parentElement;
      }
      return null;
    };
    const docTop = () => (document.scrollingElement || document.documentElement).scrollTop || 0;
    const scrollTop = () => (scroller.current ? scroller.current.scrollTop : docTop());

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current || e.touches.length !== 1) { armed.current = false; return; }
      scroller.current = findScrollable(e.target);
      if (scrollTop() <= 0) { startY.current = e.touches[0].clientY; armed.current = true; }
      else { armed.current = false; startY.current = null; }
    };
    const onMove = (e: TouchEvent) => {
      if (!armed.current || startY.current == null || refreshingRef.current) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0 || scrollTop() > 0) { armed.current = false; pullRef.current = 0; setPull(0); setDragging(false); return; }
      const dist = Math.min(dy * 0.5, threshold * 1.7); // resistance + cap
      pullRef.current = dist;
      setPull(dist);
      setDragging(true);
      if (dist > 3 && e.cancelable) e.preventDefault(); // hold the page still while pulling
    };
    const onEnd = () => {
      if (!armed.current) { setDragging(false); return; }
      armed.current = false;
      startY.current = null;
      setDragging(false);
      if (pullRef.current >= threshold) {
        refreshingRef.current = true; setRefreshing(true); pullRef.current = threshold; setPull(threshold);
        Promise.resolve(onRefresh()).finally(() => {
          refreshingRef.current = false; setRefreshing(false); pullRef.current = 0; setPull(0);
        });
      } else { pullRef.current = 0; setPull(0); }
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove as EventListener);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [onRefresh, threshold]);

  const shown = refreshing ? threshold : pull;
  const visible = shown > 0;
  const progress = Math.min(1, shown / threshold);

  return (
    <div aria-hidden className="fixed inset-x-0 top-0 z-[60] flex justify-center pointer-events-none"
      style={{
        transform: `translateY(${Math.max(0, shown) - 4}px)`,
        transition: dragging ? 'none' : 'transform 0.22s ease, opacity 0.22s ease',
        opacity: visible ? 1 : 0,
      }}>
      <div className="mt-1 w-9 h-9 rounded-full bg-white shadow-md ring-1 ring-black/5 grid place-items-center"
        style={{ transform: `scale(${0.6 + 0.4 * progress})` }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
          className={`text-brand ${refreshing ? 'animate-spin' : ''}`}
          style={{ transform: refreshing ? undefined : `rotate(${progress * 270}deg)` }}>
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <polyline points="21 4 21 9 16 9" />
        </svg>
      </div>
    </div>
  );
}
